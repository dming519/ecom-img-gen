import type { RedeemCodeRow } from "../../src/lib/types";
import type { UserKvNamespace } from "./users";

interface RedeemCodeRecord {
  id: string;
  label: string;
  codeHash: string;
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

export interface RedeemCodeEnv {
  TASKS_KV?: UserKvNamespace;
}

const REDEEM_INDEX = "redeemCodes:index";
const HASH_PREFIX = "redeemCodeHash:";
const CODE_PREFIX = "redeemCode:";
const USE_PREFIX = "redeemCodeUse:";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function redeemCodeKey(id: string) {
  return `${CODE_PREFIX}${id}`;
}

function redeemCodeHashKey(hash: string) {
  return `${HASH_PREFIX}${hash}`;
}

function redeemUseKey(codeId: string, userKey: string) {
  return `${USE_PREFIX}${codeId}:${userKey}`;
}

function normalizeCode(code: string) {
  return code.trim().replace(/[\s-]+/g, "").toUpperCase();
}

function normalizeCredits(value: number | undefined) {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(999, Math.round(value ?? 5)));
}

function normalizeMaxRedemptions(value: number | undefined) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(10000, Math.round(value ?? 1)));
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
  return `RDM-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

async function appendIndex(kv: UserKvNamespace, id: string) {
  const index = (await readJson<string[]>(kv, REDEEM_INDEX)) ?? [];
  if (index.includes(id)) return;
  index.push(id);
  await writeJson(kv, REDEEM_INDEX, index);
}

function toRow(record: RedeemCodeRecord): RedeemCodeRow {
  return {
    id: record.id,
    label: record.label,
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

export async function listRedeemCodes(env: RedeemCodeEnv) {
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置兑换码表");

  let ids = (await readJson<string[]>(kv, REDEEM_INDEX)) ?? [];
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

  const rows: RedeemCodeRow[] = [];
  for (const id of ids) {
    const record = await readJson<RedeemCodeRecord>(kv, redeemCodeKey(id));
    if (record) rows.push(toRow(record));
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createRedeemCodeRecord(
  env: RedeemCodeEnv,
  options: {
    label?: string;
    code?: string;
    credits?: number;
    maxRedemptions?: number;
    createdBy?: string | null;
  },
) {
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置兑换码表");

  const code = options.code ? normalizeCode(options.code) : createCode();
  const normalizedCode = normalizeCode(code);
  if (normalizedCode.length < 6) throw new Error("兑换码至少需要 6 位");

  const codeHash = await hashCode(normalizedCode);
  if (await kv.get(redeemCodeHashKey(codeHash))) {
    throw new Error("兑换码已存在，请换一个");
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const record: RedeemCodeRecord = {
    id,
    label: options.label?.trim() || `兑换码 ${new Date(now).toLocaleDateString("zh-CN")}`,
    codeHash,
    credits: normalizeCredits(options.credits),
    maxRedemptions: normalizeMaxRedemptions(options.maxRedemptions),
    redeemCount: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: options.createdBy ?? null,
  };

  await writeJson(kv, redeemCodeKey(id), record);
  await kv.put(redeemCodeHashKey(codeHash), id);
  await appendIndex(kv, id);

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
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置兑换码表");

  const record = await readJson<RedeemCodeRecord>(kv, redeemCodeKey(id));
  if (!record) throw new Error("兑换码不存在");

  const next: RedeemCodeRecord = {
    ...record,
    label: patch.label?.trim() || record.label,
    active: typeof patch.active === "boolean" ? patch.active : record.active,
    updatedAt: Date.now(),
  };
  await writeJson(kv, redeemCodeKey(id), next);
  return toRow(next);
}

export async function redeemCodeRecord(env: RedeemCodeEnv, code: string, userKey: string) {
  const kv = env.TASKS_KV;
  if (!kv) throw new Error("服务端未配置兑换码表");

  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("请输入兑换码");

  const hash = await hashCode(normalized);
  const id = await kv.get(redeemCodeHashKey(hash));
  if (!id) throw new Error("兑换码不正确");

  const record = await readJson<RedeemCodeRecord>(kv, redeemCodeKey(id));
  if (!record || record.codeHash !== hash) throw new Error("兑换码不正确");
  if (!record.active) throw new Error("兑换码已停用");
  if (record.redeemCount >= record.maxRedemptions) throw new Error("兑换码已被兑完");

  const useKey = redeemUseKey(record.id, userKey);
  if (await kv.get(useKey)) throw new Error("当前账号已兑换过该兑换码");

  const now = Date.now();
  const useRecord: RedeemUseRecord = {
    id: crypto.randomUUID(),
    codeId: record.id,
    userKey,
    credits: record.credits,
    redeemedAt: now,
  };
  const next: RedeemCodeRecord = {
    ...record,
    redeemCount: record.redeemCount + 1,
    lastRedeemedAt: now,
    updatedAt: now,
  };

  await writeJson(kv, useKey, useRecord);
  await writeJson(kv, redeemCodeKey(record.id), next);

  return {
    redeemCode: toRow(next),
    credits: record.credits,
  };
}
