import { handleLogoutRequest } from "../../_lib/auth";

interface RequestContext {
  request: Request;
}

export function handleGet(context: RequestContext) {
  return handleLogoutRequest(context.request);
}
