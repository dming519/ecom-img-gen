import { requireSession } from "../_lib/auth";
import type { HistoryD1Database } from "../_lib/historyStorage";
import { redeemCodeRecord } from "../_lib/redeemCodes";
import {
  getUserKey,
  grantImageCredits,
  type UserKvNamespace,
} from "../_lib/users";

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

export async function handlePost(context: RequestContext) {
  const session = await requireSession(context.request, context.env);
  if (!session) {
    return json({ error: "请先登录后再兑换次数" }, { status: 401 });
  }
  if (session.user.role === "super_admin") {
    return json({ error: "超级管理员不限次数，无需兑换" }, { status: 400 });
  }

  try {
    const body = (await context.request.json()) as { code?: string };
    const userKey = session.user.userKey ?? getUserKey(session.user);
    const redeemed = await redeemCodeRecord(context.env, body.code ?? "", userKey);
    const granted = await grantImageCredits(context.env, session.user, redeemed.credits);

    return json({
      grantedCredits: granted.granted,
      redeemCode: redeemed.redeemCode,
      user: granted.user,
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
