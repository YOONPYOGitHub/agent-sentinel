CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_findings_tenant ON findings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings((data->>'severity'));

CREATE TABLE IF NOT EXISTS validation_runs (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_validation_runs_finding ON validation_runs(finding_id);
