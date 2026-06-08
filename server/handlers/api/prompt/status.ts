import { requireSession } from "../../_lib/auth";
import {
  json,
  storeDetailPrompt,
  type HistoryD1Database,
} from "../../_lib/historyStorage";
import type { TaskKvNamespace } from "../../_lib/tasks";
import { getUserKey } from "../../_lib/users";

interface RequestContext {
  request: Request;
  env: {
    TASKS_KV?: TaskKvNamespace;
    AUTH_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
  };
}

interface PromptTaskPrompt {
  promptId?: unknown;
  id?: unknown;
  title?: unknown;
  prompt?: unknown;
  index?: unknown;
}

interface PromptTaskRecord {
  status?: string;
  userKey?: string;
  prompts?: PromptTaskPrompt[];
  model?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

const TASK_TTL_SECONDS = 3600;
const TASK_TIMEOUT_MS = 8 * 60 * 1000;

function taskKey(taskId: string) {
  return `prompt-task:${taskId}`;
}

function normalizePromptId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeIndex(value: unknown, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function normalizeTitle(value: unknown, index: number) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : `第${index + 1}张商品详情图`;
}

function hasPromptText(item: PromptTaskPrompt) {
  return typeof item.prompt === "string" && !!item.prompt.trim();
}

function normalizeTaskStatus(task: PromptTaskRecord) {
  if (
    (task.status === "pending" || task.status === "running") &&
    Number.isFinite(task.updatedAt) &&
    Date.now() - Number(task.updatedAt) > TASK_TIMEOUT_MS
  ) {
    return {
      ...task,
      status: "failed",
      error: "详情图文案任务已超时，请重新生成。",
      updatedAt: Date.now(),
    };
  }
  return task;
}

function stripPromptText(task: PromptTaskRecord): PromptTaskRecord {
  if (!Array.isArray(task.prompts)) return task;
  return {
    ...task,
    prompts: task.prompts.map((item, index) => ({
      promptId: normalizePromptId(item.promptId ?? item.id),
      title: normalizeTitle(item.title, index),
      index: normalizeIndex(item.index, index),
    })),
  };
}

async function persistPrompts(
  context: RequestContext,
  kv: TaskKvNamespace,
  key: string,
  taskId: string,
  task: PromptTaskRecord,
  userKey: string,
) {
  if (task.status !== "succeeded" || !Array.isArray(task.prompts)) {
    return task;
  }

  const prompts = await Promise.all(
    task.prompts.map(async (item, index) => {
      const promptId = normalizePromptId(item.promptId ?? item.id) || crypto.randomUUID();
      const title = normalizeTitle(item.title, index);
      const promptIndex = normalizeIndex(item.index, index);
      if (hasPromptText(item)) {
        await storeDetailPrompt(context.env, userKey, {
          id: promptId,
          title,
          prompt: String(item.prompt),
          taskId,
          index: promptIndex,
        });
      }
      return {
        promptId,
        title,
        index: promptIndex,
      };
    }),
  );

  const nextTask = {
    ...task,
    userKey: task.userKey ?? userKey,
    prompts,
    updatedAt: Date.now(),
  };
  await kv.put(key, JSON.stringify(nextTask), { expirationTtl: TASK_TTL_SECONDS });
  return nextTask;
}

export async function handleGet(context: RequestContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再查询详情图文案任务" }, { status: 401 });
  }

  const kv = context.env.TASKS_KV;
  if (!kv) {
    return json({ error: "服务端未配置 TASKS_KV" }, { status: 500 });
  }

  const taskId = new URL(context.request.url).searchParams.get("taskId")?.trim();
  if (!taskId) {
    return json({ error: "缺少 taskId" }, { status: 400 });
  }

  const key = taskKey(taskId);
  const rawTask = await kv.get(key);
  if (!rawTask) {
    return json({ error: "任务不存在或已过期" }, { status: 404 });
  }

  let task: PromptTaskRecord;
  try {
    task = JSON.parse(rawTask) as PromptTaskRecord;
  } catch {
    return json({ error: "任务数据损坏" }, { status: 500 });
  }

  const userKey = getUserKey(session.user);
  const normalized = normalizeTaskStatus(task);
  if (normalized.userKey && normalized.userKey !== userKey) {
    return json({ error: "无权访问该任务" }, { status: 403 });
  }

  try {
    const persisted = await persistPrompts(context, kv, key, taskId, normalized, userKey);
    return json(stripPromptText(persisted));
  } catch (error) {
    return json(
      {
        status: "failed",
        error: `详情图文案保存失败：${error instanceof Error ? error.message : String(error)}`,
        updatedAt: Date.now(),
      },
      { status: 500 },
    );
  }
}
