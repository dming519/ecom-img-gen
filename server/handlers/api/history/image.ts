import {
  json,
  requireUserHistoryStorage,
  storeProductImage,
  type HistoryStorageFunctionEnv,
} from "../../_lib/historyStorage";

interface RequestContext {
  request: Request;
  env: HistoryStorageFunctionEnv;
}

export async function handlePost(context: RequestContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再上传图片");
  if ("response" in auth) return auth.response;

  try {
    const body = (await context.request.json().catch(() => null)) as {
      dataUrl?: string;
    } | null;
    const dataUrl = body?.dataUrl;
    if (!dataUrl || typeof dataUrl !== "string") {
      return json({ error: "请求体缺少图片数据" }, { status: 400 });
    }
    return json({ id: await storeProductImage(auth.storage, auth.userKey, dataUrl) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
