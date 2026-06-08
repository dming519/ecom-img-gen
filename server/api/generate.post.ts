import { defineEventHandler } from "h3"
import { onRequestPost } from "../legacy/api/generate"
import { runLegacyHandler } from "../utils/pagesAdapter"

export default defineEventHandler((event) => runLegacyHandler(event, onRequestPost))
