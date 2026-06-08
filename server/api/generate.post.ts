import { defineEventHandler } from "h3"
import { handlePost } from "../handlers/api/generate"
import { runServerHandler } from "../utils/nitroEventHandler"

export default defineEventHandler((event) => runServerHandler(event, handlePost))
