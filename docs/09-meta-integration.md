# 09 — Meta Ads Integration (Custom Audiences)

Adapter: `packages/core/src/destinations/adapters/meta.ts` (`MetaAdapter`), mock:
`adapters/mock-meta.ts` (`MockMetaAdapter`, in-memory, identical contract).

## Configuration (stored on `destinations.config`, non-secret)

| Field | Example | Notes |
|---|---|---|
| `api_version` | `v25.0` | default in `MetaAdapter.DEFAULT_API_VERSION`; configurable per destination |
| `business_id` | `123456789` | Meta Business Manager id |
| `customer_file_source` | `USER_PROVIDED_ONLY` | required by Meta on audience creation (`USER_PROVIDED_ONLY` \| `PARTNER_PROVIDED_ONLY` \| `BOTH_USER_AND_PARTNER_PROVIDED`) — we are first-party, so the default is `USER_PROVIDED_ONLY` |
| `credential_ref` (column) | `secret://meta/<destination_id>/access_token` | system-user token with `ads_management` on the ad account; resolved by `SecretStore` in the worker only |

`destination_accounts.external_account_id` = `act_<AD_ACCOUNT_ID>`.

## Endpoints used (Graph API)

| Operation | Call |
|---|---|
| Test connection / list ad accounts | `GET /me/adaccounts?fields=id,name,account_id,currency,timezone_name` · `GET /act_X?fields=...` |
| Create audience | `POST /act_X/customaudiences` `{name, subtype:"CUSTOM", description, customer_file_source}` → `{id}` |
| Add members | `POST /{audience_id}/users` `payload={schema:["EMAIL","PHONE"], data:[[emailHash, phoneHash], …]}` + `session={session_id, batch_seq, last_batch_flag, estimated_num_total}` — ≤ 10,000 rows/request |
| Remove members | `DELETE /{audience_id}/users` same payload |
| Full replace (FULL_REFRESH mode) | `POST /{audience_id}/usersreplace` (session-scoped, 90-min window) |
| Status / approximate size | `GET /{audience_id}?fields=id,name,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,time_updated` |
| Delete | `DELETE /{audience_id}` |

Match counts: Meta does **not** return matched users; we store `approximate_count_lower_bound /
upper_bound` as `matched_lower / matched_upper` and never present the submitted count as reach.
Responses to `/users` include `num_received` and `num_invalid_entries` (we persist the counts,
**not** `invalid_entry_samples`).

## Identifier normalization & hashing (Meta rules)

* EMAIL: trim, lowercase → SHA-256 hex → hash profile `EMAIL_SHA256`.
* PHONE: digits only, country code included, no `+`, no leading zeros → SHA-256 hex → `PHONE_DIGITS_SHA256`.
* Multi-key rows: the `schema` lists the keys, each data row is an array in the same order; a
  missing key is sent as an empty string.

## Idempotency & retries

* Each `sync_job_batches` row maps to one request; `external_ref` = Meta `session_id`,
  `seq` = `batch_seq`. Re-sending a batch with the same session/batch_seq after a crash is safe
  (Meta de-duplicates hashed rows within an audience).
* Error classification (`classifyMetaError`):
  * `190` (OAuthException, expired/invalid token) → `AUTH_EXPIRED` — job paused, destination
    `status=ERROR`, admin notified; not retried.
  * `4`, `17`, `32`, `613`, `80000–80014` (rate limits / business use-case usage) → `RATE_LIMITED`
    — exponential backoff with jitter, honours `X-Business-Use-Case-Usage` estimated time to regain access.
  * `100` (invalid parameter), `2654` (audience TOS), `1870xxx` → `INVALID_REQUEST` — terminal
    for the batch; logged with the error code only.
  * `1`, `2`, HTTP 5xx, network timeouts → `TRANSIENT` — retried up to `maxAttempts`.
  * `200/10/294` permissions → `PERMISSION_DENIED` — terminal, destination flagged.
* All requests carry `appsecret_proof` when an app secret is configured.

## Account connection UX

Connect Meta account → (OAuth system-user token pasted into the SecretStore or OAuth flow in
production) → adapter `validate()` lists ad accounts → user selects accounts → `Test connection`
→ `Create audience` on activation → `Sync` / `Pause` / `Delete` / `View status`.
