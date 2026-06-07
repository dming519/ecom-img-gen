import { requireSession } from "../../_lib/auth";
import type { HistoryD1Database } from "../../_lib/historyStorage";
import type { UserKvNamespace } from "../../_lib/users";

interface FunctionContext {
  request: Request;
  env: {
    TASKS_KV?: UserKvNamespace;
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

function normalizeTaskStatus(task: unknown) {
  if (!task || typeof task !== "object") return task;
  const value = task as {
    status?: string;
    createdAt?: number;
    updatedAt?: number;
  };
  if (
    (value.status === "pending" || value.status === "running") &&
    Number.isFinite(value.updatedAt) &&
    Date.now() - Number(value.updatedAt) > 8 * 60 * 1000
  ) {
    return {
      ...value,
      status: "failed",
      error: "详情图文案任务已超时，请重新生成。",
      updatedAt: Date.now(),
    };
  }
  return task;
}

export async function onRequestGet(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再查询详情图文案任务" }, { status: 401 });
  }

  const kv = context.env.TASKS_KV;
  if (!kv) {
    return json({ error: "服务端未配置 TASKS_KV" }, { status: 500 });
  }

  const url = new URL(context.request.url);
  const taskId = url.searchParams.get("taskId")?.trim();
  if (!taskId) {
    return json({ error: "缺少 taskId" }, { status: 400 });
  }

  const task = await kv.get(`prompt-task:${taskId}`);
  if (!task) {
    return json({ error: "任务不存在或已过期" }, { status: 404 });
  }

  return json(normalizeTaskStatus(JSON.parse(task)));
}
