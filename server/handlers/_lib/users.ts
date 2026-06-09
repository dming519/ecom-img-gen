import type { AuthUser, AdminUserRow, UserRole } from "@/lib/types";
import type { HistoryD1Database } from "./historyStorage";

const DAILY_IMAGE_CREDITS = 10;
const DAILY_RESET_OFFSET_MS = 8 * 60 * 60 * 1000;

type AuthProvider = AuthUser["provider"];

interface KvListResult {
  keys: Array<{ name: string }>;
  cursor?: string;
  list_complete?: boolean;
}

export interface UserKvNamespace {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  list?: (options?: { prefix?: string; cursor?: string; limit?: number }) => Promise<KvListResult>;
}

export interface UserEnv {
  HISTORY_DB?: HistoryD1Database;
  TASKS_KV?: UserKvNamespace;
}

interface UserRecord {
  userKey: string;
  provider: AuthProvider;
  providerId: string;
  name: string;
  email: string | null;
  image: string | null;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number;
}

interface UsageRecord {
  userKey: string;
  remainingCredits: number;
  usedCredits: number;
  grantedCredits: number;
  dailyUsageDate: string;
  dailyUsedCredits: number;
  createdAt: number;
  updatedAt: number;
  lastGeneratedAt?: number;
}

interface UserRow {
  user_key: string;
  provider: AuthProvider;
  provider_id: string;
  name: string;
  email: string | null;
  image: string | null;
  role: UserRole;
  created_at: number;
  updated_at: number;
  last_login_at: number;
}

interface UsageRow {
  user_key: string;
  remaining_credits: number;
  used_credits: number;
  granted_credits: number;
  daily_usage_date?: string | null;
  daily_used_credits?: number | null;
  created_at: number;
  updated_at: number;
  last_generated_at?: number | null;
}

const META_ADMIN = "meta:superAdminUserKey";
const USERS_INDEX = "users:index";

function userRecordKey(userKey: string) {
  return `user:${userKey}`;
}

function usageRecordKey(userKey: string) {
  return `usage:${userKey}`;
}

function getUsageDay(timestamp = Date.now()) {
  return new Date(timestamp + DAILY_RESET_OFFSET_MS).toISOString().slice(0, 10);
}

function clampDailyUsed(value: unknown) {
  return Math.min(
    DAILY_IMAGE_CREDITS,
    Math.max(0, Number.isFinite(value) ? Math.round(Number(value)) : 0),
  );
}

function getDailyUsageSnapshot(usage: UsageRecord, now = Date.now()) {
  const usageDay = getUsageDay(now);
  const used = usage.dailyUsageDate === usageDay ? clampDailyUsed(usage.dailyUsedCredits) : 0;
  return {
    usageDay,
    used,
    remaining: Math.max(0, DAILY_IMAGE_CREDITS - used),
    limit: DAILY_IMAGE_CREDITS,
  };
}

function normalizeDailyUsage(usage: UsageRecord, now = Date.now()) {
  const snapshot = getDailyUsageSnapshot(usage, now);
  const normalized: UsageRecord = {
    ...usage,
    dailyUsageDate: snapshot.usageDay,
    dailyUsedCredits: snapshot.used,
    remainingCredits: snapshot.remaining,
    grantedCredits: snapshot.limit,
  };
  return normalized;
}

function dailyUsageChanged(before: UsageRecord, after: UsageRecord) {
  return (
    before.dailyUsageDate !== after.dailyUsageDate ||
    before.dailyUsedCredits !== after.dailyUsedCredits ||
    before.remainingCredits !== after.remainingCredits ||
    before.grantedCredits !== after.grantedCredits
  );
}

function normalizeRole(role: string | undefined): UserRole {
  if (role === "super_admin" || role === "admin") return role;
  return "user";
}

export function getUserKey(user: AuthUser) {
  return user.userKey || `${user.provider}:${user.id}`;
}

async function readJson<T>(kv: UserKvNamespace, key: string) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function ensureAdminSchema(db: HistoryD1Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS admin_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS managed_users (
      user_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      image TEXT,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_managed_users_last_login
      ON managed_users(last_login_at)`,
    `CREATE TABLE IF NOT EXISTS user_usage (
      user_key TEXT PRIMARY KEY,
      remaining_credits INTEGER NOT NULL,
      used_credits INTEGER NOT NULL,
      granted_credits INTEGER NOT NULL,
      daily_usage_date TEXT,
      daily_used_credits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_generated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS access_codes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS access_code_hashes (
      code_hash TEXT PRIMARY KEY,
      code_id TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS redeem_codes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      credits INTEGER NOT NULL,
      max_redemptions INTEGER NOT NULL,
      redeem_count INTEGER NOT NULL,
      active INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT,
      last_redeemed_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS redeem_code_hashes (
      code_hash TEXT PRIMARY KEY,
      code_id TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS redeem_code_uses (
      code_id TEXT NOT NULL,
      user_key TEXT NOT NULL,
      id TEXT NOT NULL,
      credits INTEGER NOT NULL,
      redeemed_at INTEGER NOT NULL,
      PRIMARY KEY (code_id, user_key)
    )`,
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
  }

  await ensureUserUsageDailyColumns(db);
}

async function ensureUserUsageDailyColumns(db: HistoryD1Database) {
  const columns = await db.prepare(`PRAGMA table_info(user_usage)`).all<{ name: string }>();
  const names = new Set((columns.results ?? []).map((column) => column.name));
  if (!names.has("daily_usage_date")) {
    await db.prepare(`ALTER TABLE user_usage ADD COLUMN daily_usage_date TEXT`).run();
  }
  if (!names.has("daily_used_credits")) {
    await db
      .prepare(`ALTER TABLE user_usage ADD COLUMN daily_used_credits INTEGER NOT NULL DEFAULT 0`)
      .run();
  }
}

export async function requireAdminDb(env: UserEnv, label = "管理数据表") {
  const db = env.HISTORY_DB;
  if (!db) throw new Error(`服务端未配置 ${label} D1 数据库`);
  await ensureAdminSchema(db);
  return db;
}

function fromUserRow(row: UserRow): UserRecord {
  return {
    userKey: row.user_key,
    provider: row.provider,
    providerId: row.provider_id,
    name: row.name,
    email: row.email,
    image: row.image,
    role: normalizeRole(row.role),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function fromUsageRow(row: UsageRow): UsageRecord {
  return {
    userKey: row.user_key,
    remainingCredits: row.remaining_credits,
    usedCredits: row.used_credits,
    grantedCredits: row.granted_credits,
    dailyUsageDate: row.daily_usage_date ?? "",
    dailyUsedCredits: clampDailyUsed(row.daily_used_credits),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastGeneratedAt: row.last_generated_at ?? undefined,
  };
}

function toSessionUser(record: UserRecord, usage: UsageRecord): AuthUser {
  const snapshot = getDailyUsageSnapshot(usage);
  return {
    provider: record.provider,
    id: record.providerId,
    userKey: record.userKey,
    name: record.name,
    email: record.email,
    image: record.image,
    role: record.role,
    remainingCredits: snapshot.remaining,
    usedCredits: snapshot.used,
    grantedCredits: snapshot.limit,
  };
}

function toAdminRow(record: UserRecord, usage: UsageRecord): AdminUserRow {
  const snapshot = getDailyUsageSnapshot(usage);
  return {
    userKey: record.userKey,
    provider: record.provider,
    providerId: record.providerId,
    name: record.name,
    email: record.email,
    image: record.image,
    role: record.role,
    remainingCredits: snapshot.remaining,
    usedCredits: snapshot.used,
    grantedCredits: snapshot.limit,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastLoginAt: record.lastLoginAt,
  };
}

async function readMeta(db: HistoryD1Database, key: string) {
  const row = await db
    .prepare(`SELECT value FROM admin_meta WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeMeta(db: HistoryD1Database, key: string, value: string) {
  await db
    .prepare(
      `INSERT INTO admin_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, Date.now())
    .run();
}

async function readSuperAdminKey(env: UserEnv, db: HistoryD1Database) {
  const existing = await readMeta(db, META_ADMIN);
  if (existing) return existing;
  const kvFallback = await env.TASKS_KV?.get(META_ADMIN);
  if (kvFallback) await writeMeta(db, META_ADMIN, kvFallback);
  return kvFallback ?? null;
}

async function readUserRecord(db: HistoryD1Database, userKey: string) {
  const row = await db
    .prepare(
      `SELECT user_key, provider, provider_id, name, email, image, role,
        created_at, updated_at, last_login_at
       FROM managed_users
       WHERE user_key = ?`,
    )
    .bind(userKey)
    .first<UserRow>();
  return row ? fromUserRow(row) : null;
}

async function writeUserRecord(db: HistoryD1Database, record: UserRecord) {
  await db
    .prepare(
      `INSERT INTO managed_users
        (user_key, provider, provider_id, name, email, image, role,
         created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_key)
       DO UPDATE SET
         provider = excluded.provider,
         provider_id = excluded.provider_id,
         name = excluded.name,
         email = excluded.email,
         image = excluded.image,
         role = excluded.role,
         updated_at = excluded.updated_at,
         last_login_at = excluded.last_login_at`,
    )
    .bind(
      record.userKey,
      record.provider,
      record.providerId,
      record.name,
      record.email,
      record.image,
      record.role,
      record.createdAt,
      record.updatedAt,
      record.lastLoginAt,
    )
    .run();
}

async function readUsageRecord(db: HistoryD1Database, userKey: string) {
  const row = await db
    .prepare(
      `SELECT user_key, remaining_credits, used_credits, granted_credits,
        daily_usage_date, daily_used_credits,
        created_at, updated_at, last_generated_at
       FROM user_usage
       WHERE user_key = ?`,
    )
    .bind(userKey)
    .first<UsageRow>();
  return row ? fromUsageRow(row) : null;
}

async function writeUsageRecord(db: HistoryD1Database, usage: UsageRecord) {
  await db
    .prepare(
      `INSERT INTO user_usage
        (user_key, remaining_credits, used_credits, granted_credits,
         daily_usage_date, daily_used_credits,
         created_at, updated_at, last_generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_key)
       DO UPDATE SET
         remaining_credits = excluded.remaining_credits,
         used_credits = excluded.used_credits,
         granted_credits = excluded.granted_credits,
         daily_usage_date = excluded.daily_usage_date,
         daily_used_credits = excluded.daily_used_credits,
         updated_at = excluded.updated_at,
         last_generated_at = excluded.last_generated_at`,
    )
    .bind(
      usage.userKey,
      usage.remainingCredits,
      usage.usedCredits,
      usage.grantedCredits,
      usage.dailyUsageDate,
      usage.dailyUsedCredits,
      usage.createdAt,
      usage.updatedAt,
      usage.lastGeneratedAt ?? null,
    )
    .run();
}

async function readKvFallbackUser(env: UserEnv, userKey: string) {
  return env.TASKS_KV
    ? readJson<UserRecord>(env.TASKS_KV, userRecordKey(userKey))
    : null;
}

async function readKvFallbackUsage(env: UserEnv, userKey: string) {
  return env.TASKS_KV
    ? readJson<UsageRecord>(env.TASKS_KV, usageRecordKey(userKey))
    : null;
}

async function readUsage(
  env: UserEnv,
  db: HistoryD1Database,
  userKey: string,
  now = Date.now(),
) {
  const existing = await readUsageRecord(db, userKey);
  if (existing) {
    const normalized = normalizeDailyUsage(existing, now);
    if (dailyUsageChanged(existing, normalized)) {
      await writeUsageRecord(db, normalized);
    }
    return normalized;
  }
  const kvFallback = await readKvFallbackUsage(env, userKey);
  if (kvFallback) {
    const normalized = normalizeDailyUsage(
      {
        ...kvFallback,
        dailyUsageDate: kvFallback.dailyUsageDate ?? "",
        dailyUsedCredits: clampDailyUsed(kvFallback.dailyUsedCredits),
      },
      now,
    );
    await writeUsageRecord(db, normalized);
    return normalized;
  }
  const created: UsageRecord = {
    userKey,
    remainingCredits: DAILY_IMAGE_CREDITS,
    usedCredits: 0,
    grantedCredits: DAILY_IMAGE_CREDITS,
    dailyUsageDate: getUsageDay(now),
    dailyUsedCredits: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeUsageRecord(db, created);
  return created;
}

async function importKvFallbackUsers(env: UserEnv, db: HistoryD1Database) {
  if (!env.TASKS_KV) return;

  const kvFallbackAdmin = await env.TASKS_KV.get(META_ADMIN);
  if (kvFallbackAdmin) await writeMeta(db, META_ADMIN, kvFallbackAdmin);

  let userKeys = (await readJson<string[]>(env.TASKS_KV, USERS_INDEX)) ?? [];
  if (!userKeys.length && env.TASKS_KV.list) {
    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await env.TASKS_KV.list({ prefix: "user:", cursor, limit: 1000 });
      listed.push(...result.keys.map((item) => item.name.replace(/^user:/, "")));
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    userKeys = listed;
  }

  for (const userKey of userKeys) {
    const record = await readKvFallbackUser(env, userKey);
    if (!record) continue;
    await writeUserRecord(db, record);
    await readUsage(env, db, userKey);
  }
}

export async function ensureManagedUser(env: UserEnv, authUser: AuthUser) {
  const db = env.HISTORY_DB;
  if (!db) {
    return {
      user: {
        ...authUser,
        userKey: getUserKey(authUser),
        role: normalizeRole(authUser.role),
      } satisfies AuthUser,
      record: null,
      usage: null,
    };
  }
  await ensureAdminSchema(db);

  const now = Date.now();
  const userKey = getUserKey(authUser);
  const existing = (await readUserRecord(db, userKey)) ?? (await readKvFallbackUser(env, userKey));
  if (existing && !(await readUserRecord(db, userKey))) {
    await writeUserRecord(db, existing);
  }
  const existingAdmin = await readSuperAdminKey(env, db);
  const canBecomeFirstAdmin = authUser.provider !== "access";
  const isFirstUser = !existingAdmin && canBecomeFirstAdmin;
  const isRegisteredSuperAdmin = existingAdmin === userKey;
  const role: UserRole =
    isFirstUser || isRegisteredSuperAdmin ? "super_admin" : normalizeRole(existing?.role);

  const record: UserRecord = {
    userKey,
    provider: authUser.provider,
    providerId: authUser.id,
    name: authUser.name,
    email: authUser.email,
    image: authUser.image,
    role,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastLoginAt: now,
  };

  await writeUserRecord(db, record);
  if (isFirstUser) {
    await writeMeta(db, META_ADMIN, userKey);
  }

  const usage = await readUsage(env, db, userKey, now);
  return {
    user: toSessionUser(record, usage),
    record,
    usage,
  };
}

export async function hydrateManagedUser(env: UserEnv, authUser: AuthUser) {
  const db = env.HISTORY_DB;
  if (!db) return ensureManagedUser(env, authUser);
  await ensureAdminSchema(db);

  const userKey = getUserKey(authUser);
  const record = (await readUserRecord(db, userKey)) ?? (await readKvFallbackUser(env, userKey));
  if (!record) return ensureManagedUser(env, authUser);
  if (!(await readUserRecord(db, userKey))) {
    await writeUserRecord(db, record);
  }

  const superAdminKey = await readSuperAdminKey(env, db);
  const role: UserRole =
    superAdminKey === userKey ? "super_admin" : normalizeRole(record.role);
  const normalizedRecord =
    role === record.role ? record : { ...record, role, updatedAt: Date.now() };
  if (normalizedRecord !== record) {
    await writeUserRecord(db, normalizedRecord);
  }

  const usage = await readUsage(env, db, userKey);
  return {
    user: toSessionUser(normalizedRecord, usage),
    record: normalizedRecord,
    usage,
  };
}

export async function consumeImageCreditByUserKey(env: UserEnv, userKey: string) {
  const db = await requireAdminDb(env, "用户次数表");
  let record = await readUserRecord(db, userKey);
  if (!record) {
    const kvFallback = await readKvFallbackUser(env, userKey);
    if (kvFallback) {
      await writeUserRecord(db, kvFallback);
      record = kvFallback;
    }
  }
  if (!record) throw new Error("用户不存在");

  const usage = await readUsage(env, db, userKey);
  const superAdminKey = await readSuperAdminKey(env, db);
  const role: UserRole =
    superAdminKey === userKey ? "super_admin" : normalizeRole(record.role);
  const normalizedRecord =
    role === record.role ? record : { ...record, role, updatedAt: Date.now() };
  if (normalizedRecord !== record) {
    await writeUserRecord(db, normalizedRecord);
  }

  const user = toSessionUser(normalizedRecord, usage);
  if (role === "super_admin") {
    return {
      user,
      usage,
      unlimited: true,
    };
  }
  const now = Date.now();
  const snapshot = getDailyUsageSnapshot(usage, now);
  if (snapshot.remaining <= 0) {
    throw new Error("今日 10 次生图机会已用完，请明天再试。");
  }

  const next: UsageRecord = {
    ...usage,
    remainingCredits: Math.max(0, snapshot.remaining - 1),
    usedCredits: usage.usedCredits + 1,
    grantedCredits: DAILY_IMAGE_CREDITS,
    dailyUsageDate: snapshot.usageDay,
    dailyUsedCredits: snapshot.used + 1,
    updatedAt: now,
    lastGeneratedAt: now,
  };
  await writeUsageRecord(db, next);

  return {
    user: {
      ...user,
      remainingCredits: next.remainingCredits,
      usedCredits: next.dailyUsedCredits,
      grantedCredits: DAILY_IMAGE_CREDITS,
    },
    usage: next,
    unlimited: false,
  };
}

export async function requireImageCredit(env: UserEnv, authUser: AuthUser) {
  const managed = await hydrateManagedUser(env, authUser);
  if (!env.HISTORY_DB || !managed.usage) {
    throw new Error("服务端未配置用户次数表");
  }
  if (managed.user.role === "super_admin") {
    return {
      user: managed.user,
      usage: managed.usage,
      unlimited: true,
    };
  }
  const snapshot = getDailyUsageSnapshot(managed.usage);
  if (snapshot.remaining <= 0) {
    throw new Error("今日 10 次生图机会已用完，请明天再试。");
  }
  return {
    user: managed.user,
    usage: managed.usage,
    unlimited: false,
  };
}

export async function grantImageCredits(env: UserEnv, authUser: AuthUser, amount: number) {
  const managed = await hydrateManagedUser(env, authUser);
  if (!managed.usage) throw new Error("服务端未配置用户次数表");
  const credits = Math.max(1, Math.min(999, Math.round(amount)));

  return {
    user: managed.user,
    usage: managed.usage,
    granted: credits,
  };
}

export async function listManagedUsers(env: UserEnv) {
  const db = await requireAdminDb(env, "用户表");
  await importKvFallbackUsers(env, db);
  const superAdminKey = await readSuperAdminKey(env, db);
  const result = await db
    .prepare(
      `SELECT user_key, provider, provider_id, name, email, image, role,
        created_at, updated_at, last_login_at
       FROM managed_users
       ORDER BY last_login_at DESC`,
    )
    .all<UserRow>();

  const rows: AdminUserRow[] = [];
  for (const row of result.results ?? []) {
    const record = fromUserRow(row);
    const role: UserRole =
      superAdminKey === record.userKey ? "super_admin" : normalizeRole(record.role);
    const normalizedRecord =
      role === record.role ? record : { ...record, role, updatedAt: Date.now() };
    if (normalizedRecord !== record) {
      await writeUserRecord(db, normalizedRecord);
    }
    const usage = await readUsage(env, db, normalizedRecord.userKey);
    rows.push(toAdminRow(normalizedRecord, usage));
  }

  return rows;
}

export async function updateManagedUser(
  env: UserEnv,
  userKey: string,
  patch: { role?: UserRole },
) {
  const db = await requireAdminDb(env, "用户表");
  let record = await readUserRecord(db, userKey);
  if (!record) {
    const kvFallback = await readKvFallbackUser(env, userKey);
    if (kvFallback) {
      await writeUserRecord(db, kvFallback);
      record = kvFallback;
    }
  }
  if (!record) throw new Error("用户不存在");

  const now = Date.now();
  const superAdminKey = await readSuperAdminKey(env, db);
  const isSuperAdmin = superAdminKey === userKey;
  let nextRecord = record;
  if (patch.role) {
    const nextRole: UserRole = isSuperAdmin
      ? "super_admin"
      : patch.role === "super_admin"
        ? "admin"
        : patch.role;
    nextRecord = { ...nextRecord, role: nextRole, updatedAt: now };
    await writeUserRecord(db, nextRecord);
  } else if (isSuperAdmin && nextRecord.role !== "super_admin") {
    nextRecord = { ...nextRecord, role: "super_admin", updatedAt: now };
    await writeUserRecord(db, nextRecord);
  }

  let usage = await readUsage(env, db, userKey, now);

  return toAdminRow(nextRecord, usage);
}
