import { DETAIL_PROMPT_TEMPLATE } from "../../../src/lib/promptTemplate";
import { requireSession } from "../_lib/auth";
import {
  readProductImageDataUrls,
  type HistoryStorageEnv,
} from "../_lib/historyStorage";
import { getUserKey, type UserKvNamespace } from "../_lib/users";

interface PromptRequestBody {
  name?: string;
  sellingPoints?: string;
  imageCount?: number;
  productImageIds?: string[];
}

// Nuxt/Nitro 会把运行时环境变量、KV、D1 等都放进 context.env。
interface RequestContext {
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
    IMAGE_WORKER_URL?: string;
    IMAGE_WORKER_TOKEN?: string;
  } & HistoryStorageEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

// 文案接口会携带参考图，限制单张和总大小，避免 Worker 请求体过大。
const MAX_PROMPT_IMAGE_CHARS = 1_500_000;
const MAX_PROMPT_IMAGE_TOTAL_CHARS = 6_000_000;

// 小项目里直接用这个 helper 返回 JSON，避免每个分支重复写 headers。
function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

// 用户可以选 1-8 张详情图；非法值统一回落到默认 5 张。
function normalizeCount(value: number | undefined) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(8, Math.max(1, Math.round(value ?? 5)));
}

// 只接受 data URL 或 http(s) 图片，并过滤超大图片。
function normalizeProductImages(images: string[] | undefined) {
  const normalized = (images ?? [])
    .filter((image) => image.startsWith("data:image/") || /^https?:\/\//i.test(image))
    .filter((image) => image.length <= MAX_PROMPT_IMAGE_CHARS)
    .slice(0, 8);
  const total = normalized.reduce((sum, image) => sum + image.length, 0);
  if (total > MAX_PROMPT_IMAGE_TOTAL_CHARS) return [];
  return normalized;
}

function normalizeImageIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && !!id.trim()).slice(0, 8)
    : [];
}

// 任务状态先写进 KV，前端之后通过 `/api/prompt/status?taskId=...` 查询。
async function writePromptTask(
  kv: UserKvNamespace,
  taskId: string,
  data: Record<string, unknown>,
) {
  await kv.put(`prompt-task:${taskId}`, JSON.stringify(data), {
    expirationTtl: 3600,
  });
}

// POST /api/prompt：创建“详情图文案生成”任务。
export async function handlePost(context: RequestContext) {
  // 所有生成类接口都要求登录，避免匿名用户消耗模型额度。
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
  const userKey = getUserKey(session.user);
  const productImageIds = normalizeImageIds(body.productImageIds);
  let storedImages: Array<string | null> = [];
  if (productImageIds.length) {
    try {
      storedImages = await readProductImageDataUrls(context.env, userKey, productImageIds);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
  if (storedImages.some((image) => !image)) {
    return json({ error: "产品参考图不存在或无权访问" }, { status: 400 });
  }
  const productImages = normalizeProductImages(
    storedImages.filter((image): image is string => !!image),
  );

  // 这些校验直接返回 400，属于用户输入问题，不需要派发到 Worker。
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

  // 下面这些配置缺失属于部署问题，返回 500 方便排查 Cloudflare 环境变量。
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

  // userText 是本次商品资料；DETAIL_PROMPT_TEMPLATE 是稳定的系统模板。
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
    "生成前先识别商品所属品类，并按该品类详情页侧重点规划每张图主题；title 要体现该张图的品类化模块，而不是机械套用固定五段式。",
    "参考图是产品事实来源，但不是每张图都必须完整展示参考图商品；可以根据该张图主题提取参考图里的材质、纹理、色彩、局部结构、包装标签、工艺细节、图案元素或使用状态。",
    `prompts 数组长度必须等于 ${imageCount}。每个 prompt 必须是完整单张图片生成提示词，并包含统一视觉系统、构图、中文文案、4:5 竖版、参考图一致性或参考图特征提取要求。不要输出“负面提示词”或“Negative Prompt”段落。`,
  ].join("\n");

  const taskId = crypto.randomUUID();
  const now = Date.now();
  await writePromptTask(kv, taskId, {
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  try {
    // Worker 负责真正调用模型；Pages API 只做鉴权、校验和任务派发。
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
