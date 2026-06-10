CREATE TABLE IF NOT EXISTS history_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_records_user_kind_id
  ON history_records(user_key, kind, id);

CREATE TABLE IF NOT EXISTS cutout_drafts (
  user_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stored_images (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_detail_prompts_user
  ON detail_prompts(user_key, created_at);
