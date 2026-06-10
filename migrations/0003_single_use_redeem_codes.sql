CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_code_uses_once
  ON redeem_code_uses(code_id);
