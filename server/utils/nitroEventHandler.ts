import type { H3Event } from "h3"
import { getRouterParams, toWebRequest } from "h3"

interface ServerRequestContext<Env = Record<string, unknown>> {
  request: Request
  env: Env
  waitUntil?: (promise: Promise<unknown>) => void
  params?: Record<string, string | undefined>
}

// 项目里的业务 handler 统一接收 Web 标准 Request，而不是直接依赖 Nuxt 的 H3Event。
type ServerRequestHandler<Env> = (
  context: ServerRequestContext<Env>,
) => Response | undefined | Promise<Response | undefined>

// Cloudflare Pages 部署时 env 来自 event.context.cloudflare.env；
// 本地/测试环境可能通过 globalThis 注入，所以这里做兼容。
function getCloudflareEnv<Env = Record<string, unknown>>(
  event: H3Event,
): Env {
  return (
    event.context.cloudflare?.env ??
    (globalThis as typeof globalThis & { __env__?: Env }).__env__ ??
    {}
  ) as Env
}

// waitUntil 可以让 Cloudflare 在响应返回后继续执行异步清理或写入任务。
function getWaitUntil(event: H3Event) {
  const waitUntil =
    event.context.cloudflare?.context?.waitUntil ??
    event.context.waitUntil ??
    (globalThis as typeof globalThis & {
      __wait_until__?: (promise: Promise<unknown>) => void
    }).__wait_until__
  return typeof waitUntil === "function" ? waitUntil : undefined
}

// 把 Nuxt 的 H3Event 转成项目内部统一的 RequestContext，再调用业务 handler。
export async function runServerHandler<Env>(
  event: H3Event,
  handler: ServerRequestHandler<Env>,
) {
  const response = await handler({
    request: toWebRequest(event),
    env: getCloudflareEnv<Env>(event),
    waitUntil: getWaitUntil(event),
    params: getRouterParams(event),
  })
  return response ?? new Response("Server handler did not return a response", { status: 500 })
}
