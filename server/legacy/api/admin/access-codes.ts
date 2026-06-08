import {
  createAccessCodeRecord,
  listAccessCodes,
  updateAccessCodeRecord,
} from "../../_lib/accessCodes";
import { requireSession } from "../../_lib/auth";
import type { HistoryD1Database } from "../../_lib/historyStorage";
import type { UserKvNamespace } from "../../_lib/users";

interface FunctionContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    ACCESS_LOGIN_CODE?: string;
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

async function requireAdmin(context: FunctionContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return { response: json({ error: "请先登录" }, { status: 401 }) };
  }
  if (session.user.role !== "admin" && session.user.role !== "super_admin") {
    return { response: json({ error: "当前账号没有后台权限" }, { status: 403 }) };
  }
  return { session };
}

export async function onRequestGet(context: FunctionContext) {
  const auth = await requireAdmin(context);
  if ("response" in auth) return auth.response;

  try {
    return json({ accessCodes: await listAccessCodes(context.env) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function onRequestPost(context: FunctionContext) {
  const auth = await requireAdmin(context);
  if ("response" in auth) return auth.response;

  try {
    const body = (await context.request.json()) as {
      action?: "create" | "update";
      id?: string;
      label?: string;
      code?: string;
      active?: boolean;
    };

    if (body.action === "update") {
      const id = body.id?.trim();
      if (!id) return json({ error: "缺少访问码标识" }, { status: 400 });
      const accessCode = await updateAccessCodeRecord(context.env, id, {
        label: body.label,
        active: body.active,
      });
      return json({ accessCode });
    }

    const created = await createAccessCodeRecord(context.env, {
      label: body.label,
      code: body.code,
      createdBy: auth.session.user.userKey ?? `${auth.session.user.provider}:${auth.session.user.id}`,
    });
    return json(created, { status: 201 });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
