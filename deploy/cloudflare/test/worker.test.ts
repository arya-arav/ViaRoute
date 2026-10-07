// Run: pnpm --filter @viaroute/cloudflare test
import assert from 'node:assert/strict';
import worker, { Api, Jobs, Web, type Env } from '../src/index';

type Hit = { ns: string; name: string; req: Request };
const hits: Hit[] = [];
const ns = (name: string) => ({
  idFromName: (n: string) => n,
  get: (id: string) => ({ fetch: async (req: Request) => (hits.push({ ns: name, name: id, req }), new Response('ok')) }),
});
const env = {
  API: ns('API'), WEB: ns('WEB'), JOBS: ns('JOBS'), API_INSTANCES: '3', WEB_INSTANCES: '2',
  APP_DOMAIN: 'viaroute.co', DATABASE_URL: 'postgres://db', JWT_SECRET: 's', S3_BUCKET: '',
  CLOUDFLARE_API_TOKEN: 'must-not-leak',
} as unknown as Env;

async function run() {
  // /api/* goes to the API without the /api prefix; visitor IP replaces any client-sent value.
  const body = JSON.stringify({ email: 'a@b.c' });
  await worker.fetch(new Request('https://acme.viaroute.co/api/auth/login?x=1', {
    method: 'POST', body, headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '6.6.6.6', 'X-Tenant-Host': 'acme.viaroute.co' },
  }), env);
  let h = hits.pop()!;
  assert.equal(h.ns, 'API');
  assert.match(h.name, /^instance-[0-2]$/);
  const u = new URL(h.req.url);
  assert.equal(u.host, 'acme.viaroute.co');
  assert.equal(u.pathname + u.search, '/auth/login?x=1');
  assert.equal(h.req.method, 'POST');
  assert.equal(await h.req.text(), body);
  assert.equal(h.req.headers.get('X-Forwarded-For'), '203.0.113.9');
  assert.equal(h.req.headers.get('X-Forwarded-Proto'), 'https');
  assert.equal(h.req.headers.get('X-Tenant-Host'), 'acme.viaroute.co');

  // Bare /api → API "/".
  await worker.fetch(new Request('https://viaroute.co/api'), env);
  assert.equal(new URL(hits.pop()!.req.url).pathname, '/');

  // Pages (and look-alikes such as /apiary) go to the web app unchanged.
  for (const path of ['/login', '/apiary', '/']) {
    await worker.fetch(new Request(`https://viaroute.co${path}`), env);
    h = hits.pop()!;
    assert.equal(h.ns, 'WEB', path);
    assert.match(h.name, /^instance-[01]$/);
    assert.equal(new URL(h.req.url).pathname, path);
  }

  // www → the main site, same path, nothing reaches the containers.
  const www = await worker.fetch(new Request('https://www.viaroute.co/signup?ref=x'), env);
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('Location'), 'https://viaroute.co/signup?ref=x');
  assert.equal(hits.length, 0);

  // Cron: background worker + every API and web instance.
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext);
  await Promise.all(waits);
  const pinged = hits.splice(0).map((x) => `${x.ns}:${x.name}:${new URL(x.req.url).pathname}`).sort();
  assert.deepEqual(pinged, [
    'API:instance-0:/health', 'API:instance-1:/health', 'API:instance-2:/health',
    'JOBS:instance-0:/health', 'WEB:instance-0:/login', 'WEB:instance-1:/login',
  ]);

  // Containers get only the app's settings, plus their role; empty values are left out.
  const api = new Api({} as never, env);
  assert.equal(api.envVars.APP_ROLE, 'api');
  assert.equal(api.envVars.TRUST_PROXY_HOPS, '1');
  assert.equal(api.envVars.DATABASE_URL, 'postgres://db');
  assert.equal(api.envVars.APP_DOMAIN, 'viaroute.co');
  assert.equal('S3_BUCKET' in api.envVars, false);
  assert.equal('CLOUDFLARE_API_TOKEN' in api.envVars, false);
  assert.equal(new Jobs({} as never, env).envVars.APP_ROLE, 'worker');
  const web = new Web({} as never, env);
  assert.equal(web.enableInternet, false);
  assert.equal('DATABASE_URL' in web.envVars, false);
  assert.equal(api.sleepAfter, '1h');

  console.log('worker tests passed');
}
run().catch((e) => { console.error(e); process.exit(1); });
