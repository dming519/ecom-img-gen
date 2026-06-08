import type {
  AspectRatio,
  ImageQuality,
  ImageSize,
  MultiViewAngleId,
} from "../../../src/lib/types";
import { requireSession } from "../_lib/auth";
import {
  readProductImageDataUrls,
  type HistoryStorageEnv,
} from "../_lib/historyStorage";
import { getUserKey, requireImageCredit, type UserKvNamespace } from "../_lib/users";

interface GenerateRequestBody {
  mode?: "multi-view";
  prompt?: string;
  angleId?: MultiViewAngleId;
  size?: ImageSize;
  aspectRatio?: AspectRatio;
  quality?: ImageQuality;
  inputImageIds?: string[];
}

// 图片生成接口只创建任务，不直接等待模型返回，避免请求长时间占用 Pages。
interface RequestContext {
  request: Request;
  env: {
    TASKS_KV?: UserKvNamespace & {
      put: (
        key: string,
        value: string,
        options?: { expirationTtl?: number },
      ) => Promise<void>;
    };
    IMAGE_WORKER_URL?: string;
    IMAGE_WORKER_TOKEN?: string;
    AUTH_SECRET?: string;
  } & HistoryStorageEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

// 统一 JSON 响应格式。
function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

const ASPECT_RATIOS: AspectRatio[] = ["auto", "1:1", "4:3", "3:4", "16:9", "9:16"];
const IMAGE_QUALITIES: ImageQuality[] = ["1K", "2K", "4K"];
const IMAGE_SIZES: ImageSize[] = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const MULTI_VIEW_ANGLE_INSTRUCTIONS: Record<MultiViewAngleId, { title: string; instruction: string }> = {
  front: {
    title: "正面",
    instruction: "front view, product facing camera directly, key visual identity clearly visible",
  },
  "left-side": {
    title: "左侧",
    instruction: "left side profile view, product body complete and vertically aligned",
  },
  "right-side": {
    title: "右侧",
    instruction: "right side profile view, product body complete and vertically aligned",
  },
  back: {
    title: "背面",
    instruction: "back view, same product turned around, infer only from visible structure and do not redesign",
  },
  "oblique-45": {
    title: "45°斜侧",
    instruction: "45-degree three-quarter oblique side view, product rotated naturally with full body visible",
  },
  top: {
    title: "俯视",
    instruction: "top view, show top structure only when meaningful for this product shape",
  },
  "bottom-up": {
    title: "仰视",
    instruction: "low angle upward view, show underside or base structure only when meaningful and infer conservatively",
  },
  detail: {
    title: "局部特写",
    instruction: "close product-only detail view of the most useful structure, material, seam, opening, interface, cap, sole, clasp, or packaging side",
  },
};

// 所有 normalizeXxx 函数都在做同一件事：把不可信的请求参数转成安全默认值。
function normalizeAspectRatio(value: unknown): AspectRatio {
  return typeof value === "string" && ASPECT_RATIOS.includes(value as AspectRatio)
    ? (value as AspectRatio)
    : "3:4";
}

function normalizeQuality(value: unknown): ImageQuality {
  return typeof value === "string" && IMAGE_QUALITIES.includes(value as ImageQuality)
    ? (value as ImageQuality)
    : "1K";
}

function normalizeSize(value: unknown): ImageSize | null {
  return typeof value === "string" && IMAGE_SIZES.includes(value as ImageSize)
    ? (value as ImageSize)
    : null;
}

// 用户没有显式传 size 时，根据比例推导模型需要的尺寸。
function resolveImageSize(aspectRatio: AspectRatio): ImageSize {
  if (aspectRatio === "auto") return "auto";
  if (aspectRatio === "1:1") return "1024x1024";
  if (aspectRatio === "4:3" || aspectRatio === "16:9") return "1536x1024";
  return "1024x1536";
}

function normalizeImageIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && !!id.trim()).slice(0, 8)
    : [];
}

function normalizeMultiViewAngleId(value: unknown): MultiViewAngleId | null {
  return typeof value === "string" && value in MULTI_VIEW_ANGLE_INSTRUCTIONS
    ? (value as MultiViewAngleId)
    : null;
}

function createMultiViewPrompt(angleId: MultiViewAngleId) {
  const angle = MULTI_VIEW_ANGLE_INSTRUCTIONS[angleId];
  return [
    "Generate one clean ecommerce product packshot on a pure white background.",
    "Output only the product body. No marketing copy, no angle labels, no text overlays, no icons, no badges, no cards, no borders, no decorative elements, no hands, no people, no table, no shelf, no lifestyle scene, no props.",
    "The product must match the uploaded reference images for color, material, structure, packaging shape, visible logo, label layout, proportions, transparency, seams, interfaces and all visible product identity.",
    "Only change the camera/view angle. Do not redesign, replace, simplify, or invent a different product.",
    "If this exact angle is not fully visible in the references, infer conservatively from visible structure and keep the same product design.",
    `Required angle: ${angle.title} (${angle.instruction}).`,
    "The full product should be centered, complete, sharp, evenly lit, isolated on pure #ffffff background, with natural minimal contact shadow only if needed to ground the object.",
  ].join("\n");
}

// POST /api/generate：创建单张详情图生成任务。
export async function handlePost(context: RequestContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再生成商品详情图" }, { status: 401 });
  }

  let body: GenerateRequestBody;
  try {
    body = (await context.request.json()) as GenerateRequestBody;
  } catch {
    return json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const kv = context.env.TASKS_KV;
  const workerUrl = context.env.IMAGE_WORKER_URL?.trim();
  const workerToken = context.env.IMAGE_WORKER_TOKEN?.trim();
  if (!kv) {
    return json({ error: "服务端未配置 TASKS_KV" }, { status: 500 });
  }
  if (!workerUrl) {
    return json({ error: "服务端未配置 IMAGE_WORKER_URL" }, { status: 500 });
  }
  if (!workerToken) {
    return json({ error: "服务端未配置 IMAGE_WORKER_TOKEN" }, { status: 500 });
  }

  const mode = body.mode === "multi-view" ? "multi-view" : "detail";
  const angleId = mode === "multi-view" ? normalizeMultiViewAngleId(body.angleId) : null;
  if (mode === "multi-view" && body.prompt) {
    return json({ error: "多视角生成不接收前端 prompt" }, { status: 400 });
  }
  const prompt = mode === "multi-view"
    ? angleId
      ? createMultiViewPrompt(angleId)
      : ""
    : body.prompt?.trim() ?? "";
  const userKey = getUserKey(session.user);
  const imageIds = normalizeImageIds(body.inputImageIds);
  let storedImages: Array<string | null> = [];
  if (imageIds.length) {
    try {
      storedImages = await readProductImageDataUrls(context.env, userKey, imageIds);
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
  const images = storedImages.filter((image): image is string => !!image).slice(0, 8);
  const aspectRatio = normalizeAspectRatio(body.aspectRatio);
  const quality = normalizeQuality(body.quality);
  const size = normalizeSize(body.size) ?? resolveImageSize(aspectRatio);
  // 纯文案生成被禁用，强制要求参考图，保证商品外观一致。
  if (mode === "multi-view" && !angleId) {
    return json({ error: "请选择有效的多视角角度" }, { status: 400 });
  }
  if (!prompt) {
    return json(
      { error: mode === "multi-view" ? "请选择有效的多视角角度" : "请输入详情图文案" },
      { status: 400 },
    );
  }
  if (!images.length) {
    return json(
      {
        error:
          mode === "multi-view"
            ? "请上传产品参考图后再生成多视角产品图。"
            : "请上传产品参考图后再生成详情图。系统已禁止纯文案生成，以保证产品外观一致。",
      },
      { status: 400 },
    );
  }

  let creditResult: Awaited<ReturnType<typeof requireImageCredit>>;
  try {
    // 这里只检查是否有额度；真正扣费在任务成功后由 status 接口完成。
    creditResult = await requireImageCredit(context.env, session.user);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 402 },
    );
  }

  const taskId = crypto.randomUUID();
  const now = Date.now();
  // KV 里先放 pending 状态，前端随后通过 `/api/generate/status` 轮询。
  await kv.put(
    `task:${taskId}`,
    JSON.stringify({
      status: "pending",
      userKey,
      createdAt: now,
      updatedAt: now,
    }),
    { expirationTtl: 3600 },
  );

  try {
    // Worker 负责调用图像模型，Pages API 负责鉴权、参数校验和任务派发。
    const dispatch = await fetch(`${workerUrl.replace(/\/+$/, "")}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        taskId,
        prompt,
        size,
        aspectRatio,
        quality,
        inputImages: images,
        userKey,
      }),
    });
    if (!dispatch.ok) {
      const detail = await dispatch.text().catch(() => "");
      throw new Error(`HTTP ${dispatch.status}: ${detail.slice(0, 300)}`);
    }
  } catch (error) {
    await kv.put(
      `task:${taskId}`,
      JSON.stringify({
        status: "failed",
        userKey,
        createdAt: now,
        updatedAt: Date.now(),
        error:
          "图片生成任务派发失败：" +
          (error instanceof Error ? error.message : String(error)),
      }),
      { expirationTtl: 3600 },
    );
    return json(
      {
        error:
          "图片生成任务派发失败：" +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 502 },
    );
  }

  return json(
    {
      taskId,
      status: "pending",
      remainingCredits: creditResult.user.remainingCredits,
      usedCredits: creditResult.user.usedCredits,
      unlimitedCredits: creditResult.unlimited,
    },
    { status: 202 },
  );
}
