import { defineEventHandler } from "h3"
import { onRequestGet, onRequestPost } from "../../legacy/api/admin/redeem-codes"
import { runLegacyHandler } from "../../utils/pagesAdapter"

export default defineEventHandler((event) => {
  if (event.method === "GET") return runLegacyHandler(event, onRequestGet)
  if (event.method === "POST") return runLegacyHandler(event, onRequestPost)
  return new Response("Method Not Allowed", { status: 405 })
})
