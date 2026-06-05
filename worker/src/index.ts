export interface Env {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  IMAGE_WORKER_TOKEN?: string;
  TASKS_KV: KVNamespace;
  IMAGE_TASKS: DurableObjectNamespace;
}

type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";

interface GenerateRequestBody {
  prompt?: string;
  size?: ImageSize;
  inputImages?: string[];
}

interface ImagesPayload {
  data?: Array<{ b64_json?: string }>;
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

export class ImageTasksDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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
          updatedAt: Date.now(),
          error: "服务端缺少 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL 配置",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 500 });
    }

    const prompt = body.prompt?.trim() ?? "";
    const images = (body.inputImages ?? []).filter(Boolean).slice(0, 8);
    const size = body.size ?? "1024x1536";
    const taskKey = `task:${taskId}`;
    const now = Date.now();

    if (!prompt) {
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          createdAt: now,
          updatedAt: now,
          error: "缺少商品详情图 Prompt",
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 400 });
    }

    await this.env.TASKS_KV.put(
      taskKey,
      JSON.stringify({ status: "running", createdAt: now, updatedAt: now }),
      { expirationTtl: 3600 },
    );

    try {
      const hasImages = images.length > 0;
      const upstream = await fetch(
        resolveImageEndpoint(baseUrl, hasImages),
        hasImages
          ? (() => {
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
                formData.append("image[]", imageBlob, `product-${index + 1}.${extension}`);
              });

              return {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}` },
                body: formData,
              } satisfies RequestInit;
            })()
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model,
                prompt,
                ...(size !== "auto" ? { size } : {}),
                response_format: "b64_json",
              }),
            },
      );

      const text = await upstream.text();
      if (!upstream.ok) {
        let detail = text.slice(0, 300);
        try {
          const payload = JSON.parse(text) as ImagesPayload;
          if (payload.error?.message) detail = payload.error.message;
          if (payload.message) detail = payload.message;
        } catch {
          // Keep raw response.
        }
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            createdAt: now,
            updatedAt: Date.now(),
            error: `HTTP ${upstream.status}: ${detail}`,
          }),
          { expirationTtl: 3600 },
        );
        return json({ ok: false }, { status: 502 });
      }

      let payload: ImagesPayload;
      try {
        payload = JSON.parse(text) as ImagesPayload;
      } catch {
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            createdAt: now,
            updatedAt: Date.now(),
            error: "上游返回了无法解析的 JSON",
          }),
          { expirationTtl: 3600 },
        );
        return json({ ok: false }, { status: 502 });
      }

      const result = payload.data?.[0]?.b64_json;
      if (!result) {
        await this.env.TASKS_KV.put(
          taskKey,
          JSON.stringify({
            status: "failed",
            createdAt: now,
            updatedAt: Date.now(),
            error: "API 返回成功但未包含生成的图片",
          }),
          { expirationTtl: 3600 },
        );
        return json({ ok: false }, { status: 502 });
      }

      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "succeeded",
          createdAt: now,
          updatedAt: Date.now(),
          model,
          base64: result,
        }),
        { expirationTtl: 3600 },
      );

      return json({ ok: true });
    } catch (error) {
      await this.env.TASKS_KV.put(
        taskKey,
        JSON.stringify({
          status: "failed",
          createdAt: now,
          updatedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }),
        { expirationTtl: 3600 },
      );
      return json({ ok: false }, { status: 500 });
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
    return json({ ok: true });
  },
};
