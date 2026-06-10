import type { AccessCodeRow, AuthUser } from "@/lib/types";
import { requireAdminDb } from "./users";
import type { HistoryD1Database } from "./historyStorage";

interface AccessCodeRecord {
  id: string;
  label: string;
  codeHash: string;
  codeText: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastUsedAt?: number;
  useCount: number;
}

interface AccessCodeRowRecord {
  id: string;
  label: string;
  code_hash: string;
  code_text?: string | null;
  active: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  last_used_at?: number | null;
  use_count: number;
}

export interface AccessCodeEnv {
  ACCESS_LOGIN_CODE?: string;
  HISTORY_DB?: HistoryD1Database;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeCode(code: string) {
  return code.trim().replace(/[\s-]+/g, "").toUpperCase();
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
  return `EIG-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

function fromRow(row: AccessCodeRowRecord): AccessCodeRecord {
  return {
    id: row.id,
    label: row.label,
    codeHash: row.code_hash,
    codeText: row.code_text ?? null,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at ?? undefined,
    useCount: row.use_count,
  };
}

function toRow(record: AccessCodeRecord): AccessCodeRow {
  return {
    id: record.id,
    label: record.label,
    code: record.codeText,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    lastUsedAt: record.lastUsedAt,
    useCount: record.useCount,
  };
}

async function writeAccessCode(db: HistoryD1Database, record: AccessCodeRecord) {
  await db
    .prepare(
      `INSERT INTO access_codes
        (id, label, code_hash, code_text, active, created_at, updated_at,
         created_by, last_used_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id)
       DO UPDATE SET
         label = excluded.label,
         code_hash = excluded.code_hash,
         code_text = COALESCE(excluded.code_text, access_codes.code_text),
         active = excluded.active,
         updated_at = excluded.updated_at,
         created_by = excluded.created_by,
         last_used_at = excluded.last_used_at,
         use_count = excluded.use_count`,
    )
    .bind(
      record.id,
      record.label,
      record.codeHash,
      record.codeText,
      record.active ? 1 : 0,
      record.createdAt,
      record.updatedAt,
      record.createdBy,
      record.lastUsedAt ?? null,
      record.useCount,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO access_code_hashes (code_hash, code_id)
       VALUES (?, ?)
       ON CONFLICT(code_hash)
       DO UPDATE SET code_id = excluded.code_id`,
    )
    .bind(record.codeHash, record.id)
    .run();
}

async function readAccessCode(db: HistoryD1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT id, label, code_hash, active, created_at, updated_at,
        code_text, created_by, last_used_at, use_count
       FROM access_codes
       WHERE id = ?`,
    )
    .bind(id)
    .first<AccessCodeRowRecord>();
  return row ? fromRow(row) : null;
}

async function readAccessCodeByHash(db: HistoryD1Database, hash: string) {
  const hashRow = await db
    .prepare(`SELECT code_id FROM access_code_hashes WHERE code_hash = ?`)
    .bind(hash)
    .first<{ code_id: string }>();
  if (hashRow?.code_id) {
    return readAccessCode(db, hashRow.code_id);
  }
  return null;
}

export async function resolveAccessCodeUser(env: AccessCodeEnv, code: string) {
  const normalized = normalizeCode(code);
  const envCode = normalizeCode(env.ACCESS_LOGIN_CODE ?? "");
  if (envCode && normalized === envCode) {
    return {
      provider: "access",
      id: "access-code",
      name: "访问码用户",
      email: null,
      image: null,
    } satisfies AuthUser;
  }
  if (!normalized || !env.HISTORY_DB) return null;

  const db = await requireAdminDb(env, "访问码表");
  const hash = await hashCode(normalized);
  const record = await readAccessCodeByHash(db, hash);
  if (!record || !record.active || record.codeHash !== hash) return null;

  const next: AccessCodeRecord = {
    ...record,
    lastUsedAt: Date.now(),
    updatedAt: Date.now(),
    useCount: record.useCount + 1,
  };
  await writeAccessCode(db, next);

  return {
    provider: "access",
    id: record.id,
    name: record.label ? `访问码：${record.label}` : "访问码用户",
    email: null,
    image: null,
  } satisfies AuthUser;
}

export async function listAccessCodes(env: AccessCodeEnv) {
  const db = await requireAdminDb(env, "访问码表");
  const result = await db
    .prepare(
      `SELECT id, label, code_hash, active, created_at, updated_at,
        code_text, created_by, last_used_at, use_count
       FROM access_codes
       ORDER BY created_at DESC`,
    )
    .all<AccessCodeRowRecord>();
  return (result.results ?? []).map(fromRow).map(toRow);
}

export async function createAccessCodeRecord(
  env: AccessCodeEnv,
  options: { label?: string; code?: string; createdBy?: string | null },
) {
  const db = await requireAdminDb(env, "访问码表");
  const code = options.code ? normalizeCode(options.code) : createCode();
  const normalizedCode = normalizeCode(code);
  if (normalizedCode.length < 6) throw new Error("访问码至少需要 6 位");

  const codeHash = await hashCode(normalizedCode);
  if (await readAccessCodeByHash(db, codeHash)) {
    throw new Error("访问码已存在，请换一个");
  }

  const now = Date.now();
  const record: AccessCodeRecord = {
    id: crypto.randomUUID(),
    label: options.label?.trim() || `访问码 ${new Date(now).toLocaleDateString("zh-CN")}`,
    codeHash,
    codeText: code,
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: options.createdBy ?? null,
    useCount: 0,
  };
  await writeAccessCode(db, record);

  return {
    accessCode: toRow(record),
    code,
  };
}

export async function updateAccessCodeRecord(
  env: AccessCodeEnv,
  id: string,
  patch: { label?: string; active?: boolean },
) {
  const db = await requireAdminDb(env, "访问码表");
  const record = await readAccessCode(db, id);
  if (!record) throw new Error("访问码不存在");

  const next: AccessCodeRecord = {
    ...record,
    label: patch.label?.trim() || record.label,
    active: typeof patch.active === "boolean" ? patch.active : record.active,
    updatedAt: Date.now(),
  };
  await writeAccessCode(db, next);
  return toRow(next);
}
