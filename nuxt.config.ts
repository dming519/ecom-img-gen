import { defineNuxtConfig } from "nuxt/config"
import { fileURLToPath } from "node:url"

export default defineNuxtConfig({
  compatibilityDate: "2026-06-07",
  devtools: { enabled: true },
  srcDir: "app",
  ssr: false,
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      title: "EcomImgGen",
      meta: [
        {
          name: "description",
          content: "登录后生成商品详情图文案，并逐张生成电商详情页图片",
        },
      ],
    },
  },
  alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
  },
  css: ["~/assets/globals.css"],
  runtimeConfig: {
    wrangler: {
      configPath: "wrangler.toml",
      persistDir: ".wrangler/state",
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
})
