import { handleCallbackRequest } from "../../../_lib/auth";
import type { PostgresEnv } from "../../../_lib/postgres";
import type { UserKvNamespace } from "../../../_lib/users";
import type { OAuthProvider } from "../../../_lib/auth";

interface RequestContext {
  request: Request;
  env: PostgresEnv & {
    AUTH_SECRET?: string;
    AUTH_GITHUB_ID?: string;
    AUTH_GITHUB_SECRET?: string;
    AUTH_GOOGLE_ID?: string;
    AUTH_GOOGLE_SECRET?: string;
    TASKS_KV?: UserKvNamespace;
  };
  params?: {
    provider?: string;
  };
}

function isProvider(value: string | undefined): value is OAuthProvider {
  return value === "github" || value === "google";
}

export function handleGet(context: RequestContext) {
  const provider = context.params?.provider;
  if (!isProvider(provider)) {
    return new Response("Not Found", { status: 404 });
  }
  return handleCallbackRequest(context.request, context.env, provider);
}
