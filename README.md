# Flowday

一个使用 Tauri 2、Gem、Duoyun UI 和 Rsbuild 构建的轻量移动任务清单，前端代码同时用于 iOS、Android 和桌面端。

## 技术栈

- Tauri `2.11.5`
- Tauri CLI `2.11.4`
- Rsbuild `2.1.10`
- `@mantou/gem 2.2.4`
- `duoyun-ui 2.2.3`
- `unplugin-gem 0.1.1`
- `swc-plugin-gem 0.1.9`

## 本地预览

只预览前端界面不需要 Android Studio：

```bash
pnpm install
pnpm run dev
```

检查类型或生成前端静态资源：

```bash
pnpm run check
pnpm run build
```

安装 Rust 和 Tauri 的系统依赖后，也可以运行桌面窗口：

```bash
pnpm run tauri dev
```

## Android

准备好 Android Studio、Android SDK、NDK 和 JDK 后，首次初始化并启动：

```bash
pnpm run tauri android init
pnpm run tauri android dev
```

## iOS

iOS 开发和发布必须在 macOS 上安装 Xcode。首次初始化并启动：

```bash
pnpm run tauri ios init
pnpm run tauri ios dev
```

移动端生成目录由 Tauri CLI 管理。本项目目前没有执行 Android/iOS 初始化或构建。
