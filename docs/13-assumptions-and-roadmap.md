# 13 — Assumptions, Decisions & Roadmap

## Assumptions made (documented rather than blocking)

| Topic | Assumption / decision |
|---|---|
| Queue | Postgres `job_queue` by default (transactional checkpoints); BullMQ via `REDIS_URL` with the same interface. |
| Auth | Local session auth (scrypt + DB sessions) behind `AuthService`; Supabase Auth/SSO can replace `login()`/`resolveSession()` without touching routes. RLS policies are not enabled by default (every query is org-scoped in code); a `0002_rls.sql`-style migration can be added for Supabase deployments. |
| Secrets | `SECRET_STORE=db` (AES-GCM rows keyed by `PII_ENCRYPTION_KEYS`) for self-hosted; production should use a managed secret manager behind `SecretStore`. |
| Cart abandonment | `has_open_cart` = ADD_TO_CART after the last purchase; a purchase converts the open cart when it references the same `cart_id` or happens after the last cart activity. `CART_ABANDONERS_x_yD` = open cart with `last_cart_at` in the window. |
| Consent semantics | `consent_status` reflects advertising consent (GRANTED iff `advertising_personalization_allowed`); revoking advertising consent also adds an `ADVERTISING_OPT_OUT` suppression (lifted on re-grant). Default policy requires GRANTED + advertising + data-sharing flags + a valid identifier; organizations relax/tighten per destination and region in Consent → policies. |
| Order corrections | CANCELLED reduces order_count/revenue; REFUNDED reduces lifetime_value (revenue − refunds). Duplicate `PURCHASE_COMPLETED` for the same `external_order_id` is ignored. |
| Event idempotency | `(organization_id, event_id, occurred_at)` — replays carry the same timestamp. |
| Exclusions | applied at eligibility time (preview + sync) against the excluded audiences' *current* membership; `audience_members` stays the pure rule set. |
| Priority | `is_primary` recomputed incrementally for customers whose memberships changed; `distribution_policy.primaryOnly` restricts a destination audience to primary members. |
| Holdout | deterministic by `md5(salt, customer_id)`; control is never sent; outcomes measured on first-party orders. |
| Match reporting | Meta: `approximate_count_lower/upper_bound` (no exact matched count); Google: `user_list.match_rate_percentage` + Data Manager `uploadMatchRateRange`. Source counts are never shown as reach. |
| Meta API | Graph v25.0 default; EMAIL+PHONE schema; `customer_file_source=USER_PROVIDED_ONLY`. |
| Google API | Data Manager API `audienceMembers:ingest/remove` for members (mandatory since 2026-04-01), Google Ads API for `UserList` CRUD and GAQL stats; OAuth refresh token + developer token. |
| Orders partitioning | heap in v1; partition by `ordered_at` when > ~300M rows (documented in 08). |
| Seeding | COPY-based generator predicts identity ids from sequences (tool only; not an ingestion path). |

## What is deliberately out of the MVP (Phase 5–6 per the brief)

* Natural-language audience builder & AI recommendations (rule AST + templates are the contract they would emit; must still pass the same compliance gate).
* Data-source adapters beyond events/API/synthetic (CSV/S3/Postgres/MySQL/BigQuery/Snowflake/Shopify) — `data_sources`/`ingestion_runs` tables and the bulk COPY path are in place; adapters plug into `EventIngestor` / `bulk upsert`.
* Outbound webhook delivery worker (tables exist), ad-exposure ingestion for fatigue rules (`customer_ad_exposure` + policy `fatigue` block exist; the eligibility SQL hook is the next step).
* Additional destinations (TikTok, Snapchat, The Trade Desk) — implement `DestinationAdapter`, register in `DestinationRegistry`.
* Export workflow (disabled by design; requires `data:export`, purpose, expiry, encryption).
* Live-account verification of the Meta/Google adapters (no credentials available during development).
