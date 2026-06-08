import { defineEventHandler } from "h3"
import { handleGet, handlePost } from "../../handlers/api/admin/redeem-codes"
import { runServerHandler } from "../../utils/nitroEventHandler"

export default defineEventHandler((event) => {
  if (event.method === "GET") return runServerHandler(event, handleGet)
  if (event.method === "POST") return runServerHandler(event, handlePost)
  return new Response("Method Not Allowed", { status: 405 })
})
