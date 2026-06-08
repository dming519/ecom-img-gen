import {
  handleTaskStatusRequest,
  type TaskKvNamespace,
} from "../../_lib/tasks";
import type { HistoryD1Database } from "../../_lib/historyStorage";

interface FunctionContext {
  request: Request;
  env: {
    TASKS_KV?: TaskKvNamespace;
    AUTH_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
  };
}

export async function onRequestGet(context: FunctionContext) {
  return handleTaskStatusRequest(context, {
    prefix: "task",
    unauthorizedMessage: "内置模式需要先登录",
    timeoutMs: 12 * 60 * 1000,
    timeoutMessage: "图片生成任务已超时，请重新生成。",
    billOnSuccess: true,
  });
}
