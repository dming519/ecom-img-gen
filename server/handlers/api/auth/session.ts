import { handleSession } from "../../_lib/auth";
import type { PostgresEnv } from "../../_lib/postgres";
import type { UserKvNamespace } from "../../_lib/users";

interface RequestContext {
  request: Request;
  env: PostgresEnv & {
    AUTH_SECRET?: string;
    TASKS_KV?: UserKvNamespace;
  };
}

export function handleGet(context: RequestContext) {
  return handleSession(context.request, context.env);
}
