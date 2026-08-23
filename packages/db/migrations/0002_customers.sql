-- =============================================================================
-- 0002_customers — customer 360, identity, consent, suppression, catalog, orders, events
-- =============================================================================

-- ---------------------------------------------------------------------------
-- customers: one row per canonical first-party customer. Raw PII encrypted,
-- hashes for identity/activation. Aggregates are denormalized here and
-- maintained by the event processor (never computed by scanning orders at read time).
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id                                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id                    uuid NOT NULL,
  external_customer_id               text,
  source                             text,                       -- store / brand / system of record
  -- identity (PII encrypted with AES-256-GCM; hash = sha256(normalized value))
  email_encrypted                    bytea,
  email_hash                         bytea,                      -- 32 bytes, sha256(lower(trim(email)))
  phone_encrypted                    bytea,
  phone_hash                         bytea,                      -- 32 bytes, sha256(E.164)
  email_valid                        boolean,
  phone_valid                        boolean,
  -- geo (only where legally permissible)
  country                            char(2),
  region                             text,
  city                               text,
  -- commerce aggregates
  first_order_at                     timestamptz,
  last_order_at                      timestamptz,
  order_count                        integer NOT NULL DEFAULT 0,
  total_revenue                      numeric(14,2) NOT NULL DEFAULT 0,
  average_order_value                numeric(14,2) NOT NULL DEFAULT 0,
  lifetime_value                     numeric(14,2) NOT NULL DEFAULT 0,   -- revenue - refunds
  refund_count                       integer NOT NULL DEFAULT 0,
  refund_amount                      numeric(14,2) NOT NULL DEFAULT 0,
  cancelled_count                    integer NOT NULL DEFAULT 0,
  purchase_frequency_days            numeric(10,2),              -- avg days between orders
  -- behavior
  last_cart_at                       timestamptz,
  has_open_cart                      boolean NOT NULL DEFAULT false,
  open_cart_id                       text,
  cart_event_count                   integer NOT NULL DEFAULT 0,
  last_product_view_at               timestamptz,
  last_activity_at                   timestamptz,
  -- lifecycle state machine
  lifecycle_state                    text NOT NULL DEFAULT 'PROSPECT'
                                       CHECK (lifecycle_state IN ('PROSPECT','CART_ABANDONER','PURCHASER','REPEAT_PURCHASER','VIP',
                                                                  'INACTIVE_30D','INACTIVE_60D','LAPSED_90D','LAPSED_180D','LAPSED_365D')),
  lifecycle_state_changed_at         timestamptz,
  status                             text NOT NULL DEFAULT 'ACTIVE',     -- source status: ACTIVE / DISABLED / GUEST ...
  -- consent (derived from consent_events)
  consent_status                     text NOT NULL DEFAULT 'UNKNOWN' CHECK (consent_status IN ('GRANTED','DENIED','UNKNOWN','EXPIRED')),
  marketing_allowed                  boolean NOT NULL DEFAULT false,
  advertising_personalization_allowed boolean NOT NULL DEFAULT false,
  data_sharing_allowed               boolean NOT NULL DEFAULT false,
  consent_updated_at                 timestamptz,
  -- privacy
  suppressed                         boolean NOT NULL DEFAULT false,
  suppressed_at                      timestamptz,
  deleted                            boolean NOT NULL DEFAULT false,
  deleted_at                         timestamptz,
  -- long tail
  attributes                         jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at                  timestamptz,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);

-- ingestion upsert path
CREATE UNIQUE INDEX customers_org_external_uidx ON customers (organization_id, external_customer_id) WHERE external_customer_id IS NOT NULL;
-- identity resolution / dedupe
CREATE INDEX customers_org_email_hash_idx ON customers (organization_id, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX customers_org_phone_hash_idx ON customers (organization_id, phone_hash) WHERE phone_hash IS NOT NULL;
-- incremental candidate extraction (dirty customers since watermark) — most important index
CREATE INDEX customers_org_updated_idx ON customers (organization_id, updated_at);
-- recency / lapsed / dormant time bands
CREATE INDEX customers_org_last_order_idx ON customers (organization_id, last_order_at);
CREATE INDEX customers_org_last_activity_idx ON customers (organization_id, last_activity_at);
-- cart abandoner windows: tiny partial index over open carts only
CREATE INDEX customers_org_open_cart_idx ON customers (organization_id, last_cart_at) WHERE has_open_cart;
-- value thresholds
CREATE INDEX customers_org_revenue_idx ON customers (organization_id, total_revenue);
-- state + geo
CREATE INDEX customers_org_lifecycle_idx ON customers (organization_id, lifecycle_state);
CREATE INDEX customers_org_country_idx ON customers (organization_id, country);
-- suppression sweeps
CREATE INDEX customers_org_suppressed_idx ON customers (organization_id) WHERE suppressed;
-- NOT indexed on purpose: order_count, consent flags, marketing_allowed (low cardinality; applied
-- after more selective predicates or over an already-selected member set).

-- ---------------------------------------------------------------------------
-- Activation identifiers: hashes per destination hash profile. Activation reads
-- ONLY this table (never raw PII). Profiles: EMAIL_SHA256 (lower/trim),
-- EMAIL_SHA256_GOOGLE (lower/trim + gmail dot removal), PHONE_E164_SHA256 (+E.164),
-- PHONE_DIGITS_SHA256 (digits only, Meta).
-- ---------------------------------------------------------------------------
CREATE TABLE customer_identifiers (
  organization_id uuid NOT NULL,
  customer_id     bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('EMAIL','PHONE')),
  hash_profile    text NOT NULL,
  hash            bytea NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, kind, hash_profile)
);
CREATE INDEX customer_identifiers_lookup_idx ON customer_identifiers (organization_id, kind, hash_profile, hash);

-- Identity history: append-only record of identifier changes so old identifiers still resolve.
CREATE TABLE identity_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id     bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('EMAIL','PHONE','EXTERNAL_ID')),
  previous_hash   bytea,
  new_hash        bytea,
  source          text,
  reason          text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_history_prev_idx ON identity_history (organization_id, kind, previous_hash) WHERE previous_hash IS NOT NULL;
CREATE INDEX identity_history_customer_idx ON identity_history (customer_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Consent (append-only) and derived state on customers.
-- ---------------------------------------------------------------------------
CREATE TABLE consent_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id     bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event_type      text NOT NULL CHECK (event_type IN ('CONSENT_GRANTED','CONSENT_REVOKED','CONSENT_UPDATED')),
  purposes        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {marketing:bool, advertising_personalization:bool, data_sharing:bool}
  source          text,                                 -- checkout, preference_center, import, api
  legal_basis     text,                                 -- consent, legitimate_interest, contract
  jurisdiction    text,
  evidence        jsonb,                                -- policy version, form id (no PII)
  event_id        text,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_events_customer_idx ON consent_events (customer_id, occurred_at DESC);
CREATE INDEX consent_events_org_time_idx ON consent_events (organization_id, occurred_at DESC);

-- Suppression: first-class, can target a customer or a bare identifier hash (tombstone).
CREATE TABLE suppression_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id     bigint REFERENCES customers(id) ON DELETE SET NULL,
  identifier_kind text CHECK (identifier_kind IN ('EMAIL','PHONE')),
  identifier_hash bytea,
  reason          text NOT NULL CHECK (reason IN ('UNSUBSCRIBE','PRIVACY_REQUEST','CUSTOMER_DELETION','ADVERTISING_OPT_OUT',
                                                  'LEGAL_RESTRICTION','INTERNAL_BLACKLIST','FRAUD','CUSTOMER_COMPLAINT','OTHER')),
  scope           text NOT NULL DEFAULT 'GLOBAL',       -- GLOBAL or destination type (META/GOOGLE_ADS)
  source          text,
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX suppression_customer_idx ON suppression_records (customer_id) WHERE revoked_at IS NULL;
CREATE INDEX suppression_hash_idx ON suppression_records (organization_id, identifier_kind, identifier_hash) WHERE identifier_hash IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX suppression_org_time_idx ON suppression_records (organization_id, created_at DESC);

-- Compliance policies: configurable per org × destination type; JSON rules compiled to SQL.
CREATE TABLE compliance_policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  destination_type text,                               -- NULL = default for all destinations
  is_default       boolean NOT NULL DEFAULT false,
  rules            jsonb NOT NULL,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_policies_org_idx ON compliance_policies (organization_id, destination_type);

CREATE TABLE deletion_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id     bigint,
  identifier_kind text,
  identifier_hash bytea,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  requested_by    text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX deletion_requests_org_idx ON deletion_requests (organization_id, status, requested_at);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id      uuid NOT NULL,
  external_category_id text NOT NULL,
  name                 text NOT NULL,
  parent_id            bigint REFERENCES categories(id),
  path                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_category_id)
);

CREATE TABLE products (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id     uuid NOT NULL,
  external_product_id text NOT NULL,
  name                text NOT NULL,
  sku                 text,
  brand               text,
  category_id         bigint REFERENCES categories(id),
  price               numeric(14,2),
  currency            char(3),
  active              boolean NOT NULL DEFAULT true,
  attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_product_id)
);
CREATE INDEX products_org_category_idx ON products (organization_id, category_id);
CREATE INDEX products_org_name_idx ON products (organization_id, lower(name) text_pattern_ops);

-- Cross-sell / upsell / replenishment relationships feed the product-level templates.
CREATE TABLE product_relationships (
  organization_id    uuid NOT NULL,
  product_id         bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  related_product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('CROSS_SELL','UPSELL','REPLENISHMENT','BUNDLE')),
  weight             numeric(6,3) NOT NULL DEFAULT 1,
  replenish_days     integer,
  PRIMARY KEY (organization_id, product_id, related_product_id, kind)
);

-- ---------------------------------------------------------------------------
-- Orders (heap in v1; partition by ordered_at when > ~300M rows — see docs/08)
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   uuid NOT NULL,
  customer_id       bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  external_order_id text NOT NULL,
  status            text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED')),
  currency          char(3) NOT NULL DEFAULT 'INR',
  subtotal          numeric(14,2) NOT NULL DEFAULT 0,
  discount          numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  refunded_amount   numeric(14,2) NOT NULL DEFAULT 0,
  item_count        integer NOT NULL DEFAULT 0,
  cart_id           text,
  source            text,
  ordered_at        timestamptz NOT NULL,
  cancelled_at      timestamptz,
  refunded_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_order_id)
);
CREATE INDEX orders_customer_idx ON orders (customer_id, ordered_at DESC);
CREATE INDEX orders_org_time_idx ON orders (organization_id, ordered_at);

CREATE TABLE order_items (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  order_id        bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id     bigint NOT NULL,
  product_id      bigint REFERENCES products(id),
  category_id     bigint REFERENCES categories(id),
  quantity        integer NOT NULL DEFAULT 1,
  unit_price      numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  ordered_at      timestamptz NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_org_product_idx ON order_items (organization_id, product_id, ordered_at);

-- Materialized per-customer product/category aggregates: product audiences never scan order_items.
CREATE TABLE customer_product_purchases (
  organization_id    uuid NOT NULL,
  customer_id        bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id         bigint NOT NULL,
  first_purchased_at timestamptz NOT NULL,
  last_purchased_at  timestamptz NOT NULL,
  purchase_count     integer NOT NULL DEFAULT 1,
  quantity           integer NOT NULL DEFAULT 1,
  revenue            numeric(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, product_id)
) WITH (fillfactor = 85);
CREATE INDEX cpp_org_product_idx ON customer_product_purchases (organization_id, product_id, last_purchased_at);

CREATE TABLE customer_category_purchases (
  organization_id    uuid NOT NULL,
  customer_id        bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  category_id        bigint NOT NULL,
  first_purchased_at timestamptz NOT NULL,
  last_purchased_at  timestamptz NOT NULL,
  purchase_count     integer NOT NULL DEFAULT 1,
  revenue            numeric(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, category_id)
) WITH (fillfactor = 85);
CREATE INDEX ccp_org_category_idx ON customer_category_purchases (organization_id, category_id, last_purchased_at);

-- Views / carts per product (for "viewed product X", "carted product X" audiences)
CREATE TABLE customer_product_interactions (
  organization_id uuid NOT NULL,
  customer_id     bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id      bigint NOT NULL,
  interaction     text NOT NULL CHECK (interaction IN ('VIEWED','CARTED')),
  first_at        timestamptz NOT NULL,
  last_at         timestamptz NOT NULL,
  count           integer NOT NULL DEFAULT 1,
  PRIMARY KEY (customer_id, product_id, interaction)
) WITH (fillfactor = 85);
CREATE INDEX cpi_org_product_idx ON customer_product_interactions (organization_id, interaction, product_id, last_at);

-- ---------------------------------------------------------------------------
-- Cart events — monthly RANGE partitions (high volume, time-pruned retention)
-- ---------------------------------------------------------------------------
CREATE TABLE cart_events (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  organization_id uuid NOT NULL,
  customer_id     bigint NOT NULL,
  cart_id         text,
  event_type      text NOT NULL CHECK (event_type IN ('ADD_TO_CART','REMOVE_FROM_CART','CHECKOUT_STARTED','CART_CONVERTED')),
  product_id      bigint,
  quantity        integer,
  value           numeric(14,2),
  event_id        text,
  occurred_at     timestamptz NOT NULL,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX cart_events_customer_idx ON cart_events (customer_id, occurred_at DESC);
CREATE INDEX cart_events_org_time_idx ON cart_events (organization_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Raw customer events (event log) — monthly RANGE partitions.
-- Idempotency: UNIQUE (organization_id, event_id, occurred_at). A replayed event carries the
-- same occurred_at; the partition key must be part of any unique index on a partitioned table.
-- ---------------------------------------------------------------------------
CREATE TABLE customer_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY,
  organization_id      uuid NOT NULL,
  event_id             text NOT NULL,
  event_type           text NOT NULL CHECK (event_type IN ('CUSTOMER_CREATED','CUSTOMER_UPDATED','PRODUCT_VIEWED','ADD_TO_CART',
                                            'CHECKOUT_STARTED','PURCHASE_COMPLETED','ORDER_CANCELLED','ORDER_REFUNDED',
                                            'CONSENT_GRANTED','CONSENT_REVOKED','CUSTOMER_DELETED')),
  customer_id          bigint,                       -- resolved at processing time
  external_customer_id text,
  source               text,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- raw PII inside is encrypted by the ingestion layer (see core/events)
  payload_hash         bytea NOT NULL,
  processing_status    text NOT NULL DEFAULT 'PENDING' CHECK (processing_status IN ('PENDING','PROCESSED','FAILED','SKIPPED')),
  processing_error     text,
  occurred_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  PRIMARY KEY (id, occurred_at),
  UNIQUE (organization_id, event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX customer_events_pending_idx ON customer_events (organization_id, received_at) WHERE processing_status = 'PENDING';
CREATE INDEX customer_events_customer_idx ON customer_events (customer_id, occurred_at DESC) WHERE customer_id IS NOT NULL;

-- Data sources & ingestion runs
CREATE TABLE data_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('CSV','S3','API','POSTGRES','MYSQL','BIGQUERY','SNOWFLAKE','SHOPIFY','WEBHOOK','SYNTHETIC')),
  name            text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret configuration
  credential_ref  text,
  schedule        text,
  status          text NOT NULL DEFAULT 'ACTIVE',
  last_run_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingestion_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  data_source_id  uuid REFERENCES data_sources(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCESS','SUCCESS_WITH_WARNINGS','FAILED','CANCELLED')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  rows_read       bigint NOT NULL DEFAULT 0,
  rows_upserted   bigint NOT NULL DEFAULT 0,
  rows_rejected   bigint NOT NULL DEFAULT 0,
  events_emitted  bigint NOT NULL DEFAULT 0,
  checkpoint      jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_by    uuid
);
CREATE INDEX ingestion_runs_org_idx ON ingestion_runs (organization_id, started_at DESC);

-- Data quality snapshots (score + per-check results; never samples of PII)
CREATE TABLE data_quality_snapshots (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  score           numeric(5,2) NOT NULL,
  checks          jsonb NOT NULL
);
CREATE INDEX dq_org_idx ON data_quality_snapshots (organization_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- Partition management helper: ensure monthly partitions exist for a window.
-- Called by migrations (initial window) and by the maintenance job (rolling).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(p_table text, p_from date, p_to date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d date := date_trunc('month', p_from)::date; part text;
BEGIN
  WHILE d < p_to LOOP
    part := format('%s_%s', p_table, to_char(d, 'YYYYMM'));
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                     part, p_table, d, (d + interval '1 month')::date);
    END IF;
    d := (d + interval '1 month')::date;
  END LOOP;
END $$;

-- default partitions catch anything outside the managed window (e.g., very old backfills)
CREATE TABLE cart_events_default PARTITION OF cart_events DEFAULT;
CREATE TABLE customer_events_default PARTITION OF customer_events DEFAULT;
SELECT ensure_monthly_partitions('cart_events', (now() - interval '36 months')::date, (now() + interval '3 months')::date);
SELECT ensure_monthly_partitions('customer_events', (now() - interval '36 months')::date, (now() + interval '3 months')::date);
