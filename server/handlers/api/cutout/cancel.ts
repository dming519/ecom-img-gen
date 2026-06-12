import {
  handleTaskCancelRequest,
  type TaskKvNamespace,
} from "../../_lib/tasks";
import type { PostgresEnv } from "../../_lib/postgres";

interface RequestContext {
  request: Request;
  env: PostgresEnv & {
    TASKS_KV?: TaskKvNamespace;
    AUTH_SECRET?: string;
  };
}

export async function handlePost(context: RequestContext) {
  return handleTaskCancelRequest(context, {
    prefix: "cutout-task",
    unauthorizedMessage: "请先登录",
    canceledError: "用户已中断抠图",
  });
}
