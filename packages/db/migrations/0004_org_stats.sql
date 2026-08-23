-- =============================================================================
-- 0004 — pre-aggregated organization statistics for dashboards (never count(*) 50M rows per page view)
-- =============================================================================
CREATE TABLE organization_stats (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  stats           jsonb NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  duration_ms     integer
);
