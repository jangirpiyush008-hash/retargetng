# 06 — Data Flow

## A. Ingestion → Customer 360

```
Source (CSV/S3/DB/Shopify/webhook) ──► DataSourceAdapter.read() ──► batches of CustomerRecord / Event
                                                                        │
                              POST /api/v1/events (API key) ────────────┤
                                                                        ▼
                                                   customer_events (partitioned, idempotent on (org,event_id,occurred_at))
                                                                        │ enqueue events.process (batch of event ids)
                                                                        ▼
                                                      CustomerEventProcessor (worker)
   ┌────────────────────────────────────────────────────────────────────┴──────────────────────────┐
   │ 1. resolve identity: external_customer_id → email_hash → phone_hash (identity_history on change)│
   │ 2. apply effect by event_type:                                                                  │
   │      CUSTOMER_CREATED/UPDATED → upsert customers (+ encrypted PII, hashes, identifiers)         │
   │      PRODUCT_VIEWED           → customer_product_interactions, last_product_view_at             │
   │      ADD_TO_CART/CHECKOUT     → cart_events, has_open_cart=true, last_cart_at                   │
   │      PURCHASE_COMPLETED       → orders/order_items (upsert by external_order_id),                │
   │                                 aggregates (order_count,total_revenue,AOV,LTV,first/last order),│
   │                                 customer_product_purchases, customer_category_purchases,        │
   │                                 has_open_cart=false (cart converted)                           │
   │      ORDER_CANCELLED/REFUNDED → order status, refund aggregates                                 │
   │      CONSENT_GRANTED/REVOKED  → consent_events + derived consent flags                          │
   │      CUSTOMER_DELETED         → deleted=true, suppression, PII erased, deletion_requests         │
   │ 3. lifecycle state machine → customers.lifecycle_state                                          │
   │ 4. customers.updated_at = now()   ← makes the customer a candidate for incremental evaluation   │
   └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

All writes for one event happen in one transaction; the event row is marked `PROCESSED`
(or `FAILED` with a sanitized error — payloads are never logged).

## B. Membership (see 05 §4)

```
scheduler tick ─► due audiences ─► enqueue audience.evaluate(audience_id, mode)
                                           │
                                           ▼
                      candidates (dirty ∪ time-band ∪ dependency feed) → predicate → upsert members
                                           │
                                           ├─► audience_membership_history (ENTER/EXIT)
                                           ├─► audience_stats_daily, audiences.member_count
                                           └─► if audience has active destinations & schedule is REALTIME/HOURLY due → enqueue audience.sync
```

## C. Distribution / delta sync

```
audience.sync(audience_destination_id, mode)
  1. create sync_jobs row (idempotency_key = ad_id + window), status RUNNING
  2. ELIGIBLE = audience_members(ACTIVE)
               − members of excluded audiences
               − suppressed/deleted
               − ¬ compliance_policy(destination)
               − holdout CONTROL
               − customers with no usable identifier for this destination
     (one SQL statement producing a temp set; counts per rejection reason recorded on the job)
  3. DELTA against audience_destination_members:
        ADD    = ELIGIBLE  ∖ {state ∈ SYNCED, PENDING_ADD}
        REMOVE = {state = SYNCED} ∖ ELIGIBLE
     rows flip to PENDING_ADD / PENDING_REMOVE in the same transaction (checkpoint)
  4. batches of ≤ N (Meta 10k, Google 10k) → sync_job_batches (seq, op, customer_ids)
  5. for each batch: load hashed identifiers for the destination's hash profiles
        (customer_identifiers only — raw PII never touched) → adapter.addMembers/removeMembers
        → on success: members SYNCED / REMOVED, batch SUCCEEDED
        → on retryable error: exponential backoff with jitter, batch attempts++
        → on terminal error: batch FAILED, members FAILED with error_code; job continues
  6. adapter.getStatus() → matched/approximate counts → audience_destinations.matched_count
  7. job status: SUCCESS | SUCCESS_WITH_WARNINGS (some failed/skipped) | FAILED
```

A crashed worker resumes from the last committed batch: job is re-leased, batches in
`PENDING`/`SENT` are retried with the same `idempotency_key` (Meta session/batch_seq, Google
job + operation set), so re-sends are idempotent at the destination.

## D. Suppression & opt-out

```
unsubscribe / privacy request / deletion / complaint / fraud / legal
      → POST /suppression (or CONSENT_REVOKED / CUSTOMER_DELETED event)
      → suppression_records + customers.suppressed=true (+ consent flags false on revoke)
      → customers.updated_at bump
      → membership: stays (source truth) but eligibility = false everywhere
      → next sync of EVERY audience_destination containing the customer emits REMOVE
      → optional immediate "suppression sweep" job enqueues sync for all affected audience_destinations
```

## E. Measurement

```
destination metrics (pull, per campaign/day) → campaign_metrics_daily
orders (first-party truth) ⨝ holdout_assignments → audience_outcomes_daily (treatment vs control)
dashboard: spend/revenue/ROAS/CPA/CTR/CVR per audience; incremental revenue = treatment − control (rate × size)
```
