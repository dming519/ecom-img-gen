import { requireSession } from "../../_lib/auth";
import {
  json,
  readProductImages,
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

async function requireStorage(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return { response: json({ error: "请先登录后再读取图片" }, { status: 401 }) };
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

export async function onRequestPost(context: FunctionContext) {
  const auth = await requireStorage(context);
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
