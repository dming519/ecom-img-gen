import {
  createRedeemCodeRecord,
  listRedeemCodes,
  updateRedeemCodeRecord,
} from "../../_lib/redeemCodes";
import { requireSession } from "../../_lib/auth";
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
    return json({ redeemCodes: await listRedeemCodes(context.env) });
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
      action?: "create" | "update";
      id?: string;
      label?: string;
      code?: string;
      credits?: number;
      active?: boolean;
    };

    if (body.action === "update") {
      const id = body.id?.trim();
      if (!id) return json({ error: "缺少兑换码标识" }, { status: 400 });
      const redeemCode = await updateRedeemCodeRecord(context.env, id, {
        label: body.label,
        active: body.active,
      });
      return json({ redeemCode });
    }

    const created = await createRedeemCodeRecord(context.env, {
      label: body.label,
      code: body.code,
      credits: body.credits,
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
