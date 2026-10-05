# 项目长期记忆

## 项目性质

Chrome MV3 扩展 YouTube Digest 的 **fork**。上游 `zarazhangrui/youtube-digest`（BYOK 纯本地、无开发者服务器），本 fork 自建了 Cloudflare Worker + Neon Postgres 同步层，**已明确偏离上游定位**。

## 分支约定

- `feat/new-feature` — 实际工作分支（2026-10-05 时含 28 个本地提交 + 1 个上游合并）
- `main` — 长期落后，停在 fork 点 `d03e1f6`
- `backup-before-upstream-merge-2026-10-05` — 合并前安全点，勿删

## 技术栈（已锁定）

- 字幕：Supadata API（`api.supadata.ai`）
- AI：DeepSeek / MiniMax / OpenCode Go 三 provider，key 相互隔离，切换时只有当前 key 出站
- 同步：Cloudflare Worker @ `ytd.panbo.space` + Neon Postgres，GitHub OAuth web flow，client secret 存 Worker secret
- 扩展侧同步逻辑集中在 `cloud-sync.js`
- 无构建步骤、无框架、无图标库，原生 JS

## 架构约定

- 云端是 source of truth，删除要能传播回本地
- 同步冲突用 `clientId` + `updatedAt` 双键合并
- 本地按账号命名空间隔离，登出前笔记在登录时迁移进账号
- **改动 `background.js` / `sidepanel.js` 时注意**：这两个文件与上游高度重叠，每次同步上游都要手工融合

## 同步上游的注意事项

1. `git fetch` 需 `dangerouslyDisableSandbox: true`，且要用 `--depth=60` 浅拉取（完整 fetch 会被 SIGTERM 杀死）
2. 合并前先建备份分支；27+ 个本地提交不可再生
3. 优先用 `git merge-tree --write-tree --name-only` 无副作用预演冲突
4. 上游会做 P0 级清理（如 emoji 禁令、SVG 化），本地需跟进

## 测试

- 扩展：`npm test`（node --test tests/*.test.js）
- 后端：`cd server && npm test`
- 测试是真行为测试（vm 沙箱 + fetch 桩），可信度较高，可作回归基线
- **CI 不跑测试**，只在本地跑

## 已知待办

- 词汇/复习功能三端错配，需定性：砍掉 or 接回 UI
- Dashboard 视觉与扩展脱节，需引入 design-tokens.css 统一
- Dashboard 存在指向不存在页面的死链
- 合并后未做浏览器端到端实测

## 审查报告

- `docs/PROJECT-REVIEW-2026-10-05.md`
