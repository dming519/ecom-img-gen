import { handleSessionRequest } from "../../_lib/auth";
import type { HistoryD1Database } from "../../_lib/historyStorage";
import type { UserKvNamespace } from "../../_lib/users";

interface FunctionContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
    TASKS_KV?: UserKvNamespace;
  };
}

export function onRequestGet(context: FunctionContext) {
  return handleSessionRequest(context.request, context.env);
}
