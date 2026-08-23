# 03 — Repository / Folder Structure

pnpm monorepo. Domain logic lives in `packages/core` and is consumed by both the Next.js
app and the worker. Packages export TypeScript source directly (transpiled by Next /
executed by `tsx`) to avoid a build step during development.

```
.
├── apps/
│   ├── web/                          Next.js 15 dashboard + REST API
│   │   ├── src/app/
│   │   │   ├── (auth)/login/         sign-in
│   │   │   ├── (app)/                authenticated shell (sidebar nav)
│   │   │   │   ├── dashboard/        KPIs, sync health, funnel
│   │   │   │   ├── customers/        search (hashed/masked), data quality
│   │   │   │   ├── audiences/        list, [id] detail, new (builder)
│   │   │   │   ├── destinations/     connections, accounts, test
│   │   │   │   ├── sync-jobs/        job list + detail + batches
│   │   │   │   ├── campaigns/        campaigns + metrics
│   │   │   │   ├── analytics/        audience analytics, holdouts
│   │   │   │   ├── suppression/      suppression records / import
│   │   │   │   ├── consent/          consent overview + compliance policies
│   │   │   │   ├── settings/         org, members/roles, API keys, retention
│   │   │   │   └── audit-logs/
│   │   │   └── api/v1/               route handlers (REST) — thin, call core services
│   │   ├── src/components/           ui/ (shadcn-style primitives), charts/, domain widgets
│   │   ├── src/lib/                  server helpers (auth session, api responder, db handle)
│   │   └── src/server/               server-only composition root (services wiring)
│   └── worker/                       queue consumers + schedulers + /health /ready /metrics
│       └── src/
│           ├── main.ts               boots consumers, scheduler, http
│           ├── consumers/            events.process, audience.evaluate, audience.sync, ...
│           └── scheduler.ts          cron-like tick: due audiences, retention, stats rollups
├── packages/
│   ├── core/                         framework-free domain
│   │   └── src/
│   │       ├── identity/             normalize + hash (email/phone), identity resolution
│   │       ├── crypto/               AES-GCM PII encryption, key ring, HMAC
│   │       ├── consent/              consent state, compliance policy evaluator (TS + SQL)
│   │       ├── events/               event schemas, idempotency, CustomerEventProcessor
│   │       ├── lifecycle/            customer lifecycle state machine
│   │       ├── rules/                rule AST (zod), field catalog, SQL compiler, candidates
│   │       ├── audience/             audience service (CRUD, versioning, preview, templates)
│   │       ├── membership/           incremental membership engine, priority, history
│   │       ├── destinations/         DestinationAdapter + registry + adapters/{mock,meta,google}
│   │       ├── distribution/         eligibility, delta computation, sync job runner, retries
│   │       ├── queue/                JobQueue interface, PgJobQueue, BullMqJobQueue
│   │       ├── secrets/              SecretStore (env, memory; AWS/GCP stubs)
│   │       ├── audit/                audit logger
│   │       ├── rbac/                 roles → permissions
│   │       ├── measurement/          campaign metrics, funnel, holdout assignment
│   │       ├── quality/              data quality checks
│   │       ├── observability/        pino logger with PII redaction, metrics registry
│   │       └── index.ts
│   └── db/                           (seed generator lives in packages/core/src/seed)
│       ├── migrations/               versioned SQL (0001_..., 0002_...)
│       ├── src/
│       │   ├── client.ts             Kysely instance factory (pg pool)
│       │   ├── migrate.ts            migrator (schema_migrations table)
│       │   ├── types.ts              generated/maintained DB types
│       │   └── (seed: see packages/core/src/seed — COPY-based synthetic generator)
│       │   └── test-utils.ts         test DB bootstrap (fresh schema per run)
│       └── package.json
├── docs/                             design docs (this folder)
├── scripts/                          dev helpers (local pg, smoke tests)
├── docker-compose.yml                postgres + redis for local/prod-like
├── .env.example
├── pnpm-workspace.yaml
└── vitest.config.ts
```

Module boundaries are enforced by package imports: `apps/*` may import `@aap/core` and
`@aap/db`; `@aap/core` may import `@aap/db` types only; adapters are only instantiated via
the `DestinationRegistry`.
