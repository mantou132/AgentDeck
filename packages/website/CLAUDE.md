# AgentDeck Website (`packages/website`)

官网落地页 `https://agentdeck.xianqiao.wang`，[Gemkit](https://gemkit.gemjs.org/zh/guide/) 应用：构建时预渲染为静态页面，客户端水合。

## 结构

- `src/pages/index.ts`：唯一页面，含导航、各区块与页脚；`title` / `meta` 按语言输出。
- `src/elements/`：`app-*` 元素自动导入；`stores`（商店徽章）、`cmd`（可复制的命令）、`video`（点击后才加载 YouTube 播放器）。
- `src/locales/`：`en.json` 为默认语言（`/`），`zh.json` 为 `/zh/`；导航中的语言链接用 `localizePath` 切换。富文本用 Gem i18n 的 `$1<文字>` 占位，在模板中传入渲染函数。
- `src/index.html`：HTML 模板与全站 `<meta>`；`src/global.css`：CSS 变量与 body 样式；`public/`：原样拷贝的静态资源。
- `.gemkit/` 由 `rsbuild dev` / `rsbuild build` 生成（已被 Git 忽略），`tsconfig.json` 继承它；根目录 `prepare` 在 `pnpm install` 后构建官网，所以安装后即可运行 tsc。

## 部署

Vercel 项目的 Root Directory 设为 `packages/website`，push 到 main 自动部署；Gemkit 在 Vercel 上构建时自动输出 `.vercel/output`，不需要 `vercel.json`。域名在 Vercel 项目的 Domains 中添加，DNS 中把 `agentdeck` 指向 Vercel 给出的 CNAME。

## 常用命令

- `pnpm run dev`：带 SSR 与 HMR 的开发服务器。
- `pnpm run build`：构建到 `dist/web`（预渲染页面）与 `dist/server`。
- `pnpm run start`：本地预览构建产物。
