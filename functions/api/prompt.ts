import { DETAIL_PROMPT_TEMPLATE } from "../../src/lib/promptTemplate";
import { requireSession } from "../_lib/auth";
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
  };
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  content?: string;
  text?: string;
  output_text?: string;
  error?: {
    message?: string;
  };
  message?: string;
}

interface UpstreamRequest {
  url: string;
  init: RequestInit;
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

function parsePromptJson(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  return JSON.parse(candidate) as {
    prompts?: Array<{ title?: string; prompt?: string }>;
  };
}

function summarizeRawText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function normalizeCount(value: number | undefined) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, Math.round(value ?? 5)));
}

function resolveOpenAiEndpoint(baseUrl: string, path: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const base = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  return `${base}${path}`;
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

function createUpstreamRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  userText: string,
  productImages: string[],
): UpstreamRequest {
  return {
    url: resolveOpenAiEndpoint(baseUrl, "/chat/completions"),
    init: {
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
            content: DETAIL_PROMPT_TEMPLATE,
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
    },
  };
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
  const productImages = (body.productImages ?? []).filter(Boolean).slice(0, 8);

  if (!name) {
    return json({ error: "请输入产品名称" }, { status: 400 });
  }
  if (!sellingPoints) {
    return json({ error: "请输入产品核心卖点和功效" }, { status: 400 });
  }
  if (!productImages.length) {
    return json({ error: "请至少上传一张产品图片" }, { status: 400 });
  }

  const apiKey =
    context.env.PROMPT_API_KEY?.trim() || context.env.OPENAI_API_KEY?.trim();
  const baseUrl = (
    context.env.PROMPT_BASE_URL?.trim() ||
    context.env.OPENAI_BASE_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  const model =
    context.env.PROMPT_MODEL?.trim() || context.env.OPENAI_MODEL?.trim();

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
    `prompts 数组长度必须等于 ${imageCount}。每个 prompt 必须是完整单张图片生成提示词，并包含统一视觉系统、构图、中文文案、负面提示词、4:5 竖版、严格参考产品图片等要求。`,
  ].join("\n");

  const upstreamRequest = createUpstreamRequest(
    baseUrl,
    apiKey,
    model,
    userText,
    productImages,
  );

  let upstream: Response;
  try {
    upstream = await fetch(upstreamRequest.url, upstreamRequest.init);
  } catch (error) {
    return json(
      {
        error:
          "详情图文案服务请求失败：" +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 502 },
    );
  }

  let text = "";
  try {
    text = await upstream.text();
  } catch (error) {
    return json(
      {
        error:
          "详情图文案服务响应读取失败：" +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    let detail = summarizeRawText(text);
    try {
      const payload = JSON.parse(text) as ChatCompletionPayload;
      if (payload.error?.message) detail = payload.error.message;
      if (payload.message) detail = payload.message;
    } catch {
      // Keep raw response.
    }
    return json({ error: `详情图文案生成失败: HTTP ${upstream.status}: ${detail}` }, { status: 502 });
  }

  let content = "";
  try {
    content = extractChatContent(text);
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }

  if (!content) {
    return json(
      { error: `详情图文案服务未返回内容：${summarizeRawText(text) || "空响应"}` },
      { status: 502 },
    );
  }

  try {
    const parsed = parsePromptJson(content);
    const prompts = (parsed.prompts ?? [])
      .map((item, index) => ({
        title: item.title?.trim() || `第${index + 1}张商品详情图`,
        prompt: item.prompt?.trim() || "",
      }))
      .filter((item) => item.prompt);

    if (prompts.length !== imageCount) {
      return json(
        { error: `详情图文案数量不匹配：期望 ${imageCount} 条，实际 ${prompts.length} 条` },
        { status: 502 },
      );
    }

    return json({ prompts, model });
  } catch (error) {
    return json(
      {
        error:
          "详情图文案服务未按 JSON 格式返回：" +
          (error instanceof Error ? error.message : String(error)) +
          `；原始内容：${summarizeRawText(content) || "空响应"}`,
      },
      { status: 502 },
    );
  }
}
