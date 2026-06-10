import type { RedeemCodeRow } from "@/lib/types";
import type { HistoryD1Database } from "./historyStorage";
import { requireAdminDb } from "./users";

interface RedeemCodeRecord {
  id: string;
  label: string;
  codeHash: string;
  codeText: string;
  credits: number;
  maxRedemptions: number;
  redeemCount: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastRedeemedAt?: number;
}

interface RedeemUseRecord {
  id: string;
  codeId: string;
  userKey: string;
  credits: number;
  redeemedAt: number;
}

interface RedeemCodeRowRecord {
  id: string;
  label: string;
  code_hash: string;
  code_text: string;
  credits: number;
  max_redemptions: number;
  redeem_count: number;
  active: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  last_redeemed_at?: number | null;
}

export interface RedeemCodeEnv {
  HISTORY_DB?: HistoryD1Database;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SINGLE_USE_REDEMPTION_LIMIT = 1;

function normalizeCode(code: string) {
  return code.trim().replace(/[\s-]+/g, "").toUpperCase();
}

function normalizeCredits(value: number | undefined) {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(999, Math.round(value ?? 5)));
}

async function hashCode(code: string) {
  const bytes = new TextEncoder().encode(normalizeCode(code));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function createCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `RDM-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

function fromRow(row: RedeemCodeRowRecord): RedeemCodeRecord {
  return {
    id: row.id,
    label: row.label,
    codeHash: row.code_hash,
    codeText: row.code_text,
    credits: row.credits,
    maxRedemptions: row.max_redemptions,
    redeemCount: row.redeem_count,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    lastRedeemedAt: row.last_redeemed_at ?? undefined,
  };
}

function toRow(record: RedeemCodeRecord): RedeemCodeRow {
  return {
    id: record.id,
    label: record.label,
    code: record.codeText,
    credits: record.credits,
    maxRedemptions: record.maxRedemptions,
    redeemCount: record.redeemCount,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    lastRedeemedAt: record.lastRedeemedAt,
  };
}

async function writeRedeemCode(db: HistoryD1Database, record: RedeemCodeRecord) {
  await db
    .prepare(
      `INSERT INTO redeem_codes
        (id, label, code_hash, code_text, credits, max_redemptions, redeem_count,
         active, created_at, updated_at, created_by, last_redeemed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET
         label = excluded.label,
         code_hash = excluded.code_hash,
         code_text = excluded.code_text,
         credits = excluded.credits,
         max_redemptions = excluded.max_redemptions,
         redeem_count = excluded.redeem_count,
         active = excluded.active,
         updated_at = excluded.updated_at,
         created_by = excluded.created_by,
         last_redeemed_at = excluded.last_redeemed_at`,
    )
    .bind(
      record.id,
      record.label,
      record.codeHash,
      record.codeText,
      record.credits,
      record.maxRedemptions,
      record.redeemCount,
      record.active ? 1 : 0,
      record.createdAt,
      record.updatedAt,
      record.createdBy,
      record.lastRedeemedAt ?? null,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO redeem_code_hashes (code_hash, code_id)
       VALUES (?, ?)
       ON CONFLICT(code_hash)
       DO UPDATE SET code_id = excluded.code_id`,
    )
    .bind(record.codeHash, record.id)
    .run();
}

async function readRedeemCode(db: HistoryD1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT id, label, code_hash, credits, max_redemptions, redeem_count,
        code_text, active, created_at, updated_at, created_by, last_redeemed_at
       FROM redeem_codes
       WHERE id = ?`,
    )
    .bind(id)
    .first<RedeemCodeRowRecord>();
  return row ? fromRow(row) : null;
}

async function readRedeemCodeByHash(db: HistoryD1Database, hash: string) {
  const hashRow = await db
    .prepare(`SELECT code_id FROM redeem_code_hashes WHERE code_hash = ?`)
    .bind(hash)
    .first<{ code_id: string }>();
  if (hashRow?.code_id) {
    return readRedeemCode(db, hashRow.code_id);
  }
  return null;
}

async function writeRedeemUse(db: HistoryD1Database, record: RedeemUseRecord) {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO redeem_code_uses
        (code_id, user_key, id, credits, redeemed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(record.codeId, record.userKey, record.id, record.credits, record.redeemedAt)
    .run();
  return result.meta?.changes ?? 1;
}

export async function listRedeemCodes(env: RedeemCodeEnv) {
  const db = await requireAdminDb(env, "兑换码表");
  const result = await db
    .prepare(
      `SELECT id, label, code_hash, credits, max_redemptions, redeem_count,
        code_text, active, created_at, updated_at, created_by, last_redeemed_at
       FROM redeem_codes
       ORDER BY created_at DESC`,
    )
    .all<RedeemCodeRowRecord>();
  return (result.results ?? []).map(fromRow).map(toRow);
}

export async function createRedeemCodeRecord(
  env: RedeemCodeEnv,
  options: {
    label?: string;
    code?: string;
    credits?: number;
    createdBy?: string | null;
  },
) {
  const db = await requireAdminDb(env, "兑换码表");
  const code = options.code ? normalizeCode(options.code) : createCode();
  const normalizedCode = normalizeCode(code);
  if (normalizedCode.length < 6) throw new Error("兑换码至少需要 6 位");

  const codeHash = await hashCode(normalizedCode);
  if (await readRedeemCodeByHash(db, codeHash)) {
    throw new Error("兑换码已存在，请换一个");
  }

  const now = Date.now();
  const record: RedeemCodeRecord = {
    id: crypto.randomUUID(),
    label: options.label?.trim() || `兑换码 ${new Date(now).toLocaleDateString("zh-CN")}`,
    codeHash,
    codeText: code,
    credits: normalizeCredits(options.credits),
    maxRedemptions: SINGLE_USE_REDEMPTION_LIMIT,
    redeemCount: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: options.createdBy ?? null,
  };
  await writeRedeemCode(db, record);

  return {
    redeemCode: toRow(record),
    code,
  };
}

export async function updateRedeemCodeRecord(
  env: RedeemCodeEnv,
  id: string,
  patch: { label?: string; active?: boolean },
) {
  const db = await requireAdminDb(env, "兑换码表");
  const record = await readRedeemCode(db, id);
  if (!record) throw new Error("兑换码不存在");

  const next: RedeemCodeRecord = {
    ...record,
    label: patch.label?.trim() || record.label,
    active: typeof patch.active === "boolean" ? patch.active : record.active,
    updatedAt: Date.now(),
  };
  await writeRedeemCode(db, next);
  return toRow(next);
}

export async function redeemCodeRecord(env: RedeemCodeEnv, code: string, userKey: string) {
  const db = await requireAdminDb(env, "兑换码表");
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("请输入兑换码");

  const hash = await hashCode(normalized);
  const record = await readRedeemCodeByHash(db, hash);
  if (!record || record.codeHash !== hash) throw new Error("兑换码不正确");
  if (!record.active) throw new Error("兑换码已停用");
  if (record.redeemCount >= SINGLE_USE_REDEMPTION_LIMIT) throw new Error("兑换码已被兑换");

  const now = Date.now();
  const useRecord: RedeemUseRecord = {
    id: crypto.randomUUID(),
    codeId: record.id,
    userKey,
    credits: record.credits,
    redeemedAt: now,
  };

  const insertedUses = await writeRedeemUse(db, useRecord);
  if (!insertedUses) throw new Error("兑换码已被兑换");

  const updateResult = await db
    .prepare(
      `UPDATE redeem_codes
       SET redeem_count = redeem_count + 1,
         max_redemptions = ?,
         last_redeemed_at = ?,
         updated_at = ?
       WHERE id = ? AND redeem_count < ?`,
    )
    .bind(SINGLE_USE_REDEMPTION_LIMIT, now, now, record.id, SINGLE_USE_REDEMPTION_LIMIT)
    .run();

  if ((updateResult.meta?.changes ?? 0) < 1) {
    await db
      .prepare(`DELETE FROM redeem_code_uses WHERE code_id = ? AND user_key = ?`)
      .bind(record.id, userKey)
      .run();
    throw new Error("兑换码已被兑换");
  }

  const next = await readRedeemCode(db, record.id);
  if (!next) throw new Error("兑换码不存在");

  return {
    redeemCode: toRow(next),
    credits: record.credits,
  };
}
