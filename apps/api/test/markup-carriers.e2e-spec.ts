import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { generateKeyPairSync } from 'crypto';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { createApp, portal, resetDb, signupTenant, verifyEmail, waitFor } from './helpers';

let app: INestApplication;
let admin: ReturnType<typeof portal>;
const realFetch = global.fetch;

interface Hit {
  method: string;
  url: string;
  auth: string;
  body: string;
}
const hits: Hit[] = [];
/** The number each carrier offers in search results (different per carrier: numbers are unique). */
let offered = '+14155550131';

const CARRIER_HOSTS = ['https://api.twilio.com/', 'https://acme.signalwire.com/', 'https://api.plivo.com/', 'https://voice.bandwidth.com/', 'https://api.nexmo.com/', 'https://rest.nexmo.com/', 'https://recordings.example.com/'];

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  await prisma.user.create({ data: { email: 'root@viaroute.test', name: 'Root Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('RootPass123', 4) } });
  const res = await portal(app, null).post('/auth/login', { email: 'root@viaroute.test', password: 'RootPass123' }).expect(200);
  admin = portal(app, null, res.body.token);

  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!CARRIER_HOSTS.some((h) => url.startsWith(h))) return realFetch(input, init);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    hits.push({ method, url, auth: headers.Authorization ?? '', body: String(init?.body ?? '') });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const d = offered.slice(1);

    if (url.startsWith('https://recordings.example.com/')) return new Response(Buffer.from('fake-audio'), { status: 200 });
    // Twilio & SignalWire
    if (/AvailablePhoneNumbers/.test(url)) return ok({ available_phone_numbers: [{ phone_number: offered, locality: 'San Francisco', region: 'CA' }] });
    if (/IncomingPhoneNumbers\.json$/.test(url) && method === 'POST') return ok({ sid: 'PN123' });
    if (/\/Calls\.json$/.test(url)) return ok({ sid: 'twilio-out-1' });
    if (/2010-04-01\/Accounts\/[^/]+\.json$/.test(url)) return ok({ friendly_name: 'My Twilio', status: 'active' });
    // Plivo
    if (url.includes('api.plivo.com') && url.includes('/PhoneNumber/?')) return ok({ objects: [{ number: d, monthly_rental_rate: '0.8', city: 'San Francisco', region: 'CA' }] });
    if (url.includes('api.plivo.com') && /\/PhoneNumber\/\d+\/$/.test(url)) return ok({ status: 'fulfilled', numbers: [{ number: d, status: 'Success' }] });
    if (url.endsWith('api.plivo.com/v1/Account/MAPLIVO/Call/') && method === 'POST') return ok({ request_uuid: 'plivo-req-1' });
    if (url.endsWith('/Account/MAPLIVO/')) return ok({ cash_credits: '42.5' });
    // Bandwidth
    if (url.endsWith('/accounts/9900/calls') && method === 'POST') return ok({ callId: 'bw-out-1' });
    // Vonage
    if (url === 'https://api.nexmo.com/v1/calls' && method === 'POST') return ok({ uuid: 'vonage-out-1' });
    if (url.startsWith('https://rest.nexmo.com/number/search')) return ok({ numbers: [{ msisdn: d, cost: '0.90' }] });
    if (url.startsWith('https://rest.nexmo.com/account/get-balance')) return ok({ value: 10.5 });
    return ok({});
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await prisma.$disconnect();
});

const vonageKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type Kind = 'twilio' | 'signalwire' | 'plivo' | 'bandwidth' | 'vonage';

/** Per carrier: credentials, how its webhooks look, and what its REST calls look like. */
const CARRIERS: Record<Kind, {
  type: string;
  credentials: Record<string, string>;
  form: boolean;
  numbersApi: boolean;
  answer: (callId: string, from: string, to: string) => object;
  join: (legId: string) => object;
  status: (legId: string, caller: boolean) => object;
  recording: (callId: string) => object;
  outId: string;
  expectSpeak: (body: string) => void;
  expectHold: (body: string, room: string) => void;
  recordingAuth: RegExp | null;
}> = {
  twilio: {
    type: 'TWILIO',
    credentials: { accountSid: 'ACtest0001', authToken: 'tw_token' },
    form: true,
    numbersApi: true,
    answer: (id, from, to) => ({ CallSid: id, From: from, To: to, CallStatus: 'ringing' }),
    join: (id) => ({ CallSid: id, CallStatus: 'in-progress' }),
    status: (id) => ({ CallSid: id, CallStatus: 'completed' }),
    recording: (id) => ({ CallSid: id, RecordingUrl: 'https://recordings.example.com/RE1', RecordingStatus: 'completed' }),
    outId: 'twilio-out-1',
    expectSpeak: (b) => expect(b).toMatch(/<Say [^>]*>This call may be recorded.*<\/Say><Redirect method="POST">http:\/\/localhost:4000\/webhooks\/voice\/.+\/flow\?call=/),
    expectHold: (b, room) => expect(b).toContain(`<Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="">${room}</Conference>`),
    recordingAuth: /^Basic /,
  },
  signalwire: {
    type: 'SIGNALWIRE',
    credentials: { spaceUrl: 'acme.signalwire.com', projectId: 'proj-1', apiToken: 'PTsw' },
    form: true,
    numbersApi: true,
    answer: (id, from, to) => ({ CallSid: id, From: from, To: to }),
    join: (id) => ({ CallSid: id }),
    status: (id) => ({ CallSid: id, CallStatus: 'completed' }),
    recording: (id) => ({ CallSid: id, RecordingUrl: 'https://recordings.example.com/RE2', RecordingStatus: 'completed' }),
    outId: 'twilio-out-1',
    expectSpeak: (b) => expect(b).toContain('<Say voice="woman" language="en-US">'),
    expectHold: (b, room) => expect(b).toContain(`>${room}</Conference>`),
    recordingAuth: /^Basic /,
  },
  plivo: {
    type: 'PLIVO',
    credentials: { authId: 'MAPLIVO', authToken: 'pl_token', appId: 'app-77' },
    form: true,
    numbersApi: true,
    answer: (id, from, to) => ({ CallUUID: id, From: from.slice(1), To: to.slice(1), Direction: 'inbound' }),
    join: (id) => ({ CallUUID: 'plivo-call-1', RequestUUID: id, Direction: 'outbound' }),
    status: (id, caller) => (caller ? { CallUUID: id, Direction: 'inbound', HangupCause: 'NORMAL_CLEARING' } : { CallUUID: 'plivo-call-1', RequestUUID: id, Direction: 'outbound', HangupCause: 'NORMAL_CLEARING' }),
    recording: () => ({ RecordUrl: 'https://recordings.example.com/pl.mp3' }),
    outId: 'plivo-req-1',
    expectSpeak: (b) => expect(b).toMatch(/<Speak voice="WOMAN" language="en-US">This call may be recorded.*<\/Speak><Redirect method="POST">/),
    expectHold: (b, room) => expect(b).toContain(`endConferenceOnExit="false">${room}</Conference>`),
    recordingAuth: null,
  },
  bandwidth: {
    type: 'BANDWIDTH',
    credentials: { accountId: '9900', username: 'bw_user', password: 'bw_pass', applicationId: 'bw-app' },
    form: false,
    numbersApi: false,
    answer: (id, from, to) => ({ eventType: 'initiate', callId: id, from, to }),
    join: (id) => ({ eventType: 'answer', callId: id }),
    status: (id) => ({ eventType: 'disconnect', callId: id, cause: 'hangup' }),
    recording: (id) => ({ eventType: 'recordingAvailable', callId: id, mediaUrl: 'https://recordings.example.com/bw.wav' }),
    outId: 'bw-out-1',
    expectSpeak: (b) => expect(b).toMatch(/<SpeakSentence voice="julie">This call may be recorded.*<\/SpeakSentence><Redirect redirectUrl="[^"]+\/flow\?call=/),
    expectHold: (b, room) => expect(b).toContain(`<Conference>${room}</Conference>`),
    recordingAuth: /^Basic /,
  },
  vonage: {
    type: 'VONAGE',
    credentials: { applicationId: 'vonage-app-1', privateKey: vonageKey, apiKey: 'vn_key', apiSecret: 'vn_secret' },
    form: false,
    numbersApi: true,
    answer: (id, from, to) => ({ uuid: id, from: from.slice(1), to: to.slice(1), conversation_uuid: 'CON-1' }),
    join: (id) => ({ uuid: id }),
    status: (id) => ({ uuid: id, status: 'completed' }),
    recording: () => ({ recording_url: 'https://recordings.example.com/vn', conversation_uuid: 'CON-1' }),
    outId: 'vonage-out-1',
    expectSpeak: (b) => {
      const ncco = JSON.parse(b);
      expect(ncco[0]).toMatchObject({ action: 'talk', text: expect.stringContaining('recorded') });
      expect(ncco[1]).toMatchObject({ action: 'notify', eventUrl: [expect.stringContaining('/flow?call=')] });
    },
    expectHold: (b, room) => expect(JSON.parse(b)).toEqual([{ action: 'conversation', name: room, startOnEnter: true, endOnExit: false }]),
    recordingAuth: /^Bearer ey/,
  },
};

describe.each(Object.keys(CARRIERS) as Kind[])('%s', (kind) => {
  const k = CARRIERS[kind];

  it('buys a number, runs a whole call and saves the recording', async () => {
    offered = `+1415555013${Object.keys(CARRIERS).indexOf(kind)}`;
    const created = await admin.post('/admin/providers', { name: `${kind} main`, type: k.type, credentials: k.credentials, inboundPerMinute: 0.01, outboundPerMinute: 0.02 }).expect(201);
    const carrier = created.body as { id: string; webhookUrl: string; statusUrl: string };
    expect(carrier.webhookUrl).toMatch(new RegExp(`^http://localhost:4000/webhooks/voice/${carrier.id}/[A-Za-z0-9_-]{20,}/answer$`));
    const base = carrier.webhookUrl.replace(/\/answer$/, '').replace('http://localhost:4000', '');
    const hook = (path: string, body: object) => {
      const r = request(app.getHttpServer()).post(`${base}/${path}`);
      return k.form ? r.type('form').send(body as Record<string, string>) : r.send(body);
    };

    // Test connection
    const test = await admin.post(`/admin/providers/${carrier.id}/test`).expect(200);
    expect(test.body.ok).toBe(true);

    // A customer pinned to this carrier gets a number.
    const c = await signupTenant(app);
    await verifyEmail(app, c);
    const tenant = await prisma.tenant.update({ where: { subdomain: c.sub }, data: { walletBalance: 100, providerId: carrier.id } });
    const api = portal(app, c.sub, c.token);
    let numberId: string;
    if (k.numbersApi) {
      const found = await api.get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
      expect(found.body[0].e164).toBe(offered);
      hits.length = 0;
      const bought = await api.post('/numbers', { e164: offered }).expect(201);
      numberId = bought.body.id;
      const order = hits.find((h) => h.method === 'POST' && /IncomingPhoneNumbers|PhoneNumber\/\d+|number\/buy/.test(h.url))!;
      expect(order).toBeTruthy();
      if (kind === 'twilio' || kind === 'signalwire') expect(new URLSearchParams(order.body).get('VoiceUrl')).toBe(carrier.webhookUrl);
      if (kind === 'plivo') expect(JSON.parse(order.body)).toEqual({ app_id: 'app-77' });
      if (kind === 'vonage') expect(hits.some((h) => h.url.includes('/number/update') && h.body.includes('app_id=vonage-app-1'))).toBe(true);
    } else {
      const found = await api.get('/numbers/available?type=LOCAL').expect(502);
      expect(found.body.message).toContain('added by the platform team');
      const added = await admin.post(`/admin/tenants/${tenant.id}/numbers`, { e164: offered, providerId: carrier.id, type: 'LOCAL', monthlyPrice: 2 }).expect(201);
      numberId = added.body.id;
    }
    const number = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: numberId } });
    expect(number).toMatchObject({ provider: kind, providerId: carrier.id, status: 'ACTIVE' });

    const camp = await api.post('/campaigns', { name: `${kind} campaign`, revenue: 10 }).expect(201);
    const buyer = await api.post('/buyers', { name: `${kind} buyer`, destination: '+12125550177' }).expect(201);
    await api.post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id }).expect(201);
    await api.patch(`/numbers/${numberId}`, { campaignId: camp.body.id }).expect(200);

    // Wrong token → refused.
    await request(app.getHttpServer()).post(base.replace(/\/[^/]+$/, '/not-the-token') + '/answer').send({}).expect(403);

    // 1) Call arrives: the answer is the recording notice, then "tell me when it ended".
    const callerId = `${kind}-in-1`;
    const room = `vr-${callerId}`;
    const answer = await hook('answer', k.answer(callerId, '+15125550100', offered)).expect(200);
    k.expectSpeak(answer.text);

    // 2) Notice finished: the buyer is dialed and the caller waits in their room.
    hits.length = 0;
    const flow = await request(app.getHttpServer()).post(`${base}/flow?call=${callerId}`).send({}).expect(200);
    k.expectHold(flow.text, room);
    const dial = hits.find((h) => h.method === 'POST' && /Calls\.json$|\/Call\/$|\/calls$/.test(h.url))!;
    expect(decodeURIComponent(dial.body)).toContain(`/join?room=${room}`);
    expect(decodeURIComponent(dial.body)).toContain('12125550177');

    // 3) Buyer answers: joins the caller's room, and recording starts.
    hits.length = 0;
    const join = await hook(`join?room=${room}`, k.join(k.outId)).expect(200);
    k.expectHold(join.text, room);
    expect(hits.length).toBeGreaterThan(0); // recording started (REST or re-join with recording)
    const call = await prisma.call.findFirstOrThrow({ where: { telnyxCallId: callerId } });
    expect(call.status).toBe('IN_PROGRESS');

    // 4) Caller hangs up: the buyer's leg is hung up through the carrier's API.
    hits.length = 0;
    await hook('status', k.status(callerId, true)).expect(200);
    expect(hits.some((h) => (h.url.includes(k.outId) || h.url.includes('plivo-call-1')) && /POST|PUT|DELETE/.test(h.method))).toBe(true);
    await hook('status', k.status(k.outId, false)).expect(200);

    const done = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', provider: kind, providerId: carrier.id });

    // 5) Recording is ready: downloaded (with the carrier's credentials when it needs them).
    hits.length = 0;
    await hook(`recording?call=${callerId}`, k.recording(callerId)).expect(200);
    const recorded = await waitFor(() => prisma.call.findUniqueOrThrow({ where: { id: call.id } }), (c) => !!c.recordingUrl);
    const download = hits.find((h) => h.url.startsWith('https://recordings.example.com/'))!;
    expect(download).toBeTruthy();
    if (k.recordingAuth) expect(download.auth).toMatch(k.recordingAuth);
    expect(recorded.recordingUrl).toMatch(new RegExp(`^recordings/${tenant.id}/${call.id}\\.(mp3|wav)$`));
  });
});

describe('Markup carriers: setup rules', () => {
  it('requires each carrier’s credentials, hides secrets, and rotates the webhook token', async () => {
    await admin.post('/admin/providers', { name: 'No SID', type: 'TWILIO', credentials: { authToken: 'x' } }).expect(400);
    await admin.post('/admin/providers', { name: 'No key', type: 'VONAGE', credentials: { applicationId: 'a' } }).expect(400);
    const p = await admin.post('/admin/providers', { name: 'Twilio two', type: 'TWILIO', credentials: { accountSid: 'ACsecond', authToken: 'super_secret_token' } }).expect(201);
    expect(p.body).toMatchObject({ settings: { accountSid: 'ACsecond' }, credentialHint: 'ACs…cond' });
    expect(p.body.secretsSet).toContain('authToken');
    expect(JSON.stringify(p.body)).not.toContain('super_secret_token');

    const rotated = await admin.post(`/admin/providers/${p.body.id}/rotate-secret`).expect(200);
    expect(rotated.body.answerUrl).not.toBe(p.body.webhookUrl);
    const oldBase = (p.body.webhookUrl as string).replace('http://localhost:4000', '');
    await request(app.getHttpServer()).post(oldBase).type('form').send({ CallSid: 'x', From: '+1', To: '+2' }).expect(403);
  });

  it('a bad Vonage key is reported by Test connection', async () => {
    const p = await admin.post('/admin/providers', { name: 'Vonage bad', type: 'VONAGE', credentials: { applicationId: 'app', privateKey: 'not a pem' } }).expect(201);
    const res = await admin.post(`/admin/providers/${p.body.id}/test`).expect(200);
    expect(res.body).toEqual({ ok: false, message: 'The Vonage private key is not a valid PEM key' });
  });
});
