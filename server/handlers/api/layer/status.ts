import {
  handleTaskStatusRequest,
  type TaskKvNamespace,
} from "../../_lib/tasks";
import type { HistoryStorageFunctionEnv } from "../../_lib/historyStorage";

interface RequestContext {
  request: Request;
  env: HistoryStorageFunctionEnv & {
    TASKS_KV?: TaskKvNamespace;
  };
}

export async function handleGet(context: RequestContext) {
  return handleTaskStatusRequest(context, {
    prefix: "layer-task",
    unauthorizedMessage: "请先登录",
    timeoutMs: 12 * 60 * 1000,
    timeoutMessage: "分层任务已超时，请重新生成。",
    billOnSuccess: true,
  });
}
