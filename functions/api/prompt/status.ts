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
    prefix: "prompt-task",
    unauthorizedMessage: "请先登录后再查询详情图文案任务",
    timeoutMs: 8 * 60 * 1000,
    timeoutMessage: "详情图文案任务已超时，请重新生成。",
  });
}
