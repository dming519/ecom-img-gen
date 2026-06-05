# EcomImgGen 部署检查清单

## Cloudflare 资源

- [x] 已创建/确认 EcomImgGen 使用的 `TASKS_KV`
- [x] 根目录 `wrangler.toml` 已写入同一个 KV ID
- [x] `worker/wrangler.toml` 已写入同一个 KV ID

## Worker

- [ ] 已执行 `cd worker`
- [x] 已执行 `npx wrangler deploy`
- [x] 已记录 Worker URL
- [ ] 已配置 `OPENAI_API_KEY`
- [ ] 已配置 `OPENAI_BASE_URL`
- [ ] 已配置 `OPENAI_MODEL`
- [ ] 已配置 `IMAGE_WORKER_TOKEN`

## Pages

- [x] 已创建 Pages 项目 `ecom-img-gen`
- [ ] Build command 是 `npm run build`
- [ ] Output directory 是 `out`
- [ ] 已绑定 `TASKS_KV`
- [ ] 已配置 OAuth Secrets
- [ ] 已配置 OpenAI-compatible 接口 Secrets
- [x] 已配置 `IMAGE_WORKER_URL`
- [x] 已配置 `IMAGE_WORKER_TOKEN`
- [x] Pages 和 Worker 的 `IMAGE_WORKER_TOKEN` 完全一致

## OAuth

- [ ] GitHub OAuth callback 包含 `https://eig.easyauto.app/api/auth/callback/github`
- [ ] Google OAuth callback 包含 `https://eig.easyauto.app/api/auth/callback/google`
- [x] `AUTH_SECRET` 是足够长的随机字符串

## 发布验证

- [ ] `npm run build` 通过
- [ ] `npx tsc -p worker/tsconfig.json --noEmit` 通过
- [x] Pages 发布成功
- [ ] `https://eig.easyauto.app` 首页返回 200
- [ ] 未登录时页面显示登录入口
- [ ] 登录后可上传产品图
- [ ] 可生成 Prompt
- [ ] 可修改 Prompt
- [ ] 点击生成后会逐张创建任务并轮询
- [ ] 图片完成后逐张展示
- [ ] 刷新后历史记录仍在当前浏览器中

## 当前待补

- [ ] 配置 GitHub OAuth secrets
- [ ] 配置 Google OAuth secrets
- [ ] 配置 OpenAI-compatible 接口 secrets
- [ ] DNS 添加 `eig -> ecom-img-gen.pages.dev` CNAME
- [ ] 等待 `eig.easyauto.app` 证书和域名验证完成
