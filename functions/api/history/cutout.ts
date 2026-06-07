import {
  deleteCutoutHistory,
  json,
  listCutoutHistory,
  requireUserHistoryStorage,
  saveCutoutHistory,
  type HistoryStorageFunctionEnv,
} from "../../_lib/historyStorage";
import type { CutoutHistoryItem } from "../../../src/lib/types";

interface FunctionContext {
  request: Request;
  env: HistoryStorageFunctionEnv;
}

function parseId(request: Request) {
  const raw = new URL(request.url).searchParams.get("id");
  if (!raw) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("抠图历史 ID 无效");
  }
  return id;
}

async function readItem(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { item?: CutoutHistoryItem }
    | CutoutHistoryItem
    | null;
  const item =
    body && "status" in body && "createdAt" in body
      ? body
      : body && "item" in body
        ? body.item
        : null;
  if (!item || typeof item !== "object") {
    throw new Error("请求体缺少抠图历史");
  }
  return item;
}

export async function onRequestGet(context: FunctionContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问抠图历史");
  if ("response" in auth) return auth.response;

  try {
    return json({ items: await listCutoutHistory(auth.storage, auth.userKey) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function onRequestPost(context: FunctionContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问抠图历史");
  if ("response" in auth) return auth.response;

  try {
    const item = await readItem(context.request);
    return json({ item: await saveCutoutHistory(auth.storage, auth.userKey, item) });
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
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问抠图历史");
  if ("response" in auth) return auth.response;

  try {
    await deleteCutoutHistory(auth.storage, auth.userKey, parseId(context.request));
    return json({ ok: true });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
