import { defineEventHandler } from "h3"
import { onRequestGet } from "../../legacy/api/generate/status"
import { runLegacyHandler } from "../../utils/pagesAdapter"

export default defineEventHandler((event) => runLegacyHandler(event, onRequestGet))
