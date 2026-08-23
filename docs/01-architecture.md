# 01 — System Architecture

> First-Party Audience Activation & Retargeting Platform ("AAP")

## 1. Purpose

Turn a first-party customer database (50M+ customers, 500M+ events) into continuously
maintained, consent-gated advertising audiences and keep them synchronized to advertising
destinations (Meta Custom Audiences, Google Ads Customer Match, future platforms) with
incremental delta sync, suppression, measurement and auditability.

The platform is an **audience distribution channel**, not a CSV uploader:

```
Connect data → define audience → preview → activate → stay synchronized → measure.
```

## 2. Guiding principles

| Principle | Consequence in the design |
|---|---|
| **The database is the source of truth** | Membership, eligibility, suppression and consent are computed in Postgres. Destinations are *projections* of that truth; we reconcile destinations to the DB, never the reverse. |
| **Consent-first, privacy-by-design** | A customer is never sent to a destination unless the org's *compliance policy* for that destination evaluates to `ELIGIBLE`. Raw PII is encrypted at rest, never logged, never shown in analytics, and activation uses hashed identifiers stored separately from raw PII. |
| **Incremental everything** | Event ingestion marks customers dirty; the audience engine evaluates only *candidates* (dirty customers ∪ customers crossing a time boundary); distribution sends only deltas (`ADD` / `REMOVE`). |
| **Provider-agnostic** | All destinations implement `DestinationAdapter`. Meta and Google are two adapters; TikTok/Snap/TTD plug into the same distribution engine without touching the audience engine. |
| **Never assume match rate** | Every count is reported along the funnel: `source → eligible → submitted → matched → activatable`. |
| **Multi-tenant from day one** | Every domain table carries `organization_id`; RBAC and audit logs are scoped per organization. |
| **Asynchronous by default** | Anything that can touch millions of rows is a queued job with checkpoints; the dashboard reads pre-aggregated stats. |

## 3. Logical architecture

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ DATA SOURCES   CSV · S3 · Postgres/MySQL · BigQuery/Snowflake · Shopify · Webhooks│
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │  DataSourceAdapter (batch) / POST /api/v1/events (stream)
┌──────────────▼───────────────────────┐   idempotent (organization_id, event_id)
│ INGESTION & EVENT LOG                │   customer_events (monthly partitions)
└──────────────┬───────────────────────┘
               │ CustomerEventProcessor (queue: events.process)
┌──────────────▼───────────────────────┐   normalize → hash → resolve identity
│ IDENTITY RESOLUTION                  │   customers · customer_identifiers · identity_history
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐   consent_events → derived consent flags
│ CONSENT & PRIVACY ENGINE             │   suppression_records → customers.suppressed
│                                      │   compliance_policies (per org × destination × region)
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐   denormalized aggregates on customers
│ CUSTOMER 360                         │   customer_product_purchases · customer_category_purchases
│                                      │   lifecycle_state (state machine)
└──────────────┬───────────────────────┘
               │ marks customers.updated_at → candidates
┌──────────────▼───────────────────────┐   JSON rule AST → parameterized SQL
│ SEGMENTATION / AUDIENCE ENGINE       │   audiences · audience_rules · audience_members
│                                      │   incremental candidate evaluation · exclusions · priority
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐   eligibility (compliance policy) per destination
│ AUDIENCE DISTRIBUTION ENGINE         │   delta = eligible Δ synced → ADD / REMOVE batches
│                                      │   sync_jobs · sync_job_batches · audience_destination_members
└────┬────────────────┬────────────────┘
     │                │         DestinationAdapter
┌────▼─────┐   ┌──────▼──────┐   ┌──────────────┐
│ META     │   │ GOOGLE ADS  │   │ FUTURE (TikTok, Snap, TTD…) │
│ Custom   │   │ Customer    │   └──────────────┘
│ Audiences│   │ Match       │
└────┬─────┘   └──────┬──────┘
     └────────┬───────┘
┌─────────────▼────────────────────────┐   campaigns · campaign_metrics · holdouts
│ CAMPAIGN & AUDIENCE MEASUREMENT      │   funnel counts · match rate · ROAS · incrementality
└──────────────────────────────────────┘
```

## 4. Physical architecture (deployables)

| Component | Technology | Notes |
|---|---|---|
| `apps/web` | Next.js 15 (App Router), React 19, TypeScript, Tailwind, shadcn-style UI, Recharts | Dashboard + REST API (`/api/v1/*`). Stateless; horizontally scalable. No secrets, no destination calls from the browser. |
| `apps/worker` | Node 22 + TypeScript | Long-running process: queue consumers (event processing, audience evaluation, sync, ingestion, retention), schedulers, health/metrics HTTP endpoints. Scale horizontally; work is leased with `FOR UPDATE SKIP LOCKED`. |
| `packages/core` | Pure TypeScript domain | Identity/hashing, consent + compliance, rule engine (AST → SQL), membership engine, distribution engine, destination adapters (Mock/Meta/Google), queue abstraction, secrets, logging, RBAC. No framework dependencies. |
| `packages/db` | Kysely + `pg`, versioned SQL migrations, generated types, seed/synthetic generator | Single source of truth for the schema. |
| PostgreSQL 16 | Operational store | Partitioned event/history tables; materialized aggregates; also hosts the durable job queue (`job_queue`) so that the MVP runs with **zero** extra infrastructure. |
| Redis 7 (optional) | BullMQ queue backend | Enabled by `REDIS_URL`; same `JobQueue` interface. Recommended at >10M events/day. |
| Object storage (S3/GCS) | Raw imports (CSV/Parquet), export artifacts | Abstracted by `ObjectStore`. |
| Analytical warehouse (ClickHouse/BigQuery) | Optional Phase 4+ | Campaign metrics and long-range event analytics; not needed for membership. |
| Secret manager | AWS SM / GCP SM / Vault | `SecretStore` interface; `destination_accounts.credential_ref` stores *references only*. |

### Why the queue lives in Postgres by default

BullMQ/Redis is excellent, but for the MVP the durable-state requirement ("never lose
synchronization state") is easiest to guarantee transactionally: a sync job's batch
checkpoint and its queue record commit in the **same transaction**. The `JobQueue`
interface has two implementations (`PgJobQueue`, `BullMqJobQueue`); switching is a
config change, not a rewrite.

## 5. Clean separation of concerns

| Concern | Tables | Owner module |
|---|---|---|
| Customer database | `customers`, `customer_identifiers`, `identity_history`, `orders`, `order_items`, `cart_events`, `customer_events`, `customer_product_purchases`, `customer_category_purchases` | `core/identity`, `core/events` |
| Consent & privacy | `consent_events`, `suppression_records`, `compliance_policies`, `deletion_requests`, `retention_policies` | `core/consent` |
| Audience definitions | `audiences`, `audience_rules` (versioned), `audience_exclusions`, `audience_templates` | `core/audience` |
| Audience membership | `audience_members`, `audience_membership_history`, `audience_eval_runs`, `audience_stats_daily` | `core/membership` |
| Destinations | `destinations` (catalog), `destination_accounts`, `audience_destinations`, `audience_destination_members` | `core/destinations` |
| Synchronization | `sync_jobs`, `sync_job_batches`, `job_queue` | `core/distribution`, `core/queue` |
| Measurement | `campaigns`, `campaign_audiences`, `campaign_metrics_daily`, `holdout_assignments` | `core/measurement` |
| Platform | `organizations`, `users`, `organization_members`, `sessions`, `api_keys`, `audit_logs`, `data_quality_snapshots` | `core/platform`, `core/audit` |

## 6. Key runtime flows (summary — see 06-data-flow.md)

1. **Event in** → `POST /api/v1/events` → dedupe by `(organization_id, event_id)` → insert
   into `customer_events` → enqueue `events.process` → processor applies effect (order,
   cart, consent, deletion) → updates aggregates + lifecycle state → `customers.updated_at = now()`.
2. **Audience evaluation** (`audience.evaluate`, per audience on its schedule or on event
   burst) → candidates = dirty since watermark ∪ time-boundary crossers → run compiled SQL
   for candidates only → upsert `audience_members` (ENTER/EXIT) → write history → update stats.
3. **Distribution** (`audience.sync`) → eligible set = members ∩ compliance policy ∩ ¬suppressed
   → diff against `audience_destination_members` → batches of ADD/REMOVE → adapter →
   checkpoint each batch → update funnel counts, match counts when provided by the platform.
4. **Suppression** → `suppression_records` insert → `customers.suppressed = true` → customer
   becomes ineligible everywhere → next sync emits REMOVE to every destination audience
   they were in; global suppression is enforced in SQL at the eligibility step, overriding
   any rule.

## 7. Non-goals (compliance)

No scraping, no purchased lists, no fingerprinting, no de-anonymization, no circumvention
of platform limits or policies, no upload of opted-out users, no sensitive categories
prohibited by platform policy. The platform activates only first-party data the
organization has the rights and consent to use.
