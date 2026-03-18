-- Organizations table
CREATE TABLE organizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  stripe_default_payment_method_id TEXT,
  billing_email TEXT,
  plan TEXT NOT NULL DEFAULT 'TEAM',
  max_members INT NOT NULL DEFAULT 5,
  max_active_workspaces INT NOT NULL DEFAULT 5,
  max_concurrent_runs INT NOT NULL DEFAULT 10,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Organization memberships
CREATE TABLE org_memberships (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'MEMBER',
  invited_by_id TEXT REFERENCES users(id),
  invited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at DATETIME,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, user_id)
);

-- Add org_id to workspaces (nullable for backward compat)
ALTER TABLE workspaces ADD COLUMN org_id TEXT REFERENCES organizations(id);

-- Add org_id to projects (nullable for backward compat)
ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES organizations(id);

-- Org-level invitations
CREATE TABLE org_invitations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  invited_by_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, email)
);

CREATE INDEX idx_org_memberships_org ON org_memberships(org_id);
CREATE INDEX idx_org_memberships_user ON org_memberships(user_id);
CREATE INDEX idx_workspaces_org ON workspaces(org_id);
CREATE INDEX idx_projects_org ON projects(org_id);
