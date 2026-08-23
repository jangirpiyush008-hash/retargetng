-- =============================================================================
-- 0003 — audiences, membership, destinations, distribution, sync jobs, measurement
-- =============================================================================

CREATE TABLE audiences (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  slug                  text NOT NULL,                 -- e.g. CART_ABANDONERS_1_3D
  description           text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  current_rule_version  integer NOT NULL DEFAULT 0,
  evaluation_schedule   text NOT NULL DEFAULT 'HOURLY' CHECK (evaluation_schedule IN ('REALTIME','HOURLY','EVERY_6_HOURS','DAILY','MANUAL')),
  priority              integer NOT NULL DEFAULT 100,   -- lower = higher priority
  template_key          text,
  tags                  text[] NOT NULL DEFAULT '{}',
  holdout_percent       numeric(5,2) NOT NULL DEFAULT 0 CHECK (holdout_percent >= 0 AND holdout_percent < 100),
  holdout_salt          text NOT NULL DEFAULT encode(gen_random_bytes(8), 'hex'),
  distribution_policy   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {primaryOnly:boolean, identifierKinds:[EMAIL,PHONE], fatigue:{...}}
  recommendation        jsonb,                                  -- campaign recommendation snapshot
  -- cached counters (maintained by the membership engine; dashboards never count(*) big tables)
  member_count          bigint NOT NULL DEFAULT 0,
  eligible_count        bigint NOT NULL DEFAULT 0,
  added_today           bigint NOT NULL DEFAULT 0,
  removed_today         bigint NOT NULL DEFAULT 0,
  last_evaluated_at     timestamptz,
  next_evaluation_at    timestamptz,
  last_eval_mode        text,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  UNIQUE (organization_id, slug)
);
CREATE INDEX audiences_org_status_idx ON audiences (organization_id, status);
CREATE INDEX audiences_due_idx ON audiences (next_evaluation_at) WHERE status = 'ACTIVE';

-- Versioned rule definitions; the audience points at current_rule_version.
CREATE TABLE audience_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience_id   uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  definition    jsonb NOT NULL,          -- rule AST
  compiled_sql  text,                    -- cached for inspection/debugging
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audience_id, version)
);

-- Exclusions: members of excluded audiences are removed at eligibility time.
CREATE TABLE audience_exclusions (
  audience_id          uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  excluded_audience_id uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audience_id, excluded_audience_id),
  CHECK (audience_id <> excluded_audience_id)
);
CREATE INDEX audience_exclusions_excluded_idx ON audience_exclusions (excluded_audience_id);

-- Membership: the SOURCE set produced by the rule predicate.
CREATE TABLE audience_members (
  audience_id       uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  customer_id       bigint NOT NULL,
  organization_id   uuid NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXITED')),
  is_primary        boolean NOT NULL DEFAULT false,
  entered_at        timestamptz NOT NULL,
  exited_at         timestamptz,
  last_evaluated_at timestamptz NOT NULL,
  rule_version      integer NOT NULL,
  PRIMARY KEY (audience_id, customer_id)
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
-- "which audiences is this customer in" (priority, exclusions, customer detail)
CREATE INDEX audience_members_customer_idx ON audience_members (customer_id, audience_id) WHERE status = 'ACTIVE';
-- counts by status (index-only)
CREATE INDEX audience_members_status_idx ON audience_members (audience_id, status);

-- Change feed of membership transitions — monthly partitions. Used for: history charts,
-- incremental sync windows, dependent-audience candidate extraction, priority recompute.
CREATE TABLE audience_membership_history (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  organization_id uuid NOT NULL,
  audience_id     uuid NOT NULL,
  customer_id     bigint NOT NULL,
  action          text NOT NULL CHECK (action IN ('ENTER','EXIT')),
  reason          text,
  rule_version    integer,
  eval_run_id     uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX amh_audience_time_idx ON audience_membership_history (audience_id, occurred_at);
CREATE INDEX amh_customer_idx ON audience_membership_history (customer_id, occurred_at DESC);
CREATE TABLE audience_membership_history_default PARTITION OF audience_membership_history DEFAULT;
SELECT ensure_monthly_partitions('audience_membership_history', (now() - interval '1 month')::date, (now() + interval '3 months')::date);

CREATE TABLE audience_eval_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  audience_id     uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  mode            text NOT NULL CHECK (mode IN ('FULL','INCREMENTAL','RECONCILE','PREVIEW')),
  status          text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCESS','FAILED','CANCELLED')),
  rule_version    integer NOT NULL,
  watermark_from  timestamptz,
  watermark_to    timestamptz,
  candidates      bigint NOT NULL DEFAULT 0,
  entered         bigint NOT NULL DEFAULT 0,
  exited          bigint NOT NULL DEFAULT 0,
  duration_ms     integer,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX audience_eval_runs_audience_idx ON audience_eval_runs (audience_id, started_at DESC);

CREATE TABLE audience_stats_daily (
  audience_id     uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  day             date NOT NULL,
  member_count    bigint NOT NULL DEFAULT 0,
  eligible_count  bigint NOT NULL DEFAULT 0,
  entered         bigint NOT NULL DEFAULT 0,
  exited          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (audience_id, day)
);

-- ---------------------------------------------------------------------------
-- Destinations = a connected advertising platform; destination_accounts = ad accounts under it.
-- Credentials are NEVER stored: credential_ref points into the SecretStore.
-- ---------------------------------------------------------------------------
CREATE TABLE destinations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type              text NOT NULL,                 -- META | GOOGLE_ADS | MOCK_META | MOCK_GOOGLE | (TIKTOK, SNAPCHAT, TRADE_DESK...)
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONNECTED','DISCONNECTED','ERROR')),
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret: business_id, api_version, login_customer_id, ...
  credential_ref    text,                                 -- e.g. secret://meta/acct_demo/access_token
  connection_status jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {ok, checked_at, message, scopes}
  last_tested_at    timestamptz,
  last_sync_at      timestamptz,
  last_error        text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX destinations_org_idx ON destinations (organization_id, type);

CREATE TABLE destination_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id      uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL,
  external_account_id text NOT NULL,      -- act_123 (Meta) / 1234567890 (Google customer id)
  name                text NOT NULL,
  currency            char(3),
  timezone            text,
  is_default          boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'ACTIVE',
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (destination_id, external_account_id)
);
CREATE INDEX destination_accounts_org_idx ON destination_accounts (organization_id);

-- An audience activated on a destination account (the distribution policy instance).
CREATE TABLE audience_destinations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  audience_id            uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  destination_account_id uuid NOT NULL REFERENCES destination_accounts(id) ON DELETE CASCADE,
  external_audience_id   text,
  external_audience_name text,
  status                 text NOT NULL DEFAULT 'PENDING_CREATE'
                           CHECK (status IN ('PENDING_CREATE','ACTIVE','PAUSED','ERROR','DELETING','DELETED')),
  sync_mode              text NOT NULL DEFAULT 'INCREMENTAL' CHECK (sync_mode IN ('INCREMENTAL','FULL_REFRESH')),
  sync_schedule          text CHECK (sync_schedule IN ('REALTIME','HOURLY','EVERY_6_HOURS','DAILY','MANUAL')),  -- NULL = audience default
  compliance_policy_id   uuid REFERENCES compliance_policies(id) ON DELETE SET NULL,
  last_sync_job_id       uuid,
  last_synced_at         timestamptz,
  next_sync_at           timestamptz,
  last_error             text,
  -- funnel counters (last completed sync)
  source_count           bigint NOT NULL DEFAULT 0,
  eligible_count         bigint NOT NULL DEFAULT 0,
  submitted_count        bigint NOT NULL DEFAULT 0,   -- cumulative members currently SYNCED at destination
  matched_count          bigint,                      -- platform-reported (nullable: Meta gives ranges)
  matched_lower          bigint,
  matched_upper          bigint,
  match_rate             numeric(6,2),
  platform_status        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audience_id, destination_account_id)
);
CREATE INDEX audience_destinations_org_idx ON audience_destinations (organization_id, status);
CREATE INDEX audience_destinations_due_idx ON audience_destinations (next_sync_at) WHERE status = 'ACTIVE';

-- Per-destination member state: the delta-sync source of truth.
CREATE TABLE audience_destination_members (
  audience_destination_id uuid NOT NULL REFERENCES audience_destinations(id) ON DELETE CASCADE,
  customer_id             bigint NOT NULL,
  state                   text NOT NULL CHECK (state IN ('PENDING_ADD','SYNCED','PENDING_REMOVE','REMOVED','FAILED','SKIPPED')),
  last_sync_job_id        uuid,
  last_attempt_at         timestamptz,
  attempts                integer NOT NULL DEFAULT 0,
  last_error_code         text,
  identifier_kinds        text[] NOT NULL DEFAULT '{}',
  added_at                timestamptz,
  removed_at              timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audience_destination_id, customer_id)
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
CREATE INDEX adm_state_idx ON audience_destination_members (audience_destination_id, state);

-- Sync jobs: one per synchronization run (checkpointed; never loses state).
CREATE TABLE sync_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  audience_id             uuid NOT NULL,
  audience_destination_id uuid NOT NULL REFERENCES audience_destinations(id) ON DELETE CASCADE,
  destination_account_id  uuid NOT NULL,
  trigger                 text NOT NULL CHECK (trigger IN ('SCHEDULED','MANUAL','EVENT','INITIAL','SUPPRESSION','RETRY')),
  mode                    text NOT NULL CHECK (mode IN ('INCREMENTAL','FULL','DRY_RUN','REMOVE_ALL')),
  status                  text NOT NULL DEFAULT 'QUEUED'
                            CHECK (status IN ('QUEUED','RUNNING','SUCCESS','SUCCESS_WITH_WARNINGS','FAILED','CANCELLED','PAUSED')),
  idempotency_key         text,
  started_at              timestamptz,
  finished_at             timestamptz,
  -- funnel / outcome counters
  records_evaluated       bigint NOT NULL DEFAULT 0,
  source_count            bigint NOT NULL DEFAULT 0,
  eligible_count          bigint NOT NULL DEFAULT 0,
  excluded_by_audience    bigint NOT NULL DEFAULT 0,
  suppressed_count        bigint NOT NULL DEFAULT 0,
  consent_denied_count    bigint NOT NULL DEFAULT 0,
  consent_unknown_count   bigint NOT NULL DEFAULT 0,
  consent_expired_count   bigint NOT NULL DEFAULT 0,
  no_identifier_count     bigint NOT NULL DEFAULT 0,
  holdout_count           bigint NOT NULL DEFAULT 0,
  added                   bigint NOT NULL DEFAULT 0,
  removed                 bigint NOT NULL DEFAULT 0,
  skipped                 bigint NOT NULL DEFAULT 0,
  failed                  bigint NOT NULL DEFAULT 0,
  batches_total           integer NOT NULL DEFAULT 0,
  batches_done            integer NOT NULL DEFAULT 0,
  checkpoint              jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings                jsonb NOT NULL DEFAULT '[]'::jsonb,
  error                   text,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_jobs_idem_uidx ON sync_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX sync_jobs_org_time_idx ON sync_jobs (organization_id, created_at DESC);
CREATE INDEX sync_jobs_ad_idx ON sync_jobs (audience_destination_id, created_at DESC);
CREATE INDEX sync_jobs_status_idx ON sync_jobs (status) WHERE status IN ('QUEUED','RUNNING');

-- Batches (≤ 10k members each) — monthly partitions; stores the member ids for replay/retry.
CREATE TABLE sync_job_batches (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  sync_job_id        uuid NOT NULL,
  organization_id    uuid NOT NULL,
  seq                integer NOT NULL,
  operation          text NOT NULL CHECK (operation IN ('ADD','REMOVE')),
  member_count       integer NOT NULL,
  customer_ids       bigint[] NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','SUCCEEDED','FAILED','SKIPPED')),
  attempts           integer NOT NULL DEFAULT 0,
  external_ref       text,                 -- Meta session_id / Google requestId
  response_summary   jsonb,                -- {num_received, num_invalid_entries, ...} never PII samples
  error_code         text,
  error_message      text,
  next_attempt_at    timestamptz,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX sync_job_batches_job_idx ON sync_job_batches (sync_job_id, seq);
CREATE TABLE sync_job_batches_default PARTITION OF sync_job_batches DEFAULT;
SELECT ensure_monthly_partitions('sync_job_batches', (now() - interval '1 month')::date, (now() + interval '3 months')::date);

-- ---------------------------------------------------------------------------
-- Measurement
-- ---------------------------------------------------------------------------
CREATE TABLE campaigns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  destination_account_id uuid REFERENCES destination_accounts(id) ON DELETE SET NULL,
  external_campaign_id   text,
  name                   text NOT NULL,
  objective              text,
  status                 text NOT NULL DEFAULT 'ACTIVE',
  start_date             date,
  end_date               date,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_org_idx ON campaigns (organization_id);

CREATE TABLE campaign_audiences (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  audience_id uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, audience_id)
);

CREATE TABLE campaign_metrics_daily (
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  day              date NOT NULL,
  impressions      bigint NOT NULL DEFAULT 0,
  clicks           bigint NOT NULL DEFAULT 0,
  spend            numeric(14,2) NOT NULL DEFAULT 0,
  conversions      bigint NOT NULL DEFAULT 0,
  conversion_value numeric(14,2) NOT NULL DEFAULT 0,
  reach            bigint,
  frequency        numeric(8,3),
  PRIMARY KEY (campaign_id, day)
);

-- Holdout groups (deterministic assignment by hash(salt, customer_id)).
CREATE TABLE holdout_assignments (
  audience_id  uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  customer_id  bigint NOT NULL,
  "group"      text NOT NULL CHECK ("group" IN ('TREATMENT','CONTROL')),
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audience_id, customer_id)
);

-- Per-audience per-day first-party outcomes for treatment vs control.
CREATE TABLE audience_outcomes_daily (
  audience_id  uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  day          date NOT NULL,
  "group"      text NOT NULL CHECK ("group" IN ('TREATMENT','CONTROL')),
  customers    bigint NOT NULL DEFAULT 0,
  converters   bigint NOT NULL DEFAULT 0,
  orders       bigint NOT NULL DEFAULT 0,
  revenue      numeric(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (audience_id, day, "group")
);

-- Ad-interaction / fatigue signals per customer (only when a platform supplies them).
CREATE TABLE customer_ad_exposure (
  organization_id      uuid NOT NULL,
  customer_id          bigint NOT NULL,
  destination_type     text NOT NULL,
  impressions_7d       integer NOT NULL DEFAULT 0,
  clicks_7d            integer NOT NULL DEFAULT 0,
  last_impression_at   timestamptz,
  last_click_at        timestamptz,
  last_conversion_at   timestamptz,
  frequency_7d         numeric(8,3),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, destination_type)
);

-- Webhooks (outbound notifications)
CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url             text NOT NULL,
  events          text[] NOT NULL,
  secret_ref      text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (created_at) WHERE status = 'PENDING';
