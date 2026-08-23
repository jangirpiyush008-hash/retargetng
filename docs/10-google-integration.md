# 10 — Google Ads Integration (Customer Match)

Adapter: `packages/core/src/destinations/adapters/google.ts` (`GoogleAdsAdapter`), mock:
`adapters/mock-google.ts` (`MockGoogleAdapter`).

## Why the Data Manager API

As of **April 1, 2026** Google disabled Customer Match uploads through the Google Ads API
`OfflineUserDataJobService` / `UserDataService` for developer tokens that had not previously
used them; the **Data Manager API** (`datamanager.googleapis.com`) is Google's current
recommended ingestion path and replaces the create-job → add-operations → run → poll workflow
with a single request. This adapter therefore:

1. creates/updates/deletes the **user list** through the Google Ads API (`UserListService`,
   `CrmBasedUserList`, `upload_key_type: CONTACT_INFO`, `membership_life_span`), and reads list
   stats (`user_list.size_for_display`, `size_for_search`, `match_rate_percentage`) via GAQL;
2. **adds/removes members** through the Data Manager API:
   * `POST https://datamanager.googleapis.com/v1/audienceMembers:ingest`
   * `POST https://datamanager.googleapis.com/v1/audienceMembers:remove`
   * `GET  https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=…`

```json
{
  "destinations": [{
    "reference": "primary",
    "operatingAccount": { "accountType": "GOOGLE_ADS", "accountId": "1234567890" },
    "loginAccount":     { "accountType": "GOOGLE_ADS_MANAGER", "accountId": "9876543210" },
    "productDestinationId": "<user_list_id>"
  }],
  "audienceMembers": [
    { "userData": { "userIdentifiers": [ { "emailAddress": "<sha256 hex>" }, { "phoneNumber": "<sha256 hex>" } ] } }
  ],
  "encoding": "HEX",
  "consent": { "adUserData": "CONSENT_GRANTED", "adPersonalization": "CONSENT_GRANTED" },
  "termsOfService": { "customerMatchTermsOfServiceStatus": "ACCEPTED" },
  "validateOnly": false
}
```

Limits: ≤ 10,000 `audienceMembers` per request; lists need ≥ 100 matched members to serve.
`validateOnly: true` is used by **Test connection** and by **Dry run** so no data is applied.

## Consent

Our eligibility gate guarantees that every member in a Google batch has
`advertising_personalization_allowed` and `data_sharing_allowed` (configurable per compliance
policy), so the request-level consent is `CONSENT_GRANTED` for both `adUserData` and
`adPersonalization`. Customers without that consent are never included (they are counted as
`consent_*` rejections on the sync job).

## Identifier normalization & hashing (Google rules)

* EMAIL: lowercase; remove leading/trailing/intermediate whitespace; for `gmail.com` /
  `googlemail.com` remove all `.` before `@` and strip `+suffix`; SHA-256 → hex → hash profile
  `EMAIL_SHA256_GOOGLE`.
* PHONE: E.164 with `+` → SHA-256 hex → `PHONE_E164_SHA256`.

## Auth & configuration

| Field | Where | Notes |
|---|---|---|
| developer token | SecretStore `secret://google/<destination_id>/developer_token` | Google Ads API only |
| OAuth client id/secret + refresh token | SecretStore `secret://google/<destination_id>/oauth` | scopes: `https://www.googleapis.com/auth/adwords`, `https://www.googleapis.com/auth/datamanager` |
| `login_customer_id` | `destinations.config` | MCC id when acting through a manager |
| `api_version` | `destinations.config` | Google Ads API version (default `v21`) |
| `membership_life_span_days` | `destinations.config` | default 540; `10000` = no expiry |

`destination_accounts.external_account_id` = Google Ads customer id (digits only).

## Status & match rate

`requestStatus:retrieve` returns per-destination `requestStatus` (`PROCESSING | SUCCESS |
PARTIAL_SUCCESS | FAILED`), error/warning counts, and for user-data uploads an
`uploadMatchRateRange` bucket; the adapter maps the bucket midpoint to `match_rate` and also
reads `user_list.match_rate_percentage` and list sizes via GAQL for the audience status card.

## Errors & retries

Fast-fail model: a structurally invalid request fails entirely (`400 INVALID_ARGUMENT`, with
`field_violations`); transient errors (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, `ABORTED`,
HTTP 429/5xx) are retried with exponential backoff + jitter; `401/403` → token refresh once, then
`AUTH_EXPIRED`/`PERMISSION_DENIED` (terminal, destination flagged). Partial failures are read
from `requestStatus` and recorded as `failed` counts on the sync job (no PII samples stored).
