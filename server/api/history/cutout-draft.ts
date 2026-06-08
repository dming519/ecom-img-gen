import { defineEventHandler } from "h3"
import {
  onRequestDelete,
  onRequestGet,
  onRequestPost,
  onRequestPut,
} from "../../legacy/api/history/cutout-draft"
import { runLegacyHandler } from "../../utils/pagesAdapter"

export default defineEventHandler((event) => {
  if (event.method === "GET") return runLegacyHandler(event, onRequestGet)
  if (event.method === "POST") return runLegacyHandler(event, onRequestPost)
  if (event.method === "PUT") return runLegacyHandler(event, onRequestPut)
  if (event.method === "DELETE") return runLegacyHandler(event, onRequestDelete)
  return new Response("Method Not Allowed", { status: 405 })
})
