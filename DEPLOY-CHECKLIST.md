# EcomImgGen 部署检查清单

## Cloudflare 资源

- [x] 已创建/确认 EcomImgGen 使用的 `TASKS_KV`
- [x] 已创建/确认 EcomImgGen 使用的 `HYPERDRIVE` Postgres 连接
- [x] 已创建/确认 EcomImgGen 使用的 `HISTORY_BUCKET` R2 存储桶
- [x] 根目录 `wrangler.toml` 已写入同一个 KV ID
- [x] 根目录 `wrangler.toml` 已写入 Hyperdrive/R2 绑定
- [x] Postgres schema 已整理到 `migrations/0001_postgres_schema.sql`
- [x] `worker/wrangler.toml` 已写入同一个 KV ID

## Worker

- [ ] 已执行 `cd worker`
- [x] 已执行 `npx wrangler deploy`
- [x] 已记录 Worker URL
- [ ] 已配置 Secret `IMAGE_API_KEY`
- [x] 已配置明文变量 `IMAGE_BASE_URL`
- [x] 已配置明文变量 `IMAGE_MODEL`
- [ ] 已配置 Secret `LLM_API_KEY`
- [x] 已配置明文变量 `LLM_BASE_URL`
- [x] 已配置明文变量 `LLM_MODEL`
- [ ] 已配置 `IMAGE_WORKER_TOKEN`

## Pages

- [x] 已创建 Pages 项目 `ecom-img-gen`
- [ ] Build command 是 `npm run build`
- [ ] Output directory 是 `dist`
- [ ] 已绑定 `TASKS_KV`
- [ ] 已绑定 `HYPERDRIVE`
- [ ] 已绑定 `HISTORY_BUCKET`
- [ ] 已配置 OAuth Secrets
- [x] 已配置 LLM 文案/识别接口明文变量
- [x] 已配置 LLM 文案/识别接口 Secret `LLM_API_KEY`
- [x] 已配置 Worker 图像生成接口 Secrets
- [x] 已配置 `IMAGE_WORKER_URL`
- [x] 已配置 `IMAGE_WORKER_TOKEN`
- [x] Pages 和 Worker 的 `IMAGE_WORKER_TOKEN` 完全一致

## GitHub Actions 自动部署

- [x] 已添加 `.github/workflows/deploy.yml`
- [x] GitHub Secret 已配置 `CLOUDFLARE_API_TOKEN`
- [ ] push 到 `main` 后 Actions 自动部署 Pages
- [ ] push 到 `main` 后 Actions 自动部署 Worker

## OAuth

- [ ] GitHub OAuth callback 包含 `https://eig.easyauto.app/api/auth/callback/github`
- [ ] Google OAuth callback 包含 `https://eig.easyauto.app/api/auth/callback/google`
- [x] `AUTH_SECRET` 是足够长的随机字符串

## 发布验证

- [x] `npm run build` 通过
- [x] `npm run check` 通过
- [x] Pages 发布成功
- [ ] `https://eig.easyauto.app` 首页返回 200
- [ ] 未登录时页面显示登录入口
- [ ] 登录后可上传产品图
- [ ] 可生成 Prompt
- [ ] 可修改 Prompt
- [ ] 点击生成后会逐张创建任务并轮询
- [ ] 图片完成后逐张展示
- [ ] 刷新后历史记录从 Postgres 恢复，图片从 R2 加载

## 当前待补

- [ ] 配置 GitHub OAuth secrets
- [ ] 配置 Google OAuth secrets
- [ ] DNS 添加 `eig -> ecom-img-gen.pages.dev` CNAME
- [ ] 等待 `eig.easyauto.app` 证书和域名验证完成
