import {
  DEFAULT_CUTOUT_PATH,
  DEFAULT_EDIT_PATH,
  DEFAULT_GENERATE_PATH,
  DEFAULT_PROMPT_PATH,
} from "./config";
import type {
  AccessCodeRow,
  AdminUserRow,
  CreateCutoutTaskOptions,
  CreateImageTaskOptions,
  CutoutTaskStatus,
  GeneratePromptOptions,
  GeneratePromptResult,
  ImageTaskStatus,
  PromptTaskStatus,
  RedeemCodeRow,
  AuthUser,
  CreateEditTaskOptions,
  UserRole,
  EditTaskStatus,
} from "./types";

interface ErrorPayload {
  error?: string | { message?: string };
}

interface CreateTaskPayload extends ErrorPayload {
  taskId?: string;
  status?: string;
  remainingCredits?: number;
  usedCredits?: number;
  dailyRemainingCredits?: number;
  dailyUsedCredits?: number;
  dailyGrantedCredits?: number;
  permanentRemainingCredits?: number;
  permanentGrantedCredits?: number;
  unlimitedCredits?: boolean;
}

interface CreatePromptTaskPayload extends ErrorPayload {
  taskId?: string;
  status?: string;
}

// 浏览器偶发网络断开时重试一次，避免长任务刚开始就因为瞬时网络失败中断。
const RETRYABLE_FETCH_ERRORS = ["Failed to fetch", "NetworkError"];
const MAX_PROMPT_PAYLOAD_CHARS = 7_000_000;

// 服务端错误有时是 JSON，有时是纯文本；这里统一提取给用户看的错误信息。
function extractError(text: string) {
  let detail = text.slice(0, 300);
  try {
    const payload = JSON.parse(text) as ErrorPayload;
    if (typeof payload.error === "string") {
      detail = payload.error;
    } else if (payload.error?.message) {
      detail = payload.error.message;
    }
  } catch {
    // Keep raw text.
  }
  return detail;
}

// 所有任务接口都经过这里，保证网络抖动时有一致的重试行为。
async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!RETRYABLE_FETCH_ERRORS.some((key) => message.includes(key))) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      response = await fetch(input, init);
    } catch {
      throw new Error("网络连接中断，请保持页面常亮后重试");
    }
  }
  return response;
}

// 详情图流程第一步：根据商品资料和参考图生成多条“可用于生图”的 prompt。
export async function generateDetailPrompts(
  options: GeneratePromptOptions,
): Promise<GeneratePromptResult> {
  const body = JSON.stringify({
    name: options.name,
    sellingPoints: options.sellingPoints,
    imageCount: options.imageCount,
    productImageIds: options.productImageIds,
  });
  if (body.length > MAX_PROMPT_PAYLOAD_CHARS) {
    throw new Error("商品参考图数据过大，请减少图片数量或重新上传后再生成。");
  }

  const response = await fetchWithRetry(DEFAULT_PROMPT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }

  const payload = JSON.parse(text) as CreatePromptTaskPayload;
  if (!payload.taskId) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "创建详情图文案任务失败",
    );
  }

  const task = await pollPromptTask(payload.taskId);
  if (task.status === "failed") {
    throw new Error(task.error || "详情图文案生成失败");
  }
  if (!task.prompts?.length) {
    throw new Error("详情图文案任务未返回内容");
  }

  return {
    prompts: task.prompts,
    model: task.model ?? "",
  };
}

// 文案生成是异步任务：先创建 taskId，再每 2 秒查一次状态直到成功或失败。
async function pollPromptTask(
  taskId: string,
  timeoutMs = 6 * 60 * 1000,
): Promise<PromptTaskStatus> {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetchWithRetry(
        `${DEFAULT_PROMPT_PATH}/status?taskId=${encodeURIComponent(taskId)}`,
        { method: "GET", cache: "no-store" },
      );
      const text = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${extractError(text)}`;
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 400 ||
          (response.status === 404 && Date.now() - startedAt > 20_000)
        ) {
          throw new Error(`查询文案任务失败: ${lastError}`);
        }
        continue;
      }
      const payload = JSON.parse(text) as PromptTaskStatus;
      if (payload.status === "succeeded" || payload.status === "failed") {
        return payload;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (lastError.startsWith("查询文案任务失败:")) {
        throw error;
      }
    }
  }

  throw new Error(
    lastError
      ? `详情图文案任务超时，请重试。最后一次状态：${lastError}`
      : "详情图文案任务超时，请重试",
  );
}

// 详情图流程第二步：提交单条 prompt 和参考图，创建图片生成任务。
export async function createImageTask(
  options: CreateImageTaskOptions,
  signal?: AbortSignal,
): Promise<{
  taskId: string;
  remainingCredits?: number;
  usedCredits?: number;
  dailyRemainingCredits?: number;
  dailyUsedCredits?: number;
  dailyGrantedCredits?: number;
  permanentRemainingCredits?: number;
  permanentGrantedCredits?: number;
  unlimitedCredits?: boolean;
}> {
  const response = await fetchWithRetry(DEFAULT_GENERATE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }

  const payload = JSON.parse(text) as CreateTaskPayload;
  if (!payload.taskId) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "创建图片任务失败",
    );
  }
  return {
    taskId: payload.taskId,
    remainingCredits: payload.remainingCredits,
    usedCredits: payload.usedCredits,
    dailyRemainingCredits: payload.dailyRemainingCredits,
    dailyUsedCredits: payload.dailyUsedCredits,
    dailyGrantedCredits: payload.dailyGrantedCredits,
    permanentRemainingCredits: payload.permanentRemainingCredits,
    permanentGrantedCredits: payload.permanentGrantedCredits,
    unlimitedCredits: payload.unlimitedCredits,
  };
}

// 用户点击“取消”时只通知服务端把任务标记为取消；真正的模型请求可能已经在路上。
export async function cancelImageTask(taskId: string): Promise<void> {
  const response = await fetchWithRetry(`${DEFAULT_GENERATE_PATH}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`取消任务失败: HTTP ${response.status}: ${extractError(text)}`);
  }
}

// 查询图片生成结果。成功时返回 imageId，前端通过图片文件接口展示。
export async function pollImageTask(
  taskId: string,
  timeoutMs = 8 * 60 * 1000,
  signal?: AbortSignal,
): Promise<ImageTaskStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DOMException("图片生成已中断", "AbortError");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("图片生成已中断", "AbortError"));
        },
        { once: true },
      );
    });
    const response = await fetch(
      `${DEFAULT_GENERATE_PATH}/status?taskId=${encodeURIComponent(taskId)}`,
      { method: "GET", signal },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`查询任务失败: HTTP ${response.status}: ${extractError(text)}`);
    }
    const payload = JSON.parse(text) as ImageTaskStatus;
    if (
      payload.status === "succeeded" ||
      payload.status === "failed" ||
      payload.status === "canceled"
    ) {
      return payload;
    }
  }

  throw new Error("任务超时，请重试");
}

// 抠图流程：提交原图和 mask，创建白底图生成任务。
export async function createCutoutTask(
  options: CreateCutoutTaskOptions,
  signal?: AbortSignal,
): Promise<{
  taskId: string;
  remainingCredits?: number;
  usedCredits?: number;
  dailyRemainingCredits?: number;
  dailyUsedCredits?: number;
  dailyGrantedCredits?: number;
  permanentRemainingCredits?: number;
  permanentGrantedCredits?: number;
  unlimitedCredits?: boolean;
}> {
  const response = await fetchWithRetry(DEFAULT_CUTOUT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }

  const payload = JSON.parse(text) as CreateTaskPayload;
  if (!payload.taskId) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "创建抠图任务失败",
    );
  }
  return {
    taskId: payload.taskId,
    remainingCredits: payload.remainingCredits,
    usedCredits: payload.usedCredits,
    dailyRemainingCredits: payload.dailyRemainingCredits,
    dailyUsedCredits: payload.dailyUsedCredits,
    dailyGrantedCredits: payload.dailyGrantedCredits,
    permanentRemainingCredits: payload.permanentRemainingCredits,
    permanentGrantedCredits: payload.permanentGrantedCredits,
    unlimitedCredits: payload.unlimitedCredits,
  };
}

// 局部改图流程：提交原图、mask 和用户修改内容，创建异步改图任务。
export async function createEditTask(
  options: CreateEditTaskOptions,
  signal?: AbortSignal,
): Promise<{
  taskId: string;
  remainingCredits?: number;
  usedCredits?: number;
  dailyRemainingCredits?: number;
  dailyUsedCredits?: number;
  dailyGrantedCredits?: number;
  permanentRemainingCredits?: number;
  permanentGrantedCredits?: number;
  unlimitedCredits?: boolean;
}> {
  const response = await fetchWithRetry(DEFAULT_EDIT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceImageId: options.sourceImageId,
      maskImageId: options.maskImageId,
      instruction: options.instruction,
    }),
    signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }

  const payload = JSON.parse(text) as CreateTaskPayload;
  if (!payload.taskId) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "创建改图任务失败",
    );
  }
  return {
    taskId: payload.taskId,
    remainingCredits: payload.remainingCredits,
    usedCredits: payload.usedCredits,
    dailyRemainingCredits: payload.dailyRemainingCredits,
    dailyUsedCredits: payload.dailyUsedCredits,
    dailyGrantedCredits: payload.dailyGrantedCredits,
    permanentRemainingCredits: payload.permanentRemainingCredits,
    permanentGrantedCredits: payload.permanentGrantedCredits,
    unlimitedCredits: payload.unlimitedCredits,
  };
}

// 取消抠图任务，逻辑和详情图取消一致。
export async function cancelCutoutTask(taskId: string): Promise<void> {
  const response = await fetchWithRetry(`${DEFAULT_CUTOUT_PATH}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`取消抠图任务失败: HTTP ${response.status}: ${extractError(text)}`);
  }
}

export async function cancelEditTask(taskId: string): Promise<void> {
  const response = await fetchWithRetry(`${DEFAULT_EDIT_PATH}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`取消改图任务失败: HTTP ${response.status}: ${extractError(text)}`);
  }
}

// 查询抠图任务结果。成功时返回 imageId，前端通过图片文件接口展示。
export async function pollCutoutTask(
  taskId: string,
  timeoutMs = 8 * 60 * 1000,
  signal?: AbortSignal,
): Promise<CutoutTaskStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DOMException("抠图任务已中断", "AbortError");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("抠图任务已中断", "AbortError"));
        },
        { once: true },
      );
    });
    const response = await fetch(
      `${DEFAULT_CUTOUT_PATH}/status?taskId=${encodeURIComponent(taskId)}`,
      { method: "GET", signal, cache: "no-store" },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`查询抠图任务失败: HTTP ${response.status}: ${extractError(text)}`);
    }
    const payload = JSON.parse(text) as CutoutTaskStatus;
    if (
      payload.status === "succeeded" ||
      payload.status === "failed" ||
      payload.status === "canceled"
    ) {
      return payload;
    }
  }

  throw new Error("抠图任务超时，请重试");
}

// 查询改图任务结果。成功时返回 imageId，前端通过图片文件接口展示。
export async function pollEditTask(
  taskId: string,
  timeoutMs = 8 * 60 * 1000,
  signal?: AbortSignal,
): Promise<EditTaskStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DOMException("改图任务已中断", "AbortError");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("改图任务已中断", "AbortError"));
        },
        { once: true },
      );
    });
    const response = await fetch(
      `${DEFAULT_EDIT_PATH}/status?taskId=${encodeURIComponent(taskId)}`,
      { method: "GET", signal, cache: "no-store" },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`查询改图任务失败: HTTP ${response.status}: ${extractError(text)}`);
    }
    const payload = JSON.parse(text) as EditTaskStatus;
    if (
      payload.status === "succeeded" ||
      payload.status === "failed" ||
      payload.status === "canceled"
    ) {
      return payload;
    }
  }

  throw new Error("改图任务超时，请重试");
}

// 以下是管理后台接口：只有 admin/super_admin 能正常调用。
export async function fetchAdminUsers(): Promise<{ users: AdminUserRow[] }> {
  const response = await fetchWithRetry("/api/admin/users", {
    method: "GET",
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { users: AdminUserRow[] };
}

export async function updateAdminUser(
  userKey: string,
  patch: { remainingCredits?: number; role?: UserRole },
): Promise<{ user: AdminUserRow }> {
  const response = await fetchWithRetry("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userKey, ...patch }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { user: AdminUserRow };
}

export async function fetchAccessCodes(): Promise<{ accessCodes: AccessCodeRow[] }> {
  const response = await fetchWithRetry("/api/admin/access-codes", {
    method: "GET",
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { accessCodes: AccessCodeRow[] };
}

export async function createAccessCode(
  label: string,
  code?: string,
): Promise<{ accessCode: AccessCodeRow; code: string }> {
  const response = await fetchWithRetry("/api/admin/access-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", label, code }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { accessCode: AccessCodeRow; code: string };
}

export async function updateAccessCode(
  id: string,
  patch: { active?: boolean; label?: string },
): Promise<{ accessCode: AccessCodeRow }> {
  const response = await fetchWithRetry("/api/admin/access-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", id, ...patch }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { accessCode: AccessCodeRow };
}

export async function fetchRedeemCodes(): Promise<{ redeemCodes: RedeemCodeRow[] }> {
  const response = await fetchWithRetry("/api/admin/redeem-codes", {
    method: "GET",
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { redeemCodes: RedeemCodeRow[] };
}

export async function createRedeemCode(
  label: string,
  credits: number,
  maxRedemptions: number,
  code?: string,
): Promise<{ redeemCode: RedeemCodeRow; code: string }> {
  const response = await fetchWithRetry("/api/admin/redeem-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      label,
      credits,
      maxRedemptions,
      code,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { redeemCode: RedeemCodeRow; code: string };
}

export async function updateRedeemCode(
  id: string,
  patch: { active?: boolean; label?: string },
): Promise<{ redeemCode: RedeemCodeRow }> {
  const response = await fetchWithRetry("/api/admin/redeem-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", id, ...patch }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { redeemCode: RedeemCodeRow };
}

export async function redeemCredits(
  code: string,
): Promise<{ grantedCredits: number; user: AuthUser }> {
  const response = await fetchWithRetry("/api/redeem-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }
  return JSON.parse(text) as { grantedCredits: number; user: AuthUser };
}
