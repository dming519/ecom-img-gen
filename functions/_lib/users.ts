import type { AuthProvider, AuthUser, AdminUserRow } from "../../src/lib/types";

export const INITIAL_IMAGE_CREDITS = 5;

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
  TASKS_KV?: UserKvNamespace;
}

interface UserRecord {
  userKey: string;
  provider: AuthProvider;
  providerId: string;
  name: string;
  email: string | null;
  image: string | null;
  role: "admin" | "user";
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number;
}

interface UsageRecord {
  userKey: string;
  remainingCredits: number;
  usedCredits: number;
  grantedCredits: number;
  createdAt: number;
  updatedAt: number;
  lastGeneratedAt?: number;
}

const META_ADMIN = "meta:superAdminUserKey";
const USERS_INDEX = "users:index";

function userRecordKey(userKey: string) {
  return `user:${userKey}`;
}

function usageRecordKey(userKey: string) {
  return `usage:${userKey}`;
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

async function writeJson(kv: UserKvNamespace, key: string, value: unknown) {
  await kv.put(key, JSON.stringify(value));
}

async function appendUserIndex(kv: UserKvNamespace, userKey: string) {
  const index = (await readJson<string[]>(kv, USERS_INDEX)) ?? [];
  if (index.includes(userKey)) return;
  index.push(userKey);
  await writeJson(kv, USERS_INDEX, index);
}

function toSessionUser(record: UserRecord, usage: UsageRecord): AuthUser {
  return {
    provider: record.provider,
    id: record.providerId,
    userKey: record.userKey,
    name: record.name,
    email: record.email,
    image: record.image,
    role: record.role,
    remainingCredits: usage.remainingCredits,
    usedCredits: usage.usedCredits,
    grantedCredits: usage.grantedCredits,
  };
}

function toAdminRow(record: UserRecord, usage: UsageRecord): AdminUserRow {
  return {
    userKey: record.userKey,
    provider: record.provider,
    providerId: record.providerId,
    name: record.name,
    email: record.email,
    image: record.image,
    role: record.role,
    remainingCredits: usage.remainingCredits,
    usedCredits: usage.usedCredits,
    grantedCredits: usage.grantedCredits,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastLoginAt: record.lastLoginAt,
  };
}

async function readUsage(kv: UserKvNamespace, userKey: string, now = Date.now()) {
  const existing = await readJson<UsageRecord>(kv, usageRecordKey(userKey));
  if (existing) return existing;
  const created: UsageRecord = {
    userKey,
    remainingCredits: INITIAL_IMAGE_CREDITS,
    usedCredits: 0,
    grantedCredits: INITIAL_IMAGE_CREDITS,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(kv, usageRecordKey(userKey), created);
  return created;
}

export async function ensureManagedUser(env: UserEnv, authUser: AuthUser) {
  const kv = env.TASKS_KV;
  if (!kv) {
    return {
      user: {
        ...authUser,
        userKey: getUserKey(authUser),
        role: authUser.role ?? "user",
      } satisfies AuthUser,
      record: null,
      usage: null,
    };
  }

  const now = Date.now();
  const userKey = getUserKey(authUser);
  const existing = await readJson<UserRecord>(kv, userRecordKey(userKey));
  const existingAdmin = await kv.get(META_ADMIN);
  const canBecomeFirstAdmin = authUser.provider !== "access";
  const isFirstUser = !existingAdmin && canBecomeFirstAdmin;
  const role = existing?.role ?? (isFirstUser ? "admin" : "user");

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

  await writeJson(kv, userRecordKey(userKey), record);
  await appendUserIndex(kv, userKey);
  if (isFirstUser) {
    await kv.put(META_ADMIN, userKey);
  }

  const usage = await readUsage(kv, userKey, now);
  return {
    user: toSessionUser(record, usage),
    record,
    usage,
  };
}

export async function hydrateManagedUser(env: UserEnv, authUser: AuthUser) {
  const kv = env.TASKS_KV;
  if (!kv) return ensureManagedUser(env, authUser);

  const userKey = getUserKey(authUser);
  const record = await readJson<UserRecord>(kv, userRecordKey(userKey));
  if (!record) return ensureManagedUser(env, authUser);

  const usage = await readUsage(kv, userKey);
  return {
    user: toSessionUser(record, usage),
    record,
    usage,
  };
}

export async function consumeImageCredit(env: UserEnv, authUser: AuthUser) {
  const managed = await hydrateManagedUser(env, authUser);
  const kv = env.TASKS_KV;
  if (!kv || !managed.usage) {
    throw new Error("服务端未配置用户次数表");
  }
  if (managed.usage.remainingCredits <= 0) {
    throw new Error("本账号详情图生成次数已用完，请联系管理员增加次数。");
  }

  const now = Date.now();
  const next: UsageRecord = {
    ...managed.usage,
    remainingCredits: managed.usage.remainingCredits - 1,
    usedCredits: managed.usage.usedCredits + 1,
    updatedAt: now,
    lastGeneratedAt: now,
  };
  await writeJson(kv, usageRecordKey(managed.user.userKey ?? getUserKey(managed.user)), next);

  return {
    user: {
      ...managed.user,
      remainingCredits: next.remainingCredits,
      usedCredits: next.usedCredits,
      grantedCredits: next.grantedCredits,
    },
    usage: next,
  };
}

export async function listManagedUsers(env: UserEnv) {
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置用户表");

  let userKeys = (await readJson<string[]>(kv, USERS_INDEX)) ?? [];

  if (!userKeys.length && kv.list) {
    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await kv.list({ prefix: "user:", cursor, limit: 1000 });
      listed.push(...result.keys.map((item) => item.name.replace(/^user:/, "")));
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    userKeys = listed;
  }

  const rows: AdminUserRow[] = [];
  for (const userKey of userKeys) {
    const record = await readJson<UserRecord>(kv, userRecordKey(userKey));
    if (!record) continue;
    const usage = await readUsage(kv, userKey);
    rows.push(toAdminRow(record, usage));
  }

  return rows.sort((a, b) => b.lastLoginAt - a.lastLoginAt);
}

export async function updateManagedUser(
  env: UserEnv,
  userKey: string,
  patch: { remainingCredits?: number; role?: "admin" | "user" },
) {
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置用户表");
  const record = await readJson<UserRecord>(kv, userRecordKey(userKey));
  if (!record) throw new Error("用户不存在");

  const now = Date.now();
  let nextRecord = record;
  if (patch.role) {
    nextRecord = { ...nextRecord, role: patch.role, updatedAt: now };
    await writeJson(kv, userRecordKey(userKey), nextRecord);
  }

  let usage = await readUsage(kv, userKey, now);
  if (Number.isFinite(patch.remainingCredits)) {
    const nextRemaining = Math.max(0, Math.round(patch.remainingCredits ?? 0));
    usage = {
      ...usage,
      remainingCredits: nextRemaining,
      grantedCredits: Math.max(usage.grantedCredits, nextRemaining + usage.usedCredits),
      updatedAt: now,
    };
    await writeJson(kv, usageRecordKey(userKey), usage);
  }

  return toAdminRow(nextRecord, usage);
}
