import { requireSession } from "../../_lib/auth";
import {
  json,
  readStoredImageFile,
  requireHistoryBindings,
  type HistoryD1Database,
  type HistoryR2Bucket,
} from "../../_lib/historyStorage";
import { getUserKey, type UserKvNamespace } from "../../_lib/users";

interface FunctionContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    TASKS_KV?: UserKvNamespace;
    HISTORY_DB?: HistoryD1Database;
    HISTORY_BUCKET?: HistoryR2Bucket;
  };
}

export async function onRequestGet(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再读取图片" }, { status: 401 });
  }

  const id = new URL(context.request.url).searchParams.get("id")?.trim();
  if (!id) {
    return json({ error: "缺少图片 ID" }, { status: 400 });
  }

  try {
    const storage = requireHistoryBindings(context.env);
    const file = await readStoredImageFile(storage, getUserKey(session.user), id);
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
