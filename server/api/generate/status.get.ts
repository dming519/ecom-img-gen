import { defineEventHandler } from "h3"
import { handleGet } from "../../handlers/api/generate/status"
import { runServerHandler } from "../../utils/nitroEventHandler"

export default defineEventHandler((event) => runServerHandler(event, handleGet))
