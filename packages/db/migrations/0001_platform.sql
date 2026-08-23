-- =============================================================================
-- 0001_platform — organizations, users, sessions, api keys, audit, retention
-- =============================================================================
-- All ids for low-volume config entities are uuid; high-volume tables use bigint identity.
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_bytes (available on Supabase/RDS/Cloud SQL)

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- timezone, currency, default_policy_id, features
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  name            text NOT NULL DEFAULT '',
  password_hash   text,                 -- null for SSO-only users
  is_super_admin  boolean NOT NULL DEFAULT false,
  disabled_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);
CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email));

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('SUPER_ADMIN','ADMIN','MARKETING_MANAGER','CAMPAIGN_MANAGER','ANALYST','VIEW_ONLY')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- active org
  token_hash      bytea NOT NULL UNIQUE,       -- sha256(session token); raw token only in cookie
  expires_at      timestamptz NOT NULL,
  ip              inet,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  key_prefix      text NOT NULL,               -- first 12 chars, shown in UI
  key_hash        bytea NOT NULL UNIQUE,       -- sha256(full key)
  scopes          text[] NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX api_keys_org_idx ON api_keys (organization_id);

-- Audit log: who / what / when / where / before / after. Retention configurable (default 7y).
CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('USER','API_KEY','SYSTEM')),
  actor_id        uuid,
  actor_label     text NOT NULL DEFAULT '',   -- e.g. user email or api key name (never customer PII)
  action          text NOT NULL,              -- AUDIENCE_CREATED, AUDIENCE_ACTIVATED, DESTINATION_CONNECTED, ...
  entity_type     text,
  entity_id       text,
  before          jsonb,
  after           jsonb,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip              inet,
  user_agent      text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (organization_id, occurred_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (organization_id, entity_type, entity_id);

-- Organization-configurable retention. Nothing legal is hard-coded.
CREATE TABLE retention_policies (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_class      text NOT NULL,  -- raw_events | cart_events | audit_logs | membership_history | sync_batches | deleted_customers | sessions
  retention_days  integer NOT NULL CHECK (retention_days > 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, data_class)
);

-- Durable job queue (Postgres implementation of JobQueue). BullMQ is an alternative backend.
CREATE TABLE job_queue (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue           text NOT NULL,
  name            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  priority        integer NOT NULL DEFAULT 100,
  run_at          timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','DEAD')),
  locked_at       timestamptz,
  locked_by       text,
  lease_seconds   integer NOT NULL DEFAULT 600,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE UNIQUE INDEX job_queue_idem_uidx ON job_queue (idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('PENDING','RUNNING');
CREATE INDEX job_queue_poll_idx ON job_queue (queue, priority, run_at) WHERE status = 'PENDING';
CREATE INDEX job_queue_running_idx ON job_queue (locked_at) WHERE status = 'RUNNING';
