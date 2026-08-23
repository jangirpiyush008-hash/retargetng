# 11 — Testing

`pnpm test` runs vitest against `TEST_DATABASE_URL` (a real Postgres; schema is rebuilt once per run).

| Suite | File | Covers |
|---|---|---|
| Identity | `packages/core/src/identity/identity.test.ts` | email/phone normalization (Gmail dots/plus, E.164), per-profile SHA-256, identifier change |
| Rule engine | `packages/core/src/rules/rules.test.ts` | schema validation; compiled SQL executed in Postgres for high-value, lapsed, recent, cart 1–3d/4–7d, NOT groups, OR/IN, product cross-sell, windows, minCount, carted openOnly, custom attributes, `in_audience` dependencies; time-band extraction; human description |
| Consent | `packages/core/src/consent/consent.test.ts` | consent reducer (grant/revoke/partial/out-of-order); **policy TS evaluator ≡ SQL predicate** on a 1,000+ customer grid for 4 policies incl. regional overrides, expiry, identifier requirements |
| Lifecycle | `packages/core/src/lifecycle/lifecycle.test.ts` | state machine + SQL twin equivalence |
| Events | `packages/core/src/events/events.test.ts` | no raw PII stored; idempotent event_id; malformed rejection; customer creation with hashes/encryption/identifiers/consent; cart → purchase converts cart; duplicate purchase (different event id) idempotent; refund/cancel aggregates; opt-out ⇒ suppression, re-grant lifts it; email+phone change ⇒ identity history, old email still resolves; deletion ⇒ PII erased, tombstone blocks re-creation; behavioral events create shells and bump `updated_at` |
| Membership | `packages/core/src/membership/membership.test.ts` | FULL vs INCREMENTAL; time-boundary crossers enter/exit with no customer update; product-window bands + dependency feed; RECONCILE repairs drift; priority/primary; preview funnel with exclusions |
| Distribution | `packages/core/src/distribution/distribution.test.ts` | activation → initial sync sends only eligible; delta-only on no change; purchase ⇒ REMOVE; opt-out ⇒ suppression sweep ⇒ REMOVE; rate-limit/transient retries; invalid batch ⇒ FAILED + SUCCESS_WITH_WARNINGS; retry job; auth expiry ⇒ PAUSED + destination ERROR; exclusions; deterministic holdout; dry run sends nothing; Google receives Google-profile hashes; pause skips; archive ⇒ REMOVE_ALL + remote delete |

Critical cases from the spec and where they live: purchase after entering cart audience (membership + distribution),
opt-out (events + distribution), email/phone change (events), duplicate purchase/cart events (events), rule change
(audience service → new version → FULL), destination API fails/rate limits (distribution), customer deleted (events),
multiple audiences (membership priority).

Load testing: `pnpm db:seed` (1M customers / 10M events) then observe evaluation and sync durations in
`audience_eval_runs` / `sync_jobs`; `k6`/`autocannon` scripts against `/api/v1/events` are left to CI.
