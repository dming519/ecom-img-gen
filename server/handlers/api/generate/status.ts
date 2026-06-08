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
    // Worker 写入的 KV key 形如 `task:<taskId>`。
    prefix: "task",
    unauthorizedMessage: "内置模式需要先登录",
    timeoutMs: 12 * 60 * 1000,
    timeoutMessage: "图片生成任务已超时，请重新生成。",
    // 图片真正成功后才扣次数，避免创建任务失败也扣费。
    billOnSuccess: true,
  });
}
