# iOS FCM 推送接入待办清单 (TODO)

> **当前进度状态**：
> - [x] Rust 插件已注册 (`tauri_plugin_fcm::init()`)
> - [x] Capabilities 权限已配置 (`src-tauri/capabilities/mobile.json`)
> - [x] 前端调用与 Token 上报逻辑已完成 (`src/agent/push.ts`)
> - [x] `GoogleService-Info.plist` 已下载并加入 Xcode Target Membership (`agentdeck_iOS`)
> - [ ] Apple 开发者账号与 APNs Key (等待账号注册完成)
> - [ ] Firebase 后台绑定 APNs Key
> - [ ] Xcode Capabilities (推送与后台通知权限)
> - [ ] CocoaPods 安装与真机测试

---

## 待办事项 (当获得 Apple 开发者账号后执行)

### 1. Apple Developer 后台创建 APNs 密钥 (.p8)
- [ ] 登录 [Apple Developer 后台 (Certificates, Identifiers & Profiles)](https://developer.apple.com/account/resources/authkeys/list)
- [ ] 进入 **Keys** -> 点击 **+** 创建新 Key。
- [ ] 名称填写例如 `AgentDeck Push Key`，勾选 **Apple Push Notifications service (APNs)**。
- [ ] 点击 **Continue** -> **Register**。
- [ ] **下载 `.p8` 文件**（注意：仅可下载一次，妥善备份）。
- [ ] 记录下 **Key ID** 以及 Apple 账号的 **Team ID**。

### 2. Firebase Console 配置 APNs
- [ ] 打开 [Firebase Console](https://console.firebase.google.com/) -> 选择 `agent-deck-push` 项目。
- [ ] 点击齿轮进入 **项目设置 (Project settings)** -> 切换到 **Cloud Messaging** 标签页。
- [ ] 找到 Apple 应用 `com.mantou.agentdeck`。
- [ ] 在 **APNs 身份验证密钥 (APNs Authentication Key)** 区域点击上传：
  - 上传第一步获得的 `.p8` 文件。
  - 填入 **Key ID** 与 **Team ID**。

### 3. Xcode 配置 Capabilities 与签名
- [ ] 打开 Xcode 工程：
  ```bash
  open src-tauri/gen/apple/agentdeck.xcodeproj
  ```
- [ ] 选中项目顶部的 **agentdeck** -> 选中 Target **`agentdeck_iOS`**。
- [ ] 切换到 **Signing & Capabilities** 标签页：
  - [ ] **Team**：选择你注册好的 Apple 开发者账号 Team。
  - [ ] 点击 **`+ Capability`**，添加 **Push Notifications**。
  - [ ] 再次点击 **`+ Capability`**，添加 **Background Modes**，并勾选 **Remote notifications**。

### 4. 依赖更新与真机调试
- [ ] 进入 `src-tauri/gen/apple` 运行 Pod 安装：
  ```bash
  cd src-tauri/gen/apple && pod install
  ```
- [ ] **连接 iPhone / iPad 真机**（模拟器不支持 APNs 远程通知注册，调用 `register()` 会报错）。
- [ ] 运行或打包调试：
  ```bash
  pnpm tauri ios dev
  ```
- [ ] 在 App 中测试允许通知，观察控制台是否成功获取到 FCM Token 并上报。
- [ ] 由 Native Host / Gorush 触发一条推送，验证真机横幅通知接收。

---

## 架构说明与常见疑问

- **Native Host / Gorush 需要改动吗？**
  - **不需要。**
  - `tauri-plugin-fcm` 在 iOS 端会将 APNs Token 自动向 Firebase 交换为统一格式的 **FCM Registration Token**。
  - 前端上报给 Native Host 的依然是 FCM Token。Native Host 发送推送时只需统一调用 Gorush / FCM 接口，Firebase 会自动通过之前配置的 APNs 密钥桥接发送给苹果 APNs 服务器，再由苹果推送给 iOS 真机。
