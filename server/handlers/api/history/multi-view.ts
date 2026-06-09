import {
  deleteMultiViewHistory,
  json,
  listMultiViewHistory,
  requireUserHistoryStorage,
  saveMultiViewHistory,
  type HistoryStorageFunctionEnv,
} from "../../_lib/historyStorage";
import type { MultiViewHistoryItem } from "../../../../src/lib/types";

interface RequestContext {
  request: Request;
  env: HistoryStorageFunctionEnv;
}

function parseId(request: Request) {
  const raw = new URL(request.url).searchParams.get("id");
  if (!raw) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("多视角历史 ID 无效");
  }
  return id;
}

async function readItem(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { item?: MultiViewHistoryItem }
    | MultiViewHistoryItem
    | null;
  const item =
    body && "results" in body && "createdAt" in body
      ? body
      : body && "item" in body
        ? body.item
        : null;
  if (!item || typeof item !== "object") {
    throw new Error("请求体缺少多视角历史");
  }
  return item;
}

export async function handleGet(context: RequestContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问多视角历史");
  if ("response" in auth) return auth.response;

  try {
    return json({ items: await listMultiViewHistory(auth.storage, auth.userKey) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function handlePost(context: RequestContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问多视角历史");
  if ("response" in auth) return auth.response;

  try {
    const item = await readItem(context.request);
    return json({ item: await saveMultiViewHistory(auth.storage, auth.userKey, item) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function handlePut(context: RequestContext) {
  return handlePost(context);
}

export async function handleDelete(context: RequestContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问多视角历史");
  if ("response" in auth) return auth.response;

  try {
    await deleteMultiViewHistory(auth.storage, auth.userKey, parseId(context.request));
    return json({ ok: true });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
