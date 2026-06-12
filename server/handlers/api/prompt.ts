import { DETAIL_PROMPT_TEMPLATE } from "../../../src/lib/promptTemplate";
import { requireSession } from "../_lib/auth";
import {
  readProductImageDataUrls,
  type HistoryStorageEnv,
} from "../_lib/historyStorage";
import { getUserKey, type UserKvNamespace } from "../_lib/users";
import type { DetailImageMode } from "../../../src/lib/types";

interface PromptRequestBody {
  name?: string;
  sellingPoints?: string;
  imageModes?: unknown;
  targetPlatform?: string;
  audience?: string;
  priceBand?: string;
  proofMaterials?: string;
  offer?: string;
  productImageIds?: string[];
}

// Nuxt/Nitro 会把运行时环境变量、KV、Hyperdrive 等都放进 context.env。
interface RequestContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    LLM_API_KEY?: string;
    LLM_BASE_URL?: string;
    LLM_MODEL?: string;
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

function resolveImageModeCount(mode: DetailImageMode) {
  return mode === "main" ? 5 : 8;
}

function normalizeImageModes(value: unknown): DetailImageMode[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<DetailImageMode>();
  for (const mode of source) {
    if (mode === "main" || mode === "detail") seen.add(mode);
  }
  const ordered: DetailImageMode[] = [];
  if (seen.has("main")) ordered.push("main");
  if (seen.has("detail")) ordered.push("detail");
  return ordered;
}

function resolveImageModesCount(modes: DetailImageMode[]) {
  return modes.reduce((sum, mode) => sum + resolveImageModeCount(mode), 0);
}

function describeImageModes(modes: DetailImageMode[]) {
  return modes.map((mode) => (mode === "main" ? "主图" : "详情图")).join(" + ");
}

function describeImageModeCounts(modes: DetailImageMode[]) {
  return modes
    .map((mode) => `${mode === "main" ? "主图" : "详情图"} ${resolveImageModeCount(mode)} 张`)
    .join("，");
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 1200) : "";
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

// POST /api/prompt：创建“图包方案生成”任务。
export async function handlePost(context: RequestContext) {
  // 所有生成类接口都要求登录，避免匿名用户消耗模型额度。
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再生成图包方案" }, { status: 401 });
  }

  let body: PromptRequestBody;
  try {
    body = (await context.request.json()) as PromptRequestBody;
  } catch {
    return json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const name = body.name?.trim() ?? "";
  const sellingPoints = body.sellingPoints?.trim() ?? "";
  const imageModes = normalizeImageModes(body.imageModes);
  const imageCount = resolveImageModesCount(imageModes);
  const targetPlatform = normalizeOptionalText(body.targetPlatform) || "淘宝 / 天猫 / 京东 / 抖音商城 / 小红书";
  const audience = normalizeOptionalText(body.audience);
  const priceBand = normalizeOptionalText(body.priceBand);
  const proofMaterials = normalizeOptionalText(body.proofMaterials);
  const offer = normalizeOptionalText(body.offer);
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
    return json({ error: "商品参考图不存在或无权访问" }, { status: 400 });
  }
  const productImages = normalizeProductImages(
    storedImages.filter((image): image is string => !!image),
  );

  // 这些校验直接返回 400，属于用户输入问题，不需要派发到 Worker。
  if (!name) {
    return json({ error: "请输入商品名称" }, { status: 400 });
  }
  if (!sellingPoints) {
    return json({ error: "请输入商品核心卖点和功效" }, { status: 400 });
  }
  if (!imageModes.length) {
    return json({ error: "请选择图包类型：主图或详情图" }, { status: 400 });
  }
  if (!productImages.length) {
    return json({ error: "请至少上传一张商品图片" }, { status: 400 });
  }

  const kv = context.env.TASKS_KV;
  const workerUrl = context.env.IMAGE_WORKER_URL?.trim();
  const workerToken = context.env.IMAGE_WORKER_TOKEN?.trim();
  const apiKey = context.env.LLM_API_KEY?.trim();
  const baseUrl = context.env.LLM_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const model = context.env.LLM_MODEL?.trim();

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
          "服务端缺少 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 配置",
      },
      { status: 500 },
    );
  }

  // userText 是本次商品资料；DETAIL_PROMPT_TEMPLATE 是稳定的系统模板。
  const userText = [
    "请严格根据系统模板和上传商品图生成国内电商图包方案。",
    "",
    `商品名称：${name}`,
    `图包类型：${describeImageModes(imageModes)}`,
    `图片数量：${describeImageModeCounts(imageModes)}，总计 ${imageCount} 张`,
    `目标平台：${targetPlatform}`,
    `目标人群 / 购买场景：${audience || "未填写，请基于商品品类和卖点保守推断，并在 prompt 中使用通用国内电商场景。"}`,
    `价格带 / 客单价：${priceBand || "未填写，请按中性价位表达，不要编造具体价格。"}`,
    `证明素材 / 资质 / 用户评价：${proofMaterials || "未填写，不要编造具体认证、检测编号、真实评价截图或平台徽章；可使用温和的占位式表达。"}`,
    `活动 / 售后 / 服务承诺：${offer || "未填写，可使用通用低风险购买表达，不要编造具体优惠力度。"}`,
    "商品核心卖点和功效：",
    sellingPoints,
    "",
    "输出格式要求：只返回 JSON，不要 Markdown，不要解释。",
    `JSON 结构：{"prompts":[{"imageMode":"main","title":"第1张：首图核心卖点主视觉","prompt":"完整可直接用于 GPT-Image-2 的单张图片生成提示词"}]}`,
    "prompt 字段如需分段，必须使用 \\n 表示换行，保留清晰的段落结构。",
    "生成前必须先在内部完成国内电商转化诊断、买家购买理由卡、图内文案门和统一风格锁；不要把诊断过程输出到 JSON 外。",
    "按图包类型规划每张图主题：选中主图时必须输出 5 张商城主图轮播；选中详情图时必须输出 8 张竖版详情页模块；如果同时选中，必须先输出 5 张主图，再输出 8 张详情图。title 要体现该张图的成交任务，而不是机械套用固定五段式。",
    "参考图是商品事实来源，但不是每张图都必须完整展示参考图商品；可以根据该张图主题提取参考图里的材质、纹理、色彩、局部结构、包装标签、工艺细节、图案元素或使用状态。",
    `prompts 数组长度必须等于 ${imageCount}。每个数组项必须包含 imageMode，主图写 "main"，详情图写 "detail"。每个 prompt 必须是完整单张图片生成提示词，并包含图包类型、统一 Campaign Style Lock、单张 Frame Objective、短中文图内文案、构图、参考图一致性或参考图特征提取要求。主图按 1:1 方图构图；详情图按 3:4 竖版构图。不要输出“负面提示词”或“Negative Prompt”段落。`,
  ].join("\n");

  const taskId = crypto.randomUUID();
  const now = Date.now();
  await writePromptTask(kv, taskId, {
    status: "pending",
    userKey,
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
        userKey,
        imageModes,
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
      userKey,
      createdAt: now,
      updatedAt: Date.now(),
      error:
        "图包方案任务派发失败：" +
        (error instanceof Error ? error.message : String(error)),
    });
    return json(
      {
        error:
          "图包方案任务派发失败：" +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 502 },
    );
  }

  return json({ taskId, status: "pending" }, { status: 202 });
}
