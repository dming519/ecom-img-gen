import { defineEventHandler } from "h3"
import { handleGet } from "../../../handlers/api/auth/login/[provider]"
import { runServerHandler } from "../../../utils/nitroEventHandler"

export default defineEventHandler((event) => runServerHandler(event, handleGet))
