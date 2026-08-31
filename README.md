# AgentDeck

AgentDeck 是一个使用 Tauri 2、Gem、Tap UI、Tailwind CSS 和 Rsbuild 构建的移动端 ACP（Agent Client Protocol）客户端。

## 功能

- 打开应用后显示会话列表；点开会话后，可通过顶部菜单按钮或左边缘右滑返回列表。
- 会话中支持用户消息、Agent 流式回复、思考过程和工具调用状态。
- 为手机屏幕优化的时间线、输入框、安全区和手势交互。
- 内置演示会话和模拟回复，无需连接服务端即可体验完整界面。

## 开始使用

安装依赖并启动浏览器预览：

```bash
pnpm install
pnpm run dev
```

启动 Android 模拟器或连接设备后运行：

```bash
pnpm run tauri android dev
```

启动桌面端：

```bash
pnpm run tauri dev
```

提交改动前可运行：

```bash
pnpm run lint:check
pnpm run check
pnpm run build
```

安装依赖时会自动启用 Husky；提交前只会对暂存的前端文件运行 Biome。

## 当前状态

当前版本使用 mock ACP 数据演示交互，尚未连接真实 ACP 服务。
