import { defineEventHandler } from "h3"
import { handlePost } from "../handlers/api/redeem-code"
import { runServerHandler } from "../utils/nitroEventHandler"

export default defineEventHandler((event) => runServerHandler(event, handlePost))
