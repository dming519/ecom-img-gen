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
    // Worker 写入的 KV key 形如 `cutout-task:<taskId>`。
    prefix: "cutout-task",
    unauthorizedMessage: "请先登录",
    timeoutMs: 12 * 60 * 1000,
    timeoutMessage: "抠图任务已超时，请重新生成。",
    // 抠图成功后才扣次数。
    billOnSuccess: true,
  });
}
