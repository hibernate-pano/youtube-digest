# ADR-001: 上游集成策略选择（merge / rebase / 长期分叉）

## Status
Accepted（2026-10-05）— 已实际执行，合并提交 `6c6e08e`

## Background

本仓库是 `zarazhangrui/youtube-digest` 的 fork。

| 维度 | 上游 | 本地 fork |
|---|---|---|
| fork 点 | `d03e1f6` | — |
| 当前 HEAD | `bb2f7b1` | `b414e62`（分支 `feat/new-feature`） |
| fork 点后提交数 | 3 | 23 |
| 代码量变化 | +1965 / -312（17 个文件） | +7325 / -225（49 个文件） |

上游 3 个提交的内容：
- `5462cae` feat(release): publish transcript search and universal translation —— 唯一的功能提交，改动 `background.js`(+121)、`sidepanel.js`(+1076)、`sidepanel.html`(+156)、`sidepanel.css`(+313)，并新增 `tests/transcript-search.test.js`、`prompts/translation.md` 段落
- `cfa3569` docs(readme): update DeepSeek pricing and cost estimate —— 纯文档
- `bb2f7b1` docs(readme): add product demos —— 纯文档 + 2 张 PNG

本地新增的核心是 `server/`（Cloudflare Workers + Neon Postgres 后端）与 `cloud-sync.js`（703 行扩展侧同步），这是**上游架构里完全不存在的第二条主线**。

关键的架构事实：上游的定位是「纯本地、BYOK、无开发者服务器」（`README` 自述，API key 只存 `chrome.storage.local`）。本地 fork 引入了一个自托管后端，把「所有数据不出设备」变成了「数据同步到 ytd.panbo.space」。这是产品定位的分歧，不是实现细节的分歧。

## Decision

**采用「选择性同步 + 长期分叉」模型（fork-and-diverge），但用 merge 承载同步动作。**

具体含义：

1. **不做 rebase。** 理由：本地 23 个提交中包含 `server/` 整个后端，rebase 会要求把后端重放到上游每一个新提交之上，等于把上游的每次 release 都变成一次人工仲裁。rebase 还会重写已推送的历史（`origin/feat/new-feature` 已存在），对协作分支是破坏性的。

2. **不做「无脑 merge 后提交」。** 上游的功能提交 `5462cae` 与本地 `sidepanel.js`/`background.js` 改的是同一批文件的上游侧逻辑，而本地在同一批文件里塞进了同步账号、词汇、复习三套新状态。全量 merge 会把这两条主线在同一个文件里物理缠绕，之后每次上游更新都要重新解一次。

3. **每次上游更新走「merge 到集成分支 → 解冲突 → 验证 → 合并回主线」的固定流程**，把冲突消解成本从「每次重新分析」降为「复用已知的冲突处置表」。

4. **把上游功能当作「选择性引入」处理**：只取上游新增的 transcript search / universal translation 能力，不取上游对共享文件的整体重写。

## Consequences

### 正面
- 上游的 transcript search 与 universal translation 两个新能力可以被吸收，不因分叉而丢失
- 本地的后端主线不被上游的文档/release 提交反复干扰
- 冲突处置表可复用，未来上游每次更新只需重跑演练脚本核对
- 不重写历史，`origin/feat/new-feature` 保持可用

### 负面
- 需要维护一份「本地独有 / 上游独有」的清单，随上游演进更新
- 上游若将来也做云同步，会产生真正的路线分歧，此时需要正式决定是否合并产品定位
- 冲突消解是人工的，每次约需半天（8 个文件，其中 2 个需要理解双方语义）

### 中性
- 本项目不再是「可直接贡献回上游」的形态。若要向上游贡献，只能贡献与同步主线无关的部分（例如 provider registry 的能力位设计）

## Alternatives Considered

| 方案 | 是否采纳 | 理由 |
|---|---|---|
| rebase 到 upstream/main | 否 | 23 个提交 × 每次上游更新的人工仲裁；重写已推送历史 |
| 定期全量 merge 并解决冲突 | 部分采纳 | 接受其「动作」，拒绝其「无脑提交」；冲突必须逐个按语义仲裁 |
| 完全脱离上游（不再 fetch） | 否 | 会丢失 transcript search / universal translation 的改进，且失去上游安全修复 |
| 把 `server/` 拆成独立仓库 | 否（但建议后续评估） | 架构上更干净，但当前 `cloud-sync.js` 与 `background.js` 是 `importScripts` 强耦合，拆仓需先解耦；MVP 阶段不做 |

## Implementation

命令序列见 `docs/UPSTREAM-MERGE-PLAN.md`。

## Related ADRs
- ADR-002: 修复 NeonStore.submitReview 的跨租户越权（合并前必须先修）
- ADR-003: 云同步与上游「纯本地」定位的调和边界

## Implementation Record（2026-10-05 实际执行结果）

上述决策已落地，实际情况与计划基本一致，但有两处偏差需要记录：

**执行方式**：在独立 git worktree（`/tmp/ytd-merge-trial`，分支 `merge-trial/tmp`）完成全部冲突解决与验证，验证通过后才 `git merge --ff-only` 落回 `feat/new-feature`。主工作区全程未被污染。合并前已建安全分支 `backup-before-upstream-merge-2026-10-05`（指向 `b414e62`）。

**偏差 1 — 未使用「集成分支 + --no-ff」**：计划是 `integrate/upstream-bb2f7b1` + `git merge --no-ff`。实际因为 worktree 已提供隔离，且最终要落回的是同一个线性分支，改用了 `--ff-only` 快进。代价是**丢失了「合并」这一事实的显式记录**（历史里看不到 merge commit）。若未来需要 bisect 或追溯合并边界，应以 `backup-before-upstream-merge-2026-10-05` 与 `6c6e08e` 的父提交为界。

**偏差 2 — 冲突数比预估少**：计划预估 `tests/translation.test.js` 是最高危（5 个冲突块）。实际处理时发现该文件存在两个额外陷阱：
1. `git checkout --conflict=merge` 会把冲突标记从 `<<<<<<< HEAD` 改写成 `<<<<<<< ours`，导致按 `HEAD`/`upstream/main` 编写的批量替换脚本全部失效
2. 机械「保留双方」拼接会**截断代码块**（冲突块边界不完整时产出语法错误 `Identifier 'result' has already been declared`），必须用 `git show HEAD:<file>` 取回完整原文按测试名边界替换，并删掉 1 个残缺重复副本

**验证结果**（真实执行）：
- 扩展测试 82/82 通过（合并前 62，新增 20）
- 后端测试 18/18 通过
- 产品 UI emoji 计数 22 → 0（上游 `5462cae` 新增了 emoji 禁令测试，本地若不合规会直接红）
- `node --check` 全部主文件与测试文件通过

**后续同步上游时的注意事项**：本机 `git fetch` 在沙箱内会被 SIGTERM 杀死（SSH 卡在 sideband packet），需 `dangerouslyDisableSandbox: true` 且必须用 `--depth=60` 浅拉取；预演冲突优先用 `git merge-tree --write-tree --name-only A B`（Git 2.38+，本机 2.54.0 可用），它无副作用且不会重置已解决文件。
