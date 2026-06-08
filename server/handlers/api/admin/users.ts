import { requireSession } from "../../_lib/auth";
import {
  listManagedUsers,
  updateManagedUser,
  type UserKvNamespace,
} from "../../_lib/users";
import type { HistoryD1Database } from "../../_lib/historyStorage";
import type { UserRole } from "@/lib/types";

interface RequestContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    HISTORY_DB?: HistoryD1Database;
    TASKS_KV?: UserKvNamespace;
  };
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

async function requireAdmin(context: RequestContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return { response: json({ error: "请先登录" }, { status: 401 }) };
  }
  if (session.user.role !== "admin" && session.user.role !== "super_admin") {
    return { response: json({ error: "当前账号没有后台权限" }, { status: 403 }) };
  }
  return { session };
}

export async function handleGet(context: RequestContext) {
  const auth = await requireAdmin(context);
  if ("response" in auth) return auth.response;

  try {
    return json({ users: await listManagedUsers(context.env) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function handlePost(context: RequestContext) {
  const auth = await requireAdmin(context);
  if ("response" in auth) return auth.response;

  try {
    const body = (await context.request.json()) as {
      userKey?: string;
      remainingCredits?: number;
      role?: UserRole;
    };
    const userKey = body.userKey?.trim();
    if (!userKey) {
      return json({ error: "缺少用户标识" }, { status: 400 });
    }
    const user = await updateManagedUser(context.env, userKey, {
      remainingCredits: body.remainingCredits,
      role: body.role,
    });
    return json({ user });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
