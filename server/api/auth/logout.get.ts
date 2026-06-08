import { defineEventHandler } from "h3"
import { onRequestGet } from "../../legacy/api/auth/logout"
import { runLegacyHandler } from "../../utils/pagesAdapter"

export default defineEventHandler((event) => runLegacyHandler(event, onRequestGet))
