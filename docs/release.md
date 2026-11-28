# 发布

- 推送 `vX.Y.Z` tag 触发全部发布，版本号取自 tag：Daemon → npm / Homebrew（`mantou132/homebrew-tap`）/ Scoop（`mantou132/scoop-bucket`）/ GitHub Release；扩展发布到 Chrome、Edge、Firefox 商店；Android 提交 Google Play；iOS 经 fastlane 提交 App Store（已有版本在审或待发布时停在提交前，审核结束后重跑该 job）。npm 实现见 `crates/daemon/CLAUDE.md`。
- push 到 main 时 iOS 上传 TestFlight（版本号为最新 tag 的下一个 patch）并分发给公开链接所在的外部测试组「朋友」；商店资料与首次上架清单见 `distribution/appstore/`。
- macOS Daemon 用 Developer ID 证书签名（identifier `com.agentdeck.daemon`，使隐私授权在升级后保留），证书不可用时退回 ad-hoc。
- 前端热更新（`crates/agentdeck/src/frontend_update.rs`）：Release 附带 `agentdeck-frontend-<native id>.tar.gz`（native id 为 `crates/agentdeck` 与 `Cargo.lock` 的 git 哈希），App 下载同 id 的更新包，下次启动生效，未经 `frontend_update_ready` 确认的包回退。原生层改动会换 id，只能走商店。热更新只用于修复与小改动，新功能仍走商店审核。
- 可选：打 tag 前更新 `distribution/whatsnew/`（每种语言不超过 500 字符）作为 Google Play 与 App Store 更新说明，App 更多设置中的版本更新记录也读这些文件。更新前把旧说明按其版本存到 `history/`（如 `history/whatsnew-en-US-0.8.0`）；不能放在 `whatsnew/` 根目录，Google Play 上传会把根目录下所有 `whatsnew-*` 文件名当语言代码提交。
- 所需 Secrets 以各 workflow 文件中的引用为准。
