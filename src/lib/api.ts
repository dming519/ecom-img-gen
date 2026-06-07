import {
  DEFAULT_CUTOUT_PATH,
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
  UserRole,
} from "./types";

interface ErrorPayload {
  error?: string | { message?: string };
}

interface CreateTaskPayload extends ErrorPayload {
  taskId?: string;
  status?: string;
  remainingCredits?: number;
  usedCredits?: number;
  unlimitedCredits?: boolean;
}

interface CreatePromptTaskPayload extends ErrorPayload {
  taskId?: string;
  status?: string;
}

const RETRYABLE_FETCH_ERRORS = ["Failed to fetch", "NetworkError"];
const MAX_PROMPT_PAYLOAD_CHARS = 7_000_000;

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

export async function generateDetailPrompts(
  options: GeneratePromptOptions,
): Promise<GeneratePromptResult> {
  const body = JSON.stringify(options);
  if (body.length > MAX_PROMPT_PAYLOAD_CHARS) {
    throw new Error("产品参考图数据过大，请减少图片数量或重新上传后再生成。");
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

export async function pollPromptTask(
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

export async function createImageTask(
  options: CreateImageTaskOptions,
  signal?: AbortSignal,
): Promise<{
  taskId: string;
  remainingCredits?: number;
  usedCredits?: number;
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
    unlimitedCredits: payload.unlimitedCredits,
  };
}

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

export async function createCutoutTask(
  options: CreateCutoutTaskOptions,
  signal?: AbortSignal,
): Promise<{
  taskId: string;
  remainingCredits?: number;
  usedCredits?: number;
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
    unlimitedCredits: payload.unlimitedCredits,
  };
}

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
