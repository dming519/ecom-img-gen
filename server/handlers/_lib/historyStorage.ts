import type {
  CutoutDraft,
  CutoutHistoryItem,
  EditHistoryItem,
  HistoryItem,
  LayerHistoryItem,
  MultiViewHistoryItem,
} from "@/lib/types";
import { requireSignedSession } from "./auth";
import { getUserKey, type UserKvNamespace } from "./users";

interface HistoryD1Result {
  success?: boolean;
  meta?: {
    changes?: number;
    last_row_id?: number;
  };
}

interface HistoryD1AllResult<T> {
  results?: T[];
}

type HistoryD1BatchResult<T> = HistoryD1Result & HistoryD1AllResult<T>;

interface HistoryD1PreparedStatement {
  bind: (...values: unknown[]) => HistoryD1PreparedStatement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<HistoryD1AllResult<T>>;
  run: () => Promise<HistoryD1Result>;
}

export interface HistoryD1Database {
  batch?: <T = Record<string, unknown>>(
    statements: HistoryD1PreparedStatement[],
  ) => Promise<Array<HistoryD1BatchResult<T>>>;
  exec: (query: string) => Promise<unknown>;
  prepare: (query: string) => HistoryD1PreparedStatement;
}

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

export interface HistoryStorageEnv {
  HISTORY_DB?: HistoryD1Database;
  HISTORY_BUCKET?: HistoryR2Bucket;
}

export interface HistoryStorageFunctionEnv extends HistoryStorageEnv {
  AUTH_SECRET?: string;
  TASKS_KV?: UserKvNamespace;
}

type HistoryKind = "detail" | "cutout" | "edit" | "multi-view" | "layer";

interface HistoryRow {
  id: number;
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

function requireHistoryBindings(env: HistoryStorageEnv) {
  if (!env.HISTORY_DB) {
    throw new Error("服务端未配置 HISTORY_DB D1 数据库");
  }
  if (!env.HISTORY_BUCKET) {
    throw new Error("服务端未配置 HISTORY_BUCKET R2 存储桶");
  }
  return {
    HISTORY_DB: env.HISTORY_DB,
    HISTORY_BUCKET: env.HISTORY_BUCKET,
  };
}

export async function requireUserHistoryStorage(
  context: { request: Request; env: HistoryStorageFunctionEnv },
  unauthenticatedMessage: string,
) {
  const session = await requireSignedSession(context.request, context.env);
  if (!session) {
    return { response: json({ error: unauthenticatedMessage }, { status: 401 }) };
  }
  try {
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

async function ensureHistorySchema(db: HistoryD1Database) {
  void db;
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
  env: Required<HistoryStorageEnv>,
  userKey: string,
  value: string,
  defaultMime = DEFAULT_IMAGE_MIME,
) {
  const { bytes, mimeType } = parseImagePayload(value, defaultMime);
  return writeImageBytes(env, userKey, bytes, mimeType);
}

async function writeImageBytes(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  bytes: Uint8Array,
  mimeType = DEFAULT_IMAGE_MIME,
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const extension = mimeToExtension(mimeType);
  const r2Key = `${encodeURIComponent(userKey)}/${now}-${id}.${extension}`;

  await env.HISTORY_BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
  });
  await env.HISTORY_DB.prepare(
    `INSERT INTO stored_images
      (id, user_key, r2_key, mime_type, byte_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userKey, r2Key, mimeType, bytes.byteLength, now)
    .run();

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

async function readImageRow(db: HistoryD1Database, userKey: string, id: string) {
  return db
    .prepare(
      `SELECT id, r2_key, mime_type
       FROM stored_images
       WHERE id = ? AND user_key = ?`,
    )
    .bind(id, userKey)
    .first<ImageRow>();
}

export async function readStoredImageFile(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  id: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const row = await readImageRow(env.HISTORY_DB, userKey, id);
  if (!row) return null;
  const object = await env.HISTORY_BUCKET.get(row.r2_key);
  if (!object) return null;
  return {
    object,
    mimeType: row.mime_type || object.httpMetadata?.contentType || DEFAULT_IMAGE_MIME,
  };
}

function requireHistoryDb(env: HistoryStorageEnv) {
  if (!env.HISTORY_DB) {
    throw new Error("服务端未配置 HISTORY_DB D1 数据库");
  }
  return env.HISTORY_DB;
}

export async function readStoredImageDataUrl(
  env: Required<HistoryStorageEnv>,
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
  await ensureHistorySchema(storage.HISTORY_DB);
  return writeImage(storage, userKey, value, defaultMime);
}

export async function storeDetailPrompt(
  env: HistoryStorageEnv,
  userKey: string,
  input: DetailPromptRecordInput,
) {
  const db = requireHistoryDb(env);
  await ensureHistorySchema(db);

  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("详情图 prompt 为空");
  }

  const id = input.id?.trim() || crypto.randomUUID();
  const title = input.title?.trim() || "商品详情图";
  const index = Number.isFinite(input.index) ? Number(input.index) : null;
  const taskId = input.taskId?.trim() || null;
  const now = Date.now();

  await db.prepare(
    `INSERT INTO detail_prompts
      (id, user_key, title, prompt, source_task_id, prompt_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id)
      DO UPDATE SET
        title = excluded.title,
        prompt = excluded.prompt,
        source_task_id = excluded.source_task_id,
        prompt_index = excluded.prompt_index,
        updated_at = excluded.updated_at`,
  )
    .bind(id, userKey, title, prompt, taskId, index, now, now)
    .run();

  return id;
}

export async function readDetailPrompt(
  env: HistoryStorageEnv,
  userKey: string,
  id: string,
) {
  const db = requireHistoryDb(env);
  await ensureHistorySchema(db);
  const row = await db.prepare(
    `SELECT id, title, prompt
     FROM detail_prompts
     WHERE id = ? AND user_key = ?`,
  )
    .bind(id, userKey)
    .first<{ id: string; title: string; prompt: string }>();
  return row ?? null;
}

async function serializeDetailItem(
  env: Required<HistoryStorageEnv>,
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
      styleReferenceImages: [],
      styleReferenceImageIds: item.product.styleReferenceImageIds ?? [],
    },
  };
  return {
    ...clean,
    prompts: clean.prompts,
  };
}

async function serializeCutoutItem(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: CutoutHistoryItem,
) {
  void env;
  void userKey;
  return item;
}

async function serializeEditItem(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: EditHistoryItem,
) {
  void env;
  void userKey;
  return item;
}

async function serializeMultiViewItem(
  env: Required<HistoryStorageEnv>,
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
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: LayerHistoryItem,
) {
  void env;
  void userKey;
  return item;
}

async function serializeCutoutDraft(
  env: Required<HistoryStorageEnv>,
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
  db: HistoryD1Database,
  userKey: string,
  kind: HistoryKind,
  payload: unknown,
  now: number,
) {
  const result = await db
    .prepare(
      `INSERT INTO history_records
        (user_key, kind, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(userKey, kind, JSON.stringify(payload), now, now)
    .run();
  const id = result.meta?.last_row_id;
  if (!Number.isFinite(id)) {
    throw new Error("D1 未返回新历史记录 ID");
  }
  return Number(id);
}

async function updateHistoryRecord(
  db: HistoryD1Database,
  userKey: string,
  kind: HistoryKind,
  id: number,
  payload: unknown,
  now: number,
) {
  const existing = await db
    .prepare(
      `SELECT id FROM history_records
       WHERE id = ? AND user_key = ? AND kind = ?`,
    )
    .bind(id, userKey, kind)
    .first<{ id: number }>();
  if (!existing) {
    throw new Error("历史记录不存在或无权访问");
  }
  await db
    .prepare(
      `UPDATE history_records
       SET payload = ?, updated_at = ?
       WHERE id = ? AND user_key = ? AND kind = ?`,
    )
    .bind(JSON.stringify(payload), now, id, userKey, kind)
    .run();
}

function parseHistoryRow<T extends { id?: number }>(row: HistoryRow) {
  const item = parseJson<T>(row.payload);
  return item ? { ...item, id: row.id } : null;
}

function isPresent<T>(item: T | null): item is T {
  return item !== null;
}

async function listHistoryRows(
  db: HistoryD1Database,
  userKey: string,
  kind: HistoryKind,
) {
  const result = await db
    .prepare(
      `SELECT id, payload
       FROM history_records
       WHERE user_key = ? AND kind = ?
       ORDER BY id ASC`,
    )
    .bind(userKey, kind)
    .all<HistoryRow>();
  return result.results ?? [];
}

export async function saveDetailHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: HistoryItem,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const now = Date.now();
  const payload = await serializeDetailItem(env, userKey, item);
  let id = item.id;
  if (id == null) {
    id = await insertHistoryRecord(env.HISTORY_DB, userKey, "detail", payload, now);
  } else {
    await updateHistoryRecord(env.HISTORY_DB, userKey, "detail", id, payload, now);
  }
  return { ...payload, id };
}

export async function listDetailHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const rows = await listHistoryRows(env.HISTORY_DB, userKey, "detail");
  return rows
    .map((row) => parseHistoryRow<HistoryItem>(row))
    .filter(isPresent);
}

export async function deleteDetailHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  id?: number,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  if (id == null) {
    await env.HISTORY_DB.prepare(
      `DELETE FROM history_records
       WHERE user_key = ? AND kind = 'detail'`,
    )
      .bind(userKey)
      .run();
    return;
  }
  await env.HISTORY_DB.prepare(
    `DELETE FROM history_records
     WHERE id = ? AND user_key = ? AND kind = 'detail'`,
  )
    .bind(id, userKey)
    .run();
}

export async function saveCutoutHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: CutoutHistoryItem,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const now = Date.now();
  const payload = await serializeCutoutItem(env, userKey, item);
  let id = item.id;
  if (id == null) {
    id = await insertHistoryRecord(env.HISTORY_DB, userKey, "cutout", payload, now);
  } else {
    await updateHistoryRecord(env.HISTORY_DB, userKey, "cutout", id, payload, now);
  }
  return { ...payload, id };
}

export async function listCutoutHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const rows = await listHistoryRows(env.HISTORY_DB, userKey, "cutout");
  return rows
    .map((row) => parseHistoryRow<CutoutHistoryItem>(row))
    .filter(isPresent);
}

export async function deleteCutoutHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  id?: number,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  if (id == null) {
    await env.HISTORY_DB.prepare(
      `DELETE FROM history_records
       WHERE user_key = ? AND kind = 'cutout'`,
    )
      .bind(userKey)
      .run();
    return;
  }
  await env.HISTORY_DB.prepare(
    `DELETE FROM history_records
     WHERE id = ? AND user_key = ? AND kind = 'cutout'`,
  )
    .bind(id, userKey)
    .run();
}

export async function saveEditHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: EditHistoryItem,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const now = Date.now();
  const payload = await serializeEditItem(env, userKey, item);
  let id = item.id;
  if (id == null) {
    id = await insertHistoryRecord(env.HISTORY_DB, userKey, "edit", payload, now);
  } else {
    await updateHistoryRecord(env.HISTORY_DB, userKey, "edit", id, payload, now);
  }
  return { ...payload, id };
}

export async function listEditHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const rows = await listHistoryRows(env.HISTORY_DB, userKey, "edit");
  return rows
    .map((row) => parseHistoryRow<EditHistoryItem>(row))
    .filter(isPresent);
}

export async function deleteEditHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  id?: number,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  if (id == null) {
    await env.HISTORY_DB.prepare(
      `DELETE FROM history_records
       WHERE user_key = ? AND kind = 'edit'`,
    )
      .bind(userKey)
      .run();
    return;
  }
  await env.HISTORY_DB.prepare(
    `DELETE FROM history_records
     WHERE id = ? AND user_key = ? AND kind = 'edit'`,
  )
    .bind(id, userKey)
    .run();
}

export async function saveMultiViewHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: MultiViewHistoryItem,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const now = Date.now();
  const payload = await serializeMultiViewItem(env, userKey, item);
  let id = item.id;
  if (id == null) {
    id = await insertHistoryRecord(env.HISTORY_DB, userKey, "multi-view", payload, now);
  } else {
    await updateHistoryRecord(env.HISTORY_DB, userKey, "multi-view", id, payload, now);
  }
  return { ...payload, id };
}

export async function listMultiViewHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const rows = await listHistoryRows(env.HISTORY_DB, userKey, "multi-view");
  return rows
    .map((row) => parseHistoryRow<MultiViewHistoryItem>(row))
    .filter(isPresent);
}

export async function deleteMultiViewHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  id?: number,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  if (id == null) {
    await env.HISTORY_DB.prepare(
      `DELETE FROM history_records
       WHERE user_key = ? AND kind = 'multi-view'`,
    )
      .bind(userKey)
      .run();
    return;
  }
  await env.HISTORY_DB.prepare(
    `DELETE FROM history_records
     WHERE id = ? AND user_key = ? AND kind = 'multi-view'`,
  )
    .bind(id, userKey)
    .run();
}

export async function saveLayerHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: LayerHistoryItem,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const now = Date.now();
  const payload = await serializeLayerItem(env, userKey, item);
  let id = item.id;
  if (id == null) {
    id = await insertHistoryRecord(env.HISTORY_DB, userKey, "layer", payload, now);
  } else {
    await updateHistoryRecord(env.HISTORY_DB, userKey, "layer", id, payload, now);
  }
  return { ...payload, id };
}

export async function listLayerHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const rows = await listHistoryRows(env.HISTORY_DB, userKey, "layer");
  return rows
    .map((row) => parseHistoryRow<LayerHistoryItem>(row))
    .filter(isPresent);
}

export async function deleteLayerHistory(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  id?: number,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  if (id == null) {
    await env.HISTORY_DB.prepare(
      `DELETE FROM history_records
       WHERE user_key = ? AND kind = 'layer'`,
    )
      .bind(userKey)
      .run();
    return;
  }
  await env.HISTORY_DB.prepare(
    `DELETE FROM history_records
     WHERE id = ? AND user_key = ? AND kind = 'layer'`,
  )
    .bind(id, userKey)
    .run();
}

export async function getCutoutDraft(
  env: Required<HistoryStorageEnv>,
  userKey: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const row = await env.HISTORY_DB.prepare(
    `SELECT payload FROM cutout_drafts WHERE user_key = ?`,
  )
    .bind(userKey)
    .first<{ payload: string }>();
  return parseJson<CutoutDraft>(row?.payload);
}

export async function saveCutoutDraft(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  draft: Omit<CutoutDraft, "id"> & { id?: "active" },
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const now = Date.now();
  const payload = await serializeCutoutDraft(env, userKey, draft);
  await env.HISTORY_DB.prepare(
    `INSERT INTO cutout_drafts (user_key, payload, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_key)
     DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  )
    .bind(userKey, JSON.stringify(payload), now)
    .run();
  return payload;
}

export async function deleteCutoutDraft(
  env: Required<HistoryStorageEnv>,
  userKey: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  await env.HISTORY_DB.prepare(`DELETE FROM cutout_drafts WHERE user_key = ?`)
    .bind(userKey)
    .run();
}

export async function storeProductImage(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  dataUrl: string,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("图片数据必须是 data:image 格式");
  }
  return writeImage(env, userKey, dataUrl);
}

export async function storeProductImageFile(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  file: File,
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const mimeType = file.type || DEFAULT_IMAGE_MIME;
  if (!mimeType.startsWith("image/")) {
    throw new Error("图片文件必须是 image/* 格式");
  }
  return writeImageBytes(env, userKey, new Uint8Array(await file.arrayBuffer()), mimeType);
}

export async function readProductImages(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  ids: string[],
) {
  await ensureHistorySchema(env.HISTORY_DB);
  const images = await Promise.all(
    ids.map(async (id) => {
      const row = await readImageRow(env.HISTORY_DB, userKey, id);
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
  await ensureHistorySchema(storage.HISTORY_DB);
  return Promise.all(ids.map((id) => readStoredImageDataUrl(storage, userKey, id)));
}
