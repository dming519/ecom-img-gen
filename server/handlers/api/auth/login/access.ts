import { handleAccessLoginRequest } from "../../../_lib/auth";
import type { HistoryD1Database } from "../../../_lib/historyStorage";
import type { UserKvNamespace } from "../../../_lib/users";

interface RequestContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    ACCESS_LOGIN_CODE?: string;
    HISTORY_DB?: HistoryD1Database;
    TASKS_KV?: UserKvNamespace;
  };
}

export function handlePost(context: RequestContext) {
  return handleAccessLoginRequest(context.request, context.env);
}
