import { handleSession } from "../../_lib/auth";
import type { HistoryD1Database } from "../../_lib/historyStorage";
import type { UserKvNamespace } from "../../_lib/users";

interface RequestContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
    TASKS_KV?: UserKvNamespace;
  };
}

export function handleGet(context: RequestContext) {
  return handleSession(context.request, context.env);
}
