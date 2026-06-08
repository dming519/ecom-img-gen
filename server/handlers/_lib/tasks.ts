import { requireSession } from "./auth";
import type { HistoryD1Database } from "./historyStorage";
import {
  consumeImageCreditByUserKey,
  getUserKey,
  type UserKvNamespace,
} from "./users";

export interface TaskKvNamespace extends UserKvNamespace {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ) => Promise<void>;
}

interface TaskRequestContext {
  request: Request;
  env: {
    TASKS_KV?: TaskKvNamespace;
    AUTH_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
  };
}

interface TaskRouteOptions {
  prefix: string;
  unauthorizedMessage: string;
}

interface TaskStatusOptions extends TaskRouteOptions {
  timeoutMs: number;
  timeoutMessage: string;
  billOnSuccess?: boolean;
}

interface TaskCancelOptions extends TaskRouteOptions {
  canceledError: string;
}

interface TaskRecord {
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

function taskKey(prefix: string, taskId: string) {
  return `${prefix}:${taskId}`;
}

function parseTaskIdFromUrl(request: Request) {
  return new URL(request.url).searchParams.get("taskId")?.trim();
}

async function parseTaskIdFromBody(request: Request) {
  const body = (await request.json()) as { taskId?: string };
  return body.taskId?.trim();
}

function parseTaskRecord(raw: string) {
  return JSON.parse(raw) as TaskRecord;
}

function isTerminalStatus(status: string | undefined) {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function normalizeTaskStatus(task: TaskRecord, timeoutMs: number, timeoutMessage: string) {
  if (
    (task.status === "pending" || task.status === "running") &&
    Number.isFinite(task.updatedAt) &&
    Date.now() - Number(task.updatedAt) > timeoutMs
  ) {
    return {
      ...task,
      status: "failed",
      error: timeoutMessage,
      updatedAt: Date.now(),
    };
  }
  return task;
}

async function requireTaskAccess(
  context: TaskRequestContext,
  unauthorizedMessage: string,
) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return { response: json({ error: unauthorizedMessage }, { status: 401 }) };
  }
  const kv = context.env.TASKS_KV;
  if (!kv) {
    return { response: json({ error: "服务端未配置 TASKS_KV" }, { status: 500 }) };
  }
  return {
    kv,
    sessionUserKey: getUserKey(session.user),
  };
}

export async function handleTaskStatusRequest(
  context: TaskRequestContext,
  options: TaskStatusOptions,
) {
  const access = await requireTaskAccess(context, options.unauthorizedMessage);
  if ("response" in access) return access.response;

  const taskId = parseTaskIdFromUrl(context.request);
  if (!taskId) {
    return json({ error: "缺少 taskId" }, { status: 400 });
  }

  const key = taskKey(options.prefix, taskId);
  const rawTask = await access.kv.get(key);
  if (!rawTask) {
    return json({ error: "任务不存在或已过期" }, { status: 404 });
  }

  let task: TaskRecord;
  try {
    task = parseTaskRecord(rawTask);
  } catch {
    return json({ error: "任务数据损坏" }, { status: 500 });
  }

  const normalized = normalizeTaskStatus(task, options.timeoutMs, options.timeoutMessage);
  if (normalized.userKey && normalized.userKey !== access.sessionUserKey) {
    return json({ error: "无权访问该任务" }, { status: 403 });
  }

  if (
    options.billOnSuccess &&
    normalized.status === "succeeded" &&
    !normalized.billedAt &&
    normalized.userKey
  ) {
    try {
      const billed = await consumeImageCreditByUserKey(context.env, normalized.userKey);
      const nextTask = {
        ...normalized,
        billedAt: Date.now(),
        remainingCredits: billed.user.remainingCredits,
        usedCredits: billed.user.usedCredits,
        unlimitedCredits: billed.unlimited,
      };
      await access.kv.put(key, JSON.stringify(nextTask), { expirationTtl: 3600 });
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

export async function handleTaskCancelRequest(
  context: TaskRequestContext,
  options: TaskCancelOptions,
) {
  const access = await requireTaskAccess(context, options.unauthorizedMessage);
  if ("response" in access) return access.response;

  let taskId: string | undefined;
  try {
    taskId = await parseTaskIdFromBody(context.request);
  } catch {
    return json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  if (!taskId) {
    return json({ error: "缺少 taskId" }, { status: 400 });
  }

  const key = taskKey(options.prefix, taskId);
  const rawTask = await access.kv.get(key);
  if (!rawTask) {
    return json({ error: "任务不存在或已过期" }, { status: 404 });
  }

  let task: TaskRecord;
  try {
    task = parseTaskRecord(rawTask);
  } catch {
    task = {};
  }

  if (task.userKey && task.userKey !== access.sessionUserKey) {
    return json({ error: "无权操作该任务" }, { status: 403 });
  }

  if (isTerminalStatus(task.status)) {
    return json({ ok: true, status: task.status });
  }

  await access.kv.put(
    key,
    JSON.stringify({
      ...task,
      status: "canceled",
      userKey: task.userKey ?? access.sessionUserKey,
      updatedAt: Date.now(),
      error: options.canceledError,
    }),
    { expirationTtl: 3600 },
  );

  return json({ ok: true, status: "canceled" });
}
