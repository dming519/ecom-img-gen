import { requireSession } from "../../_lib/auth";
import type { HistoryD1Database } from "../../_lib/historyStorage";
import {
  consumeImageCreditByUserKey,
  getUserKey,
  type UserKvNamespace,
} from "../../_lib/users";

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

interface CutoutTaskRecord {
  status?: string;
  userKey?: string;
  billedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
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

function normalizeTaskStatus(task: CutoutTaskRecord) {
  if (
    (task.status === "pending" || task.status === "running") &&
    Number.isFinite(task.updatedAt) &&
    Date.now() - Number(task.updatedAt) > 12 * 60 * 1000
  ) {
    return {
      ...task,
      status: "failed",
      error: "抠图任务已超时，请重新生成。",
      updatedAt: Date.now(),
    };
  }
  return task;
}

export async function onRequestGet(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录" }, { status: 401 });
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

  const taskKey = `cutout-task:${taskId}`;
  const rawTask = await kv.get(taskKey);
  if (!rawTask) {
    return json({ error: "任务不存在或已过期" }, { status: 404 });
  }

  let task: CutoutTaskRecord;
  try {
    task = JSON.parse(rawTask) as CutoutTaskRecord;
  } catch {
    return json({ error: "任务数据损坏" }, { status: 500 });
  }

  const normalized = normalizeTaskStatus(task);
  const sessionUserKey = getUserKey(session.user);
  if (normalized.userKey && normalized.userKey !== sessionUserKey) {
    return json({ error: "无权访问该任务" }, { status: 403 });
  }

  if (normalized.status === "succeeded" && !normalized.billedAt && normalized.userKey) {
    try {
      const billed = await consumeImageCreditByUserKey(context.env, normalized.userKey);
      const nextTask = {
        ...normalized,
        billedAt: Date.now(),
        remainingCredits: billed.user.remainingCredits,
        usedCredits: billed.user.usedCredits,
        unlimitedCredits: billed.unlimited,
      };
      await kv.put(taskKey, JSON.stringify(nextTask), { expirationTtl: 3600 });
      return json(nextTask);
    } catch (error) {
      return json(
        {
          ...normalized,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        },
        { status: 402 },
      );
    }
  }

  return json(normalized);
}
