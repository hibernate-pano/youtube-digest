# 端到端验证报告

日期：2026-10-05
被验版本：`feat/new-feature` @ `db3556e`（含上游合并 `6c6e08e` + P0 修复 `23a5d4b`）
验证环境：Google Chrome 154.0.8037.97 / macOS

---

## 一、验证手段与一处环境限制

**先说限制**：Chrome 154 的 headless 模式**不再加载 unpacked 扩展**。我用 `--load-extension` 启动后，通过 CDP 的 `Target.getTargets`（权威接口）确认只存在 2 个扩展 target，均为 Chrome 内置组件（`nkeimhogjdpnpccoofpliimaahmaaome`、`fignfifoniblkonapihmkfakmlgkbkcf`），**我们的扩展未被载入**。非 headless 模式同样未生成 profile 条目。环境中也没有 `chrome-headless-shell` 可用。

因此**无法执行"装扩展 → 点图标 → 打开侧边栏"这条最完整的路径**。我改用三档递进的等效验证，覆盖真实运行时而非只看测试绿灯。

| 档次 | 手段 | 覆盖 |
|-----|------|------|
| 1 | 真实 Chrome 加载 `sidepanel.html`，`--dump-dom` 检查渲染结果 | DOM 结构、脚本引用、CSS 加载 |
| 2 | 真实 Chrome V8 中执行真实源码（`settings.js` + `cloud-sync.js`），配 MV3 API 桩 | 运行时行为、合并后能力共存 |
| 3 | 真实 Worker `fetch()` 端到端 + 本地 HTTP 服务器验证状态码分支 | 后端 P0 修复、HTTP 语义 |

---

## 二、档次 1：真实浏览器渲染

Chrome 实际加载 `sidepanel.html` 后的 DOM 检查：

| 检查项 | 结果 |
|-------|------|
| `header-actions` 融合容器 | 存在（本地上游冲突点已正确融合） |
| `syncBtn`（本地 GitHub 登录） | 存在 |
| `syncAccount`（账号 chip） | 存在 |
| `transcriptModeControl`（上游语言切换） | 存在 |
| `transcriptSearchInput` / `ClearBtn` / `Count` / `PrevBtn` / `NextBtn` | **5 个搜索控件全部存在**（上游新功能） |
| `notesList` / `notesFilterAll` / `notesFilterThis` / `notesIntro` | 存在（本地功能未被覆盖） |
| 全部 `<script>` / `<link>` 引用 | 无缺失 |
| manifest 引用的 7 个文件 | 全部存在 |

**结论**：8 个冲突文件的融合结果在真实浏览器中渲染正确，双方 UI 元素共存无重复。

---

## 三、档次 2：真实 V8 运行时行为

把真实的 `settings.js` + `cloud-sync.js` 注入 Chrome V8 执行（配 MV3 `chrome.*` 桩），逐项断言：

| 断言 | 结果 |
|------|------|
| A1 三 AI provider 注册表 | `deepseek=deepseek-v4-flash`、`minimax=MiniMax-M3`、`opencode-go=deepseek-v4-flash` |
| A2 各 provider 的 chat completions URL | `https://api.deepseek.com/chat/completions`、`https://api.minimaxi.com/v1/chat/completions`、`https://opencode.ai/zen/go/v1/chat/completions` |
| A3 `canonicalYouTubeUrl`（上游新增） | `https://www.youtube.com/watch?v=dQw4w9WgXcQ` |
| A4 `SYNC_SESSION_EXPIRED` / `SYNC_EXPIRED_KEY`（本地修复） | `SYNC_SESSION_EXPIRED` / `ytd_sync_expired` |
| A5 `starred` 云端→本地 | `{starred: true, text: "t", timestamp: "1:05"}` |
| A6 `starred` 本地→云端三态 | 有布尔值时上传（`true`）、无值时**不上传**（`false`） |
| A7 命名空间隔离（未登录） | `ytd_notes`（登出回落本地命名空间） |
| A9 时间戳格式化 | `3725` → `1:02:05` |
| A10 冲突合并取最新 | 本地旧值 vs 云端新值 → 取云端，`toPush: 0` |
| 运行时异常 | **none** |

**A6 是关键**：三态语义生效意味着扩展推送笔记文本时**不会**把用户在 Dashboard 设的收藏清空。这正是修复 `starred` 静默丢失时最容易引入的反向缺陷。

### 3.1 状态码分支精确验证

用本地 HTTP 服务器对真实 `cloudFetch` 打不同状态码：

| 响应 | 期望 | 实测 | 结果 |
|------|------|------|------|
| 401 | `code = SYNC_SESSION_EXPIRED` | `status=401 code=SYNC_SESSION_EXPIRED` | PASS |
| 500 | 不标记过期 | `status=500 code=none` | PASS |
| 502 | 不标记过期 | `status=502 code=none` | PASS |
| 503 | 不标记过期 | `status=503 code=none` | PASS |

**4/4 通过**。这条区分很重要：如果 5xx 也弹"同步已过期"，网络抖动会让用户反复被要求重新登录，提示就失去意义了。

---

## 四、档次 3：真实 Worker 端到端

直接调用真实 Cloudflare Worker 的 `fetch()`，走完整 HTTP 面（路由匹配 → 鉴权 → store）。

| # | 断言 | 结果 |
|---|------|------|
| 1 | bob 创建私有词汇 | PASS |
| 2 | 返回 vocabulary id | PASS |
| 3 | **alice 对 bob 的 vocabId 提交复习 → 404 拒绝** | PASS |
| 4 | **alice 的到期列表不含 `SECRET_TERM`** | PASS |
| 5 | bob 对自己的词提交复习 → 200 | PASS |
| 6 | 新复习按 SM-2 排在 2 天后（此时不该到期） | PASS |
| 7 | alice 创建笔记 | PASS |
| 8 | 返回 note id | PASS |
| 9 | **star PATCH 响应 `starred: true`** | PASS |
| 10 | **`starred` 读回保真** | PASS |
| 11 | **纯文本编辑后 `starred` 仍为 true**（三态语义） | PASS |
| 12 | bob 看不到 alice 的笔记 | PASS |
| 13 | 未鉴权访问 → 401 | PASS |

**13/13 通过**。

第 3、4 条直接证明跨租户越权已封堵；第 9-11 条证明 `starred` 双向保真且不会被普通编辑清空。

---

## 五、发布门禁与打包

```
npm run check   → Release checks passed (24 allowlisted files).
npm run package → dist/youtube-digest-v1.3.0.zip
                  SHA-256: 463aea2f0f8cccaca04f34dbf4fc49001b44825441161a8d82beb681e4030b7f
```

包内 24 个文件，均为合并后版本（`background.js` 63KB、`sidepanel.js` 107KB、`cloud-sync.js` 30KB）。无 `server/`、无 `node_modules`、无密钥文件、无 `.env`。

---

## 六、最终回归

| 套件 | 用例 | 通过 | 失败 |
|-----|------|------|------|
| 扩展 | 106 | 106 | 0 |
| 后端 | 42 | 42 | 0 |
| 端到端（本次新增） | 13 + 4 | 17 | 0 |

工作区干净，无未提交改动。

---

## 七、未能覆盖的部分（诚实声明）

以下项目本次**没有**验证到，需要人工在真实环境确认：

1. **真实 YouTube 页面交互**：字幕抓取（Supadata）、AI 翻译/概览调用都需要真实 API key 和网络，本环境无凭据
2. **GitHub OAuth 完整流程**：需要真实 OAuth 应用凭据和浏览器交互
3. **真实 Neon Postgres**：`DATABASE_URL` 不可用，后端跑的是 `MemoryStore`。已用 `store-contract.test.js` 对两个 store 跑同一套契约测试来缩小风险，但 fake driver 不执行真实 SQL 语义（索引、约束、并发）
4. **侧边栏真实拖拽与视觉呈现**：DOM 结构已验证，像素级布局未做截图比对
5. **多账号切换的完整往返**：验证了命名空间隔离，未验证真实 OAuth 多次登录登出

**建议的人工验收清单**（按优先级）：
1. Chrome 加载扩展 → 打开 YouTube 视频 → 点 Digest 图标 → 确认字幕出现
2. 搜索框输入关键词 → 确认跳转高亮
3. 语言切换 Original/中文/双语 → 确认界面与内容都变
4. 设置页填 API key → 保存 → 刷新确认持久化
5. GitHub 登录 → 保存笔记 → 打开 dashboard 确认云端有数据且收藏状态一致
6. 登出 → 确认本地笔记仍在、云端不再更新
