# EcomImgGen

商品详情图 Prompt 生成与逐张出图工作台。

## 功能

- 登录后使用，支持 GitHub / Google OAuth。
- 输入产品名称、产品图片、核心卖点和功效、图片张数。
- 调用服务端 AI 接口，根据 `电商详情页Prompt自动生成器.md` 的规则生成商品详情图 Prompt。
- Prompt 会展示在页面，用户可以逐条修改标题和 Prompt 内容。
- 点击生成后按顺序逐张创建图片任务，每张先返回 `taskId`，前端轮询状态，完成一张展示一张。
- 表单草稿、Prompt 草稿保存在 `localStorage`。
- 生成历史和图片结果保存在当前浏览器 `IndexedDB`。

## 技术栈

- Next.js 15
- React 19
- TypeScript
- Cloudflare Pages
- Cloudflare Pages Functions
- Cloudflare KV
- Cloudflare Worker
- Durable Object

## 本地开发

```bash
npm install
npm run dev
```

构建静态站点：

```bash
npm run build
```

本地预览 Cloudflare Pages 输出：

```bash
npm run preview
```

## 核心链路

Prompt 生成：

1. 浏览器请求 `POST /api/prompt`
2. Pages Function 校验登录态
3. Pages Function 调用 OpenAI-compatible `chat/completions` 视觉模型
4. 返回多条商品详情图 Prompt

图片生成：

1. 浏览器逐张请求 `POST /api/generate`
2. Pages Function 创建任务并写入 KV
3. Pages Function 分发任务到独立 Worker
4. Worker 通过 Durable Object 调用图片接口
5. Worker 把任务状态和结果写回 KV
6. 浏览器轮询 `GET /api/generate/status?taskId=...`
7. 页面逐张展示生成结果并写入 IndexedDB

## 必要环境变量

Pages Functions：

- `AUTH_SECRET`
- `AUTH_GITHUB_ID`
- `AUTH_GITHUB_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `PROMPT_API_KEY`
- `PROMPT_BASE_URL`
- `PROMPT_MODEL`
- `IMAGE_WORKER_URL`
- `IMAGE_WORKER_TOKEN`

Worker：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `IMAGE_WORKER_TOKEN`

Pages 和 Worker 需要绑定同一个 `TASKS_KV`。

## 部署

目标仓库：

```text
https://github.com/dming519/ecom-img-gen
```

目标访问地址：

```text
https://eig.easyauto.app
```

当前 Cloudflare 资源：

- Worker: `https://ecom-img-gen-worker.ldmcsy2020.workers.dev`
- Pages: `https://ecom-img-gen.pages.dev`
- Latest deployment: `https://9fbb0c4e.ecom-img-gen.pages.dev`
- KV: `TASKS_KV` / `6a7ee075ab4b4cbe9cfd80ed9fb0b40a`
- Custom domain: `eig.easyauto.app` 已添加到 Pages，等待 DNS CNAME 验证

详细步骤见 [DEPLOY.md](./DEPLOY.md) 和 [DEPLOY-CHECKLIST.md](./DEPLOY-CHECKLIST.md)。
