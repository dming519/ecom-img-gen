import { requireSession } from "../_lib/auth";
import type { HistoryD1Database } from "../_lib/historyStorage";
import { getUserKey, requireImageCredit, type UserKvNamespace } from "../_lib/users";

interface CutoutRequestBody {
  sourceImage?: string;
  maskImage?: string;
}

// 抠图接口同样采用“创建任务 + 前端轮询”的异步模式。
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
    HISTORY_DB?: HistoryD1Database;
  };
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

// 抠图只接受浏览器上传后的 data URL，避免服务端主动抓取不可信远程图片。
function isDataImage(value: unknown) {
  return typeof value === "string" && value.startsWith("data:image/");
}

// POST /api/cutout：创建白底抠图任务。
export async function handlePost(context: RequestContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再使用抠图" }, { status: 401 });
  }

  let body: CutoutRequestBody;
  try {
    body = (await context.request.json()) as CutoutRequestBody;
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
  // sourceImage 是原图，maskImage 是黑白选择区，二者缺一不可。
  if (!isDataImage(body.sourceImage)) {
    return json({ error: "请上传需要抠图的产品图片" }, { status: 400 });
  }
  if (!isDataImage(body.maskImage)) {
    return json({ error: "请先涂抹需要抠出的产品区域" }, { status: 400 });
  }

  let creditResult: Awaited<ReturnType<typeof requireImageCredit>>;
  try {
    // 这里只检查额度，任务成功后由 status 接口扣费。
    creditResult = await requireImageCredit(context.env, session.user);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 402 },
    );
  }

  const taskId = crypto.randomUUID();
  const now = Date.now();
  const userKey = getUserKey(session.user);
  // 写入 pending 状态，让前端立刻拿到 taskId 并开始轮询。
  await kv.put(
    `cutout-task:${taskId}`,
    JSON.stringify({
      status: "pending",
      userKey,
      createdAt: now,
      updatedAt: now,
    }),
    { expirationTtl: 3600 },
  );

  try {
    // 真正的抠图模型调用交给 Worker；Pages API 不直接等待模型结果。
    const dispatch = await fetch(`${workerUrl.replace(/\/+$/, "")}/cutout-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        taskId,
        sourceImage: body.sourceImage,
        maskImage: body.maskImage,
        userKey,
      }),
    });
    if (!dispatch.ok) {
      const detail = await dispatch.text().catch(() => "");
      throw new Error(`HTTP ${dispatch.status}: ${detail.slice(0, 300)}`);
    }
  } catch (error) {
    await kv.put(
      `cutout-task:${taskId}`,
      JSON.stringify({
        status: "failed",
        userKey,
        createdAt: now,
        updatedAt: Date.now(),
        error:
          "抠图任务派发失败：" +
          (error instanceof Error ? error.message : String(error)),
      }),
      { expirationTtl: 3600 },
    );
    return json(
      {
        error:
          "抠图任务派发失败：" +
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
