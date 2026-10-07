import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup';

export async function createApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(mod.createNestApplication<NestExpressApplication>({ rawBody: true }));
  await app.init();
  return app;
}

/** Wipes all data between test files and re-creates the plans. */
export async function resetDb() {
  if (!process.env.REDIS_URL?.endsWith('/1')) throw new Error('Tests must use the test Redis database');
  const redis = new Redis(process.env.REDIS_URL);
  await redis.flushdb(); // test Redis DB only: live call state, caps, quotes, queues
  await redis.quit();
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuthToken","AuditLog","Postback","Call","Route","PhoneNumber","Buyer","Publisher","Campaign","Transaction","User","Tenant","Plan","TenantNote","Provider","GlobalBlock","PlatformSetting" CASCADE',
  );
  await prisma.plan.createMany({
    data: [
      { code: 'starter', name: 'Starter', monthlyPrice: 99, perMinuteRate: 0.025, includedNumbers: 2, maxUsers: 3 },
      { code: 'pro', name: 'Pro', monthlyPrice: 299, perMinuteRate: 0.02, includedNumbers: 25, maxUsers: 10, whiteLabel: true },
    ],
  });
}

/** Unique suffix so repeated runs never collide (also in the shared Mailpit inbox). */
export const uid = () => Math.random().toString(36).slice(2, 8);

/** API client acting as a given portal host, e.g. portal(app, 'acme') or portal(app, null) for the main site. */
export function portal(app: INestApplication, subdomain: string | null, token?: string) {
  const host = subdomain ? `${subdomain}.localhost:3000` : 'localhost:3000';
  const agent = request(app.getHttpServer());
  const wrap = (r: request.Test) => {
    r.set('X-Tenant-Host', host);
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r;
  };
  return {
    get: (url: string) => wrap(agent.get(url)),
    post: (url: string, body?: object) => wrap(agent.post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => wrap(agent.patch(url)).send(body ?? {}),
    put: (url: string, body?: object) => wrap(agent.put(url)).send(body ?? {}),
    delete: (url: string) => wrap(agent.delete(url)),
  };
}

/** Signs up a new tenant and returns a logged-in session on its portal. */
export async function signupTenant(app: INestApplication, sub = `t${uid()}`) {
  const email = `owner@${sub}.test`;
  const res = await portal(app, null)
    .post('/auth/signup', { companyName: `Co ${sub}`, subdomain: sub, name: 'Owner Person', email, password: 'Password123' })
    .expect(201);
  const login = await portal(app, sub).post('/auth/handoff', { handoffToken: res.body.redirect.handoffToken }).expect(200);
  return { sub, email, password: 'Password123', token: login.body.token as string };
}

/** Reads the newest email sent to `to` from Mailpit and returns the `#t=` token in its link. */
export async function tokenFromEmail(to: string, path: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const search = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((r) => r.json());
    for (const summary of search.messages ?? []) {
      // newest first
      const msg = await fetch(`http://localhost:8025/api/v1/message/${summary.ID}`).then((r) => r.json());
      const m = (msg.Text as string).match(new RegExp(`${path}#t=([A-Za-z0-9_-]+)`));
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No ${path} email found for ${to}`);
}

/** Confirms the tenant owner's email via the real verification link. */
export async function verifyEmail(app: INestApplication, t: { sub: string; email: string }) {
  const token = await tokenFromEmail(t.email, '/verify-email');
  await portal(app, t.sub).post('/auth/verify-email', { token }).expect(200);
}

/** Polls until `ok(value)` (background jobs such as the recording copy finish shortly after a webhook). */
export async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  let v = await get();
  while (!ok(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    v = await get();
  }
  return v;
}
