import type { AccessCodeRow, AuthUser } from "../../src/lib/types";
import type { UserKvNamespace } from "./users";

interface AccessCodeRecord {
  id: string;
  label: string;
  codeHash: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  lastUsedAt?: number;
  useCount: number;
}

export interface AccessCodeEnv {
  ACCESS_LOGIN_CODE?: string;
  TASKS_KV?: UserKvNamespace;
}

const ACCESS_INDEX = "accessCodes:index";
const HASH_PREFIX = "accessCodeHash:";
const CODE_PREFIX = "accessCode:";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function accessCodeKey(id: string) {
  return `${CODE_PREFIX}${id}`;
}

function accessCodeHashKey(hash: string) {
  return `${HASH_PREFIX}${hash}`;
}

function normalizeCode(code: string) {
  return code.trim().replace(/[\s-]+/g, "").toUpperCase();
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

async function appendIndex(kv: UserKvNamespace, id: string) {
  const index = (await readJson<string[]>(kv, ACCESS_INDEX)) ?? [];
  if (index.includes(id)) return;
  index.push(id);
  await writeJson(kv, ACCESS_INDEX, index);
}

function toRow(record: AccessCodeRecord): AccessCodeRow {
  return {
    id: record.id,
    label: record.label,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    lastUsedAt: record.lastUsedAt,
    useCount: record.useCount,
  };
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

  const kv = env.TASKS_KV;
  if (!kv || !normalized) return null;

  const hash = await hashCode(normalized);
  const id = await kv.get(accessCodeHashKey(hash));
  if (!id) return null;

  const record = await readJson<AccessCodeRecord>(kv, accessCodeKey(id));
  if (!record || !record.active || record.codeHash !== hash) return null;

  const next: AccessCodeRecord = {
    ...record,
    lastUsedAt: Date.now(),
    updatedAt: Date.now(),
    useCount: record.useCount + 1,
  };
  await writeJson(kv, accessCodeKey(record.id), next);

  return {
    provider: "access",
    id: record.id,
    name: record.label ? `访问码：${record.label}` : "访问码用户",
    email: null,
    image: null,
  } satisfies AuthUser;
}

export async function listAccessCodes(env: AccessCodeEnv) {
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置访问码表");

  let ids = (await readJson<string[]>(kv, ACCESS_INDEX)) ?? [];
  if (!ids.length && kv.list) {
    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await kv.list({ prefix: CODE_PREFIX, cursor, limit: 1000 });
      listed.push(...result.keys.map((item) => item.name.replace(CODE_PREFIX, "")));
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    ids = listed;
  }

  const rows: AccessCodeRow[] = [];
  for (const id of ids) {
    const record = await readJson<AccessCodeRecord>(kv, accessCodeKey(id));
    if (record) rows.push(toRow(record));
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createAccessCodeRecord(
  env: AccessCodeEnv,
  options: { label?: string; code?: string; createdBy?: string | null },
) {
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置访问码表");

  const code = options.code ? normalizeCode(options.code) : createCode();
  const normalizedCode = normalizeCode(code);
  if (normalizedCode.length < 6) throw new Error("访问码至少需要 6 位");

  const codeHash = await hashCode(normalizedCode);
  if (await kv.get(accessCodeHashKey(codeHash))) {
    throw new Error("访问码已存在，请换一个");
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const record: AccessCodeRecord = {
    id,
    label: options.label?.trim() || `访问码 ${new Date(now).toLocaleDateString("zh-CN")}`,
    codeHash,
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: options.createdBy ?? null,
    useCount: 0,
  };

  await writeJson(kv, accessCodeKey(id), record);
  await kv.put(accessCodeHashKey(codeHash), id);
  await appendIndex(kv, id);

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
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置访问码表");

  const record = await readJson<AccessCodeRecord>(kv, accessCodeKey(id));
  if (!record) throw new Error("访问码不存在");

  const next: AccessCodeRecord = {
    ...record,
    label: patch.label?.trim() || record.label,
    active: typeof patch.active === "boolean" ? patch.active : record.active,
    updatedAt: Date.now(),
  };
  await writeJson(kv, accessCodeKey(id), next);
  return toRow(next);
}
