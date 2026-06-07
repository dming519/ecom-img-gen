import { requireSession } from "../../_lib/auth";
import type { HistoryD1Database } from "../../_lib/historyStorage";
import { getUserKey, type UserKvNamespace } from "../../_lib/users";

interface FunctionContext {
  request: Request;
  env: {
    TASKS_KV?: UserKvNamespace & {
      get: (key: string) => Promise<string | null>;
      put: (
        key: string,
        value: string,
        options?: { expirationTtl?: number },
      ) => Promise<void>;
    };
    AUTH_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
  };
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

interface ImageTaskRecord {
  status?: string;
  userKey?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export async function onRequestPost(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录" }, { status: 401 });
  }

  const kv = context.env.TASKS_KV;
  if (!kv) {
    return json({ error: "服务端未配置 TASKS_KV" }, { status: 500 });
  }

  let body: { taskId?: string };
  try {
    body = (await context.request.json()) as { taskId?: string };
  } catch {
    return json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const taskId = body.taskId?.trim();
  if (!taskId) {
    return json({ error: "缺少 taskId" }, { status: 400 });
  }

  const taskKey = `task:${taskId}`;
  const rawTask = await kv.get(taskKey);
  if (!rawTask) {
    return json({ error: "任务不存在或已过期" }, { status: 404 });
  }

  let task: ImageTaskRecord;
  try {
    task = JSON.parse(rawTask) as ImageTaskRecord;
  } catch {
    task = {};
  }

  const sessionUserKey = getUserKey(session.user);
  if (task.userKey && task.userKey !== sessionUserKey) {
    return json({ error: "无权操作该任务" }, { status: 403 });
  }

  if (
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "canceled"
  ) {
    return json({ ok: true, status: task.status });
  }

  await kv.put(
    taskKey,
    JSON.stringify({
      ...task,
      status: "canceled",
      userKey: task.userKey ?? sessionUserKey,
      updatedAt: Date.now(),
      error: "用户已中断生成",
    }),
    { expirationTtl: 3600 },
  );

  return json({ ok: true, status: "canceled" });
}
