# 02 — Database Schema

Source of truth: `packages/db/migrations/*.sql` (versioned, checksummed; applied by `pnpm db:migrate`).
Types for application code are generated from the live schema (`pnpm db:codegen`).

## Entity map

```
organizations ─┬─ users ⟷ organization_members (role)      sessions, api_keys, audit_logs, retention_policies, job_queue
               ├─ customers ──┬── customer_identifiers (hash per profile)      identity_history
               │              ├── consent_events            suppression_records (customer or hash tombstone)
               │              ├── orders ── order_items      cart_events (monthly partitions)
               │              ├── customer_product_purchases · customer_category_purchases · customer_product_interactions
               │              └── customer_events (monthly partitions, idempotent)
               ├─ products ── categories · product_relationships
               ├─ compliance_policies · deletion_requests · data_sources · ingestion_runs · data_quality_snapshots · organization_stats (dashboard snapshot)
               ├─ audiences ──┬── audience_rules (versioned AST + compiled SQL)
               │              ├── audience_exclusions
               │              ├── audience_members  ── audience_membership_history (monthly partitions)
               │              ├── audience_eval_runs · audience_stats_daily · holdout_assignments · audience_outcomes_daily
               │              └── audience_destinations ── audience_destination_members (delta-sync state)
               │                                   └── sync_jobs ── sync_job_batches (monthly partitions)
               ├─ destinations ── destination_accounts
               ├─ campaigns ── campaign_audiences · campaign_metrics_daily        customer_ad_exposure
               └─ webhook_endpoints ── webhook_deliveries
```

## Key design decisions

| Decision | Rationale |
|---|---|
| **Internal `customers.id` (bigint identity)**; email/phone are attributes, never keys | customers change identifiers; bigint keeps membership indexes small (8 B vs 16 B per row × billions). |
| **Raw PII encrypted** (`email_encrypted`, `phone_encrypted`, AES-256-GCM with key ring) and **hashes separate** (`email_hash`, `phone_hash` = SHA-256 of the canonical normalization) | identity resolution and search work on hashes; activation never touches raw PII. |
| **`customer_identifiers` (customer_id, kind, hash_profile) → hash** | each destination needs a different normalization (Meta: digits-only phone; Google: Gmail dot-stripped email, E.164 phone). Profiles are precomputed at ingestion so sync is a pure hash lookup. |
| **`identity_history`** (previous_hash → new_hash) | a later event that still carries the old email resolves to the same customer. |
| **Denormalized aggregates on `customers`** (`order_count`, `total_revenue`, `last_order_at`, `has_open_cart`, `lifecycle_state`, consent flags…) | rule evaluation is a single-table predicate with indexes; no joins over orders at read time. |
| **`customer_product_purchases` / `customer_category_purchases` / `customer_product_interactions`** | product-level audiences (`bought A`, `not bought B`, `viewed`, `carted`) are `EXISTS` on narrow PK-indexed tables instead of scanning `order_items`. |
| **`customer_events` partitioned by month**, unique `(organization_id, event_id, occurred_at)` | idempotent ingestion at 500M+ rows; retention = `DROP PARTITION`. (A replayed event carries the same `occurred_at`.) |
| **`consent_events` append-only → derived flags on `customers`** | auditable history + O(1) eligibility. |
| **`suppression_records` with optional `customer_id` and always an identifier hash** | suppression tombstones apply to identifiers that arrive later (re-imports, new accounts). |
| **`compliance_policies.rules` JSON** compiled to SQL | strict by default; org/destination/region-specific without code changes. |
| **`audiences` ↔ `audience_rules` (versioned)** | rule change = new version = FULL re-evaluation; history preserved for audit. |
| **`audience_members` PK (audience_id, customer_id)** + `(customer_id) WHERE status='ACTIVE'` | set ops are index joins; "which audiences is X in" is one index range. |
| **`audience_membership_history`** (monthly partitions) | change feed for dependent audiences, priority recompute, trends, and retention. |
| **`audience_destination_members`** PK (audience_destination_id, customer_id) with `state` | delta sync truth per destination: ADD = eligible ∖ synced, REMOVE = synced ∖ eligible. |
| **`sync_jobs` + `sync_job_batches`** (monthly partitions, `customer_ids bigint[]` per batch) | checkpoint per request; replay/retry without recomputing; ~10k ids per row keeps it cheap. |
| **`job_queue`** in Postgres | durable work + state in one transaction; BullMQ optional. |
| **`holdout_assignments` / `audience_outcomes_daily`** | first-party incrementality (treatment vs control on our own orders). |
| **Every domain table has `organization_id`** | multi-tenant; RLS can be layered for Supabase deployments. |

## Indexing (see also docs/08)

* `customers`: `(org, external_customer_id)` unique partial · `(org, email_hash)` · `(org, phone_hash)` ·
  `(org, updated_at)` ← incremental candidates · `(org, last_order_at)` · `(org, last_activity_at)` ·
  `(org, last_cart_at) WHERE has_open_cart` · `(org, total_revenue)` · `(org, lifecycle_state)` · `(org, country)` ·
  `(org) WHERE suppressed`. Deliberately not indexed: `order_count`, consent flags (low cardinality).
* `customer_identifiers`: PK + `(org, kind, hash_profile, hash)`.
* `audience_members`: PK · `(customer_id, audience_id) WHERE ACTIVE` · `(audience_id, status)`.
* `audience_destination_members`: PK · `(audience_destination_id, state)`.
* `customer_events`: per-partition PK/unique; `(org, received_at) WHERE PENDING`; `(customer_id, occurred_at)`.
* `job_queue`: `(queue, priority, run_at) WHERE PENDING`; idempotency unique partial.

## Partitioning

`customer_events`, `cart_events`, `audience_membership_history`, `sync_job_batches` are RANGE-partitioned
by month with a DEFAULT partition; `ensure_monthly_partitions(table, from, to)` is called by the
migration (36 months back, 3 forward) and by the daily maintenance job. `orders`/`order_items` stay
heap in v1 (indexed by customer) with a documented migration path when they exceed ~300M rows.

## Retention (org-configurable, `retention_policies`)

raw_events 730d · cart_events 730d · membership_history 730d · sync_batches 90d · audit_logs 2555d ·
eval_runs 180d · sessions 30d · deleted_customers 30d (PII is erased immediately at deletion; the row
is purged after the window; hash tombstones remain in `suppression_records`).
