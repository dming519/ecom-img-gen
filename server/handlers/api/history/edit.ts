import {
  deleteEditHistory,
  json,
  listEditHistory,
  requireUserHistoryStorage,
  saveEditHistory,
  type HistoryStorageFunctionEnv,
} from "../../_lib/historyStorage";
import type { EditHistoryItem } from "../../../../src/lib/types";

interface RequestContext {
  request: Request;
  env: HistoryStorageFunctionEnv;
}

function parseId(request: Request) {
  const raw = new URL(request.url).searchParams.get("id");
  if (!raw) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("改图历史 ID 无效");
  }
  return id;
}

async function readItem(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { item?: EditHistoryItem }
    | EditHistoryItem
    | null;
  const item =
    body && "status" in body && "createdAt" in body
      ? body
      : body && "item" in body
        ? body.item
        : null;
  if (!item || typeof item !== "object") {
    throw new Error("请求体缺少改图历史");
  }
  return item;
}

export async function handleGet(context: RequestContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问改图历史");
  if ("response" in auth) return auth.response;

  try {
    return json({ items: await listEditHistory(auth.storage, auth.userKey) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function handlePost(context: RequestContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问改图历史");
  if ("response" in auth) return auth.response;

  try {
    const item = await readItem(context.request);
    return json({ item: await saveEditHistory(auth.storage, auth.userKey, item) });
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
  const auth = await requireUserHistoryStorage(context, "请先登录后再访问改图历史");
  if ("response" in auth) return auth.response;

  try {
    await deleteEditHistory(auth.storage, auth.userKey, parseId(context.request));
    return json({ ok: true });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
