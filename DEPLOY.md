# EcomImgGen 部署指南

这个项目需要同时部署两部分：

1. Cloudflare Pages
2. 独立 Cloudflare Worker

还需要：

1. KV
2. Durable Object
3. OAuth 配置
4. Secrets
5. 自定义域名 `eig.easyauto.app`

## 1. 创建 KV

```bash
npx wrangler kv namespace create TASKS_KV
```

把得到的 KV Namespace ID 写入两个文件：

- 根目录 `wrangler.toml`
- `worker/wrangler.toml`

当前文件里沿用了参考项目的 KV ID，正式部署前应替换为 EcomImgGen 自己的 KV ID。

## 2. 部署 Worker

```bash
cd worker
npx wrangler deploy
```

Worker 名称：`ecom-img-gen-worker`

部署后记录 Worker URL，例如：

```text
https://ecom-img-gen-worker.<account>.workers.dev
```

配置 Worker Secrets：

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_BASE_URL
npx wrangler secret put OPENAI_MODEL
npx wrangler secret put IMAGE_WORKER_TOKEN
```

`IMAGE_WORKER_TOKEN` 是 Pages 调 Worker 的内部鉴权 token，Pages 和 Worker 必须一致。

## 3. 配置 OAuth

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

## 4. 配置 Pages

Cloudflare Pages 项目：

```text
ecom-img-gen
```

构建配置：

```text
Build command: npm run build
Output directory: out
```

Pages 需要绑定同一个 `TASKS_KV`，并配置 Secrets：

```text
AUTH_SECRET
AUTH_GITHUB_ID
AUTH_GITHUB_SECRET
AUTH_GOOGLE_ID
AUTH_GOOGLE_SECRET
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
PROMPT_MODEL
IMAGE_WORKER_URL
IMAGE_WORKER_TOKEN
```

`PROMPT_MODEL` 可选。建议使用支持视觉输入的模型；不配置时使用 `OPENAI_MODEL`。

## 5. 发布 Pages

```bash
npm run build
npx wrangler pages deploy out --project-name ecom-img-gen
```

## 6. 绑定域名

在 Cloudflare Pages 项目的 Custom domains 中绑定：

```text
eig.easyauto.app
```

确保 `easyauto.app` 的 DNS 托管在 Cloudflare，绑定后等待证书签发完成。

