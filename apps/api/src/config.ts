import { config as loadEnv } from 'dotenv';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

loadEnv({ path: resolve(__dirname, '../../../.env'), quiet: true });

const GENERATED: Record<string, () => string> = {
  JWT_SECRET: () => randomBytes(48).toString('hex'),
  ENCRYPTION_KEY: () => randomBytes(32).toString('hex'),
};

/**
 * With SECRETS_DIR set (one-port Docker setup), secrets missing from the environment are generated
 * once and kept in that folder (a Docker volume), so the app starts with no configuration.
 */
function generatedSecret(name: string): string | undefined {
  const dir = process.env.SECRETS_DIR;
  if (!dir || !GENERATED[name]) return undefined;
  const file = join(dir, 'secrets.json');
  const saved: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!saved[name]) {
    saved[name] = GENERATED[name]();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  return saved[name];
}

/** "*https://App.example.com/ " → "app.example.com" (people paste URLs, quotes, stars and spaces). */
export function cleanDomain(v: string | undefined): string {
  return (v ?? '').trim().replace(/^["'*]+|["']$/g, '').replace(/^[a-z]+:\/\//i, '').replace(/^\*?\./, '').replace(/[/?#].*$/, '').toLowerCase();
}

/** One-port platforms (xCloud, Coolify) set APP_DOMAIN; the other addresses follow from it. */
const appDomain = cleanDomain(process.env.APP_DOMAIN);
/** Optional: customer portals under another domain than the main site (main viaroute.psoni.in, portals acme.psoni.in). */
const portalDomain = cleanDomain(process.env.PORTAL_DOMAIN);
const rootDomain = portalDomain || appDomain || cleanDomain(process.env.ROOT_DOMAIN) || 'localhost';

function required(name: string): string {
  const v = process.env[name] || generatedSecret(name);
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  /** Customer portals are <subdomain>.rootDomain. */
  rootDomain,
  /** Host of the main site (sign-up, Super Admin); the same as rootDomain unless PORTAL_DOMAIN is set. */
  mainHost: appDomain || rootDomain,
  webOrigin: appDomain ? `https://${appDomain}` : (process.env.WEB_ORIGIN ?? 'http://localhost:3000'),
  /** Public URL of this API (for carrier webhook URLs), e.g. https://api.yourdomain.com */
  apiOrigin: (appDomain ? `https://${appDomain}/api` : process.env.API_ORIGIN ?? `http://localhost:${process.env.API_PORT ?? 4000}`).replace(/\/$/, ''),
  smtpUrl: process.env.SMTP_URL ?? 'smtp://localhost:1025',
  mailFrom: process.env.MAIL_FROM ?? 'ViaRoute <no-reply@viaroute.local>',
  encryptionKey: required('ENCRYPTION_KEY'),
  telnyxApiKey: process.env.TELNYX_API_KEY ?? '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  trialDays: Number(process.env.TRIAL_DAYS ?? 14),
  /** Base64 public key for verifying webhooks (Telnyx portal → Keys & Credentials → Public Key). */
  telnyxPublicKey: process.env.TELNYX_PUBLIC_KEY ?? '',
  /** Telnyx Call Control application that new numbers are attached to (Module 5). */
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID ?? '',
  /** What customers pay per number per month (the carrier's cost must be lower). */
  numberPrice: {
    LOCAL: Number(process.env.NUMBER_PRICE_LOCAL ?? 2),
    TOLL_FREE: Number(process.env.NUMBER_PRICE_TOLL_FREE ?? 3),
  },
  /** Customers point their custom domain here with a CNAME record. */
  customDomainTarget: (process.env.CUSTOM_DOMAIN_TARGET || (appDomain || `domains.${rootDomain}`)).toLowerCase(),
  /**
   * Single-domain hosting (one-port setup): an address that is no portal opens the main site
   * instead of "Portal not found", so a platform-assigned domain works even if APP_DOMAIN is off.
   */
  unknownHostIsMainSite: process.env.UNKNOWN_HOST_IS_MAIN_SITE === 'true',
};

/**
 * What this process does (APP_ROLE):
 * - all     one process does everything (default: single server, development, tests)
 * - api     answers browsers and carrier webhooks; background work only goes onto the queues
 * - worker  no web traffic; runs the queues (postbacks, recordings) and timers (renewals, clean-up)
 * Run any number of each against the same database and Redis.
 */
export type AppRole = 'all' | 'api' | 'worker';
export const appRole: AppRole = (() => {
  const r = (process.env.APP_ROLE ?? 'all').trim().toLowerCase();
  if (r !== 'all' && r !== 'api' && r !== 'worker') throw new Error(`APP_ROLE must be all, api or worker (got "${r}")`);
  return r;
})();
/** This process works the background queues and timers. */
export const runsJobs = appRole !== 'api';

/** Subdomains customers can never claim. */
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'app', 'api', 'admin', 'staging', 'status', 'mail', 'docs', 'help', 'support', 'billing', 'static', 'cdn',
]);
// The main site itself can live under the portal domain (viaroute.psoni.in) — nobody may claim that name.
if (config.mainHost.endsWith(`.${config.rootDomain}`)) RESERVED_SUBDOMAINS.add(config.mainHost.slice(0, -(config.rootDomain.length + 1)));

/** Usage price per minute when neither the plan nor the customer sets one. */
export const DEFAULT_PER_MINUTE = 0.025;

/** Public URL of a portal: the tenant's own domain/subdomain, or the main site. */
export function portalOrigin(
  tenant: { subdomain: string; customDomain?: string | null; customDomainVerifiedAt?: Date | null } | null,
): string {
  const web = new URL(config.webOrigin);
  if (!tenant) return web.origin;
  // Custom domains always use HTTPS (Caddy issues the certificate).
  if (tenant.customDomain && tenant.customDomainVerifiedAt) return `https://${tenant.customDomain}`;
  const base = portalDomain ? config.rootDomain : web.host;
  return `${web.protocol}//${tenant.subdomain}.${base}`;
}
