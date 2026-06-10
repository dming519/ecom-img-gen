import { requireSession } from "../_lib/auth";
import {
  readProductImageDataUrls,
  type HistoryStorageEnv,
} from "../_lib/historyStorage";
import { getUserKey, requireImageCredit, type UserKvNamespace } from "../_lib/users";

interface LayerRequestBody {
  sourceImageId?: string;
  sourceDimensions?: {
    width?: unknown;
    height?: unknown;
  };
  layerAspectRatio?: unknown;
}

type LayerAspectRatio = "1:1" | "4:3" | "3:4";

interface ImageDimensions {
  width: number;
  height: number;
}

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

function normalizeImageId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isDataImage(value: unknown) {
  return typeof value === "string" && value.startsWith("data:image/");
}

function normalizeSourceDimensions(value: LayerRequestBody["sourceDimensions"]): ImageDimensions | undefined {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > 12000 ||
    height > 12000
  ) {
    return undefined;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

function normalizeLayerAspectRatio(value: unknown): LayerAspectRatio | undefined {
  return value === "1:1" || value === "4:3" || value === "3:4" ? value : undefined;
}

export async function handlePost(context: RequestContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再使用分层" }, { status: 401 });
  }

  let body: LayerRequestBody;
  try {
    body = (await context.request.json()) as LayerRequestBody;
  } catch {
    return json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const kv = context.env.TASKS_KV;
  const workerUrl = context.env.IMAGE_WORKER_URL?.trim();
  const workerToken = context.env.IMAGE_WORKER_TOKEN?.trim();
  if (!kv) return json({ error: "服务端未配置 TASKS_KV" }, { status: 500 });
  if (!workerUrl) return json({ error: "服务端未配置 IMAGE_WORKER_URL" }, { status: 500 });
  if (!workerToken) return json({ error: "服务端未配置 IMAGE_WORKER_TOKEN" }, { status: 500 });

  const userKey = getUserKey(session.user);
  const sourceImageId = normalizeImageId(body.sourceImageId);
  if (!sourceImageId) {
    return json({ error: "请上传需要分层的图片" }, { status: 400 });
  }

  let sourceImage: string | null | undefined;
  try {
    [sourceImage] = await readProductImageDataUrls(context.env, userKey, [sourceImageId]);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
  if (!isDataImage(sourceImage)) {
    return json({ error: "图片不存在或无权访问" }, { status: 400 });
  }

  let creditResult: Awaited<ReturnType<typeof requireImageCredit>>;
  try {
    creditResult = await requireImageCredit(context.env, session.user);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 402 },
    );
  }

  const taskId = crypto.randomUUID();
  const now = Date.now();
  const sourceDimensions = normalizeSourceDimensions(body.sourceDimensions);
  const layerAspectRatio = normalizeLayerAspectRatio(body.layerAspectRatio);
  await kv.put(
    `layer-task:${taskId}`,
    JSON.stringify({
      status: "pending",
      userKey,
      sourceImageId,
      sourceDimensions,
      layerAspectRatio,
      createdAt: now,
      updatedAt: now,
    }),
    { expirationTtl: 3600 },
  );

  try {
    const dispatch = await fetch(`${workerUrl.replace(/\/+$/, "")}/layer-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        taskId,
        sourceImage,
        sourceImageId,
        sourceDimensions,
        layerAspectRatio,
        userKey,
      }),
    });
    if (!dispatch.ok) {
      const detail = await dispatch.text().catch(() => "");
      throw new Error(`HTTP ${dispatch.status}: ${detail.slice(0, 300)}`);
    }
  } catch (error) {
    await kv.put(
      `layer-task:${taskId}`,
      JSON.stringify({
        status: "failed",
        userKey,
        sourceImageId,
        createdAt: now,
        updatedAt: Date.now(),
        error:
          "分层任务派发失败：" +
          (error instanceof Error ? error.message : String(error)),
      }),
      { expirationTtl: 3600 },
    );
    return json(
      {
        error:
          "分层任务派发失败：" +
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
      dailyRemainingCredits: creditResult.user.dailyRemainingCredits,
      dailyUsedCredits: creditResult.user.dailyUsedCredits,
      dailyGrantedCredits: creditResult.user.dailyGrantedCredits,
      permanentRemainingCredits: creditResult.user.permanentRemainingCredits,
      permanentGrantedCredits: creditResult.user.permanentGrantedCredits,
      unlimitedCredits: creditResult.unlimited,
    },
    { status: 202 },
  );
}
