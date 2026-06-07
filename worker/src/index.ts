export interface Env {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  PROMPT_API_KEY?: string;
  PROMPT_BASE_URL?: string;
  PROMPT_MODEL?: string;
  IMAGE_WORKER_TOKEN?: string;
  TASKS_KV: KVNamespace;
  IMAGE_TASKS: DurableObjectNamespace;
  PROMPT_TASKS: DurableObjectNamespace;
  CUTOUT_TASKS: DurableObjectNamespace;
}

type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";
type AspectRatio = "auto" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
type ImageQuality = "1K" | "2K" | "4K";

interface GenerateRequestBody {
  prompt?: string;
  size?: ImageSize;
  aspectRatio?: AspectRatio;
  quality?: ImageQuality;
  inputImages?: string[];
  userKey?: string;
}

interface CutoutRequestBody {
  taskId?: string;
  sourceImage?: string;
  maskImage?: string;
  userKey?: string;
}

interface ImagesPayload {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
  message?: string;
}

interface StoredImageTask {
  status?: string;
}

interface ImageRequestAttemptResult {
  response: Response;
  text: string;
  attempts: number;
  retryErrors: string[];
}

const IMAGE_RETRY_ATTEMPTS = 3;
const IMAGE_RETRY_DELAYS = [1600, 3600];
const IMAGE_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

interface PromptRequestBody {
  taskId?: string;
  userText?: string;
  imageCount?: number;
  productImages?: string[];
  systemTemplate?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: { content?: string };
    delta?: { content?: string };
  }>;
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  content?: string;
  text?: string;
  output_text?: string;
  error?: { message?: string };
  message?: string;
}

function resolveOpenAiEndpoint(baseUrl: string, path: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const base = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  return `${base}${path}`;
}

function resolveImageEndpoint(baseUrl: string, hasImages: boolean) {
  return resolveOpenAiEndpoint(
    baseUrl,
    hasImages ? "/images/edits" : "/images/generations",
  );
}

function dataUrlToBlob(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
  if (!match) {
    throw new Error("图片数据格式无效，无法解析上传内容");
  }

  const mimeType = match[1] || "application/octet-stream";
  const payload = match[2] || "";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
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

function getUpstreamErrorDetail(text: string) {
  let detail = text.replace(/\s+/g, " ").trim().slice(0, 300);
  try {
    const payload = JSON.parse(text) as ImagesPayload;
    if (payload.error?.message) detail = payload.error.message;
    if (payload.message) detail = payload.message;
  } catch {
    // Keep raw response.
  }
  return detail;
}

function createImageRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  size: ImageSize,
  images: string[],
) {
  const hasImages = images.length > 0;
  if (!hasImages) {
    throw new Error("缺少产品参考图，系统已禁止纯文案生成");
  }

  const formData = new FormData();
  formData.append("model", model);
  formData.append("prompt", prompt);
  if (size !== "auto") {
    formData.append("size", size);
  }
  formData.append("response_format", "b64_json");
  images.forEach((image, index) => {
    const imageBlob = dataUrlToBlob(image);
    const extension = imageBlob.type.split("/")[1] || "png";
    formData.append("image", imageBlob, `product-${index + 1}.${extension}`);
  });

  return fetch(resolveImageEndpoint(baseUrl, true), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
}

function getAspectRatioInstruction(aspectRatio: AspectRatio) {
  if (aspectRatio === "auto") return "画面比例由模型自动选择，确保主体完整、构图稳定。";
  return `画面比例需要接近 ${aspectRatio}，主体完整，不要裁切商品关键区域。`;
}

async function isImageTaskCanceled(env: Env, taskKey: string) {
  const raw = await env.TASKS_KV.get(taskKey);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as StoredImageTask).status === "canceled";
  } catch {
    return false;
  }
}

function isRetryableImageStatus(status: number) {
  return IMAGE_RETRYABLE_STATUS.has(status);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function createImageRequestWithRetry(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  size: ImageSize,
  images: string[],
  shouldStop?: () => Promise<boolean>,
): Promise<ImageRequestAttemptResult> {
  const retryErrors: string[] = [];

  for (let attempt = 1; attempt <= IMAGE_RETRY_ATTEMPTS; attempt += 1) {
    if (await shouldStop?.()) {
      throw new Error("任务已取消");
    }

    try {
      const response = await createImageRequest(baseUrl, apiKey, model, prompt, size, images);
      const text = await response.text();
      if (
        response.ok ||
        !isRetryableImageStatus(response.status) ||
        attempt >= IMAGE_RETRY_ATTEMPTS
      ) {
        return {
          response,
          text,
          attempts: attempt,
          retryErrors,
        };
      }

      retryErrors.push(
        `第${attempt}次 HTTP ${response.status}: ${getUpstreamErrorDetail(text)}`,
      );
    } catch (error) {
      if (attempt >= IMAGE_RETRY_ATTEMPTS) {
        throw new Error(
          [...retryErrors, `第${attempt}次请求异常: ${getErrorMessage(error)}`].join("；"),
        );
      }
      retryErrors.push(`第${attempt}次请求异常: ${getErrorMessage(error)}`);
    }

    await sleep(IMAGE_RETRY_DELAYS[Math.min(attempt - 1, IMAGE_RETRY_DELAYS.length - 1)]);
  }

  throw new Error("图片生成请求重试失败");
}

function formatImageAttemptFailure(label: string, result: ImageRequestAttemptResult) {
  const detail = `HTTP ${result.response.status}: ${getUpstreamErrorDetail(result.text)}`;
  const retries = result.retryErrors.length ? `；${result.retryErrors.join("；")}` : "";
  return `${label}失败（已尝试 ${result.attempts} 次）: ${detail}${retries}`;
}

function summarizeRawText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function removeNegativePromptSection(text: string) {
  return text
    .replace(
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:负面提示词|Negative\s*Prompt)[^\n]*\n[\s\S]*?(?=\n\s*(?:#{1,6}\s*)?(?:最终输出要求|第\d+张|图片质量要求|页面设计要求|视觉设计要求|$))/gi,
      "\n",
    )
    .replace(
      /(?:^|\n)\s*(?:负面提示词|Negative\s*Prompt)[：:][\s\S]*$/gi,
      "\n",
    );
}

function normalizeGeneratedPromptText(text: string) {
  const normalizedLines = text
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");

  return removeNegativePromptSection(normalizedLines)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function parsePromptJson(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  return JSON.parse(candidate) as {
    prompts?: Array<{ title?: string; prompt?: string }>;
  };
}

function extractContentFromSse(text: string) {
  let content = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;

    try {
      const payload = JSON.parse(data) as ChatCompletionPayload;
      content +=
        payload.choices?.[0]?.delta?.content ??
        payload.choices?.[0]?.message?.content ??
        payload.content ??
        payload.text ??
        "";
    } catch {
      content += data;
    }
  }
  return content.trim();
}

function extractChatContent(text: string) {
  try {
    const payload = JSON.parse(text) as ChatCompletionPayload;
    const geminiText = payload.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    return (
      payload.choices?.[0]?.message?.content?.trim() ??
      payload.choices?.[0]?.delta?.content?.trim() ??
      geminiText ??
      payload.output_text?.trim() ??
      payload.content?.trim() ??
      payload.text?.trim() ??
      ""
    );
  } catch {
    const sseContent = extractContentFromSse(text);
    if (sseContent) return sseContent;

    const raw = text.trim();
    if (raw.includes('"prompts"') || raw.includes("```json")) {
      return raw;
    }

    throw new Error(
      `详情图文案服务返回了无法解析的响应：${summarizeRawText(text) || "空响应"}`,
    );
  }
}

function createPromptRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemTemplate: string,
  userText: string,
  productImages: string[],
) {
  return fetch(resolveOpenAiEndpoint(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: systemTemplate,
        },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            ...productImages.map((imageUrl) => ({
              type: "image_url",
              image_url: { url: imageUrl },
            })),
          ],
        },
      ],
    }),
  });
}

function getQualityInstruction(quality: ImageQuality) {
  if (quality === "4K") {
    return "清晰度目标为 4K 级商业精修质感，文字边缘锐利，材质纹理、光影和产品细节清楚。";
  }
  if (quality === "2K") {
    return "清晰度目标为 2K 级高清详情图，文案清晰可读，产品边缘干净，细节充分。";
  }
  return "清晰度目标为 1K 标准详情图，画面干净，文案可读，商品主体清楚。";
}

function createEnhancedPrompt(prompt: string, aspectRatio: AspectRatio, quality: ImageQuality) {
  return [
    "产品一致性是最高优先级：必须以上传的产品参考图作为唯一产品来源，最终画面中的产品本体必须与参考图保持一致。",
    "禁止重新设计、重绘、改造或替换产品；禁止改变瓶型、瓶盖高度和直径、瓶身宽高比例、肩线、底部弧度、包装材质、主色、标签版式、品牌 Logo、文字位置和图案位置。",
    "只能在不改变产品本体的前提下优化背景、光影、陈列环境和周边信息模块；如果参考图是矮胖瓶、宽瓶盖、半透明浅紫瓶身，就不能生成高瘦瓶、细瓶盖或不同包装。",
    "产品参考图优先于所有文案描述；当文案与参考图冲突时，以参考图外观为准。",
    getAspectRatioInstruction(aspectRatio),
    getQualityInstruction(quality),
    prompt.trim(),
  ].join("\n\n");
}

function createCutoutPrompt() {
  return [
    "你正在执行电商产品抠图任务。第一张图片是用户上传的原始产品图，第二张图片是用户涂抹的选择区域 mask：mask 中白色/亮色区域表示必须抠出的产品主体。",
    "只提取 mask 所覆盖的产品，不要提取背景、手、道具、桌面、场景或其他未涂抹物体。",
    "如果产品被手、阴影、贴纸或其他物体遮挡，请根据原始产品的可见形状、材质、颜色、标签和结构自然补全被遮挡部分。",
    "输出必须是一张白色背景的完整商品图，商品居中，边缘干净，轮廓自然，保留原产品外观、比例、颜色、品牌标识和可见文字。",
    "禁止重新设计产品，禁止改变包装形状、颜色、标签版式、Logo 位置和材质质感。禁止添加营销文案、标题、装饰图形、水印、边框或场景。",
  ].join("\n\n");
}

function normalizeAspectRatio(value: unknown): AspectRatio {
  return value === "auto" ||
    value === "1:1" ||
    value === "4:3" ||
    value === "3:4" ||
    value === "16:9" ||
    value === "9:16"
    ? value
    : "3:4";
}

function normalizeQuality(value: unknown): ImageQuality {
  return value === "1K" || value === "2K" || value === "4K" ? value : "1K";
}

export class ImageTasksDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async alarm() {
    const body = await this.state.storage.get<GenerateRequestBody & { taskId?: string }>(
      "task",
    );
    if (!body?.taskId) return;
    await this.runTask(body);
  }

  async fetch(request: Request) {
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, { status: 405 });
    }

    let body: GenerateRequestBody & { taskId?: string };
    try {
      body = (await request.json()) as GenerateRequestBody & { taskId?: string };
    } catch {
      return json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }

    const taskId = body.taskId?.trim();
    const userKey = body.userKey?.trim();
    if (!taskId) {
      return json({ error: "缺少 taskId" }, { status: 400 });
    }

    const apiKey = this.env.OPENAI_API_KEY?.trim();
    const baseUrl = this.env.OPENAI_BASE_URL?.trim();
    const model = this.env.OPENAI_MODEL?.trim();
    if (!apiKey || !baseUrl || !model) {
      await this.env.TASKS_KV.put(
        `task:${taskId}`,
        JSON.stringify({
          status: "failed",
          userKey,
          updatedAt: Date.now(),
          error: "服务端缺少 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL 配置",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 500 });
    }

    const prompt = body.prompt?.trim() ?? "";
    const taskKey = `task:${taskId}`;
    const now = Date.now();

    if (!prompt) {
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          userKey,
          createdAt: now,
          updatedAt: now,
          error: "缺少详情图文案",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 400 });
    }

    await this.state.storage.put("task", {
      ...body,
      taskId,
    } satisfies GenerateRequestBody & { taskId?: string });
    await this.state.storage.setAlarm(Date.now() + 1);

    return json({ ok: true });
  }

  async runTask(body: GenerateRequestBody & { taskId?: string }) {
    const taskId = body.taskId?.trim();
    if (!taskId) return;
    const userKey = body.userKey?.trim();
    const apiKey = this.env.OPENAI_API_KEY?.trim();
    const baseUrl = this.env.OPENAI_BASE_URL?.trim();
    const model = this.env.OPENAI_MODEL?.trim();
    const prompt = body.prompt?.trim() ?? "";
    const images = (body.inputImages ?? [])
      .filter((image) => typeof image === "string" && image.startsWith("data:image/"))
      .slice(0, 8);
    const size = body.size ?? "1024x1536";
    const aspectRatio = normalizeAspectRatio(body.aspectRatio);
    const quality = normalizeQuality(body.quality);
    const enhancedPrompt = createEnhancedPrompt(prompt, aspectRatio, quality);
    const taskKey = `task:${taskId}`;
    const now = Date.now();

    await this.env.TASKS_KV.put(
      taskKey,
      JSON.stringify({ status: "running", userKey, createdAt: now, updatedAt: now }),
      { expirationTtl: 3600 },
    );

    try {
      if (!apiKey || !baseUrl || !model) {
        throw new Error("服务端缺少 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL 配置");
      }
      if (!images.length) {
        throw new Error("缺少产品参考图，系统已禁止纯文案生成");
      }
      const shouldStop = () => isImageTaskCanceled(this.env, taskKey);
      const attemptResult = await createImageRequestWithRetry(
        baseUrl,
        apiKey,
        model,
        enhancedPrompt,
        size,
        images,
        shouldStop,
      );

      if (!attemptResult.response.ok) {
        if (await isImageTaskCanceled(this.env, taskKey)) return;
        const detail = formatImageAttemptFailure("参考图模式", attemptResult);
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            userKey,
            createdAt: now,
            updatedAt: Date.now(),
            error: `${detail}；已禁止纯文案生成，请重新上传清晰产品参考图后再试。`,
          }),
          { expirationTtl: 3600 },
        );
        return;
      }

      let payload: ImagesPayload;
      try {
        payload = JSON.parse(attemptResult.text) as ImagesPayload;
      } catch {
        if (await isImageTaskCanceled(this.env, taskKey)) return;
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            userKey,
            createdAt: now,
            updatedAt: Date.now(),
            error: "上游返回了无法解析的 JSON",
          }),
          { expirationTtl: 3600 },
        );
        return;
      }

      const result = payload.data?.[0]?.b64_json;
      if (!result) {
        if (await isImageTaskCanceled(this.env, taskKey)) return;
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            userKey,
            createdAt: now,
            updatedAt: Date.now(),
            error: "API 返回成功但未包含生成的图片",
          }),
          { expirationTtl: 3600 },
        );
        return;
      }

      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "succeeded",
          userKey,
          createdAt: now,
          updatedAt: Date.now(),
          model,
          usedReferenceImages: true,
          usedCompactPrompt: false,
          warning: null,
          base64: result,
        }),
        { expirationTtl: 3600 },
      );

      await this.state.storage.delete("task");
    } catch (error) {
      if (await isImageTaskCanceled(this.env, taskKey)) return;
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          userKey,
          createdAt: now,
          updatedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }),
        { expirationTtl: 3600 },
      );
    }
  }
}

export class CutoutTasksDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async alarm() {
    const body = await this.state.storage.get<CutoutRequestBody>("task");
    if (!body?.taskId) return;
    await this.runTask(body);
  }

  async fetch(request: Request) {
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, { status: 405 });
    }

    let body: CutoutRequestBody;
    try {
      body = (await request.json()) as CutoutRequestBody;
    } catch {
      return json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }

    const taskId = body.taskId?.trim();
    const userKey = body.userKey?.trim();
    const taskKey = `cutout-task:${taskId}`;
    const now = Date.now();
    if (!taskId) {
      return json({ error: "缺少 taskId" }, { status: 400 });
    }

    const apiKey = this.env.OPENAI_API_KEY?.trim();
    const baseUrl = this.env.OPENAI_BASE_URL?.trim();
    const model = this.env.OPENAI_MODEL?.trim();
    if (!apiKey || !baseUrl || !model) {
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          userKey,
          createdAt: now,
          updatedAt: now,
          error: "服务端缺少 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL 配置",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 500 });
    }

    if (!body.sourceImage?.startsWith("data:image/") || !body.maskImage?.startsWith("data:image/")) {
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          userKey,
          createdAt: now,
          updatedAt: now,
          error: "抠图任务缺少原图或涂抹区域",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 400 });
    }

    await this.state.storage.put("task", {
      ...body,
      taskId,
      userKey,
    } satisfies CutoutRequestBody);
    await this.state.storage.setAlarm(Date.now() + 1);

    return json({ ok: true });
  }

  async runTask(body: CutoutRequestBody) {
    const taskId = body.taskId?.trim();
    if (!taskId) return;
    const userKey = body.userKey?.trim();
    const apiKey = this.env.OPENAI_API_KEY?.trim();
    const baseUrl = this.env.OPENAI_BASE_URL?.trim();
    const model = this.env.OPENAI_MODEL?.trim();
    const sourceImage = body.sourceImage ?? "";
    const maskImage = body.maskImage ?? "";
    const taskKey = `cutout-task:${taskId}`;
    const now = Date.now();

    await this.env.TASKS_KV.put(
      taskKey,
      JSON.stringify({ status: "running", userKey, createdAt: now, updatedAt: now }),
      { expirationTtl: 3600 },
    );

    try {
      if (!apiKey || !baseUrl || !model) {
        throw new Error("服务端缺少 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL 配置");
      }
      if (!sourceImage.startsWith("data:image/") || !maskImage.startsWith("data:image/")) {
        throw new Error("抠图任务缺少原图或涂抹区域");
      }

      const shouldStop = () => isImageTaskCanceled(this.env, taskKey);
      const attemptResult = await createImageRequestWithRetry(
        baseUrl,
        apiKey,
        model,
        createCutoutPrompt(),
        "1024x1024",
        [sourceImage, maskImage],
        shouldStop,
      );

      if (!attemptResult.response.ok) {
        if (await isImageTaskCanceled(this.env, taskKey)) return;
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            userKey,
            createdAt: now,
            updatedAt: Date.now(),
            error: formatImageAttemptFailure("抠图", attemptResult),
          }),
          { expirationTtl: 3600 },
        );
        return;
      }

      let payload: ImagesPayload;
      try {
        payload = JSON.parse(attemptResult.text) as ImagesPayload;
      } catch {
        if (await isImageTaskCanceled(this.env, taskKey)) return;
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            userKey,
            createdAt: now,
            updatedAt: Date.now(),
            error: "上游返回了无法解析的 JSON",
          }),
          { expirationTtl: 3600 },
        );
        return;
      }

      const result = payload.data?.[0]?.b64_json;
      if (!result) {
        if (await isImageTaskCanceled(this.env, taskKey)) return;
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            userKey,
            createdAt: now,
            updatedAt: Date.now(),
            error: "API 返回成功但未包含抠图结果",
          }),
          { expirationTtl: 3600 },
        );
        return;
      }

      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "succeeded",
          userKey,
          createdAt: now,
          updatedAt: Date.now(),
          model,
          base64: result,
        }),
        { expirationTtl: 3600 },
      );

      await this.state.storage.delete("task");
    } catch (error) {
      if (await isImageTaskCanceled(this.env, taskKey)) return;
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          userKey,
          createdAt: now,
          updatedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }),
        { expirationTtl: 3600 },
      );
    }
  }
}

export class PromptTasksDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async alarm() {
    const body = await this.state.storage.get<PromptRequestBody>("task");
    if (!body?.taskId) return;
    await this.runTask(body);
  }

  async fetch(request: Request) {
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, { status: 405 });
    }

    let body: PromptRequestBody;
    try {
      body = (await request.json()) as PromptRequestBody;
    } catch {
      return json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }

    const taskId = body.taskId?.trim();
    const taskKey = `prompt-task:${taskId}`;
    const createdAt = Date.now();
    if (!taskId) {
      return json({ error: "缺少 taskId" }, { status: 400 });
    }

    const apiKey =
      body.apiKey?.trim() ||
      this.env.PROMPT_API_KEY?.trim() ||
      this.env.OPENAI_API_KEY?.trim();
    const baseUrl =
      body.baseUrl?.trim() ||
      this.env.PROMPT_BASE_URL?.trim() ||
      this.env.OPENAI_BASE_URL?.trim();
    const model =
      body.model?.trim() ||
      this.env.PROMPT_MODEL?.trim() ||
      this.env.OPENAI_MODEL?.trim();
    if (!apiKey || !baseUrl || !model) {
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          createdAt,
          updatedAt: Date.now(),
          error: "服务端缺少 PROMPT_API_KEY / PROMPT_BASE_URL / PROMPT_MODEL 配置",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 500 });
    }

    const userText = body.userText?.trim() ?? "";
    const systemTemplate = body.systemTemplate?.trim() ?? "";
    const imageCount = Math.min(8, Math.max(1, Math.round(body.imageCount ?? 5)));
    const productImages = (body.productImages ?? []).filter(Boolean).slice(0, 8);
    if (!userText || !systemTemplate || !productImages.length) {
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          createdAt,
          updatedAt: Date.now(),
          error: "详情图文案任务参数不完整",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 400 });
    }

    await this.state.storage.put("task", {
      ...body,
      taskId,
      apiKey,
      baseUrl,
      model,
      imageCount,
      productImages,
      userText,
      systemTemplate,
    } satisfies PromptRequestBody);
    await this.state.storage.setAlarm(Date.now() + 1);

    return json({ ok: true });
  }

  async runTask(body: PromptRequestBody) {
    const taskId = body.taskId?.trim();
    if (!taskId) return;
    const taskKey = `prompt-task:${taskId}`;
    const createdAt = Date.now();
    const apiKey =
      body.apiKey?.trim() ||
      this.env.PROMPT_API_KEY?.trim() ||
      this.env.OPENAI_API_KEY?.trim();
    const baseUrl =
      body.baseUrl?.trim() ||
      this.env.PROMPT_BASE_URL?.trim() ||
      this.env.OPENAI_BASE_URL?.trim();
    const model =
      body.model?.trim() ||
      this.env.PROMPT_MODEL?.trim() ||
      this.env.OPENAI_MODEL?.trim();
    const userText = body.userText?.trim() ?? "";
    const systemTemplate = body.systemTemplate?.trim() ?? "";
    const imageCount = Math.min(8, Math.max(1, Math.round(body.imageCount ?? 5)));
    const productImages = (body.productImages ?? []).filter(Boolean).slice(0, 8);

    await this.env.TASKS_KV.put(
      taskKey,
      JSON.stringify({ status: "running", createdAt, updatedAt: createdAt }),
      { expirationTtl: 3600 },
    );

    try {
      if (!apiKey || !baseUrl || !model) {
        throw new Error("服务端未配置详情图文案生成接口");
      }
      const upstream = await createPromptRequest(
        baseUrl,
        apiKey,
        model,
        systemTemplate,
        userText,
        productImages,
      );
      const text = await upstream.text();

      if (!upstream.ok) {
        let detail = summarizeRawText(text);
        try {
          const payload = JSON.parse(text) as ChatCompletionPayload;
          if (payload.error?.message) detail = payload.error.message;
          if (payload.message) detail = payload.message;
        } catch {
          // Keep raw response.
        }
        throw new Error(`详情图文案生成失败: HTTP ${upstream.status}: ${detail}`);
      }

      const content = extractChatContent(text);
      if (!content) {
        throw new Error(
          `详情图文案服务未返回内容：${summarizeRawText(text) || "空响应"}`,
        );
      }

      const parsed = parsePromptJson(content);
      const prompts = (parsed.prompts ?? [])
        .map((item, index) => ({
          title: item.title?.trim() || `第${index + 1}张商品详情图`,
          prompt: normalizeGeneratedPromptText(item.prompt ?? ""),
        }))
        .filter((item) => item.prompt);

      if (prompts.length !== imageCount) {
        throw new Error(
          `详情图文案数量不匹配：期望 ${imageCount} 条，实际 ${prompts.length} 条`,
        );
      }

      if (await isImageTaskCanceled(this.env, taskKey)) return;
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "succeeded",
          prompts,
          model,
          createdAt,
          updatedAt: Date.now(),
        }),
        { expirationTtl: 3600 },
      );

      await this.state.storage.delete("task");
    } catch (error) {
      if (await isImageTaskCanceled(this.env, taskKey)) return;
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          createdAt,
          updatedAt: Date.now(),
          error:
            error instanceof SyntaxError
              ? "详情图文案服务未按 JSON 格式返回：" + error.message
              : error instanceof Error
                ? error.message
                : String(error),
        }),
        { expirationTtl: 3600 },
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/task" && request.method === "POST") {
      const token = env.IMAGE_WORKER_TOKEN?.trim();
      const auth = request.headers.get("Authorization")?.trim();
      if (!token || auth !== `Bearer ${token}`) {
        return json({ error: "Unauthorized" }, { status: 401 });
      }
      const body = (await request.json()) as GenerateRequestBody & {
        taskId: string;
      };
      const id = env.IMAGE_TASKS.idFromName(body.taskId);
      const stub = env.IMAGE_TASKS.get(id);
      return stub.fetch("https://do/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (url.pathname === "/prompt-task" && request.method === "POST") {
      const token = env.IMAGE_WORKER_TOKEN?.trim();
      const auth = request.headers.get("Authorization")?.trim();
      if (!token || auth !== `Bearer ${token}`) {
        return json({ error: "Unauthorized" }, { status: 401 });
      }
      const body = (await request.json()) as PromptRequestBody & {
        taskId: string;
      };
      const id = env.PROMPT_TASKS.idFromName(body.taskId);
      const stub = env.PROMPT_TASKS.get(id);
      return stub.fetch("https://do/prompt-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (url.pathname === "/cutout-task" && request.method === "POST") {
      const token = env.IMAGE_WORKER_TOKEN?.trim();
      const auth = request.headers.get("Authorization")?.trim();
      if (!token || auth !== `Bearer ${token}`) {
        return json({ error: "Unauthorized" }, { status: 401 });
      }
      const body = (await request.json()) as CutoutRequestBody & {
        taskId: string;
      };
      const id = env.CUTOUT_TASKS.idFromName(body.taskId);
      const stub = env.CUTOUT_TASKS.get(id);
      return stub.fetch("https://do/cutout-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    return json({ ok: true });
  },
};
