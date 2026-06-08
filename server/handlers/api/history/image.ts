import {
  json,
  requireUserHistoryStorage,
  storeProductImageFile,
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
    const contentType = context.request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "请使用 multipart/form-data 上传图片文件" }, { status: 415 });
    }
    const form = await context.request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return json({ error: "表单缺少图片文件" }, { status: 400 });
    }
    return json({ id: await storeProductImageFile(auth.storage, auth.userKey, file) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
