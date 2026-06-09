import { requireSession } from "../_lib/auth";
import type { HistoryD1Database } from "../_lib/historyStorage";
import type { UserKvNamespace } from "../_lib/users";

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

  return json(
    { error: "系统已改为每个注册用户每天 10 次生图机会，兑换码不再增加次数。" },
    { status: 410 },
  );
}
