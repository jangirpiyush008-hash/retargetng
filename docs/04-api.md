# 04 — API Design

Base path: `/api/v1`. JSON in/out. Authentication: session cookie (dashboard) **or**
`Authorization: Bearer aap_live_…` API key (machine). Every request is scoped to the caller's
organization; ids from other organizations 404. Errors: `{ error: { code, message, details? } }`.
Mutations are audited. Large collections are cursor-paginated: `?cursor=&limit=` →
`{ data: [...], nextCursor }`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` · `/auth/logout` | – | session cookie |
| GET/PATCH | `/me` | any | user, org, role, permissions; PATCH switches organization |
| GET | `/dashboard` | `dashboard:read` | KPI summary (cached counters) |
| GET | `/customers?q=&cursor=` | `customers:read` | `q` = external id, or email/phone (hashed server-side); masked output |
| GET | `/customers/:id` | `customers:read` | 360 view (masked), memberships, consent, eligibility reasons |
| POST | `/customers` | `customers:write` | upsert batch (≤ 1000) → emits CUSTOMER_CREATED/UPDATED events |
| POST | `/events` | `events:write` | batch (≤ 1000) of events; idempotent; returns accepted/duplicates/rejected |
| GET | `/data-quality` | `customers:read` | latest snapshot + history |
| GET/POST | `/audiences` | `audiences:read` / `audiences:write` | create with rule AST or `templateKey` |
| GET | `/audiences/:id` | `audiences:read` | detail incl. rules, exclusions, destinations, stats |
| PATCH | `/audiences/:id` | `audiences:write` | name/description/schedule/priority/holdout/exclusions; new rule ⇒ new version |
| DELETE | `/audiences/:id` | `audiences:delete` (ADMIN+) | archives; removes from destinations |
| POST | `/audiences/preview` | `audiences:read` | preview a rule AST (unsaved) → funnel counts |
| POST | `/audiences/:id/preview` | `audiences:read` | preview saved audience (+ history) |
| POST | `/audiences/:id/evaluate` | `audiences:write` | enqueue FULL/INCREMENTAL evaluation |
| POST | `/audiences/:id/activate` | `audiences:activate` | body `{destinationAccountIds[], syncMode, schedule, dryRun}` → creates audience_destinations, initial sync jobs (or dry-run report) |
| POST | `/audiences/:id/sync` | `audiences:activate` | manual sync now (all or one destination) |
| POST | `/audiences/:id/pause` · `/resume` | `audiences:activate` | pause/resume distribution |
| GET | `/audiences/:id/members?cursor=` | `customers:read` | masked member sample |
| GET | `/audiences/:id/history` | `audiences:read` | membership trend, eval runs |
| GET | `/audiences/templates` · `/audiences/fields` | `audiences:read` | template catalog + recommendations; field catalog + operators for the builder |
| GET | `/products?q=|ids=` · `/categories?q=` | `audiences:read` | typeahead for product/category conditions |
| GET | `/destinations/catalog` | `destinations:read` | supported destination types + mock/live mode |
| GET/POST | `/destinations` | `destinations:read` / `destinations:manage` (ADMIN+) | connect (stores credential in SecretStore, never returns it) |
| GET/PATCH/DELETE | `/destinations/:id` | … | disconnect/reconnect |
| POST | `/destinations/:id/test` · `/reconnect` | `destinations:manage` | adapter.connect() (refreshes accounts) · rotate credential |
| GET/POST | `/destinations/:id/accounts` | … | list accounts · validate / set default |
| GET/POST | `/destinations/:id/accounts` | … | list/select ad accounts |
| GET | `/sync-jobs?status=&audienceId=&cursor=` | `sync:read` | |
| GET | `/sync-jobs/:id` | `sync:read` | job + batches |
| DELETE | `/audiences/:id/destinations/:adId` | `audiences:delete` | remove audience from one destination (REMOVE_ALL + remote delete) |
| POST | `/sync-jobs/:id/retry` · `/cancel` | `audiences:activate` | |
| GET/POST | `/suppression` | `suppression:read` / `suppression:write` | add by customer id or identifier (hashed server-side) |
| GET | `/consent/overview` | `consent:read` | consent distribution |
| GET/POST/PATCH | `/compliance-policies` | `consent:manage` (ADMIN+) | |
| GET/POST | `/campaigns` · `/campaigns/:id/metrics` | `campaigns:*` | |
| GET | `/analytics/overview` · `/analytics/audiences/:id` · `/analytics/holdout/:id` | `analytics:read` | |
| GET | `/audit-logs?cursor=` | `audit:read` | |
| GET/POST/DELETE | `/settings/api-keys` | `settings:manage` | key shown once |
| GET/POST | `/settings/members` | `members:manage` | org members + roles |
| GET/PATCH | `/settings/retention` | `settings:manage` | |
| GET/POST | `/webhooks` | `settings:manage` | |
| GET | `/health` · `/ready` · `/metrics` | – (worker also exposes on :9464) | |

Request/response schemas are defined with `zod` in `packages/core/src/api-schemas.ts` (single source for validation). `scripts/smoke.mjs` exercises the main flows end-to-end against a running instance.
