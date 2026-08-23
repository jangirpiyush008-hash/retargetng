# 12 — Runbook

## Local development (no Docker)

```bash
scripts/local-infra.sh start          # Homebrew Postgres 16 + Redis (creates aap / aap_test)
cp .env.example .env                  # defaults work for local
pnpm install
pnpm db:reset                         # schema
pnpm db:seed -- --quick               # 50k customers / 500k events (≈ 1 min); omit --quick for 1M / 10M
pnpm dev:worker                       # queue consumers + scheduler (:9464/health, /metrics)
pnpm dev:web                          # http://localhost:3000  (admin@demo.aap / Admin12345!)
```
With Docker: `docker compose up -d` instead of the first line.

## Environment

| Var | Purpose |
|---|---|
| `DATABASE_URL` / `TEST_DATABASE_URL` | Postgres |
| `REDIS_URL` | optional; switches the queue to BullMQ |
| `PII_ENCRYPTION_KEYS` | `kid:hex32[,kid2:hex32]` — first is active; rotate by prepending |
| `SESSION_SECRET` | cookie session signing |
| `DESTINATION_MODE` | `mock` (default) or `live` |
| `SECRET_STORE` | `db` (encrypted rows, default) · `env` · `memory` |
| `WORKER_CONCURRENCY`, `WORKER_PORT`, `SCHEDULER_INTERVAL_MS` | worker tuning |

## Going live with real destinations

1. `DESTINATION_MODE=live` on the worker and web.
2. Destinations → Connect → paste the Meta system-user token (scope `ads_management`) / Google OAuth JSON + developer token.
   The credential goes to the SecretStore; the DB keeps a reference only.
3. Test connection → select accounts → Validate (TOS/permissions).
4. Audience → Activate → **Dry run** → review funnel → **ACTIVATE AUDIENCE**.
5. Watch Sync Jobs; failures are classified (RATE_LIMITED/TRANSIENT retried; AUTH_EXPIRED pauses and flags the destination).

## Operations

* **Queue stuck?** `GET :9464/stats`; dead jobs: `SELECT * FROM job_queue WHERE status='DEAD'`; re-enqueue by `UPDATE job_queue SET status='PENDING', attempts=0 WHERE id=…`.
* **Reconcile an audience**: `POST /api/v1/audiences/:id/evaluate {"mode":"RECONCILE"}` (weekly safety net runs automatically).
* **Re-sync from scratch**: `POST /api/v1/audiences/:id/sync {"mode":"FULL"}`.
* **Rotate PII key**: `PII_ENCRYPTION_KEYS=v2:…,v1:…`; new writes use v2; old rows decrypt with v1; a lazy re-encrypt sweep can be added using `PiiCipher.kidOf`.
* **Retention** runs daily; adjust per org in Settings → Retention.
* **Partitions** for the next 3 months are created daily (`ensure_monthly_partitions`).
* **Health**: web `/api/v1/health`, `/api/v1/ready`, `/api/v1/metrics`; worker `/health`, `/ready`, `/metrics` (Prometheus text).

## Deploy to Railway (or any container host)

One repo, **two services** + Postgres (+ optional Redis):

| Service | Root | Build | Start | Health |
|---|---|---|---|---|
| `web` | repo root | `pnpm install --frozen-lockfile && pnpm --filter @aap/web build` (from `railway.json`) | `pnpm start` → runs migrations, then `next start` on `$PORT` | `/api/v1/health` |
| `worker` | repo root (override start command) | same install (no build) | `pnpm start:worker` → migrations, then the worker on `$PORT` | `/health` |

Environment variables for both services: `DATABASE_URL` (Railway Postgres; append `?sslmode=require` when using the public host),
`PII_ENCRYPTION_KEYS` (`v1:<64 hex>` — generate with `openssl rand -hex 32`), `SESSION_SECRET`, `DESTINATION_MODE` (`mock` until
real credentials are connected), `SECRET_STORE=db`, `NODE_ENV=production`, optional `REDIS_URL`.
Seed a demo org from the worker shell once: `pnpm db:seed -- --quick`.
