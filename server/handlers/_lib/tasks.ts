import { requireSession } from "./auth";
import {
  storeHistoryImage,
  type HistoryStorageFunctionEnv,
} from "./historyStorage";
import {
  consumeImageCreditByUserKey,
  getUserKey,
  type UserKvNamespace,
} from "./users";

// TASKS_KV 是 Cloudflare KV，用来保存异步任务状态。
// Worker 写入结果，Pages API 读取结果并返回给前端。
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
  env: HistoryStorageFunctionEnv & {
    TASKS_KV?: TaskKvNamespace;
  };
}

interface TaskRouteOptions {
  prefix: string;
  unauthorizedMessage: string;
}

interface TaskStatusOptions extends TaskRouteOptions {
  timeoutMs: number;
  timeoutMessage: string;
  // true 表示任务成功后在 status 接口里扣费，避免派发成功但模型失败也扣次数。
  billOnSuccess?: boolean;
}

interface TaskCancelOptions extends TaskRouteOptions {
  canceledError: string;
}

interface TaskRecord {
  status?: string;
  userKey?: string;
  imageId?: string;
  base64?: unknown;
  // billedAt 存在时说明这条成功任务已经扣过费，防止前端多次轮询重复扣费。
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

// status 接口从 URL query 读 taskId；cancel 接口从 POST body 读 taskId。
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

function stripTaskBase64(task: TaskRecord) {
  const { base64: _base64, ...rest } = task;
  return rest;
}

async function ensureTaskImageId(
  context: TaskRequestContext,
  kv: TaskKvNamespace,
  key: string,
  task: TaskRecord,
) {
  if (task.status !== "succeeded" || typeof task.base64 !== "string") {
    return stripTaskBase64(task);
  }
  if (!task.userKey) {
    return stripTaskBase64(task);
  }

  const imageId =
    typeof task.imageId === "string" && task.imageId
      ? task.imageId
      : await storeHistoryImage(context.env, task.userKey, task.base64);
  const nextTask = stripTaskBase64({
    ...task,
    imageId,
    updatedAt: Date.now(),
  });
  await kv.put(key, JSON.stringify(nextTask), { expirationTtl: 3600 });
  return nextTask;
}

// 超过指定时间还在 pending/running，就把任务视为失败，避免前端无限等待。
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
  // 查询/取消任务也要校验登录态，并且只能访问自己的任务。
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

// 通用任务状态查询：generate、cutout、prompt 都复用这个流程。
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

  let responseTask: TaskRecord;
  try {
    responseTask = await ensureTaskImageId(context, access.kv, key, normalized);
  } catch (error) {
    return json(
      {
        ...stripTaskBase64(normalized),
        status: "failed",
        error: `图片结果转存失败：${error instanceof Error ? error.message : String(error)}`,
        updatedAt: Date.now(),
      },
      { status: 500 },
    );
  }

  // 图片/抠图任务只有成功后才扣费；文案任务不扣费，所以不传 billOnSuccess。
  if (
    options.billOnSuccess &&
    responseTask.status === "succeeded" &&
    !responseTask.billedAt &&
    responseTask.userKey
  ) {
    try {
      const billed = await consumeImageCreditByUserKey(context.env, responseTask.userKey);
      const nextTask = {
        ...responseTask,
        billedAt: Date.now(),
        remainingCredits: billed.user.remainingCredits,
        usedCredits: billed.user.usedCredits,
        dailyRemainingCredits: billed.user.dailyRemainingCredits,
        dailyUsedCredits: billed.user.dailyUsedCredits,
        dailyGrantedCredits: billed.user.dailyGrantedCredits,
        permanentRemainingCredits: billed.user.permanentRemainingCredits,
        permanentGrantedCredits: billed.user.permanentGrantedCredits,
        unlimitedCredits: billed.unlimited,
      };
      await access.kv.put(key, JSON.stringify(stripTaskBase64(nextTask)), { expirationTtl: 3600 });
      return json(stripTaskBase64(nextTask));
    } catch (error) {
      return json(
        {
          ...responseTask,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        },
        { status: 402 },
      );
    }
  }

  return json(stripTaskBase64(responseTask));
}

// 通用取消接口：把 KV 状态标记为 canceled，让前端停止等待。
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
