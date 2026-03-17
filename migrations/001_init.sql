-- 001_init.sql
-- 
-- DEPRECATED: This migration is for reference only.
-- Aldaro uses Prisma migrations as the source of truth.
-- Run `npx prisma migrate dev` to apply schema changes.
--
-- This file has been updated to reflect Aldaro-owned GPU infrastructure.
-- NO EXTERNAL GPU PROVIDERS (RunPod, etc.) ARE SUPPORTED.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- USERS
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,

  account_status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | SUSPENDED
  payment_status TEXT NOT NULL DEFAULT 'NONE',   -- NONE | VALID | BLOCKED
  role TEXT NOT NULL DEFAULT 'CUSTOMER',         -- CUSTOMER | AUTHOR | ADMIN

  stripe_customer_id TEXT,
  stripe_default_payment_method_id TEXT,

  max_active_workspaces INT NOT NULL DEFAULT 1,
  max_concurrent_runs INT NOT NULL DEFAULT 2,
  daily_runtime_limit_minutes INT NOT NULL DEFAULT 360,
  daily_spend_limit_seconds INT NOT NULL DEFAULT 86400,
  launches_per_hour_limit INT NOT NULL DEFAULT 3,
  is_alpha_tester BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_users_created_at ON users(created_at);


-- FLEET NODES (Aldaro-owned Proxmox infrastructure)
CREATE TABLE fleet_nodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  api_host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | MAINTENANCE | OFFLINE
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);


-- FLEET GPUS (Physical GPUs in Aldaro fleet)
CREATE TABLE fleet_gpus (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  node_id UUID NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
  gpu_name TEXT NOT NULL,
  pci_address TEXT NOT NULL,
  vram_gb NUMERIC,
  serial TEXT,
  status TEXT NOT NULL DEFAULT 'FREE', -- FREE | ALLOCATED | FAILED
  failure_count INT NOT NULL DEFAULT 0,
  last_verification_pass_at TIMESTAMPTZ,
  last_verification_fail_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(node_id, pci_address)
);

CREATE INDEX idx_fleet_gpus_status ON fleet_gpus(status);


-- VM TEMPLATES
CREATE TABLE vm_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  proxmox_node TEXT NOT NULL,
  template_vmid INT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(proxmox_node, template_vmid)
);


-- WORKSPACES (backed by Aldaro fleet, NOT external providers)
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Proxmox backing (Aldaro-owned only)
  proxmox_node TEXT,
  proxmox_vmid INT,
  vm_internal_ip TEXT,

  -- Gateway exposure
  gateway_host TEXT,
  port_ssh INT,
  port_jupyter INT,
  port_vscode INT,

  region TEXT NOT NULL DEFAULT 'US',
  gpu_type TEXT NOT NULL,
  gpu_count INT NOT NULL DEFAULT 1,
  image_type TEXT NOT NULL DEFAULT 'BASE_ML_V1',

  status TEXT NOT NULL, -- CREATING | WAITING_FOR_AGENT | VERIFYING | WARM_AVAILABLE | ASSIGNING | RUNNING_ASSIGNED | TERMINATING | TERMINATED | FAILED

  is_warm_pool BOOLEAN NOT NULL DEFAULT false,
  assigned_user_id UUID REFERENCES users(id),

  connect_ssh_command TEXT,
  connect_jupyter_url TEXT,
  connect_vscode_url TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,

  verification_status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | PASS | FAIL
  verification_score INT,
  last_health_check_at TIMESTAMPTZ,

  last_agent_heartbeat_at TIMESTAMPTZ,
  last_gpu_utilization_pct INT,
  last_network_rx_mb INT,
  last_network_tx_mb INT
);

CREATE INDEX idx_workspaces_status ON workspaces(status);
CREATE INDEX idx_workspaces_assigned_user_id ON workspaces(assigned_user_id);
CREATE INDEX idx_workspaces_is_warm_pool ON workspaces(is_warm_pool);


-- GPU ALLOCATIONS (links workspace to fleet GPU)
CREATE TABLE workspace_gpu_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  gpu_id UUID NOT NULL UNIQUE REFERENCES fleet_gpus(id),
  node_id UUID NOT NULL REFERENCES fleet_nodes(id),
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);


-- WORKSPACE ENDPOINTS (gateway port allocations)
CREATE TABLE workspace_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  gateway_host TEXT NOT NULL,
  ssh_port INT NOT NULL UNIQUE,
  jupyter_port INT NOT NULL UNIQUE,
  vscode_port INT NOT NULL UNIQUE,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);


-- VERIFICATION RUNS
CREATE TABLE workspace_verifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  gpu_name TEXT,
  vram_gb NUMERIC,
  cuda_version TEXT,
  driver_version TEXT,

  disk_read_mb_s NUMERIC,
  disk_write_mb_s NUMERIC,

  net_down_mbps NUMERIC,
  net_up_mbps NUMERIC,

  micro_train_seconds NUMERIC,

  score_0_100 INT NOT NULL,
  pass BOOLEAN NOT NULL,

  raw_log TEXT
);

CREATE INDEX idx_workspace_verifications_workspace_id ON workspace_verifications(workspace_id);
CREATE INDEX idx_workspace_verifications_ran_at ON workspace_verifications(ran_at);


-- USAGE SESSIONS (BILLING SOURCE OF TRUTH)
CREATE TABLE usage_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),

  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,

  total_seconds INT NOT NULL DEFAULT 0,
  price_per_hour_cents INT NOT NULL DEFAULT 0,
  billed_cents INT NOT NULL DEFAULT 0,

  stripe_payment_intent_id TEXT,

  status TEXT NOT NULL DEFAULT 'RUNNING' -- RUNNING | ENDED | CHARGED | FAILED
);

CREATE INDEX idx_usage_sessions_user_id ON usage_sessions(user_id);
CREATE INDEX idx_usage_sessions_workspace_id ON usage_sessions(workspace_id);
CREATE INDEX idx_usage_sessions_status ON usage_sessions(status);


-- SECURITY LOGS
CREATE TABLE security_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  event_data TEXT
);

CREATE INDEX idx_security_logs_created_at ON security_logs(created_at);
CREATE INDEX idx_security_logs_event_type ON security_logs(event_type);
CREATE INDEX idx_security_logs_user_id ON security_logs(user_id);


-- WARM POOL CONFIG
CREATE TABLE warm_pool_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  region TEXT NOT NULL DEFAULT 'US',
  gpu_type TEXT NOT NULL,
  target_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(region, gpu_type)
);


-- GPU SKUS (pricing)
CREATE TABLE gpu_skus (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  price_per_hour_cents INT NOT NULL,
  vram_gb INT NOT NULL,
  short_badge TEXT NOT NULL,
  description_lines TEXT NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
