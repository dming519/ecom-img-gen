import {
  json,
  readStoredImageFile,
  requireUserHistoryStorage,
  type HistoryStorageFunctionEnv,
} from "../../_lib/historyStorage";

interface FunctionContext {
  request: Request;
  env: HistoryStorageFunctionEnv;
}

export async function onRequestGet(context: FunctionContext) {
  const auth = await requireUserHistoryStorage(context, "请先登录后再读取图片");
  if ("response" in auth) return auth.response;

  const id = new URL(context.request.url).searchParams.get("id")?.trim();
  if (!id) {
    return json({ error: "缺少图片 ID" }, { status: 400 });
  }

  try {
    const file = await readStoredImageFile(auth.storage, auth.userKey, id);
    if (!file) {
      return json({ error: "图片不存在或无权访问" }, { status: 404 });
    }

    const body = file.object.body ?? (await file.object.arrayBuffer());
    return new Response(body, {
      headers: {
        "Content-Type": file.mimeType,
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
