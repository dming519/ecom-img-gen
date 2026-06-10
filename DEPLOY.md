# EcomImgGen 部署指南

这个项目需要同时部署两部分：

1. Cloudflare Pages
2. 独立 Cloudflare Worker

还需要：

1. KV
2. D1
3. R2
4. Durable Object
5. OAuth 配置
6. Secrets
7. 自定义域名 `eig.easyauto.app`

## 1. 创建 KV

```bash
npx wrangler kv namespace create TASKS_KV
```

把得到的 KV Namespace ID 写入两个文件：

- 根目录 `wrangler.toml`
- `worker/wrangler.toml`

当前项目使用的 KV：

```text
TASKS_KV = 6a7ee075ab4b4cbe9cfd80ed9fb0b40a
```

## 2. 创建历史数据库和图片存储桶

```bash
npx wrangler d1 create ecom-img-gen-history
npx wrangler r2 bucket create ecom-img-gen-images
```

根目录 `wrangler.toml` 当前已绑定：

```text
HISTORY_DB = ecom-img-gen-history / 47b2ddfa-9418-4c60-b3ba-7f71112196c1
HISTORY_BUCKET = ecom-img-gen-images
```

应用 D1 表结构：

```bash
npx wrangler d1 execute ecom-img-gen-history --remote --file migrations/0001_history_storage.sql
npx wrangler d1 execute ecom-img-gen-history --remote --file migrations/0002_admin_data_d1.sql
```

Nuxt/Nitro API 首次访问时也会兜底创建同一套表。历史记录元数据写入 D1，参考图、生成图、抠图结果写入 R2；后台用户、访问码、兑换码和用户额度也写入 D1。

## 3. 部署 Worker

```bash
cd worker
npx wrangler deploy
```

Worker 名称：`ecom-img-gen-worker`

部署后记录 Worker URL，例如：

```text
https://ecom-img-gen-worker.ldmcsy2020.workers.dev
```

Worker 的非敏感配置写在 `worker/wrangler.toml` 的明文变量里：

```toml
[vars]
IMAGE_MODEL = "gpt-image-2"
IMAGE_BASE_URL = "https://sub2api.easyauto.app"
LLM_MODEL = "gpt-5.5"
LLM_BASE_URL = "https://sub2api.easyauto.app"
```

配置 Worker Secrets：

```bash
npx wrangler secret put IMAGE_API_KEY
npx wrangler secret put LLM_API_KEY
npx wrangler secret put IMAGE_WORKER_TOKEN
```

`IMAGE_*` 用于 GPT-Image-2 等生图/编辑接口；`LLM_*` 用于详情图文案生成和分层图像结构识别，必须指向支持图片输入的聊天/Responses 兼容接口。`*_API_KEY` 必须继续使用 Secret。

`IMAGE_WORKER_TOKEN` 是 Pages 调 Worker 的内部鉴权 token，Pages 和 Worker 必须一致。

## 4. 配置 OAuth

项目支持 GitHub 和 Google 登录。Cloudflare Pages 上需要配置：

```text
AUTH_SECRET
AUTH_GITHUB_ID
AUTH_GITHUB_SECRET
AUTH_GOOGLE_ID
AUTH_GOOGLE_SECRET
```

OAuth 回调地址：

```text
https://eig.easyauto.app/api/auth/callback/github
https://eig.easyauto.app/api/auth/callback/google
```

如果先使用 Pages 临时域名联调，也要把临时域名的 callback 加到 OAuth App 配置里。

## 5. 配置 Pages

Cloudflare Pages 项目：

```text
ecom-img-gen
```

构建配置：

```text
Build command: npm run build
Output directory: dist
```

Pages 的非敏感配置写在根目录 `wrangler.toml` 的明文变量里：

```toml
[vars]
LLM_MODEL = "gpt-5.5"
LLM_BASE_URL = "https://sub2api.easyauto.app"
```

Pages 需要绑定同一个 `TASKS_KV`，并绑定 `HISTORY_DB` 和 `HISTORY_BUCKET`。同时配置 Secrets：

```text
AUTH_SECRET
AUTH_GITHUB_ID
AUTH_GITHUB_SECRET
AUTH_GOOGLE_ID
AUTH_GOOGLE_SECRET
LLM_API_KEY
IMAGE_WORKER_URL
IMAGE_WORKER_TOKEN
```

`LLM_MODEL` 建议使用支持视觉输入的模型，例如 `gpt-5.5`。不要把 `LLM_BASE_URL` 指向生图代理。

当前已自动配置：

```text
AUTH_SECRET
IMAGE_WORKER_URL
IMAGE_WORKER_TOKEN
LLM_API_KEY
```

仍需配置：

```text
AUTH_GITHUB_ID
AUTH_GITHUB_SECRET
AUTH_GOOGLE_ID
AUTH_GOOGLE_SECRET
```

Worker 已配置：

```text
IMAGE_API_KEY
LLM_API_KEY
IMAGE_WORKER_TOKEN
```

## 6. 发布 Pages

```bash
npm run build
npx wrangler pages deploy dist --project-name ecom-img-gen
```

## 7. 绑定域名

在 Cloudflare Pages 项目的 Custom domains 中绑定：

```text
eig.easyauto.app
```

确保 `easyauto.app` 的 DNS 托管在 Cloudflare，绑定后等待证书签发完成。

当前状态：

- Pages custom domain 已添加：`eig.easyauto.app`
- Cloudflare 返回验证错误：`CNAME record not set`
- 需要在 DNS 中添加：

```text
Type: CNAME
Name: eig
Target: ecom-img-gen.pages.dev
Proxy: enabled
```
