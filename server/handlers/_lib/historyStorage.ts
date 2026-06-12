import type {
  CutoutDraft,
  CutoutHistoryItem,
  EditHistoryItem,
  HistoryItem,
  LayerHistoryItem,
  MultiViewHistoryItem,
} from "@/lib/types";
import { getPostgres, runSchemaOnce, toNumber, type AppSql, type PostgresEnv } from "./postgres";
import { requireSession } from "./auth";
import { getUserKey, type UserKvNamespace } from "./users";

interface HistoryR2Object {
  body?: ReadableStream;
  arrayBuffer: () => Promise<ArrayBuffer>;
  httpMetadata?: {
    contentType?: string;
  };
}

interface HistoryR2Bucket {
  get: (key: string) => Promise<HistoryR2Object | null>;
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<unknown>;
}

export interface HistoryStorageEnv extends PostgresEnv {
  HISTORY_BUCKET?: HistoryR2Bucket;
}

export interface HistoryStorageBindings extends HistoryStorageEnv {
  HISTORY_BUCKET: HistoryR2Bucket;
  sql?: AppSql;
}

export interface HistoryStorageFunctionEnv extends HistoryStorageEnv {
  AUTH_SECRET?: string;
  TASKS_KV?: UserKvNamespace;
}

type HistoryKind = "detail" | "cutout" | "edit" | "multi-view" | "layer";

interface HistoryRow {
  id: number | string;
  payload: string;
}

interface ImageRow {
  id: string;
  r2_key: string;
  mime_type: string | null;
}

interface DetailPromptRecordInput {
  id?: string;
  title?: string;
  prompt: string;
  taskId?: string;
  index?: number;
}

const DEFAULT_IMAGE_MIME = "image/png";

const HISTORY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS history_records (
    id BIGSERIAL PRIMARY KEY,
    user_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_history_records_user_kind_id
    ON history_records(user_key, kind, id)`,
  `CREATE TABLE IF NOT EXISTS cutout_drafts (
    user_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stored_images (
    id TEXT PRIMARY KEY,
    user_key TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stored_images_user
    ON stored_images(user_key, created_at)`,
  `CREATE TABLE IF NOT EXISTS detail_prompts (
    id TEXT PRIMARY KEY,
    user_key TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    source_task_id TEXT,
    prompt_index INTEGER,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_detail_prompts_user
    ON detail_prompts(user_key, created_at)`,
];

const historySchemaReady = new WeakMap<AppSql, Promise<void>>();

export function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

export function getHistorySql(env: HistoryStorageEnv & { sql?: AppSql }) {
  return env.sql ?? getPostgres(env, "业务数据");
}

export async function ensureHistorySchema(sql: AppSql) {
  await runSchemaOnce(historySchemaReady, sql, HISTORY_SCHEMA);
}

function requireHistoryBindings(env: HistoryStorageEnv) {
  if (!env.HISTORY_BUCKET) {
    throw new Error("服务端未配置 HISTORY_BUCKET R2 存储桶");
  }
  const sql = getHistorySql(env);
  return {
    ...env,
    sql,
    HISTORY_BUCKET: env.HISTORY_BUCKET,
  };
}

export async function requireUserHistoryStorage(
  context: { request: Request; env: HistoryStorageFunctionEnv },
  unauthenticatedMessage: string,
) {
  try {
    const session = await requireSession(context.request, context.env);
    if (!session) {
      return { response: json({ error: unauthenticatedMessage }, { status: 401 }) };
    }
    return {
      userKey: getUserKey(session.user),
      storage: requireHistoryBindings(context.env),
    };
  } catch (error) {
    return {
      response: json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      ),
    };
  }
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function mimeToExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/svg+xml") return "svg";
  return "png";
}

function base64ToBytes(value: string) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseImagePayload(value: string, defaultMime = DEFAULT_IMAGE_MIME) {
  const trimmed = value.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/s.exec(trimmed);
  if (dataUrlMatch) {
    const encoded = dataUrlMatch[2];
    if (!encoded) {
      throw new Error("图片数据为空");
    }
    return {
      mimeType: dataUrlMatch[1] || defaultMime,
      bytes: base64ToBytes(encoded),
    };
  }
  return {
    mimeType: defaultMime,
    bytes: base64ToBytes(trimmed),
  };
}

async function writeImage(
  env: HistoryStorageBindings,
  userKey: string,
  value: string,
  defaultMime = DEFAULT_IMAGE_MIME,
) {
  const { bytes, mimeType } = parseImagePayload(value, defaultMime);
  return writeImageBytes(env, userKey, bytes, mimeType);
}

async function writeImageBytes(
  env: HistoryStorageBindings,
  userKey: string,
  bytes: Uint8Array,
  mimeType = DEFAULT_IMAGE_MIME,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);

  const id = crypto.randomUUID();
  const now = Date.now();
  const extension = mimeToExtension(mimeType);
  const r2Key = `${encodeURIComponent(userKey)}/${now}-${id}.${extension}`;

  await env.HISTORY_BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
  });
  await sql`
    INSERT INTO stored_images
      (id, user_key, r2_key, mime_type, byte_size, created_at)
    VALUES
      (${id}, ${userKey}, ${r2Key}, ${mimeType}, ${bytes.byteLength}, ${now})
  `;

  return id;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

async function readImageRow(sql: AppSql, userKey: string, id: string) {
  const rows = await sql<ImageRow[]>`
    SELECT id, r2_key, mime_type
    FROM stored_images
    WHERE id = ${id} AND user_key = ${userKey}
  `;
  return rows[0] ?? null;
}

export async function readStoredImageFile(
  env: HistoryStorageBindings,
  userKey: string,
  id: string,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  const row = await readImageRow(sql, userKey, id);
  if (!row) return null;
  const object = await env.HISTORY_BUCKET.get(row.r2_key);
  if (!object) return null;
  return {
    object,
    mimeType: row.mime_type || object.httpMetadata?.contentType || DEFAULT_IMAGE_MIME,
  };
}

export async function readStoredImageDataUrl(
  env: HistoryStorageBindings,
  userKey: string,
  id: string,
) {
  const file = await readStoredImageFile(env, userKey, id);
  if (!file) return null;
  const buffer = await file.object.arrayBuffer();
  return `data:${file.mimeType};base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

export async function storeHistoryImage(
  env: HistoryStorageEnv,
  userKey: string,
  value: string,
  defaultMime = DEFAULT_IMAGE_MIME,
) {
  const storage = requireHistoryBindings(env);
  await ensureHistorySchema(storage.sql);
  return writeImage(storage, userKey, value, defaultMime);
}

export async function storeDetailPrompt(
  env: HistoryStorageEnv,
  userKey: string,
  input: DetailPromptRecordInput,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);

  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("详情图 prompt 为空");
  }

  const id = input.id?.trim() || crypto.randomUUID();
  const title = input.title?.trim() || "商品详情图";
  const index = Number.isFinite(input.index) ? Number(input.index) : null;
  const taskId = input.taskId?.trim() || null;
  const now = Date.now();

  await sql`
    INSERT INTO detail_prompts
      (id, user_key, title, prompt, source_task_id, prompt_index, created_at, updated_at)
    VALUES
      (${id}, ${userKey}, ${title}, ${prompt}, ${taskId}, ${index}, ${now}, ${now})
    ON CONFLICT(id)
    DO UPDATE SET
      title = excluded.title,
      prompt = excluded.prompt,
      source_task_id = excluded.source_task_id,
      prompt_index = excluded.prompt_index,
      updated_at = excluded.updated_at
  `;

  return id;
}

export async function readDetailPrompt(
  env: HistoryStorageEnv,
  userKey: string,
  id: string,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  const rows = await sql<Array<{ id: string; title: string; prompt: string }>>`
    SELECT id, title, prompt
    FROM detail_prompts
    WHERE id = ${id} AND user_key = ${userKey}
  `;
  return rows[0] ?? null;
}

async function serializeDetailItem(
  env: HistoryStorageBindings,
  userKey: string,
  item: HistoryItem,
) {
  void env;
  void userKey;
  const clean: HistoryItem = {
    ...item,
    product: {
      ...item.product,
      productImages: [],
      productImageIds: item.product.productImageIds ?? [],
    },
  };
  return {
    ...clean,
    prompts: clean.prompts,
  };
}

async function serializeCutoutItem(
  env: HistoryStorageBindings,
  userKey: string,
  item: CutoutHistoryItem,
) {
  void env;
  void userKey;
  return item;
}

async function serializeEditItem(
  env: HistoryStorageBindings,
  userKey: string,
  item: EditHistoryItem,
) {
  void env;
  void userKey;
  return item;
}

async function serializeMultiViewItem(
  env: HistoryStorageBindings,
  userKey: string,
  item: MultiViewHistoryItem,
) {
  void env;
  void userKey;
  return {
    ...item,
    sourceImageIds: item.sourceImageIds ?? [],
  };
}

async function serializeLayerItem(
  env: HistoryStorageBindings,
  userKey: string,
  item: LayerHistoryItem,
) {
  void env;
  void userKey;
  return item;
}

async function serializeCutoutDraft(
  env: HistoryStorageBindings,
  userKey: string,
  draft: Omit<CutoutDraft, "id"> & { id?: "active" },
) {
  void env;
  void userKey;
  return {
    ...draft,
    id: "active" as const,
  };
}

async function insertHistoryRecord(
  sql: AppSql,
  userKey: string,
  kind: HistoryKind,
  payload: unknown,
  now: number,
) {
  const rows = await sql<Array<{ id: number | string }>>`
    INSERT INTO history_records
      (user_key, kind, payload, created_at, updated_at)
    VALUES
      (${userKey}, ${kind}, ${JSON.stringify(payload)}, ${now}, ${now})
    RETURNING id
  `;
  const id = toNumber(rows[0]?.id, NaN);
  if (!Number.isFinite(id)) {
    throw new Error("Postgres 未返回新历史记录 ID");
  }
  return id;
}

async function updateHistoryRecord(
  sql: AppSql,
  userKey: string,
  kind: HistoryKind,
  id: number,
  payload: unknown,
  now: number,
) {
  const rows = await sql<Array<{ id: number | string }>>`
    UPDATE history_records
    SET payload = ${JSON.stringify(payload)}, updated_at = ${now}
    WHERE id = ${id} AND user_key = ${userKey} AND kind = ${kind}
    RETURNING id
  `;
  if (!rows[0]) {
    throw new Error("历史记录不存在或无权访问");
  }
}

function parseHistoryRow<T extends { id?: number }>(row: HistoryRow) {
  const item = parseJson<T>(row.payload);
  return item ? { ...item, id: toNumber(row.id) } : null;
}

function isPresent<T>(item: T | null): item is T {
  return item !== null;
}

async function listHistoryRows(
  sql: AppSql,
  userKey: string,
  kind: HistoryKind,
) {
  return sql<HistoryRow[]>`
    SELECT id, payload
    FROM history_records
    WHERE user_key = ${userKey} AND kind = ${kind}
    ORDER BY id ASC
  `;
}

async function saveHistoryItem<T extends { id?: number }>(
  env: HistoryStorageBindings,
  userKey: string,
  kind: HistoryKind,
  item: T,
  serialize: (env: HistoryStorageBindings, userKey: string, item: T) => Promise<T>,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  const now = Date.now();
  const payload = await serialize(env, userKey, item);
  let id = item.id;
  if (id == null) {
    id = await insertHistoryRecord(sql, userKey, kind, payload, now);
  } else {
    await updateHistoryRecord(sql, userKey, kind, id, payload, now);
  }
  return { ...payload, id };
}

async function listHistoryItems<T extends { id?: number }>(
  env: HistoryStorageBindings,
  userKey: string,
  kind: HistoryKind,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  const rows = await listHistoryRows(sql, userKey, kind);
  return rows.map((row) => parseHistoryRow<T>(row)).filter(isPresent);
}

async function deleteHistoryItem(
  env: HistoryStorageBindings,
  userKey: string,
  kind: HistoryKind,
  id?: number,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  if (id == null) {
    await sql`
      DELETE FROM history_records
      WHERE user_key = ${userKey} AND kind = ${kind}
    `;
    return;
  }
  await sql`
    DELETE FROM history_records
    WHERE id = ${id} AND user_key = ${userKey} AND kind = ${kind}
  `;
}

export async function saveDetailHistory(
  env: HistoryStorageBindings,
  userKey: string,
  item: HistoryItem,
) {
  return saveHistoryItem(env, userKey, "detail", item, serializeDetailItem);
}

export async function listDetailHistory(
  env: HistoryStorageBindings,
  userKey: string,
) {
  return listHistoryItems<HistoryItem>(env, userKey, "detail");
}

export async function deleteDetailHistory(
  env: HistoryStorageBindings,
  userKey: string,
  id?: number,
) {
  return deleteHistoryItem(env, userKey, "detail", id);
}

export async function saveCutoutHistory(
  env: HistoryStorageBindings,
  userKey: string,
  item: CutoutHistoryItem,
) {
  return saveHistoryItem(env, userKey, "cutout", item, serializeCutoutItem);
}

export async function listCutoutHistory(
  env: HistoryStorageBindings,
  userKey: string,
) {
  return listHistoryItems<CutoutHistoryItem>(env, userKey, "cutout");
}

export async function deleteCutoutHistory(
  env: HistoryStorageBindings,
  userKey: string,
  id?: number,
) {
  return deleteHistoryItem(env, userKey, "cutout", id);
}

export async function saveEditHistory(
  env: HistoryStorageBindings,
  userKey: string,
  item: EditHistoryItem,
) {
  return saveHistoryItem(env, userKey, "edit", item, serializeEditItem);
}

export async function listEditHistory(
  env: HistoryStorageBindings,
  userKey: string,
) {
  return listHistoryItems<EditHistoryItem>(env, userKey, "edit");
}

export async function deleteEditHistory(
  env: HistoryStorageBindings,
  userKey: string,
  id?: number,
) {
  return deleteHistoryItem(env, userKey, "edit", id);
}

export async function saveMultiViewHistory(
  env: HistoryStorageBindings,
  userKey: string,
  item: MultiViewHistoryItem,
) {
  return saveHistoryItem(env, userKey, "multi-view", item, serializeMultiViewItem);
}

export async function listMultiViewHistory(
  env: HistoryStorageBindings,
  userKey: string,
) {
  return listHistoryItems<MultiViewHistoryItem>(env, userKey, "multi-view");
}

export async function deleteMultiViewHistory(
  env: HistoryStorageBindings,
  userKey: string,
  id?: number,
) {
  return deleteHistoryItem(env, userKey, "multi-view", id);
}

export async function saveLayerHistory(
  env: HistoryStorageBindings,
  userKey: string,
  item: LayerHistoryItem,
) {
  return saveHistoryItem(env, userKey, "layer", item, serializeLayerItem);
}

export async function listLayerHistory(
  env: HistoryStorageBindings,
  userKey: string,
) {
  return listHistoryItems<LayerHistoryItem>(env, userKey, "layer");
}

export async function deleteLayerHistory(
  env: HistoryStorageBindings,
  userKey: string,
  id?: number,
) {
  return deleteHistoryItem(env, userKey, "layer", id);
}

export async function getCutoutDraft(
  env: HistoryStorageBindings,
  userKey: string,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  const rows = await sql<Array<{ payload: string }>>`
    SELECT payload FROM cutout_drafts WHERE user_key = ${userKey}
  `;
  return parseJson<CutoutDraft>(rows[0]?.payload);
}

export async function saveCutoutDraft(
  env: HistoryStorageBindings,
  userKey: string,
  draft: Omit<CutoutDraft, "id"> & { id?: "active" },
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  const now = Date.now();
  const payload = await serializeCutoutDraft(env, userKey, draft);
  await sql`
    INSERT INTO cutout_drafts (user_key, payload, updated_at)
    VALUES (${userKey}, ${JSON.stringify(payload)}, ${now})
    ON CONFLICT(user_key)
    DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `;
  return payload;
}

export async function deleteCutoutDraft(
  env: HistoryStorageBindings,
  userKey: string,
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  await sql`DELETE FROM cutout_drafts WHERE user_key = ${userKey}`;
}

export async function storeProductImage(
  env: HistoryStorageBindings,
  userKey: string,
  dataUrl: string,
) {
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("图片数据必须是 data:image 格式");
  }
  return writeImage(env, userKey, dataUrl);
}

export async function storeProductImageFile(
  env: HistoryStorageBindings,
  userKey: string,
  file: File,
) {
  const mimeType = file.type || DEFAULT_IMAGE_MIME;
  if (!mimeType.startsWith("image/")) {
    throw new Error("图片文件必须是 image/* 格式");
  }
  return writeImageBytes(env, userKey, new Uint8Array(await file.arrayBuffer()), mimeType);
}

export async function readProductImages(
  env: HistoryStorageBindings,
  userKey: string,
  ids: string[],
) {
  const sql = getHistorySql(env);
  await ensureHistorySchema(sql);
  const images = await Promise.all(
    ids.map(async (id) => {
      const row = await readImageRow(sql, userKey, id);
      return row ? `/api/history/image-file?id=${encodeURIComponent(id)}` : null;
    }),
  );
  return images;
}

export async function readProductImageDataUrls(
  env: HistoryStorageEnv,
  userKey: string,
  ids: string[],
) {
  const storage = requireHistoryBindings(env);
  await ensureHistorySchema(storage.sql);
  return Promise.all(ids.map((id) => readStoredImageDataUrl(storage, userKey, id)));
}
