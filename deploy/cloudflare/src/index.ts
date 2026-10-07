/**
 * ViaRoute on Cloudflare Containers.
 *
 *   browser / carrier ──► this Worker (viaroute.co, *.viaroute.co; www → viaroute.co)
 *                           ├─ /api/*  ──► Api pool   (APP_ROLE=api,    NestJS on :4000, "/api" removed)
 *                           └─ else    ──► Web pool   (Next.js on :3000)
 *   cron (every minute) ──► Jobs       (APP_ROLE=worker: postbacks, recordings, renewals, clean-up)
 *                       └─► keeps every Api/Web instance warm (carrier webhooks must not wait for a cold start)
 *
 * Postgres, Redis and the recordings bucket (R2) are outside; containers reach them over the internet.
 */
import { Container } from '@cloudflare/containers';

export interface Env {
  API: DurableObjectNamespace<Api>;
  WEB: DurableObjectNamespace<Web>;
  JOBS: DurableObjectNamespace<Jobs>;
  /** How many Api / Web instances share the traffic (fixed pools: Containers have no autoscaling yet). */
  API_INSTANCES: string;
  WEB_INSTANCES: string;
  // Everything else (vars + secrets) is handed to the app containers, see APP_SETTINGS.
  [key: string]: unknown;
}

/** Settings the app reads (wrangler vars and secrets); only these are passed into the containers. */
const APP_SETTINGS = [
  'APP_DOMAIN', 'PORTAL_DOMAIN', 'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'ENCRYPTION_KEY', 'JWT_EXPIRES_IN',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SMTP_URL', 'MAIL_FROM',
  'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_CONNECTION_ID', 'SIMULATOR_ENABLED',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'TRIAL_DAYS', 'NUMBER_PRICE_LOCAL', 'NUMBER_PRICE_TOLL_FREE', 'POSTBACK_CONCURRENCY', 'RECORDING_CONCURRENCY',
] as const;

function appEnv(env: Env, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { NODE_ENV: 'production', ...extra };
  for (const k of APP_SETTINGS) if (typeof env[k] === 'string' && env[k] !== '') out[k] = env[k] as string;
  return out;
}

/** Containers that never go to sleep on their own: a cold start would make callers wait. */
abstract class AlwaysOn extends Container<Env> {
  sleepAfter = '1h';
  enableInternet = true; // Postgres, Redis, R2, carriers, publisher postbacks

  // Not stopping here keeps the instance running (the platform may still restart it; the cron restarts it then).
  override async onActivityExpired() {}

  override onError(error: unknown) {
    console.error(`${this.constructor.name} container error:`, error);
    throw error;
  }
}

/** NestJS API (browsers + carrier webhooks). */
export class Api extends AlwaysOn {
  defaultPort = 4000;
  pingEndpoint = 'container/health';
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // One proxy hop in front of the API: this Worker (it sets X-Forwarded-For to the visitor's IP).
    this.envVars = appEnv(env, { APP_ROLE: 'api', API_PORT: '4000', TRUST_PROXY_HOPS: '1', STORAGE_DIR: '/app/storage' });
  }
}

/** Background work: queues and timers. Nothing calls it except the cron, which keeps it running. */
export class Jobs extends AlwaysOn {
  defaultPort = 4000;
  pingEndpoint = 'container/health';
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = appEnv(env, { APP_ROLE: 'worker', API_PORT: '4000', STORAGE_DIR: '/app/storage' });
  }
}

/** Next.js web app (all portals). Its settings are baked in at build time (image_vars). */
export class Web extends AlwaysOn {
  defaultPort = 3000;
  pingEndpoint = 'container/login';
  enableInternet = false; // pages only; the browser talks to /api itself
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = { NODE_ENV: 'production', PORT: '3000', HOSTNAME: '0.0.0.0' };
  }
}

const count = (v: string, fallback: number) => Math.max(1, Number(v) || fallback);
const instance = <T extends Container<Env>>(ns: DurableObjectNamespace<T>, i: number) => ns.get(ns.idFromName(`instance-${i}`));
const pick = <T extends Container<Env>>(ns: DurableObjectNamespace<T>, n: number) => instance(ns, Math.floor(Math.random() * n));

/** Forwards the visitor's request; the app sees the real client IP and the https scheme. */
function forward(request: Request, path?: string): Request {
  const url = new URL(request.url);
  if (path !== undefined) url.pathname = path;
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') ?? ''); // replace, never trust a client value
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Forwarded-Host', url.host);
  return new Request(url, new Request(request, { headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // One address for the main site: www.viaroute.co → viaroute.co.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    // Same layout as the one-port Docker gateway: /api/auth/login → API /auth/login.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(4) || '/';
      return pick(env.API, count(env.API_INSTANCES, 2)).fetch(forward(request, path));
    }
    return pick(env.WEB, count(env.WEB_INSTANCES, 2)).fetch(forward(request));
  },

  /** Every minute: start the background worker if it isn't running, and keep the Api/Web pools warm. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const ping = async (name: string, stub: { fetch(r: Request): Promise<Response> }, path: string) => {
      try {
        const res = await stub.fetch(new Request(`http://container${path}`));
        if (!res.ok) console.warn(`${name}: ${path} answered ${res.status}`);
      } catch (e) {
        console.error(`${name}: ${(e as Error).message}`);
      }
    };
    const pings = [ping('jobs', instance(env.JOBS, 0), '/health')];
    for (let i = 0; i < count(env.API_INSTANCES, 2); i++) pings.push(ping(`api-${i}`, instance(env.API, i), '/health'));
    for (let i = 0; i < count(env.WEB_INSTANCES, 2); i++) pings.push(ping(`web-${i}`, instance(env.WEB, i), '/login'));
    ctx.waitUntil(Promise.all(pings));
  },
} satisfies ExportedHandler<Env>;
