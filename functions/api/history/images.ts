import {
  json,
  readProductImages,
  requireUserHistoryStorage,
  type HistoryStorageFunctionEnv,
} from "../../_lib/historyStorage";

interface FunctionContext {
  request: Request;
  env: HistoryStorageFunctionEnv;
}

export async function onRequestPost(context: FunctionContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再读取图片");
  if ("response" in auth) return auth.response;

  try {
    const body = (await context.request.json().catch(() => null)) as {
      ids?: string[];
    } | null;
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id): id is string => typeof id === "string" && !!id)
      : [];
    return json({ images: await readProductImages(auth.storage, auth.userKey, ids) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
