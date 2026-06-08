import type {
  CutoutDraft,
  CutoutHistoryItem,
  EditHistoryItem,
  HistoryItem,
} from "@/lib/types";
import { requireSession } from "./auth";
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

interface HistoryD1PreparedStatement {
  bind: (...values: unknown[]) => HistoryD1PreparedStatement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<HistoryD1AllResult<T>>;
  run: () => Promise<HistoryD1Result>;
}

export interface HistoryD1Database {
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

type HistoryKind = "detail" | "cutout" | "edit";

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
  const session = await requireSession(context.request, context.env);
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
  const statements = [
    `CREATE TABLE IF NOT EXISTS history_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_history_records_user_kind_id
      ON history_records(user_key, kind, id)`,
    `CREATE TABLE IF NOT EXISTS cutout_drafts (
      user_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS stored_images (
      id TEXT PRIMARY KEY,
      user_key TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_detail_prompts_user
      ON detail_prompts(user_key, created_at)`,
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
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
  const productImages = item.product.productImages
    .filter((image) => image.startsWith("data:image/"))
    .slice(0, 8);
  const existingImageIds = item.product.productImageIds ?? [];
  const productImageIds = productImages.length
    ? await Promise.all(
        productImages.map((image, index) =>
          existingImageIds[index] ?? writeImage(env, userKey, image),
        ),
      )
    : existingImageIds;
  const clean: HistoryItem = {
    ...item,
    product: {
      ...item.product,
      productImages: [],
      productImageIds,
    },
  };
  const prompts = await Promise.all(
    clean.prompts.map(async (prompt) => {
      const legacyPrompt = (prompt as typeof prompt & { prompt?: unknown }).prompt;
      const promptId =
        typeof legacyPrompt === "string" && legacyPrompt.trim()
          ? await storeDetailPrompt(env, userKey, {
              id: prompt.promptId,
              title: prompt.title,
              prompt: legacyPrompt,
              index: prompt.index,
            })
          : prompt.promptId;
      const imageId =
        prompt.base64 && !prompt.imageId
          ? await writeImage(env, userKey, prompt.base64, DEFAULT_IMAGE_MIME)
          : prompt.imageId;
      const { base64: _base64, prompt: _prompt, ...rest } =
        prompt as typeof prompt & { prompt?: unknown };
      return {
        ...rest,
        promptId,
        imageId,
      };
    }),
  );
  return {
    ...clean,
    prompts,
  };
}

async function serializeCutoutItem(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: CutoutHistoryItem,
) {
  const sourceImageId =
    item.sourceImage && !item.sourceImageId
      ? await writeImage(env, userKey, item.sourceImage, DEFAULT_IMAGE_MIME)
      : item.sourceImageId;
  const maskImageId =
    item.maskImage && !item.maskImageId
      ? await writeImage(env, userKey, item.maskImage, DEFAULT_IMAGE_MIME)
      : item.maskImageId;
  const resultImageId =
    item.resultBase64 && !item.resultImageId
      ? await writeImage(env, userKey, item.resultBase64, DEFAULT_IMAGE_MIME)
      : item.resultImageId;
  const {
    sourceImage: _sourceImage,
    maskImage: _maskImage,
    resultBase64: _resultBase64,
    ...rest
  } = item;
  return {
    ...rest,
    sourceImageId,
    maskImageId,
    resultImageId,
  };
}

async function serializeEditItem(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  item: EditHistoryItem,
) {
  const sourceImageId =
    item.sourceImage && !item.sourceImageId
      ? await writeImage(env, userKey, item.sourceImage, DEFAULT_IMAGE_MIME)
      : item.sourceImageId;
  const maskImageId =
    item.maskImage && !item.maskImageId
      ? await writeImage(env, userKey, item.maskImage, DEFAULT_IMAGE_MIME)
      : item.maskImageId;
  const resultImageId =
    item.resultBase64 && !item.resultImageId
      ? await writeImage(env, userKey, item.resultBase64, DEFAULT_IMAGE_MIME)
      : item.resultImageId;
  const {
    sourceImage: _sourceImage,
    maskImage: _maskImage,
    resultBase64: _resultBase64,
    ...rest
  } = item;
  return {
    ...rest,
    sourceImageId,
    maskImageId,
    resultImageId,
  };
}

async function serializeCutoutDraft(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  draft: Omit<CutoutDraft, "id"> & { id?: "active" },
) {
  const resultBase64 =
    typeof draft.resultBase64 === "string" && draft.resultBase64
      ? draft.resultBase64
      : null;
  const resultImageId =
    resultBase64 && !draft.resultImageId
      ? await writeImage(env, userKey, resultBase64, DEFAULT_IMAGE_MIME)
      : draft.resultImageId;
  const { resultBase64: _resultBase64, ...rest } = draft;
  return {
    ...rest,
    id: "active" as const,
    resultImageId: resultImageId || undefined,
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

function hasInlineDetailImages(item: HistoryItem) {
  return (
    item.product.productImages.some((image) => image.startsWith("data:image/")) ||
    item.prompts.some((prompt) => {
      const legacyPrompt = (prompt as typeof prompt & { prompt?: unknown }).prompt;
      return !!prompt.base64 || (typeof legacyPrompt === "string" && !!legacyPrompt.trim());
    })
  );
}

function hasInlineCutoutImages(item: CutoutHistoryItem) {
  return !!(
    item.sourceImage ||
    item.maskImage ||
    item.resultBase64
  );
}

function hasInlineEditImages(item: EditHistoryItem) {
  return !!(
    item.sourceImage ||
    item.maskImage ||
    item.resultBase64
  );
}

function hasInlineCutoutDraftImages(draft: CutoutDraft) {
  return typeof draft.resultBase64 === "string" && !!draft.resultBase64;
}

async function normalizeStoredDetailItem(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  row: HistoryRow,
) {
  const item = parseJson<HistoryItem>(row.payload);
  if (!item) return null;
  if (!hasInlineDetailImages(item)) return { ...item, id: row.id };

  const payload = await serializeDetailItem(env, userKey, item);
  await updateHistoryRecord(env.HISTORY_DB, userKey, "detail", row.id, payload, Date.now());
  return { ...payload, id: row.id };
}

async function normalizeStoredCutoutItem(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  row: HistoryRow,
) {
  const item = parseJson<CutoutHistoryItem>(row.payload);
  if (!item) return null;
  if (!hasInlineCutoutImages(item)) return { ...item, id: row.id };

  const payload = await serializeCutoutItem(env, userKey, item);
  await updateHistoryRecord(env.HISTORY_DB, userKey, "cutout", row.id, payload, Date.now());
  return { ...payload, id: row.id };
}

async function normalizeStoredEditItem(
  env: Required<HistoryStorageEnv>,
  userKey: string,
  row: HistoryRow,
) {
  const item = parseJson<EditHistoryItem>(row.payload);
  if (!item) return null;
  if (!hasInlineEditImages(item)) return { ...item, id: row.id };

  const payload = await serializeEditItem(env, userKey, item);
  await updateHistoryRecord(env.HISTORY_DB, userKey, "edit", row.id, payload, Date.now());
  return { ...payload, id: row.id };
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
  const items: HistoryItem[] = [];
  for (const row of rows) {
    const item = await normalizeStoredDetailItem(env, userKey, row);
    if (item) items.push(item);
  }
  return items;
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
  const items: CutoutHistoryItem[] = [];
  for (const row of rows) {
    const item = await normalizeStoredCutoutItem(env, userKey, row);
    if (item) items.push(item);
  }
  return items;
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
  const items: EditHistoryItem[] = [];
  for (const row of rows) {
    const item = await normalizeStoredEditItem(env, userKey, row);
    if (item) items.push(item);
  }
  return items;
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
  const draft = parseJson<CutoutDraft>(row?.payload);
  if (draft && hasInlineCutoutDraftImages(draft)) {
    const payload = await serializeCutoutDraft(env, userKey, draft);
    await env.HISTORY_DB.prepare(
      `UPDATE cutout_drafts SET payload = ?, updated_at = ? WHERE user_key = ?`,
    )
      .bind(JSON.stringify(payload), Date.now(), userKey)
      .run();
    return payload;
  }
  return draft ?? null;
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
