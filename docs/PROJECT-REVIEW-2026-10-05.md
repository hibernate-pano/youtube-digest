# 项目深度审查报告

日期：2026-10-05
分支：`feat/new-feature`（合并后 `6c6e08e`）
审查范围：上游合并 + 本地新增功能影响 + 后续方向

---

## 一、上游更新情况与合并结果

### 上游状态

| 项 | 值 |
|----|----|
| 上游仓库 | `zarazhangrui/youtube-digest` |
| Fork 点 | `d03e1f6` Add bilingual Settings interface (#9) |
| 上游最新 | `bb2f7b1` docs(readme): add product demos |
| 新增提交 | 3 个 |
| 距上次同步 | 约 6 周 |

上游这段时间做了两件实事：

1. **`5462cae` 发布字幕搜索 + 全界面翻译（v1.4.0）**
   - 侧边栏内新增字幕搜索框（`transcript-search`），支持上一处/下一处跳转，**不打断视频播放**
   - 语言切换器从「字幕区」上移到「头部」，成为全局开关
   - 新增「界面翻译」能力：Overview、Notes 走独立 prompt（`interfaceBatch`）
   - 修复侧边栏在非 YouTube 标签页不关闭的问题（Chrome 141+ `chrome.sidePanel.close`）
2. **`cfa3569` / `bb2f7b1`** 更新 DeepSeek 价格说明、补充产品演示图

**关键发现**：上游在 `5462cae` 里顺手清理了产品 UI 的 emoji，并新增了一条 `product UI contains no emoji` 测试。本地代码当时有 22 处 emoji，这条测试一旦合入就会直接红。

### 合并结果

采用 **merge + 手工语义融合**（非选择性移植），8 个冲突文件全部解决：

| 文件 | 冲突 | 处置 |
|-----|------|------|
| `manifest.json` | 版本号 1.3.0 vs 1.2.0 | 保留本地 1.3.0（本地更高） |
| `package.json` | 同上 | 保留本地 1.3.0 |
| `background.js` | 导入列表 | **并集**：本地全部 cloud-sync 导入 + 上游 `closePanelForTab` / `updatePanelForTab` |
| `sidepanel.html` | 头部结构 | 本地 sync 按钮**嵌入**上游 `header-actions` 容器内，4 个关键元素各 1 份无重复 |
| `sidepanel.css` | 选择器组 | 上游 `.header-actions` 规则 + 本地 `.sync-btn/.sync-account` 选择器合并 |
| `sidepanel.js` | 笔记渲染 | 融合：`title="Click to edit"` + `renderLocalizedContent(...)` 两者兼得 |
| `tests/release.test.js` | 版本断言 | 保留本地 1.3.0，同时引入上游 emoji 测试 |
| `tests/translation.test.js` | 5 处 | 沙箱统一（同时服务 provider 注册表与 `canonicalYouTubeUrl`）；双方独立测试全部保留；删除 1 个残缺重复副本 |

### 验证（真实跑出来的）

```
扩展测试：82 passed / 0 failed   （合并前 62）
后端测试：18 passed / 0 failed
产品 UI emoji 数：0            （合并前 22）
node --check 全部主文件与测试：通过
```

安全兜底：合并前已建分支 `backup-before-upstream-merge-2026-10-05`（指向 `b414e62`），演练在独立 worktree 完成，主工作区未被污染。

---

## 二、本地新增功能的影响分析

本地 27 个提交新增了 **7325 行**，核心是「BYOK 纯本地」之上叠加了一套自建云同步。

### 架构层面

```
Chrome 扩展 (MV3)
├── BYOK 直连：Supadata（字幕）+ DeepSeek/MiniMax/OpenCode Go（AI）
├── 本地存储：chrome.storage.LOCAL，按账号命名空间隔离
└── 自建同步层：cloud-sync.js (703 行)
        ↓ HTTPS
    Cloudflare Worker @ ytd.panbo.space
    ├── GitHub OAuth web flow（client secret 存 Worker secret）
    ├── JWT 签发/校验
    └── Neon PostgreSQL（notes / vocabulary / reviews）
```

### 做得好的地方

1. **密钥隔离**：三个 AI provider 的 key 各自独立存储，切换 provider 时只有当前 key 出站，有专门测试守着（`active provider sends only only its own key`）
2. **多账号隔离**：本地按账号命名空间存储，登录时迁移登出前的本地笔记，有测试覆盖
3. **同步冲突用 clientId + updatedAt 双键合并**，删除也能传播
4. **测试是真测试**：62 个测试跑真实 sandbox（vm 沙箱 + 真实 fetch 桩），不是只断言文件存在

### 三个真实问题

**1. 前后端能力错配（最需要决策）**

`2e6de5b` / `9d50357` 两个提交把 Words tab 和提取弹窗从 UI 删掉了，但：

- `cloud-sync.js` 仍保留完整词汇/复习链路（`handleExtractVocabulary`、`handleSaveVocabulary`、`handleGetDueReviews`、`handleSubmitReview`）
- `server/src/routes/vocabulary.js`、`reviews.js` 仍在服务
- sidepanel 启动时**仍在调用** `syncVocabulary`（`sidepanel.js:249`）

结果：云端存着词汇和复习数据，界面上找不到入口；每次打开面板还在跑一次无用的词汇同步。三端状态不一致。

**2. Dashboard 视觉与扩展脱节**

`server/dashboard/style.css` 与 `sidepanel.css` 是两套独立的视觉：dashboard 亮色硬编码、无暗色跟随、无 i18n（扩展的 options 页有中英双语，dashboard 只有英文）。同一个用户的两处界面像两个产品。

**3. 硬编码颜色**

`sidepanel.css`（28KB）、`server/dashboard/style.css`（222 行）里大量十六进制色值直接写死，没有 `design-tokens.css`。项目里不存在 Token 文件，上游也没有引入 Token 机制。改主题色要翻多个文件。

---

## 三、质量与安全审查

### 已核实为误报（不作为结论）

审查过程中有两条「P0」我实际复核后不成立：

- **「OAuth CLIENT_ID 硬编码」**：`server/src/index.js:91,102,148` 全部走 `env.GITHUB_CLIENT_ID` / `env.GITHUB_CLIENT_SECRET`，代码里没有任何硬编码 client id
- **「Dashboard XSS」**：`server/dashboard/app.js` 全程用 `createElement` + `textContent` 渲染，两处 `innerHTML` 都只是 `list.innerHTML = ""` 清空容器；`escapeHtml` 已定义但用户数据根本没走拼接

### 真实成立的问题

以下问题我已逐行复核确认成立：

| 级别 | 问题 | 位置 | 说明 |
|-----|------|------|------|
| **P0** | **生产环境词汇保存 100% 失败** | `server/src/db.js:450`（原） | `insert into review_items (user_id, vocabulary_id) values (${rows[0].id}, ${rows[0].id})` —— 两个占位符都绑到了 vocabulary 的 UUID。而 `schema.sql:51` 是 `user_id bigint not null references users(id)`，把 UUID 文本塞进 bigint 列会抛 `invalid input syntax for type bigint`。**每次保存新词都 500，间隔复习功能在生产上完全不可用**。这是全量功能失效，比越权更致命 |
| **P0** | 跨租户越权写入 + 跨账号数据泄露 | `server/src/db.js:469`（原）vs `:206` | `MemoryStore.submitReview` 有 `vocab.userId !== userId` 校验，**`NeonStore.submitReview` 完全没有**。攻击者可对他人 `vocabularyId` 写入复习行；再经 `listDueReviews:455` 的 `join vocabulary v on v.id = ri.vocabulary_id`（**未校验 `v.user_id`**）读到受害者的 `term`/`translation`/`sentence`/`videoTitle`。`schema.sql:59` 的 `unique(user_id, vocabulary_id)` 无法阻止——同一 vocab_id 可出现在不同 user_id 下 |
| **P0** | `starred` 字段同步被静默丢弃 | `cloud-sync.js:177-209`（原） | `grep starred cloud-sync.js` **零命中**，但 `schema.sql:23` 有该字段、Dashboard 在写它。用户在 Dashboard 收藏的笔记，一次全量同步就被抹掉。链路实际有 4 个断点：`validate.js:parseNote` 丢弃 → `createNote` INSERT 列缺失 → `updateNote` RETURNING 漏字段（PATCH 响应谎报 false）→ `cloud-sync.js` 双向缺失 |
| **P0** | token 过期后同步静默失效 | `server/src/index.js:28` + `cloud-sync.js:25,107` | 30 天 TTL、**零 refresh 端点**（`grep -c refresh server/src/index.js` = 0）。`cloudFetch:157` 会抛带 `status: 401` 的 Error，但调用点全部 `.catch(console.warn)` 吞掉。30 天后用户零提示，云端镜像永久停止更新，而用户以为一直在备份 |

**共同根因**：这四条都源于同一个结构缺陷——`server/tests/server.test.js:14` 的 `makeEnv()` 写死 `store: new MemoryStore()`，全文件 `grep NeonStore` **零命中**。生产数据路径零断言，所以「18 个测试全绿」根本证明不了线上正确。这也是为什么修复必须包含给 `NeonStore` 建契约测试，而不只是改那两行代码。

**修复状态**（提交 `aff9896`，已独立复核通过）：

- 4 处缺陷全部修复，并额外发现并修复 `getAllUserData` 的同类 join 漏洞
- `starred` 采用**三态语义**（缺省 = 不改动已存值）。若简单地在客户端无条件发 `starred: false`，扩展每次推文本都会清空用户在 Dashboard 的收藏——把静默丢数据换成静默毁数据
- 新增 33 个用例（后端 18→42，扩展 82→91），同一套契约同时喂 `MemoryStore` 与 `NeonStore`
- **我用变异测试独立验证了测试的有效性**：削弱归属校验 → 2 个用例变红；把 `user_id` 改回 vocabulary id → 1 个用例精确命中。测试不是摆设

其余已确认问题：

| 级别 | 问题 | 位置 | 说明 |
|-----|------|------|------|
| 中 | CI 不跑测试 | `.github/workflows/ci.yml` | 只做 `npm run package`，没有任何 `npm test` 步骤 → 上游那条 emoji 守护测试在 CI 里不会拦住违规 |
| 中 | Dashboard 入口指向不存在的页面 | `server/dashboard/index.html` | 目录只有 `index.html` / `privacy.html` / `app.js` / `style.css`，无 `review.html` → 死链 |
| 中 | Dashboard 无焦点可见性、触摸目标过小 | `server/dashboard/style.css` | `grep -c focus` = 0；`.ghost-btn`/`.del-btn`/`.star-btn` 命中区均 < 44px |
| 中 | 词汇/复习三端错配 | 见上节 | 前端无入口、后端在存、同步还在跑 |
| 低 | 超长文件 | `sidepanel.js` 2225 行、`background.js` 1813 行、`sidepanel.css` 1380 行 | 远超 300 行规范，fork 继承的历史包袱 |
| 低 | 硬编码生产域名 | `settings.js:17`、`server/src/index.js:295` | `https://ytd.panbo.space` 写死，无环境切换 |

**emoji 精确归属**（用 `git diff d03e1f6 6c6e08e` 逐行比对确认）：

- 本地**新增**的只有 3 处，全在 dashboard：`index.html:25`、`index.html:51`、`app.js:87` 的 `★`/`☆`
- `sidepanel.html` / `sidepanel.js` / `content.js` 里的 `📝 ✓ 💡 🔗 ✕` 属**上游继承**，且已被上游 `5462cae` 顺带清理完毕
- 合并后扩展侧产品 UI emoji 计数 = **0**，`server/dashboard/` 剩 3 处

**安全性正面确认**（均已用命令核实，非推断）：

- 路由层按 token 里的 user id 过滤，未发现客户端可传 `user_id` 的越权路径（**数据层断裂已单列为 P0**）
- SQL 全部走 `@neondatabase/serverless` tagged template 参数化，无字符串拼接
- `git ls-files .env` 与 `git ls-files server/.dev.vars` 均为空，`git log --all -- .env server/.dev.vars` 无记录 → **密钥文件从未被提交进仓库**
- JWT 用 WebCrypto HMAC-SHA256 + 逐字节常数时间比较（`jwt.js:71-77`）+ exp 校验
- OAuth 双 `Set-Cookie` 用 `append` 而非 `set`（`index.js:110-118`）；`safeRedirectPath:82-87` 拦掉 `//` 与非白名单字符，开放重定向防护到位
- `server/backups/`（含用户数据的数据库备份）已在忽略列表

---

## 四、后续方向建议

### 立刻做（收尾合并遗留）

1. **跑一次真实端到端**：合并后没在浏览器里实测过。至少验证：字幕搜索、语言切换、GitHub 登录、笔记保存这四条主链路
2. **修 dashboard 死链**：要么补页面，要么先隐藏入口

### 短期（消除技术债）

3. **给词汇/复习功能定性**：这是砍掉还是接回 UI？现在的状态是最坏的——后端在花钱维护、前端看不见。建议二选一：
   - 砍：删 `vocabulary.js` / `reviews.js` 路由 + `cloud-sync.js` 中对应链路 + 数据库表
   - 接回：在 Notes tab 里做一个轻量的「生词本」入口，复用已有后端
4. **CI 加测试步骤**：`npm test` + `server/npm test`，让上游那种「新增测试守护」真的生效
5. **引入 `design-tokens.css`**：把 sidepanel 和 dashboard 的硬编码色值收敛成一套 Token，两套视觉合并

### 中期（架构决策）

6. **分叉策略正式化**：本项目已明确偏离上游定位（上游是「无开发者服务器」，本项目自带 Worker）。建议：
   - 保持 fork，但建立定期同步节奏（每 1-2 个月查一次上游）
   - 改动文件高度重叠（`background.js` / `sidepanel.js`）意味着每次同步都要手工融合，把这个成本写进排期
   - 考虑向上游贡献「多 provider 支持」这类通用改进，维护好关系

7. **`main` 分支落后**：`main` 还停在 `d03e1f6`（fork 点），所有工作都在 `feat/new-feature`。合并稳定后应把 `feat/new-feature` 合回 `main`。

---

## 五、决策记录

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-10-05 | 上游采用 merge 而非 rebase | 本地已推送 27 个提交，rebase 会重写已发布历史 |
| 2026-10-05 | 冲突用语义融合而非取舍 | 8 处冲突全部可双保留，机械取舍会丢掉一方的功能 |
| 2026-10-05 | 版本号保留本地 1.3.0 | 本地版本高于上游 1.2.0，回退会误导用户 |
| 2026-10-05 | 合并前建 `backup-before-upstream-merge-2026-10-05` | 27 个本地提交不可再生，必须有回退点 |
