import { handleTaskCancelRequest } from "../../_lib/tasks";

export const handlePost = (context: Parameters<typeof handleTaskCancelRequest>[0]) =>
  handleTaskCancelRequest(context, {
    prefix: "edit-task",
    unauthorizedMessage: "请先登录后再取消改图任务",
    canceledError: "改图已中断",
  });
