import { handleAccessLoginRequest } from "../../../_lib/auth";
import type { PostgresEnv } from "../../../_lib/postgres";
import type { UserKvNamespace } from "../../../_lib/users";

interface RequestContext {
  request: Request;
  env: PostgresEnv & {
    AUTH_SECRET?: string;
    ACCESS_LOGIN_CODE?: string;
    TASKS_KV?: UserKvNamespace;
  };
}

export function handlePost(context: RequestContext) {
  return handleAccessLoginRequest(context.request, context.env);
}
