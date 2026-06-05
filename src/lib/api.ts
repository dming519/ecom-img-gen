import {
  DEFAULT_GENERATE_PATH,
  DEFAULT_PROMPT_PATH,
} from "./config";
import type {
  CreateImageTaskOptions,
  GeneratePromptOptions,
  GeneratePromptResult,
  ImageTaskStatus,
} from "./types";

interface ErrorPayload {
  error?: string | { message?: string };
}

interface CreateTaskPayload extends ErrorPayload {
  taskId?: string;
  status?: string;
}

const RETRYABLE_FETCH_ERRORS = ["Failed to fetch", "NetworkError"];

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
  const response = await fetchWithRetry(DEFAULT_PROMPT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${extractError(text)}`);
  }

  return JSON.parse(text) as GeneratePromptResult;
}

export async function createImageTask(
  options: CreateImageTaskOptions,
): Promise<{ taskId: string }> {
  const response = await fetchWithRetry(DEFAULT_GENERATE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
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
  return { taskId: payload.taskId };
}

export async function pollImageTask(
  taskId: string,
  timeoutMs = 8 * 60 * 1000,
): Promise<ImageTaskStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(
      `${DEFAULT_GENERATE_PATH}/status?taskId=${encodeURIComponent(taskId)}`,
      { method: "GET" },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`查询任务失败: HTTP ${response.status}: ${extractError(text)}`);
    }
    const payload = JSON.parse(text) as ImageTaskStatus;
    if (payload.status === "succeeded" || payload.status === "failed") {
      return payload;
    }
  }

  throw new Error("任务超时，请重试");
}
