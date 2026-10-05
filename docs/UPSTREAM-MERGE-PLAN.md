# 上游合并执行方案（fork 点 d03e1f6 → upstream/main bb2f7b1）

> 本文档由架构审查产出。所有冲突结论均来自 `git merge-tree --write-tree` 无副作用演练 +
> 隔离 worktree 真实合并演练，演练环境已清理，主仓库工作区干净（`git status` 为空，HEAD 仍为 `b414e62`）。

---

## 0. 前置事实

```
fork point : d03e1f6  (Add bilingual Settings interface #9)
upstream   : bb2f7b1  (docs(readme): add product demos)
local HEAD : b414e62  (Trust and operations layer: privacy, data portability, monitoring)

upstream 侧新增提交：3 个（1 个功能 + 2 个文档）
  5462cae feat(release): publish transcript search and universal translation
  cfa3569 docs(readme): update DeepSeek pricing and cost estimate
  bb2f7b1 docs(readme): add product demos

上游改动面：17 个文件，+1965 / -312
本地改动面：49 个文件，+7325 / -225
双方都改：10 个文件
```

**注意**：本仓库原先的 `refs/remotes/upstream/main` 停留在 `d03e1f6`（陈旧）。
`git remote show upstream` 提示 `main (local out of date)`。任何合并前必须先 `git fetch upstream main`。

---

## 1. 演练方法（无副作用，优先使用）

```bash
# 方法 A：Git >= 2.38 无副作用演练（推荐，不碰工作区）
git merge-tree --write-tree --name-only HEAD upstream/main
# 输出：<tree-sha> 后跟冲突文件清单；退出码 1 表示有冲突
# 本机 Git 2.54.0，该方法可用

# 方法 B：隔离 worktree 真实演练（需要看冲突内容时用）
git worktree add --detach /tmp/ytd-trial HEAD
git -C /tmp/ytd-trial merge --no-commit --no-ff upstream/main
git -C /tmp/ytd-trial status --short          # 看冲突清单
# 逐个文件提取冲突块
awk '/^<<<<<<</{c=1} c{print NR": "$0} /^>>>>>>>/{if(c){c=0}}' /tmp/ytd-trial/sidepanel.js

# 清理（务必执行）
git worktree remove /tmp/ytd-trial --force && git worktree prune
test -f .git/MERGE_HEAD && echo "有残留" || echo "干净"
```

**绝对不要**在主工作区直接 `git merge upstream/main` 试错——一旦解错冲突，
`git merge --abort` 未必能还原到等价状态（尤其当工作区原本不干净时）。

---

## 2. 冲突处置表

演练实测结果：**8 个内容冲突 + 2 个自动合并 + 0 个 delete-modify**。

| # | 文件 | 冲突类型 | 冲突原因 | 建议处置 |
|---|---|---|---|---|
| 1 | `manifest.json:4-8` | 内容冲突（1 处） | 版本号：本地 `1.3.0` vs 上游 `1.2.0`。上游版本号**回退**（本地已发过 1.3.0） | **本地保留** `1.3.0`。上游的 1.2.0 是它自己的发布序列，与本 fork 无关 |
| 2 | `package.json:3-7` | 内容冲突（1 处） | 同上，版本号 | **本地保留** `1.3.0` |
| 3 | `tests/release.test.js:22-26` | 内容冲突（1 处） | 断言 `manifest.version === "1.2.0"` vs 本地 `"1.3.0"` | **本地保留**，与 #1 保持一致。改版本号时这两处必须同步改 |
| 4 | `background.js:1865-1892` | 内容冲突（1 处），**互补型** | 双方都在同一个 `globalThis.__ytdTestHooks` 对象字面量尾部追加导出：本地追加 23 个同步/词汇/复习钩子，上游追加 `closePanelForTab` / `updatePanelForTab` | **手工融合：两边都保留**。这是最容易解错的一处——若直接 `ours` 会静默丢掉上游的 `updatePanelForTab`，导致 transcript search 的面板刷新在测试里不被覆盖；若直接 `theirs` 会让本地 23 个同步钩子全部失去测试入口 |
| 5 | `sidepanel.js:2189-2193` | 内容冲突（1 处），**语义冲突** | 本地：`<div class="note-text" title="Click to edit">"${escapeHtml(note.text)}"</div>`<br>上游：`<div class="note-text">${renderLocalizedContent(note.text, "notes", translationId)}</div>` | **采纳上游**（并保留本地的 `title="Click to edit"` 与引号样式）。已核实：上游的三个辅助函数 `renderLocalizedContent`(合并后 786)、`getNoteTranslationId`(926)、`getLocalizedPlainText`(804) 都由自动合并干净地带入，`translationId` 在 2181 行已由上游自动合入定义。**若取本地侧，笔记将永远不会被翻译**，且 `translationId` 变成未使用变量 |
| 6 | `sidepanel.html:20-88` | 内容冲突（1 处），**互补型** | 本地：sign-in 按钮 + sync-account + settings 按钮（平铺）<br>上游：`.header-actions` 容器，内含 settings 按钮 + transcript 语言切换控件（原/中/双语 + spinner） | **手工融合：把本地三个按钮放进上游的 `.header-actions` 容器内，并保留上游的 `transcriptModeControl` + `langSpinner`**。直接 `ours` 会静默丢掉 transcript 语言切换入口（`#transcriptModeControl` 不存在 → 上游 JS 拿不到节点 → 语言切换功能静默失效） |
| 7 | `sidepanel.css:135-149` | 内容冲突（1 处），**互补型** | 本地：`.settings-btn, .sync-btn, .sync-account { ... }` 选择器组<br>上游：`.header-actions { display:flex; flex-direction:column; ... }` + 单独的 `.settings-btn {` | **手工融合**：新增 `.header-actions` 规则块，并把本地的 `.sync-btn` / `.sync-account` 并入选择器组；上游后续的 `.settings-btn` 规则体保留。直接 `ours` 会让 `.header-actions` 无样式 → header 布局塌陷；直接 `theirs` 会让 sync 按钮失去样式 |
| 8 | `tests/translation.test.js:109-116` | 内容冲突（1 处），**互补型** | 本地：`storageMock` 注入参数<br>上游：`sidePanel = { setPanelBehavior(){}, setOptions }` mock | **两边都保留**（同一对象的不同属性） |
| 9 | `tests/translation.test.js:134-163` | 内容冲突（1 处），**互斥型** | 本地 storage mock 走 `storageMock` 委托，且 `set`/`remove` 在缺 mock 时**抛错**（防止测试静默通过）<br>上游 storage mock 走内存 `localStorage` 对象 | **保留本地的严格版**，另在上游侧补 `canonicalYouTubeUrl` 等新增依赖。理由：上游版 `get` 返回 `{...localStorage}` 会让「设置未写入」的断言静默通过——这正是生成式代码最典型的「沉默逻辑错误」。若采纳上游，本地关于 API key 隔离的断言会失去防护 |
| 10 | `tests/translation.test.js:183-229` | 内容冲突（1 处），**契约分叉** | 本地 `chatCompletionsUrl: (providerId) => \`${baseUrl[providerId]}/chat/completions\``（按 provider 取）<br>上游 `chatCompletionsUrl: (baseUrl) => \`${baseUrl}/chat/completions\``（接收 baseUrl）+ 新增 `canonicalYouTubeUrl` | **保留本地签名 + 补上游的 `canonicalYouTubeUrl`**。已核实 `settings.js:116` 本地签名是 `chatCompletionsUrl(providerId)`，且 `background.js:148` 调用 `YTD_SETTINGS.chatCompletionsUrl(settings.provider)`。若采纳上游的 mock 签名，测试会与 `settings.js` 契约脱节 |
| 11 | `tests/translation.test.js:782-903` | 内容冲突（2 处），**互斥型测试** | 本地两个测试：`active provider sends only its own key and skips unsupported fields`（验证 API key 不串号）、`provider rejecting response_format with HTTP 400 retries once without it`<br>上游一个测试：`interface batches use the dedicated Overview and Notes translation prompt` | **三个测试全部保留**。本地第一个测试是防止「DeepSeek key 发到 MiniMax」的安全回归，必须活下来；上游测试覆盖新的批量翻译提示词路径。已核实合并后 `background.js` 同时具备 `handleTranslateContent`(1739) 与 `callAiTranslation`(1828)，三个测试都有对应实现 |
| 12 | `README.md` | **自动合并成功** | 双方都改（本地加同步章节，上游改定价+加截图） | 接受自动合并结果，但**必须人工复核**同步章节是否仍与实际代码一致 |
| 13 | `README.zh-CN.md` | **自动合并成功** | 同上 | 同上 |

### 自动合并但**必须人工复核**的语义冲突（最危险的一类）

| 文件 | 现象 | 为什么危险 | 期望 |
|---|---|---|---|
| `background.js` | 自动合并后 `chatCompletionsUrl(settings.provider)`（本地调用点，148 行）与 `handleTranslateContent`（上游函数，1739 行）、`YTD_SETTINGS.getProvider(...)`（46/51/1117 行）共存 | 三方语义融合无冲突标记。**已核实**：合并后 `settings.js` 保持本地签名，调用点与定义一致，当前是自洽的。但这类「双方都改同一函数的不同区段」是最容易在下次上游更新时静默断裂的地方 | 合并后必须跑 `npm test` 全绿 + 手工验证多 provider 切换 |
| `background.js` | `YTD_SETTINGS.SERVER_BASE_URL` 相关代码（本地）与上游新增的 transcript 状态（`transcriptModeControl`）共存 | 上游新增的 DOM 节点依赖 `sidepanel.html`，若 #6 解错则上游 JS 拿到 `null` 节点 | 见 #6 |

---

## 3. 上游新增、需一并引入的文件（无冲突）

```
A  YouTube Digest demo.png               (2.4 MB 截图)
A  YouTube Digest demo bilingual.png     (2.5 MB 截图)
A  tests/transcript-search.test.js      (108 行，transcript search 回归)
M  content.js                            (14 行)
M  prompts/translation.md               (+19 行，Overview/Notes 专用翻译提示词)
M  tests/digest-button.test.js           (1 行)
M  tests/transcript-selection.test.js   (90 行)
```

注意：两张 PNG 共约 5 MB。若不想进仓库历史，可保留 README 引用但不提交图片，
或用 Git LFS。README 引用了这两张图，删掉会产生死链。

---

## 4. 执行命令序列

```bash
cd /Users/panbo/Code/Demos/youtube-digest

# 0) 保险：确认工作区干净
git status --porcelain            # 必须为空

# 1) 打标签（比分支更安全，不会误 push）
git tag backup/pre-upstream-merge-2026-10-05
git push origin backup/pre-upstream-merge-2026-10-05

# 2) 拉取上游（refs 当前是陈旧的 d03e1f6）
git fetch upstream main
git log --oneline -1 upstream/main        # 期望 bb2f7b1

# 3) 建集成分支
git switch -c integrate/upstream-bb2f7b1

# 4) 无副作用预演，确认冲突清单与本文档一致
git merge-tree --write-tree --name-only HEAD upstream/main

# 5) 正式合并（--no-commit 便于逐个解冲突）
git merge --no-commit --no-ff upstream/main

# 6) 逐个解冲突（按第 2 节处置表）
#    #1 #2 #3  -> git checkout --ours  manifest.json package.json tests/release.test.js
#    #4       -> 手工融合，两边都保留
#    #5       -> 采纳上游，保留本地 title 属性
#    #6 #7    -> 手工融合，容器 + 控件都保留
#    #8 #9 #10 #11 -> 手工融合，按处置表

git add -A
git status                       # 确认无 <<<<<<< 残留

# 7) 验证门禁（顺序不可跳过）
grep -rn '<<<<<<<\|>>>>>>>' --include='*.js' --include='*.json' --include='*.css' --include='*.html' . \
  && echo "还有冲突残留，停" || echo "无冲突残留"

npm test                                  # 扩展侧全量测试
node --test server/tests/*.test.js        # 服务端全量测试（cd server）

# 8) 提交
git commit -m "Merge upstream/main (bb2f7b1): transcript search + universal translation

手工融合点见 docs/UPSTREAM-MERGE-PLAN.md 第 2 节冲突处置表。
保留本地 provider registry 契约签名（settings.js:116）。

Co-Authored-By: <上游署名>"

# 9) 合并回主线
git switch feat/new-feature
git merge --no-ff integrate/upstream-bb2f7b1
npm test                                  # 再跑一次

# 10) 清理
git branch -d integrate/upstream-bb2f7b1
git push origin feat/new-feature
```

**回滚**：任何一步出问题 → `git merge --abort`（合并未提交时）或
`git reset --hard backup/pre-upstream-merge-2026-10-05`（已提交时）。

---

## 5. 合并后必须补的上游能力（本 fork 尚未拥有）

上游 `5462cae` 引入的 transcript search 在本地 sidepanel 里**没有 UI 入口**
（合并后 `sidepanel.html` 的 `#transcriptModeControl` 是上游带来的，本地原本没有）。
合并完成后需确认：

- [ ] transcript 搜索框已渲染且可输入
- [ ] 语言切换（Original / 中文 / 双语）三个按钮可点击，spinner 出现
- [ ] 笔记内容随语言切换实时更新（依赖 #5 取上游）
- [ ] 概览页的章节标题 / 摘要 / 引用也走 `renderLocalizedContent`

---

## 6. 合并前必须先修的阻断项

**见架构审查报告 B-1（`server/src/db.js:469` 跨租户越权 + 数据泄露）。**
该缺陷当前**只在生产路径（NeonStore）存在**，测试用的 MemoryStore 是正确的，
所以测试全绿也发现不了。建议在合并前或至少合并后立刻修，
否则同步功能一旦对外开放就是可被利用的越权读。

---

## 7. 长期分叉说明文档大纲（`FORK-NOTES.md`，建议置于仓库根）

```
# YouTube Digest — Fork 说明

## 1. 我们是谁
   - fork 自 zarazhangrui/youtube-digest，fork 点 d03e1f6
   - 本分支与上游的差异范围：见 git diff upstream/main...HEAD --stat

## 2. 与上游的核心分歧：产品定位
   上游：纯本地、BYOK、数据不出设备、无开发者服务器
   本项目：本地优先 + 可选云同步（GitHub OAuth + 自托管 Worker）
   → 详见 ADR-003

## 3. 本项目独有（上游没有）
   - server/：Cloudflare Workers + Neon Postgres 后端
   - cloud-sync.js：扩展侧双向同步
   - 词汇提取 + 间隔复习（SM-2）
   - Web Dashboard（server/dashboard/）
   - 隐私与数据可移植性（PRIVACY.md、/api/export、/api/account）

## 4. 上游有而本项目尚未吸收
   - transcript search（5462cae）→ 合并后已引入，需验证
   - universal translation（5462cae）→ 合并后已引入
   - 三方 provider registry 的能力位设计 → 我们已独立实现同构版本

## 5. 如何向上游贡献
   可以贡献（与同步主线无关）：
   - provider registry 的能力位模式（usesThinkingDisabled / supportsJsonMode）
   - 测试中「缺 mock 即抛错」的严格 storage mock
   不建议贡献（会引入我们不需要的耦合）：
   - 任何依赖 SERVER_BASE_URL 的改动
   - server/ 下的任何文件

## 6. 如何跟进上游
   见 docs/UPSTREAM-MERGE-PLAN.md

## 7. 安全报告
   见 SECURITY.md
```
