import { defineEventHandler } from "h3";
import { createAccessCodeRecord } from "../../handlers/_lib/accessCodes";
import { requireSession } from "../../handlers/_lib/auth";
import { ensureHistorySchema, getHistorySql, json } from "../../handlers/_lib/historyStorage";
import { ensureManagedUser, requireAdminDb, type UserKvNamespace } from "../../handlers/_lib/users";
import type { PostgresEnv } from "../../handlers/_lib/postgres";
import { runServerHandler } from "../../utils/nitroEventHandler";

const RESET_CONFIRMATION = "CONFIRM_FULL_RESET";

interface R2ListResult {
  objects: Array<{ key: string }>;
  truncated?: boolean;
  cursor?: string;
}

interface ResetR2Object {
  body?: ReadableStream;
  arrayBuffer: () => Promise<ArrayBuffer>;
  httpMetadata?: {
    contentType?: string;
  };
}

interface ResetR2Bucket {
  get: (key: string) => Promise<ResetR2Object | null>;
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<unknown>;
  list: (options?: { cursor?: string; limit?: number }) => Promise<R2ListResult>;
  delete: (keys: string | string[]) => Promise<void>;
}

interface ResetKvNamespace extends UserKvNamespace {
  list: (options?: {
    cursor?: string;
    limit?: number;
    prefix?: string;
  }) => Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
  delete: (key: string) => Promise<void>;
}

interface ResetEnv extends PostgresEnv {
  AUTH_SECRET?: string;
  TASKS_KV?: ResetKvNamespace;
  HISTORY_BUCKET?: ResetR2Bucket;
}

interface ResetBody {
  confirm?: string;
  accessCode?: string;
}

async function deleteAllR2Objects(bucket?: ResetR2Bucket) {
  if (!bucket) return 0;

  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return deleted;
}

async function deleteAllKvKeys(namespace?: ResetKvNamespace) {
  if (!namespace) return 0;

  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await namespace.list({ cursor, limit: 1000 });
    await Promise.all(page.keys.map((key) => namespace.delete(key.name)));
    deleted += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return deleted;
}

async function truncatePostgres(env: ResetEnv) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  await requireAdminDb(env);

  await sql.unsafe(`
    TRUNCATE TABLE
      history_records,
      cutout_drafts,
      stored_images,
      detail_prompts,
      admin_meta,
      managed_users,
      user_usage,
      access_codes,
      access_code_hashes,
      redeem_codes,
      redeem_code_hashes,
      redeem_code_uses
    RESTART IDENTITY
  `);
}

export default defineEventHandler((event) =>
  runServerHandler<ResetEnv>(event, async (context) => {
    const session = await requireSession(context.request, context.env);
    if (!session) {
      return json({ error: "请先登录" }, { status: 401 });
    }
    if (session.user.role !== "super_admin") {
      return json({ error: "只有超级管理员可以清空数据" }, { status: 403 });
    }

    const body = (await context.request.json().catch(() => null)) as ResetBody | null;
    if (body?.confirm !== RESET_CONFIRMATION) {
      return json({ error: "缺少确认值" }, { status: 400 });
    }

    try {
      const deletedR2Objects = await deleteAllR2Objects(context.env.HISTORY_BUCKET);
      const deletedKvKeys = await deleteAllKvKeys(context.env.TASKS_KV);
      await truncatePostgres(context.env);

      const managed = await ensureManagedUser(context.env, session.user);
      const created = await createAccessCodeRecord(context.env, {
        label: "全量清理测试访问码",
        code: body.accessCode,
        createdBy: managed.user.userKey,
      });

      return json({
        ok: true,
        deletedR2Objects,
        deletedKvKeys,
        accessCode: created.accessCode,
        code: created.code,
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }),
);
