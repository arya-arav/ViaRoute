# ViaRoute on Cloudflare Containers

```
browser / carrier ─► Worker "viaroute"  (viaroute.psoni.in + *.psoni.in)
                       ├─ /api/*  ─► Api   ×2  standard-1 (½ vCPU, 4 GiB)   APP_ROLE=api
                       └─ pages   ─► Web   ×2  basic      (¼ vCPU, 1 GiB)   Next.js
cron (every minute) ─► Jobs  ×1  basic   APP_ROLE=worker (postbacks, recordings, renewals, clean-up)
                    └─ keeps every Api/Web instance warm

Outside Cloudflare's containers: Postgres (managed), Redis (managed), recordings in R2.
```

All containers run in **US East** (`ENAM`), next to the database. Container disks are wiped on every restart,
so recordings must go to R2 and every secret must be set (nothing is generated on first start here).

## What you need

| Item | Notes |
|---|---|
| Cloudflare **Workers Paid** plan | $5/month; Containers need it |
| Domain on Cloudflare | `psoni.in` (zone in the same account) |
| Managed **Postgres 17** | US East, e.g. Neon, DigitalOcean, or PlanetScale Postgres (billed via Cloudflare) |
| Managed **Redis** | US East, fixed-price plan (BullMQ polls constantly; avoid pay-per-command). TLS URL `rediss://…` |
| **R2** bucket | `viaroute-recordings` + an R2 API token (Object Read & Write) |
| **SMTP** | e.g. Resend — sign-up, invite and password emails (there is no test inbox here) |
| Docker running locally | `wrangler deploy` builds the images (on Windows: Docker Desktop) |

## DNS (Cloudflare → psoni.in → DNS)

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `*` | `192.0.2.1` | 🟠 Proxied |

`viaroute.psoni.in` is created automatically (custom domain). The `*` record only has to exist and be proxied;
the Worker answers, the address is never used. Delete any old records for `viaroute`, `acme` or `*` first.

> **Other sites on psoni.in:** the route `*.psoni.in/*` catches every proxied subdomain. Subdomains with their own
> DNS record keep resolving, but proxied ones are answered by this Worker — add a more specific route for them, or
> host ViaRoute on a domain of its own.

## First deploy

```bash
pnpm install
cd deploy/cloudflare
npx wrangler login

# Secrets (each command asks for the value)
npx wrangler secret put DATABASE_URL          # postgresql://user:pass@host:5432/viaroute?sslmode=require
npx wrangler secret put REDIS_URL             # rediss://default:pass@host:port
npx wrangler secret put JWT_SECRET            # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npx wrangler secret put ENCRYPTION_KEY        # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  (64 chars)
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD        # 12+ characters
npx wrangler secret put SMTP_URL              # smtps://resend:API_KEY@smtp.resend.com:465
npx wrangler secret put S3_BUCKET             # viaroute-recordings
npx wrangler secret put S3_ENDPOINT           # https://<account id>.r2.cloudflarestorage.com
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
# Later: TELNYX_API_KEY, TELNYX_PUBLIC_KEY, TELNYX_CONNECTION_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

pnpm run deploy    # builds api + web images, pushes them, deploys the Worker
```

The first deploy takes several minutes before containers answer. Then:

- `https://viaroute.psoni.in/api/health` → `{"ok":true,…}`
- `https://viaroute.psoni.in/login` → admin login (ADMIN_EMAIL / ADMIN_PASSWORD)
- `npx wrangler tail` → live logs; Cloudflare dashboard → Workers & Pages → viaroute → Containers

Database migrations run automatically when the API starts.

## Updating

`pnpm run deploy` again. The Worker switches first; containers roll over gradually (each gets SIGTERM and up to
15 minutes to finish). A changed secret reaches a container on its next start (`pnpm run deploy` restarts them).

## Sizing

| | Setting | Where |
|---|---|---|
| More API capacity | `API_INSTANCES` (and `max_instances` ≥ it + 2 for rollouts) | `wrangler.jsonc` |
| More web capacity | `WEB_INSTANCES` | `wrangler.jsonc` |
| Bigger machines | `instance_type`: `basic` → `standard-1` … `standard-4` (4 vCPU, 12 GiB) | `wrangler.jsonc` |
| Faster background work | `POSTBACK_CONCURRENCY`, `RECORDING_CONCURRENCY` (vars) | `wrangler.jsonc` |

Rough cost of this layout (always on, US): ~$100/month for the containers (2× standard-1, 3× basic) + $5 Workers Paid +
small Durable Object/request charges, plus Postgres, Redis and R2.

## Tests

`pnpm --filter @viaroute/cloudflare test` checks the Worker's routing, headers, cron and container settings.
Running the containers locally (`wrangler dev`) needs Linux/macOS or WSL with Docker.
