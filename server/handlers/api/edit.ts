import { requireSession } from "../_lib/auth";
import {
  readProductImageDataUrls,
  type HistoryStorageEnv,
} from "../_lib/historyStorage";
import { getUserKey, requireImageCredit, type UserKvNamespace } from "../_lib/users";

interface EditRequestBody {
  sourceImageId?: string;
  maskImageId?: string;
  instruction?: string;
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

function isDataImage(value: unknown) {
  return typeof value === "string" && value.startsWith("data:image/");
}

function normalizeImageId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeInstruction(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 600) : "";
}

// POST /api/edit：创建局部改图任务。
export async function handlePost(context: RequestContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再使用改图" }, { status: 401 });
  }

  let body: EditRequestBody;
  try {
    body = (await context.request.json()) as EditRequestBody;
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

  const userKey = getUserKey(session.user);
  const sourceImageId = normalizeImageId(body.sourceImageId);
  const maskImageId = normalizeImageId(body.maskImageId);
  const instruction = normalizeInstruction(body.instruction);
  if (!sourceImageId) {
    return json({ error: "请上传需要改图的商品图片" }, { status: 400 });
  }
  if (!maskImageId) {
    return json({ error: "请先涂抹需要修改的区域" }, { status: 400 });
  }
  if (!instruction) {
    return json({ error: "请输入需要更改的内容" }, { status: 400 });
  }

  let storedImages: Array<string | null>;
  try {
    storedImages = await readProductImageDataUrls(context.env, userKey, [
      sourceImageId,
      maskImageId,
    ]);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
  const [sourceImage, maskImage] = storedImages;
  if (!sourceImage) {
    return json({ error: "商品原图不存在或无权访问" }, { status: 400 });
  }
  if (!maskImage) {
    return json({ error: "涂抹区域不存在或无权访问" }, { status: 400 });
  }
  if (!isDataImage(sourceImage)) {
    return json({ error: "请上传需要改图的商品图片" }, { status: 400 });
  }
  if (!isDataImage(maskImage)) {
    return json({ error: "请先涂抹需要修改的区域" }, { status: 400 });
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
  await kv.put(
    `edit-task:${taskId}`,
    JSON.stringify({
      status: "pending",
      userKey,
      createdAt: now,
      updatedAt: now,
    }),
    { expirationTtl: 3600 },
  );

  try {
    const dispatch = await fetch(`${workerUrl.replace(/\/+$/, "")}/edit-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        taskId,
        sourceImage,
        maskImage,
        editInstruction: instruction,
        userKey,
      }),
    });
    if (!dispatch.ok) {
      const detail = await dispatch.text().catch(() => "");
      throw new Error(`HTTP ${dispatch.status}: ${detail.slice(0, 300)}`);
    }
  } catch (error) {
    await kv.put(
      `edit-task:${taskId}`,
      JSON.stringify({
        status: "failed",
        userKey,
        createdAt: now,
        updatedAt: Date.now(),
        error:
          "改图任务派发失败：" +
          (error instanceof Error ? error.message : String(error)),
      }),
      { expirationTtl: 3600 },
    );
    return json(
      {
        error:
          "改图任务派发失败：" +
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
