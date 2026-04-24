-- ========================================
-- MIGL v3.0.0 PostgreSQL Schema
-- Multi-User, Multi-Branch Architecture
-- ========================================

-- Branches table
CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  phone VARCHAR(20),
  email VARCHAR(255),
  manager_id UUID,
  parent_branch_id UUID REFERENCES branches(id),
  status VARCHAR(20) DEFAULT 'active',
  region VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Roles table
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  tier_level INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Permissions table
CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  resource VARCHAR(100),
  action VARCHAR(50),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Role-Permission mapping
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  branch_id UUID REFERENCES branches(id),
  role_id UUID REFERENCES roles(id),
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP,
  mfa_enabled BOOLEAN DEFAULT false,
  mfa_secret VARCHAR(255),
  password_changed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User sessions
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  access_token_hash VARCHAR(255),
  refresh_token_hash VARCHAR(255),
  device_id VARCHAR(255),
  ip_address INET,
  user_agent TEXT,
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Clients table (updated for multi-branch)
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_number VARCHAR(50) NOT NULL,
  branch_id UUID REFERENCES branches(id) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  id_number VARCHAR(50),
  id_type VARCHAR(50),
  address TEXT,
  occupation VARCHAR(100),
  monthly_income NUMERIC(12, 2),
  status VARCHAR(20) DEFAULT 'active',
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_number, branch_id)
);

-- Loans table (updated for multi-branch & approvals)
CREATE TABLE IF NOT EXISTS loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_number VARCHAR(50) NOT NULL,
  client_id UUID REFERENCES clients(id) NOT NULL,
  branch_id UUID REFERENCES branches(id) NOT NULL,
  originated_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  amount NUMERIC(12, 2) NOT NULL,
  interest_rate NUMERIC(5, 2) DEFAULT 0,
  duration_months INTEGER,
  start_date DATE,
  due_date DATE,
  status VARCHAR(50) DEFAULT 'pending',
  approval_status VARCHAR(50) DEFAULT 'pending',
  approval_comment TEXT,
  daily_penalty_rate NUMERIC(5, 2) DEFAULT 5.0,
  grace_period_days INTEGER DEFAULT 0,
  collateral_value NUMERIC(12, 2),
  signature_data BYTEA,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(loan_number, branch_id)
);

-- Payments table (updated for multi-branch)
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID REFERENCES loans(id) NOT NULL,
  branch_id UUID REFERENCES branches(id) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  payment_date DATE NOT NULL,
  payment_method VARCHAR(50),
  recorded_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  receipt_number VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Penalties table (updated for multi-branch)
CREATE TABLE IF NOT EXISTS penalties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID REFERENCES loans(id) NOT NULL,
  branch_id UUID REFERENCES branches(id) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  penalty_type VARCHAR(50),
  applied_date DATE,
  reason TEXT,
  is_waived BOOLEAN DEFAULT false,
  waived_by UUID REFERENCES users(id),
  waived_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Collateral table (updated for multi-branch)
CREATE TABLE IF NOT EXISTS collateral (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID REFERENCES loans(id),
  client_id UUID REFERENCES clients(id),
  branch_id UUID REFERENCES branches(id) NOT NULL,
  description TEXT,
  value NUMERIC(12, 2),
  image_url TEXT,
  document_url TEXT,
  status VARCHAR(50) DEFAULT 'held',
  is_forfeited BOOLEAN DEFAULT false,
  forfeited_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Approvals & Dual-Control
CREATE TABLE IF NOT EXISTS approval_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  branch_id UUID REFERENCES branches(id),
  status VARCHAR(50) DEFAULT 'pending',
  created_by UUID REFERENCES users(id) NOT NULL,
  approved_by UUID REFERENCES users(id),
  rejected_by UUID REFERENCES users(id),
  approval_comment TEXT,
  rejection_reason TEXT,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit Log (immutable)
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  branch_id UUID REFERENCES branches(id),
  changes JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Accounts table (Chart of Accounts)
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number VARCHAR(50) UNIQUE NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  account_type VARCHAR(50),
  branch_id UUID REFERENCES branches(id),
  balance NUMERIC(15, 2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Transactions table (GL posting)
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id),
  branch_id UUID REFERENCES branches(id),
  debit NUMERIC(15, 2) DEFAULT 0,
  credit NUMERIC(15, 2) DEFAULT 0,
  description TEXT,
  reference_type VARCHAR(50),
  reference_id UUID,
  posted_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Backups metadata
CREATE TABLE IF NOT EXISTS backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type VARCHAR(50),
  backup_path TEXT,
  size_bytes BIGINT,
  branch_id UUID REFERENCES branches(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Balance Sheets (periodic snapshots)
CREATE TABLE IF NOT EXISTS balance_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_date DATE NOT NULL,
  branch_id UUID REFERENCES branches(id),
  total_assets NUMERIC(15, 2),
  total_liabilities NUMERIC(15, 2),
  total_equity NUMERIC(15, 2),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period_date, branch_id)
);

-- Licenses (per-machine or server-wide)
CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key VARCHAR(255) UNIQUE NOT NULL,
  machine_id VARCHAR(255),
  tier VARCHAR(50),
  user_limit INTEGER,
  branch_limit INTEGER,
  client_limit INTEGER,
  loan_limit INTEGER,
  expires_at DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Settings (server-wide config)
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) UNIQUE NOT NULL,
  value TEXT,
  value_type VARCHAR(50),
  is_sensitive BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_clients_branch_id ON clients(branch_id);
CREATE INDEX idx_loans_branch_id ON loans(branch_id);
CREATE INDEX idx_loans_client_id ON loans(client_id);
CREATE INDEX idx_payments_loan_id ON payments(loan_id);
CREATE INDEX idx_penalties_loan_id ON penalties(loan_id);
CREATE INDEX idx_users_branch_id ON users(branch_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_branch ON audit_logs(branch_id);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX idx_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_transactions_account_id ON transactions(account_id);
