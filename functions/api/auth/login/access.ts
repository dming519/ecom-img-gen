import { handleAccessLoginRequest } from "../../../_lib/auth";

interface FunctionContext {
  request: Request;
  env: {
    AUTH_SECRET?: string;
    ACCESS_LOGIN_CODE?: string;
  };
}

export function onRequestPost(context: FunctionContext) {
  return handleAccessLoginRequest(context.request, context.env);
}
