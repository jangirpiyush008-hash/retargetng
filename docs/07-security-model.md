# 07 — Security & Privacy Model

## 1. Data classification

| Class | Examples | Storage | Who can read |
|---|---|---|---|
| **Raw PII** | email, phone | `customers.email_encrypted / phone_encrypted` — AES-256-GCM, key ring with `kid` prefix, rotation supported | `customers:read_pii` permission (ADMIN+), never the dashboard by default, never logs |
| **Activation identifiers** | SHA-256 of normalized email/phone per hash profile | `customers.email_hash/phone_hash`, `customer_identifiers` | worker (sync), `customers:read` (masked display = first 8 hex chars) |
| **Behavioral/commercial** | orders, carts, aggregates | plain | per RBAC |
| **Consent & suppression** | consent events, suppression records | plain, append-only | per RBAC; changes audited |
| **Credentials** | Meta token, Google refresh token | **never in DB** — `SecretStore` references only (`destination.credential_ref`) | worker process only |

## 2. Controls

* **Encryption in transit**: TLS everywhere (Postgres `sslmode=require` in prod, HTTPS to
  destinations). **At rest**: disk encryption + field-level AES-GCM for raw PII.
* **PII minimization**: activation reads only `customer_identifiers`. The dashboard shows masked
  hashes; search by email/phone is performed by hashing the query server-side and comparing hashes.
* **No PII in logs / errors / analytics**: `pino` logger with redaction paths (`email`, `phone`,
  `payload`, `*.email`, …) and a structured-only policy; destination error samples returned by
  the platforms (e.g. Meta `invalid_entry_samples`) are dropped before persisting.
* **RBAC** (`packages/core/src/rbac`): roles `SUPER_ADMIN, ADMIN, MARKETING_MANAGER,
  CAMPAIGN_MANAGER, ANALYST, VIEW_ONLY` map to permissions; route handlers call
  `requirePermission(session, 'audiences:activate')`. Connect accounts, export, consent rules,
  delete audiences and manage credentials are ADMIN+ only.
* **Authentication**: session cookies (HttpOnly, Secure, SameSite=Lax) backed by the `sessions`
  table (hash of the token stored), scrypt password hashing for the local provider; pluggable
  `AuthProvider` so Supabase Auth/SSO can replace it. API keys: `aap_live_<prefix>_<secret>`,
  stored hashed, scoped (`events:write`, `customers:write`, `audiences:read`, …), revocable.
* **Audit log**: every mutating action writes `audit_logs(actor, action, entity, before, after,
  ip, ua)`. Retention is configurable (default 7 years).
* **Secrets**: `SecretStore` interface — `EnvSecretStore` (dev), `MemorySecretStore` (tests),
  documented adapters for AWS Secrets Manager / GCP Secret Manager / Vault. Key rotation: add a
  new `kid` to `PII_ENCRYPTION_KEYS`; a background job re-encrypts rows lazily.
* **Deletion workflow**: `CUSTOMER_DELETED` event or `deletion_requests` → PII erased (encrypted
  columns nulled; hashes kept only as suppression tombstones so the person is never re-added),
  memberships exited, REMOVE pushed to every destination, audit entry written.
* **Retention**: `retention_policies(org, data_class, days)`; the retention job drops expired
  partitions (`customer_events`, `cart_events`, `audience_membership_history`, `sync_job_batches`)
  and deletes expired rows elsewhere. No legal period is hard-coded.
* **Export**: disabled by default; when enabled requires `data:export`, a stated purpose, filters,
  expiry, server-side encryption of the artifact and an audit record.
* **Multi-tenancy**: every query is scoped by `organization_id` from the session; services take
  an `OrgContext` and never accept a bare org id from the client. (Row-Level Security policies
  can be layered on for Supabase deployments — see migration `0002_rls.sql` comments.)
* **Input validation**: all API bodies validated with `zod`; SQL only through Kysely/parameters;
  rule compiler emits parameters only — field/operator whitelists prevent injection.
* **Destination API hygiene**: least-privilege tokens (Meta `ads_management` on the specific ad
  account; Google developer token + OAuth refresh token for the specific customer), rate-limit
  aware clients, no credential ever echoed to the UI (only status + last 4 chars of the ad
  account id).

## 3. Threat notes

* Enumeration of customers by id is blocked by RBAC and org scoping; bigint ids are internal.
* A compromised dashboard session cannot exfiltrate PII (no export, masked hashes) nor
  destination credentials (not stored).
* Replay of ingestion events is harmless (idempotency keys).
* Worker and web share the DB but only the worker holds destination credentials.
