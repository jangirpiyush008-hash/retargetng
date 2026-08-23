# 08 — Scaling Strategy (50M customers · 500M events · 1000 audiences · 100 destinations)

## 1. Data volume & layout

| Table | Rows (target) | Layout |
|---|---|---|
| `customers` | 50M | heap; narrow hot columns; `attributes jsonb` for long tail |
| `customer_identifiers` | 100–200M | PK (customer_id, kind, hash_profile); lookup index (org, kind, hash_profile, hash) |
| `customer_events` | 500M+ | **RANGE partition by month (`occurred_at`)**; retention = drop partition |
| `cart_events` | 200M | RANGE monthly |
| `orders` / `order_items` | 150M / 400M | heap in v1 (indexed by customer); partition by `ordered_at` year when > 300M (documented migration) |
| `customer_product_purchases` | 300M | materialized aggregate, PK (customer_id, product_id) — replaces scanning order_items for product audiences |
| `audience_members` | 1000 audiences × avg 2M = 2B worst case | PK (audience_id, customer_id); realistic overlap much lower; `EXITED` rows pruned after retention |
| `audience_membership_history` | millions/day | RANGE monthly; BRIN on occurred_at |
| `audience_destination_members` | Σ eligible per destination | PK (audience_destination_id, customer_id) |
| `sync_job_batches` | thousands/day | RANGE monthly (stores `customer_ids bigint[]`) |

## 2. Why we never scan everything

* **Event-driven dirtiness** (`customers.updated_at`) + **time-band candidate extraction** (05 §4)
  bound each incremental evaluation to `O(changes + boundary crossers)` rather than `O(customers)`.
* **Keyset pagination by `customers.id`** for full evaluations and initial syncs (50k per
  transaction; no OFFSET).
* **Delta sync** compares sets in SQL (`EXCEPT` / anti-joins on indexed PKs) and sends only
  `ADD`/`REMOVE`.
* **Counts come from cached columns / daily stats**, never `count(*)` over big tables on page
  load. Preview uses the real predicate but is bounded by a statement timeout and falls back to
  sampling (`TABLESAMPLE SYSTEM`) with extrapolation + "≈" for very broad audiences.

## 3. Indexing decisions (customers)

| Index | Reason |
|---|---|
| `(organization_id, external_customer_id)` unique partial | ingestion upsert |
| `(organization_id, email_hash)`, `(organization_id, phone_hash)` partial | identity resolution / dedupe |
| `(organization_id, updated_at)` | incremental candidates — the single most important index |
| `(organization_id, last_order_at)` | recency/lapsed bands |
| `(organization_id, last_cart_at) WHERE has_open_cart` | cart-abandoner windows — tiny partial index |
| `(organization_id, last_activity_at)` | dormant/active windows |
| `(organization_id, total_revenue)` | value thresholds (high-value / VIP) |
| `(organization_id, lifecycle_state)` | state audiences + dashboard breakdown |
| `(organization_id, country)` | geo audiences |
| `(organization_id) WHERE suppressed` partial | suppression sweeps |

Deliberately **not** indexed: `order_count`, `consent_status`, `advertising_personalization_allowed`,
`marketing_allowed` — low cardinality; they are applied after a more selective predicate or
over an already-selected member set. `average_order_value`/`lifetime_value` share the
selectivity profile of `total_revenue`; add on demand.

## 4. Asynchrony & back-pressure

* All heavy work is a `job_queue` job (Postgres `FOR UPDATE SKIP LOCKED`, or BullMQ when
  `REDIS_URL` is set). Queues: `events.process`, `audience.evaluate`, `audience.sync`,
  `ingest.run`, `maintenance.*`.
* Workers are stateless; concurrency per queue is configurable; job leases expire (`locked_at`)
  so crashed workers' jobs are re-leased.
* Per-destination **rate limiting** is enforced in the adapter client (token bucket) and by
  honoring `429`/`X-Business-Use-Case-Usage`/`Retry-After` with exponential backoff + jitter.
* Sync jobs checkpoint per batch; a 5M-member initial sync survives restarts.

## 5. Postgres operational notes

* `work_mem` per sort for evaluation queries; `maintenance_work_mem` for index builds;
  `autovacuum` tuned aggressively on `customers`, `audience_members`, `audience_destination_members`
  (high update churn): `autovacuum_vacuum_scale_factor = 0.02`.
* `fillfactor = 80` on `customers` and membership tables to favor HOT updates.
* Read replicas for dashboard/analytics queries; the worker writes to the primary.
* At > 100M customers or multi-region: shard by `organization_id` (tenant-per-database) — the
  code never joins across organizations.
* Analytical workloads (campaign metrics over years, event analytics) move to ClickHouse/BigQuery
  via the `customer_events` partitions exported as Parquet to object storage.

## 6. Capacity math (illustrative)

* 50M customers × ~600 B = 30 GB heap + ~20 GB indexes.
* 2% daily churn → 1M dirty customers/day → incremental eval of 1000 audiences touches at most
  1M × (audiences whose candidate sets include them) — bounded by indexes, not by 50M.
* Meta: 10k identifiers per request, ~2–5 req/s per ad account sustained → 5M adds ≈ 500 calls ≈
  minutes, not hours. Google: 10k ops/request into one offline job, one `run` per job.
