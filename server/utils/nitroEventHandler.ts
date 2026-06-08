import type { H3Event } from "h3"
import { getRouterParams, toWebRequest } from "h3"

interface ServerRequestContext<Env = Record<string, unknown>> {
  request: Request
  env: Env
  waitUntil?: (promise: Promise<unknown>) => void
  params?: Record<string, string | undefined>
}

type ServerRequestHandler<Env> = (
  context: ServerRequestContext<Env>,
) => Response | undefined | Promise<Response | undefined>

function getCloudflareEnv<Env = Record<string, unknown>>(
  event: H3Event,
): Env {
  return (
    event.context.cloudflare?.env ??
    (globalThis as typeof globalThis & { __env__?: Env }).__env__ ??
    {}
  ) as Env
}

function getWaitUntil(event: H3Event) {
  const waitUntil =
    event.context.cloudflare?.context?.waitUntil ??
    event.context.waitUntil ??
    (globalThis as typeof globalThis & {
      __wait_until__?: (promise: Promise<unknown>) => void
    }).__wait_until__
  return typeof waitUntil === "function" ? waitUntil : undefined
}

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
