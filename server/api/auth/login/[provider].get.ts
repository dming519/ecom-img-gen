import { defineEventHandler } from "h3"
import { onRequestGet } from "../../../legacy/api/auth/login/[provider]"
import { runLegacyHandler } from "../../../utils/pagesAdapter"

export default defineEventHandler((event) => runLegacyHandler(event, onRequestGet))
