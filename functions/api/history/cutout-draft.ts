import { requireSession } from "../../_lib/auth";
import {
  deleteCutoutDraft,
  getCutoutDraft,
  json,
  requireHistoryBindings,
  saveCutoutDraft,
  type HistoryD1Database,
  type HistoryR2Bucket,
} from "../../_lib/historyStorage";
import { getUserKey, type UserKvNamespace } from "../../_lib/users";
import type { CutoutDraft } from "../../../src/lib/types";

interface FunctionContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    TASKS_KV?: UserKvNamespace;
    HISTORY_DB?: HistoryD1Database;
    HISTORY_BUCKET?: HistoryR2Bucket;
  };
}

async function requireStorage(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return { response: json({ error: "请先登录后再访问抠图草稿" }, { status: 401 }) };
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

async function readDraft(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { draft?: Omit<CutoutDraft, "id"> & { id?: "active" } }
    | (Omit<CutoutDraft, "id"> & { id?: "active" })
    | null;
  const draft =
    body && "updatedAt" in body
      ? body
      : body && "draft" in body
        ? body.draft
        : null;
  if (!draft || typeof draft !== "object") {
    throw new Error("请求体缺少抠图草稿");
  }
  return draft;
}

export async function onRequestGet(context: FunctionContext) {
  const auth = await requireStorage(context);
  if ("response" in auth) return auth.response;

  try {
    return json({ draft: await getCutoutDraft(auth.storage, auth.userKey) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function onRequestPost(context: FunctionContext) {
  const auth = await requireStorage(context);
  if ("response" in auth) return auth.response;

  try {
    const draft = await readDraft(context.request);
    return json({ draft: await saveCutoutDraft(auth.storage, auth.userKey, draft) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function onRequestPut(context: FunctionContext) {
  return onRequestPost(context);
}

export async function onRequestDelete(context: FunctionContext) {
  const auth = await requireStorage(context);
  if ("response" in auth) return auth.response;

  try {
    await deleteCutoutDraft(auth.storage, auth.userKey);
    return json({ ok: true });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
