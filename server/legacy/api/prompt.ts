import { DETAIL_PROMPT_TEMPLATE } from "../../../src/lib/promptTemplate";
import { requireSession } from "../_lib/auth";
import type { HistoryD1Database } from "../_lib/historyStorage";
import type { UserKvNamespace } from "../_lib/users";

interface PromptRequestBody {
  name?: string;
  sellingPoints?: string;
  imageCount?: number;
  productImages?: string[];
}

interface FunctionContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    OPENAI_API_KEY?: string;
    OPENAI_BASE_URL?: string;
    OPENAI_MODEL?: string;
    PROMPT_API_KEY?: string;
    PROMPT_BASE_URL?: string;
    PROMPT_MODEL?: string;
    TASKS_KV?: UserKvNamespace;
    HISTORY_DB?: HistoryD1Database;
    IMAGE_WORKER_URL?: string;
    IMAGE_WORKER_TOKEN?: string;
  };
  waitUntil?: (promise: Promise<unknown>) => void;
}

const MAX_PROMPT_IMAGE_CHARS = 1_500_000;
const MAX_PROMPT_IMAGE_TOTAL_CHARS = 6_000_000;

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

function normalizeCount(value: number | undefined) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(8, Math.max(1, Math.round(value ?? 5)));
}

function normalizeProductImages(images: string[] | undefined) {
  const normalized = (images ?? [])
    .filter((image) => image.startsWith("data:image/") || /^https?:\/\//i.test(image))
    .filter((image) => image.length <= MAX_PROMPT_IMAGE_CHARS)
    .slice(0, 8);
  const total = normalized.reduce((sum, image) => sum + image.length, 0);
  if (total > MAX_PROMPT_IMAGE_TOTAL_CHARS) return [];
  return normalized;
}

async function writePromptTask(
  kv: UserKvNamespace,
  taskId: string,
  data: Record<string, unknown>,
) {
  await kv.put(`prompt-task:${taskId}`, JSON.stringify(data), {
    expirationTtl: 3600,
  });
}

export async function onRequestPost(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再生成详情图文案" }, { status: 401 });
  }

  let body: PromptRequestBody;
  try {
    body = (await context.request.json()) as PromptRequestBody;
  } catch {
    return json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const name = body.name?.trim() ?? "";
  const sellingPoints = body.sellingPoints?.trim() ?? "";
  const imageCount = normalizeCount(body.imageCount);
  const productImages = normalizeProductImages(body.productImages);

  if (!name) {
    return json({ error: "请输入产品名称" }, { status: 400 });
  }
  if (!sellingPoints) {
    return json({ error: "请输入产品核心卖点和功效" }, { status: 400 });
  }
  if (!productImages.length) {
    return json({ error: "请至少上传一张产品图片" }, { status: 400 });
  }

  const kv = context.env.TASKS_KV;
  const workerUrl = context.env.IMAGE_WORKER_URL?.trim();
  const workerToken = context.env.IMAGE_WORKER_TOKEN?.trim();
  const apiKey =
    context.env.PROMPT_API_KEY?.trim() || context.env.OPENAI_API_KEY?.trim();
  const baseUrl = (
    context.env.PROMPT_BASE_URL?.trim() ||
    context.env.OPENAI_BASE_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  const model =
    context.env.PROMPT_MODEL?.trim() || context.env.OPENAI_MODEL?.trim();

  if (!kv) {
    return json({ error: "服务端未配置 TASKS_KV" }, { status: 500 });
  }
  if (!workerUrl) {
    return json({ error: "服务端未配置 IMAGE_WORKER_URL" }, { status: 500 });
  }
  if (!workerToken) {
    return json({ error: "服务端未配置 IMAGE_WORKER_TOKEN" }, { status: 500 });
  }
  if (!apiKey || !baseUrl || !model) {
    return json(
      {
        error:
          "服务端缺少 PROMPT_API_KEY / PROMPT_BASE_URL / PROMPT_MODEL 配置",
      },
      { status: 500 },
    );
  }

  const userText = [
    "请严格根据系统模板和上传产品图生成商品详情图文案。",
    "",
    `产品名称：${name}`,
    `图片数量：${imageCount}`,
    "产品核心卖点和功效：",
    sellingPoints,
    "",
    "输出格式要求：只返回 JSON，不要 Markdown，不要解释。",
    `JSON 结构：{"prompts":[{"title":"第1张：产品主图 / 核心卖点总览","prompt":"完整可直接用于 GPT-Image-2 的单张详情图文案"}]}`,
    "prompt 字段如需分段，必须使用 \\n 表示换行，保留清晰的段落结构。",
    `prompts 数组长度必须等于 ${imageCount}。每个 prompt 必须是完整单张图片生成提示词，并包含统一视觉系统、构图、中文文案、4:5 竖版、严格参考产品图片等要求。不要输出“负面提示词”或“Negative Prompt”段落。`,
  ].join("\n");

  const taskId = crypto.randomUUID();
  const now = Date.now();
  await writePromptTask(kv, taskId, {
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  try {
    const response = await fetch(`${workerUrl.replace(/\/+$/, "")}/prompt-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        taskId,
        imageCount,
        productImages,
        userText,
        systemTemplate: DETAIL_PROMPT_TEMPLATE,
        apiKey,
        baseUrl,
        model,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
  } catch (error) {
    await writePromptTask(kv, taskId, {
      status: "failed",
      createdAt: now,
      updatedAt: Date.now(),
      error:
        "详情图文案任务派发失败：" +
        (error instanceof Error ? error.message : String(error)),
    });
    return json(
      {
        error:
          "详情图文案任务派发失败：" +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 502 },
    );
  }

  return json({ taskId, status: "pending" }, { status: 202 });
}
