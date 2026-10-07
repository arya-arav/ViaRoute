import { privateKey } from './telnyx-keys';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'crypto';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { StorageService } from '../src/common/storage.service';
import { RecordingsService } from '../src/routing/recordings.service';
import { createApp, portal, resetDb, signupTenant, tokenFromEmail, uid, verifyEmail } from './helpers';

let app: INestApplication;
const realFetch = global.fetch;
const telnyx: { path: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.telnyx.com/v2/')) {
      const path = url.replace('https://api.telnyx.com/v2', '');
      telnyx.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ data: path === '/calls' ? { call_control_id: 'rec-out' } : {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await prisma.$disconnect();
});

type Session = Awaited<ReturnType<typeof signupTenant>>;
const api = (t: Session) => portal(app, t.sub, t.token);

async function setup() {
  const t = await signupTenant(app);
  await verifyEmail(app, t);
  await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 100 } });
  const camp = await api(t).post('/campaigns', { name: 'Recorded', revenue: 10 }).expect(201);
  const buyerA = await api(t).post('/buyers', { name: 'Buyer A', destination: '+12125550151' }).expect(201);
  const buyerB = await api(t).post('/buyers', { name: 'Buyer B', destination: '+12125550152' }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyerA.body.id, priority: 1 }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyerB.body.id, priority: 2 }).expect(201);
  const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
  const num = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(201);
  await api(t).patch(`/numbers/${num.body.id}`, { campaignId: camp.body.id }).expect(200);
  return { t, number: num.body.e164 as string, campaignId: camp.body.id as string, buyerA: buyerA.body.id as string };
}

async function recordedCall(t: Session, to: string, outcomes: string[] = [], from = '+13055550161') {
  const res = await api(t).post('/simulator/calls', { to, from, talkSec: 30, stepMs: 5, outcomes }).expect(201);
  for (let i = 0; i < 300; i++) {
    const c = await api(t).get(`/calls/${res.body.callId}`).expect(200);
    if (c.body.endedAt && c.body.recordingLink) return c.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no recording');
}

async function login(t: Session, role: 'BUYER' | 'PUBLISHER', extra: Record<string, string>) {
  const email = `${role.toLowerCase()}-${uid()}@x.test`;
  await api(t).post('/team/invite', { email, name: `${role} login`, role, ...extra }).expect(201);
  const token = await tokenFromEmail(email, '/accept-invite');
  const res = await portal(app, t.sub).post('/auth/accept-invite', { token, password: 'Partner123' }).expect(200);
  return portal(app, t.sub, res.body.token);
}

describe('Recordings library', () => {
  it('lists recordings with play and download links, and storage used', async () => {
    const s = await setup();
    const c = await recordedCall(s.t, s.number);
    expect(c.recordingDownload).toMatch(/&dl=call-\d{4}-\d{2}-\d{2}-%2B13055550161\.wav$/);

    const list = await api(s.t).get('/recordings').expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: c.id, callerNumber: '+13055550161', buyer: { name: 'Buyer A' } });
    expect(list.body.storage).toMatchObject({ recordings: 1, retentionDays: 90 });
    expect(list.body.storage.bytes).toBeGreaterThan(44);

    const dl = await request(app.getHttpServer()).get(list.body.items[0].downloadUrl).expect(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="call-\d{4}-\d{2}-\d{2}-\d{4}-\+13055550161\.wav"$/);
    const play = await request(app.getHttpServer()).get(list.body.items[0].playUrl).expect(200);
    expect(play.headers['content-disposition']).toBeUndefined();
    expect(play.headers['content-type']).toBe('audio/wav');
  });

  it('buyers hear only their calls; publishers get none', async () => {
    const s = await setup();
    await recordedCall(s.t, s.number); // Buyer A
    await recordedCall(s.t, s.number, ['no_answer'], '+13055550162'); // Buyer A doesn't answer → Buyer B
    const buyer = await login(s.t, 'BUYER', { buyerId: s.buyerA });
    const mine = await buyer.get('/recordings').expect(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].buyer.name).toBe('Buyer A');
    expect(mine.body.storage).toBeUndefined();
    const pub = await api(s.t).post('/publishers', { name: 'Pub' }).expect(201);
    const publisher = await login(s.t, 'PUBLISHER', { publisherId: pub.body.id });
    await publisher.get('/recordings').expect(403);
  });

  it('admins delete a recording for good; managers cannot', async () => {
    const s = await setup();
    const c = await recordedCall(s.t, s.number);
    const key = (await prisma.call.findUniqueOrThrow({ where: { id: c.id } })).recordingUrl!;
    expect(await app.get(StorageService).exists(key)).toBe(true);

    await api(s.t).delete(`/recordings/${c.id}`).expect(200);
    expect(await app.get(StorageService).exists(key)).toBe(false);
    const after = await api(s.t).get(`/calls/${c.id}`).expect(200);
    expect(after.body).toMatchObject({ recordingLink: null, hasRecording: false });
    expect(after.body.recordingDeletedAt).not.toBeNull();
    await api(s.t).delete(`/recordings/${c.id}`).expect(404);
    const log = await prisma.auditLog.findFirst({ where: { action: 'recording.delete', entityId: c.id } });
    expect(log).toBeTruthy();
  });
});

describe('Retention', () => {
  it('deletes recordings older than the account keeps them', async () => {
    const s = await setup();
    await api(s.t).patch('/tenant/settings', { recordingRetentionDays: 0 }).expect(400);
    await api(s.t).patch('/tenant/settings', { recordingRetentionDays: 30 }).expect(200);
    const old = await recordedCall(s.t, s.number);
    const fresh = await recordedCall(s.t, s.number);
    await prisma.call.update({ where: { id: old.id }, data: { startedAt: new Date(Date.now() - 40 * 86400_000) } });

    const removed = await app.get(RecordingsService).purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await prisma.call.findUniqueOrThrow({ where: { id: old.id } })).recordingUrl).toBeNull();
    expect((await prisma.call.findUniqueOrThrow({ where: { id: fresh.id } })).recordingUrl).not.toBeNull();

    // Keep forever.
    await api(s.t).patch('/tenant/settings', { recordingRetentionDays: null }).expect(200);
    await prisma.call.update({ where: { id: fresh.id }, data: { startedAt: new Date(Date.now() - 4000 * 86400_000) } });
    await app.get(RecordingsService).purgeExpired();
    expect((await prisma.call.findUniqueOrThrow({ where: { id: fresh.id } })).recordingUrl).not.toBeNull();
    expect((await api(s.t).get('/tenant').expect(200)).body.recordingRetentionDays).toBeNull();
  });
});

describe('Recording notice', () => {
  function event(type: string, payload: object) {
    const raw = JSON.stringify({ data: { event_type: type, occurred_at: new Date().toISOString(), payload } });
    const ts = String(Math.floor(Date.now() / 1000));
    return request(app.getHttpServer())
      .post('/webhooks/telnyx')
      .set('Content-Type', 'application/json')
      .set('telnyx-timestamp', ts)
      .set('telnyx-signature-ed25519', sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString('base64'))
      .send(raw);
  }

  async function telnyxCampaign(e164: string, data: Record<string, unknown>) {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'starter' } });
    const tenant = await prisma.tenant.create({ data: { name: 'Notice Co', subdomain: `notice${uid()}`, status: 'ACTIVE', walletBalance: 20, planId: plan.id } });
    const buyer = await prisma.buyer.create({ data: { tenantId: tenant.id, name: 'B', destination: '+12125550159' } });
    const campaign = await prisma.campaign.create({ data: { tenantId: tenant.id, name: 'Notice', ...data } });
    await prisma.route.create({ data: { tenantId: tenant.id, campaignId: campaign.id, buyerId: buyer.id } });
    await prisma.phoneNumber.create({ data: { tenantId: tenant.id, e164, status: 'ACTIVE', provider: 'telnyx', campaignId: campaign.id } });
  }

  it('speaks the campaign’s own notice', async () => {
    await telnyxCampaign('+14155550181', { recordingNotice: 'Calls are recorded for training.' });
    telnyx.length = 0;
    await event('call.initiated', { call_control_id: 'n-in-1', direction: 'incoming', from: '+15125550100', to: '+14155550181' }).expect(200);
    expect(telnyx[1]).toMatchObject({ path: '/calls/n-in-1/actions/speak', body: { payload: 'Calls are recorded for training.' } });
  });

  it('records without a notice when it is switched off', async () => {
    await telnyxCampaign('+14155550182', { playRecordingNotice: false });
    telnyx.length = 0;
    await event('call.initiated', { call_control_id: 'n-in-2', direction: 'incoming', from: '+15125550100', to: '+14155550182' }).expect(200);
    expect(telnyx.map((c) => c.path)).toEqual(['/calls/n-in-2/actions/answer', '/calls']); // straight to the buyer
    await event('call.answered', { call_control_id: 'rec-out' }).expect(200);
    expect(telnyx.map((c) => c.path).slice(-2)).toEqual(['/calls/n-in-2/actions/bridge', '/calls/n-in-2/actions/record_start']);
  });
});

describe('Copying from the carrier (queued)', () => {
  it('a worker copies the carrier recording into storage and attaches it to the call', async () => {
    const audio = Buffer.from('ID3 carrier mp3');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(audio);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const s = await setup();
      const c = await recordedCall(s.t, s.number);
      const key = `recordings/queued/${c.id}.mp3`;
      const { port } = server.address() as AddressInfo;
      await app.get(RecordingsService).enqueueDownload({ callId: c.id, key, url: `http://127.0.0.1:${port}/rec.mp3` });

      let call = await prisma.call.findUniqueOrThrow({ where: { id: c.id } });
      for (let i = 0; i < 50 && call.recordingUrl !== key; i++) {
        await new Promise((r) => setTimeout(r, 100));
        call = await prisma.call.findUniqueOrThrow({ where: { id: c.id } });
      }
      expect(call.recordingUrl).toBe(key);
      expect(call.recordingSize).toBe(audio.length);
      expect(await app.get(StorageService).exists(key)).toBe(true);
    } finally {
      server.close();
    }
  });
});
