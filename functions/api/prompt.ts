import { DETAIL_PROMPT_TEMPLATE } from "../../src/lib/promptTemplate";
import { requireSession } from "../_lib/auth";

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
  };
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
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

function normalizeCount(value: number | undefined) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, Math.round(value ?? 5)));
}

function createUpstreamRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  userText: string,
  productImages: string[],
): UpstreamRequest {
  return {
    url: `${baseUrl}/chat/completions`,
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
    return json({ error: "请先登录后再生成 Prompt" }, { status: 401 });
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
    "请严格根据系统模板和上传产品图生成商品详情图 Prompt。",
    "",
    `产品名称：${name}`,
    `图片数量：${imageCount}`,
    "产品核心卖点和功效：",
    sellingPoints,
    "",
    "输出格式要求：只返回 JSON，不要 Markdown，不要解释。",
    `JSON 结构：{"prompts":[{"title":"第1张：产品主图 / 核心卖点总览","prompt":"完整可直接用于 GPT-Image-2 的单张详情图 Prompt"}]}`,
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
          "Prompt 上游请求失败：" +
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
          "Prompt 上游响应读取失败：" +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    let detail = text.slice(0, 300);
    try {
      const payload = JSON.parse(text) as ChatCompletionPayload;
      if (payload.error?.message) detail = payload.error.message;
    } catch {
      // Keep raw response.
    }
    return json({ error: `Prompt 生成失败: HTTP ${upstream.status}: ${detail}` }, { status: 502 });
  }

  let content = "";
  try {
    const payload = JSON.parse(text) as ChatCompletionPayload;
    content = payload.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return json({ error: "Prompt 上游返回了无法解析的 JSON" }, { status: 502 });
  }

  if (!content) {
    return json({ error: "Prompt 上游未返回内容" }, { status: 502 });
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
        { error: `Prompt 数量不匹配：期望 ${imageCount} 条，实际 ${prompts.length} 条` },
        { status: 502 },
      );
    }

    return json({ prompts, model });
  } catch (error) {
    return json(
      {
        error:
          "Prompt 上游未按 JSON 格式返回：" +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 502 },
    );
  }
}
