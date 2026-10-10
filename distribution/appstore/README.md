# App Store 上架

推送 `vX.Y.Z` tag 时，`.github/workflows/release-ios.yml` 会构建签名 IPA，上传本目录 `metadata/` 和 `distribution/whatsnew/`（作为 What's New），提交审核，审核通过后自动发布。手动触发 workflow 只构建 IPA 并保存为 artifact。

`metadata/` 是 fastlane deliver 格式，`zh-Hans` 对应简体中文；字段长度限制：名称、副标题 30，关键词 100，推广文本 170，描述 4000。

## 首次上架待办

### 1. Apple Developer

- [ ] 加入 Apple Developer Program，记下 **Team ID**（Membership 页面）。
- [ ] Identifiers 中注册 App ID `com.mantou.agentdeck`，勾选 **Push Notifications**。
- [ ] Keys 中创建 APNs Key（勾选 Apple Push Notifications service），下载 `.p8`（只能下载一次），记下 Key ID。
- [ ] Firebase Console → `agent-deck-push` 项目 → 项目设置 → Cloud Messaging → Apple 应用 `com.mantou.agentdeck`，上传 APNs `.p8`，填 Key ID 和 Team ID。

### 2. App Store Connect

- [ ] 新建 App：平台 iOS，名称 AgentDeck，Bundle ID `com.mantou.agentdeck`，SKU 任意，主要语言 English (U.S.)；添加简体中文本地化。
- [ ] 用户和访问 → 集成 → App Store Connect API → 生成**团队密钥**，角色选 **Admin**（CI 自动签名需要创建分发证书和描述文件），下载 `.p8`，记下 Key ID 和 Issuer ID。
- [ ] 价格：免费。销售范围：除中国大陆以外的全部国家/地区（中国大陆需要 ICP 备案和生成式 AI 备案）。
- [ ] 年龄分级问卷。
- [ ] App 隐私：
  - 数据类型只有「标识符 → 设备 ID」（FCM 推送 token），用途「App 功能」，不与身份关联，不用于追踪。
  - 提示、回复和文件只在用户自己的设备、电脑和用户选的中继之间端到端加密传输，开发者无法读取，不算收集。
  - 语音由系统语音服务在本机识别，开发者不接收音频。
- [ ] 截图：iPhone 6.9 英寸（1320×2868）和 iPad 13 英寸（2064×2752，工程支持 iPad，所以必填），中英文各一套。workflow 不上传截图，需要在后台手动上传。
- [ ] App 审核信息：联系人、电话、邮箱（备注由 workflow 上传）。

### 3. GitHub Secrets

```bash
gh secret set APPLE_TEAM_ID
```

```bash
gh secret set APP_STORE_CONNECT_API_KEY_ID
```

```bash
gh secret set APP_STORE_CONNECT_API_ISSUER_ID
```

```bash
gh secret set APP_STORE_CONNECT_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
```

`APP_REVIEW_PAIRING_ID` 见下方「审核机与审核备注」。

### 4. 验证与首发

- [ ] 真机运行 `pnpm tauri ios dev`，确认能拿到 FCM token、收到任务完成推送（模拟器不支持远程推送）。
- [ ] 确认 `crates/agentdeck/gen/apple/agentdeck_iOS/Info.plist` 中 `NSLocalNetworkUsageDescription` 的文案与实际用途一致。
- [ ] 在 Actions 中手动运行 **Release iOS**，确认签名构建成功。
- [ ] 截图和审核信息都填好后再推 tag，否则提交审核会失败。

## 审核机与审核备注

审核员必须连上一台运行 agentdeckd 的电脑才能使用 App。审核机是腾讯云 `/root/docker-compose.yml` 里的 `agentdeck-review` 服务：`node:22-trixie` 镜像运行 `npx -y agentdeckd@latest run`，只主动连 Relay，不暴露端口，`mem_limit: 600m` + `memswap_limit: 1600m`（与线上 relay 同机，物理内存必须封顶，避免拖垮整机；opencode 单会话就超过 550MB，超出部分走主机的 2G `/swapfile`）。审核机常驻，每个版本审核都要用。数据在 `./agentdeck-review-data`，示例项目在 `./agentdeck-review-workspace`（容器内 `/root/workspace`，属主须为 root，否则 git 拒绝打开）。

审核备注模板是 `metadata/review_information/notes.txt`，发布时 workflow 把 `{{PAIRING_ID}}` 替换成 Secret `APP_REVIEW_PAIRING_ID` 后随其他资料上传。联系人姓名、电话、邮箱只在后台填一次，之后的版本自动沿用。轮换 Pairing ID 后同步 Secret：

```bash
ssh tencent 'cd /root && docker-compose stop agentdeck-review && docker-compose run --rm --no-deps agentdeck-review npx -y agentdeckd@latest reset > /dev/null && docker-compose up -d agentdeck-review'
```

```bash
ssh tencent "python3 -c \"import json;print(json.load(open('/root/agentdeck-review-data/daemon.json'))['relay_id'],end='')\"" | gh secret set APP_REVIEW_PAIRING_ID
```
