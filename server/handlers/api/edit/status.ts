import { handleTaskStatusRequest } from "../../_lib/tasks";

export const handleGet = (context: Parameters<typeof handleTaskStatusRequest>[0]) =>
  handleTaskStatusRequest(context, {
    prefix: "edit-task",
    unauthorizedMessage: "请先登录后再查询改图任务",
    timeoutMs: 8 * 60 * 1000,
    timeoutMessage: "改图任务超时，请重试",
    billOnSuccess: true,
  });
