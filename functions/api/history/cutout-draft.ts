import {
  deleteCutoutDraft,
  getCutoutDraft,
  json,
  requireUserHistoryStorage,
  saveCutoutDraft,
  type HistoryStorageFunctionEnv,
} from "../../_lib/historyStorage";
import type { CutoutDraft } from "../../../src/lib/types";

interface FunctionContext {
  request: Request;
  env: HistoryStorageFunctionEnv;
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
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问抠图草稿");
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
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问抠图草稿");
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
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问抠图草稿");
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
