CREATE TABLE IF NOT EXISTS history_records (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_records_user_kind_id
  ON history_records(user_key, kind, id);

CREATE TABLE IF NOT EXISTS cutout_drafts (
  user_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stored_images (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stored_images_user
  ON stored_images(user_key, created_at);

CREATE TABLE IF NOT EXISTS detail_prompts (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  source_task_id TEXT,
  prompt_index INTEGER,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_detail_prompts_user
  ON detail_prompts(user_key, created_at);

CREATE TABLE IF NOT EXISTS admin_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_users (
  user_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  image TEXT,
  role TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_login_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_users_last_login
  ON managed_users(last_login_at);

CREATE TABLE IF NOT EXISTS user_usage (
  user_key TEXT PRIMARY KEY,
  remaining_credits INTEGER NOT NULL,
  used_credits INTEGER NOT NULL,
  granted_credits INTEGER NOT NULL,
  daily_usage_date TEXT,
  daily_used_credits INTEGER NOT NULL DEFAULT 0,
  credit_model_version INTEGER NOT NULL DEFAULT 2,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_generated_at BIGINT
);

CREATE TABLE IF NOT EXISTS access_codes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_text TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT,
  last_used_at BIGINT,
  use_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_code_hashes (
  code_hash TEXT PRIMARY KEY,
  code_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_codes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_text TEXT NOT NULL,
  credits INTEGER NOT NULL,
  max_redemptions INTEGER NOT NULL,
  redeem_count INTEGER NOT NULL,
  active BOOLEAN NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT,
  last_redeemed_at BIGINT
);

CREATE TABLE IF NOT EXISTS redeem_code_hashes (
  code_hash TEXT PRIMARY KEY,
  code_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_code_uses (
  code_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  redeemed_at BIGINT NOT NULL,
  PRIMARY KEY (code_id, user_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_code_uses_once
  ON redeem_code_uses(code_id);
