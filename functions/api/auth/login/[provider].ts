import { handleLoginRequest } from "../../../_lib/auth";
import type { HistoryD1Database } from "../../../_lib/historyStorage";
import type { UserKvNamespace } from "../../../_lib/users";
import type { AuthProvider } from "../../../../src/lib/types";

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

function isProvider(value: string | undefined): value is AuthProvider {
  return value === "github" || value === "google";
}

export function onRequestGet(context: FunctionContext) {
  const provider = context.params?.provider;
  if (!isProvider(provider)) {
    return new Response("Not Found", { status: 404 });
  }
  return handleLoginRequest(context.request, context.env, provider);
}
