import { privateKey } from './telnyx-keys';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'crypto';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { createApp, resetDb, waitFor } from './helpers';

let app: INestApplication;
const realFetch = global.fetch;
const commands: { path: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  // Intercept the Telnyx API; let everything else (e.g. Mailpit) through.
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.telnyx.com/v2/')) {
      const path = url.replace('https://api.telnyx.com/v2', '');
      commands.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      const data = path === '/calls' ? { call_control_id: 'out-leg-1' } : { result: 'ok' };
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('https://recordings.example.com/')) return new Response(Buffer.from('ID3-fake-mp3'), { status: 200 });
    return realFetch(input, init);
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await prisma.$disconnect();
});

function signed(body: object, opts: { tamper?: boolean; timestamp?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString('base64');
  return request(app.getHttpServer())
    .post('/webhooks/telnyx')
    .set('Content-Type', 'application/json')
    .set('telnyx-timestamp', ts)
    .set('telnyx-signature-ed25519', opts.tamper ? sig.replace(/^./, sig[0] === 'A' ? 'B' : 'A') : sig)
    .send(raw);
}

const event = (type: string, payload: object, occurredAt = new Date()) => ({
  data: { event_type: type, occurred_at: occurredAt.toISOString(), payload },
});

describe('Telnyx webhooks', () => {
  it('rejects unsigned, forged and stale webhooks', async () => {
    const body = event('call.initiated', { call_control_id: 'x', direction: 'incoming', from: '+13055550100', to: '+14155550100' });
    await request(app.getHttpServer()).post('/webhooks/telnyx').send(body).expect(403);
    await signed(body, { tamper: true }).expect(403);
    await signed(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }).expect(403);
  });

  it('rejects calls to numbers we do not own', async () => {
    commands.length = 0;
    await signed(event('call.initiated', { call_control_id: 'unknown-1', direction: 'incoming', from: '+13055550100', to: '+19995550100' })).expect(200);
    expect(commands.map((c) => c.path)).toEqual(['/calls/unknown-1/actions/reject']);
  });

  it('runs a whole call through Telnyx commands', async () => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'starter' } });
    const tenant = await prisma.tenant.create({
      data: { name: 'Tel Co', subdomain: 'telco', status: 'ACTIVE', walletBalance: 20, planId: plan.id },
    });
    const campaign = await prisma.campaign.create({ data: { tenantId: tenant.id, name: 'Solar', revenue: 30, payout: 10, convertAfterSeconds: 60 } });
    const buyer = await prisma.buyer.create({ data: { tenantId: tenant.id, name: 'SolarCo', destination: '+12125550123', ringTimeoutSec: 25 } });
    await prisma.route.create({ data: { tenantId: tenant.id, campaignId: campaign.id, buyerId: buyer.id } });
    await prisma.phoneNumber.create({
      data: { tenantId: tenant.id, e164: '+14155550142', status: 'ACTIVE', provider: 'telnyx', campaignId: campaign.id },
    });

    commands.length = 0;
    const t0 = new Date(Date.now() - 120_000);
    const at = (sec: number) => new Date(t0.getTime() + sec * 1000);

    await signed(event('call.initiated', { call_control_id: 'in-1', direction: 'incoming', from: '+15125550100', to: '+14155550142' }, t0)).expect(200);
    expect(commands.map((c) => c.path)).toEqual(['/calls/in-1/actions/answer', '/calls/in-1/actions/speak']);

    await signed(event('call.speak.ended', { call_control_id: 'in-1' }, at(4))).expect(200);
    expect(commands[2]).toMatchObject({ path: '/calls', body: { to: '+12125550123', from: '+14155550142', timeout_secs: 25, link_to: 'in-1' } });

    // Our own outgoing leg's "initiated" event must be ignored.
    await signed(event('call.initiated', { call_control_id: 'out-leg-1', direction: 'outgoing', from: '+14155550142', to: '+12125550123' }, at(4))).expect(200);
    await signed(event('call.answered', { call_control_id: 'out-leg-1' }, at(10))).expect(200);
    expect(commands.slice(3).map((c) => c.path)).toEqual(['/calls/in-1/actions/bridge', '/calls/in-1/actions/record_start']);
    expect(commands[3].body).toMatchObject({ call_control_id: 'out-leg-1' });

    // The same webhook delivered twice must not bridge twice.
    await signed(event('call.answered', { call_control_id: 'out-leg-1' }, at(10))).expect(200);
    expect(commands).toHaveLength(5);

    await signed(event('call.hangup', { call_control_id: 'in-1', hangup_cause: 'normal_clearing', end_time: at(100).toISOString() }, at(100))).expect(200);
    expect(commands[5].path).toBe('/calls/out-leg-1/actions/hangup');
    await signed(event('call.hangup', { call_control_id: 'out-leg-1', hangup_cause: 'normal_clearing', end_time: at(100).toISOString() }, at(100))).expect(200);

    await signed(event('call.recording.saved', { call_control_id: 'in-1', recording_urls: { mp3: 'https://recordings.example.com/abc.mp3' } })).expect(200);

    const call = await prisma.call.findFirstOrThrow({ where: { telnyxCallId: 'in-1' } });
    expect(call).toMatchObject({ status: 'COMPLETED', converted: true, durationSec: 100, connectedSec: 90, callerState: 'TX', hangupCause: 'normal_clearing' });
    expect(Number(call.revenue)).toBe(30);
    // Copied by the recordings queue right after the webhook.
    const recorded = await waitFor(() => prisma.call.findUniqueOrThrow({ where: { id: call.id } }), (c) => !!c.recordingUrl);
    expect(recorded.recordingUrl).toBe(`recordings/${tenant.id}/${call.id}.mp3`);
  });
});
