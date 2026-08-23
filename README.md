# Audience Activation Platform (AAP)

Production-grade **first-party audience activation & retargeting** platform: segment a 50M+ customer
database continuously, apply consent and suppression automatically, and keep audiences synchronized
to **Meta Custom Audiences** and **Google Ads Customer Match** (Data Manager API) with delta sync —
measured with first-party holdouts. Provider-agnostic (`DestinationAdapter`) so more platforms can
be added without touching the audience engine.

```
Connect data → define audience (no-code) → preview → activate → stay in sync → measure
```

* **Docs**: `docs/01-architecture.md` … `docs/12-runbook.md` (architecture, schema, folder structure, API,
  rule engine, data flow, security, scaling, Meta, Google, testing, runbook).
* **Stack**: Next.js 15 · React 19 · TypeScript · Tailwind · shadcn-style UI · Recharts · Node 22 worker ·
  PostgreSQL 16 (Kysely) · Postgres-backed queue (BullMQ optional) · pino · vitest.

## Runs with zero configuration (demo mode)

If no `DATABASE_URL` is set, the app starts an **embedded PostgreSQL** (PGlite — real Postgres compiled
to WASM, in-process), applies the migrations, seeds a demo organization and runs the background engine
inside the same process. One container, no database service, fully working dashboard:

```bash
pnpm install && pnpm --filter @aap/web build && pnpm start   # → http://localhost:3000, admin@demo.aap / Admin12345!
```

`DEMO_SEED=tiny` (default) seeds 2k customers in seconds; `quick` = 50k, `full` = 1M, `off` = empty.
Demo data lives in the container (`EMBEDDED_DB_DIR`, default `./.pgdata-embedded`) and is lost on redeploy.
Set `DATABASE_URL` to a managed Postgres for anything persistent or multi-process, and `EMBEDDED_DB=off`
to make a missing database a hard error.

## Quick start

```bash
scripts/local-infra.sh start        # or: docker compose up -d
cp .env.example .env && pnpm install
pnpm db:reset && pnpm db:seed -- --quick      # synthetic data (never real PII)
pnpm dev:worker &                             # http://localhost:9464/health
pnpm dev:web                                  # http://localhost:3000
```
Login: `admin@demo.aap / Admin12345!` (also marketer@ / analyst@ / viewer@ — see seed output).
Full-scale demo: `pnpm db:seed -- --reset` (1M customers, 10M events).

## What is implemented (MVP scope, end-to-end)

| Area | Highlights |
|---|---|
| Ingestion | `POST /api/v1/events` (11 event types, zod-validated, idempotent, PII encrypted+hashed before storage), `POST /api/v1/customers`, COPY-based bulk generator |
| Identity | canonical `customer_id`, SHA-256 per destination hash profile (Meta/Google normalization), identity history, no auto-merge |
| Consent & privacy | consent reducer, configurable compliance policies (TS ≡ SQL), global suppression with hash tombstones, deletion workflow, PII-redacting logs, RBAC (6 roles), audit log, encrypted secret store, API keys |
| Audience engine | no-code rule AST → parameterized SQL, AND/OR/NOT nesting, product/category/behavior/time/value/membership/custom fields, 15 templates + standard recency windows, exclusions, priority, holdout |
| Membership engine | diff-based FULL/RECONCILE + **incremental candidate evaluation** (dirty ∪ time-boundary crossers ∪ dependency feed), history feed, daily stats |
| Distribution | eligibility funnel → delta (ADD/REMOVE) → ≤10k batches → checkpointed, retried, resumable sync jobs; dry run; pause/resume/remove; suppression sweep; match-rate reporting |
| Destinations | `MockMetaAdapter`, `MockGoogleAdapter` (default), `MetaAdapter` (Graph v25), `GoogleAdsAdapter` (UserList via Google Ads API + members via Data Manager API) |
| Worker | queue consumers, scheduler (due evaluations/syncs, lifecycle time transitions, priority, suppression sweep, daily retention/quality/holdout rollups, weekly reconcile), `/health /ready /metrics` |
| Dashboard | Dashboard, Customers (+ data quality, lifecycle), Audiences (list/detail/builder/activate dialog), Destinations, Sync Jobs, Campaigns, Analytics (+ holdout incrementality), Suppression, Consent, Settings, Audit Logs; dark/light |
| Tests | 46 tests across identity, rules, consent, lifecycle, events, membership, distribution — all against real Postgres |

## Verified at scale (synthetic 1M customers / 10M events, 8 GB laptop, Homebrew Postgres 16)

| Operation | Result |
|---|---|
| Data load (COPY) | 1,000,000 customers · 1,533,846 orders · 10,000,050 events · ~3.5M cart events in 32 min; DB ≈ 13 GB |
| FULL evaluation of an audience over 1M customers | 0.4 s (cart windows) – 20 s (DORMANT_60D, 486,762 members) – 42 s (HIGH_AOV, 378,723 members) |
| INCREMENTAL evaluation (hourly) | 1–11 s, candidates = changed customers ∪ time-boundary crossers (e.g. 1,377 candidates → +316 / −304) |
| Initial sync to a (mock) destination | HIGH_VALUE 199,388 members → 20 batches of 10k in ~10 s |
| Re-sync with no changes | 0 batches, 1–3 s (delta only) |
| Preview (rule + policy funnel) | sub-second for selective rules; broad rules use a 20 s statement timeout then a 2% sample |
| Dashboard | reads `organization_stats` snapshot + cached counters — no `count(*)` over customers per page view |

`scripts/smoke.mjs` exercises the API end-to-end (login → preview → create → dry run → activate → sync → jobs → events → analytics → audit).

## Repository layout

See `docs/03-folder-structure.md`. `apps/web` (Next.js), `apps/worker` (Node), `packages/core` (domain),
`packages/db` (migrations, client, generated types).

## Compliance principles

Only first-party data the organization has rights and consent to use. No scraping, purchased lists,
fingerprinting, de-anonymization, or circumvention of platform limits. The database is the source of
truth; advertising platforms are destinations. Source counts are never presented as reach.
