import {
  handleTaskCancelRequest,
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

export async function onRequestPost(context: FunctionContext) {
  return handleTaskCancelRequest(context, {
    prefix: "task",
    unauthorizedMessage: "请先登录",
    canceledError: "用户已中断生成",
  });
}
