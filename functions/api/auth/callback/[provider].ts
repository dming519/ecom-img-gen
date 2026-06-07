import { handleCallbackRequest } from "../../../_lib/auth";
import type { HistoryD1Database } from "../../../_lib/historyStorage";
import type { UserKvNamespace } from "../../../_lib/users";
import type { OAuthProvider } from "../../../_lib/auth";

interface FunctionContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    AUTH_GITHUB_ID?: string;
    AUTH_GITHUB_SECRET?: string;
    AUTH_GOOGLE_ID?: string;
    AUTH_GOOGLE_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
    TASKS_KV?: UserKvNamespace;
  };
  params?: {
    provider?: string;
  };
}

function isProvider(value: string | undefined): value is OAuthProvider {
  return value === "github" || value === "google";
}

export function onRequestGet(context: FunctionContext) {
  const provider = context.params?.provider;
  if (!isProvider(provider)) {
    return new Response("Not Found", { status: 404 });
  }
  return handleCallbackRequest(context.request, context.env, provider);
}
