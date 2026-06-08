import { defineEventHandler } from "h3"
import {
  handleDelete,
  handleGet,
  handlePost,
  handlePut,
} from "../../handlers/api/history/edit"
import { runServerHandler } from "../../utils/nitroEventHandler"

export default defineEventHandler((event) => {
  if (event.method === "GET") return runServerHandler(event, handleGet)
  if (event.method === "POST") return runServerHandler(event, handlePost)
  if (event.method === "PUT") return runServerHandler(event, handlePut)
  if (event.method === "DELETE") return runServerHandler(event, handleDelete)
  return new Response("Method Not Allowed", { status: 405 })
})
