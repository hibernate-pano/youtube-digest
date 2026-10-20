# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

把每个 YouTube 视频变成一份可以深入学习的资料。YouTube Digest 把字幕、双语翻译、AI 摘要、内容讲解、时间戳笔记和生词本放进同一个 Chrome 侧边栏，让你可以持续学习视频中的知识和语言，同时不丢失原视频上下文。

- 把零碎字幕变成清晰、可搜索的学习资料。
- 查看原文、简体中文翻译，或中英双语对照字幕来学习语言。
- 通过 AI 摘要、章节、重点引用和选中文本讲解建立系统理解。
- 点击字幕、摘要或笔记中的时间戳，快速跳转到对应位置。
- 保存自动润色的时间戳笔记，方便之后复习。
- 从字幕里挑出生词存进词汇本，按计划复习已经学过的词。
- 读过的视频会留在一个 30 天的资料库里，再打开时不再花字幕额度。
- 同步服务自带网页控制台，在任意设备上查看笔记、收藏和词汇。
- 使用自己的 API Key，数据保存在本地 Chrome 中，不包含分析统计或行为追踪。

YouTube Digest 是一个需要自行提供 API Key 的开源项目，通过 GitHub 安装。目前没有上架 Chrome 应用商店，也不赠送 API 额度。本扩展没有分析统计，也没有行为追踪。如果使用 GitHub 登录，可选的同步功能会把已保存的笔记和生词镜像到本项目自建的同步服务 `https://ytd.panbo.space`；不登录时，笔记和生词数据不会离开你的设备。

点击查看演示和教学视频（小白友好）：[https://www.bilibili.com/video/BV1dnuq6dEak/](https://www.bilibili.com/video/BV1dnuq6dEak/)

![YouTube Digest 双语演示](YouTube%20Digest%20demo%20bilingual.jpg)

上面这张图的绝对地址，用于本仓库之外的地方。文件名里有空格，所以要写成 `%20`：`https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/YouTube%20Digest%20demo%20bilingual.jpg`

## v1.7.3 更新

- 还没开始播放的视频，不再被说成没有字幕。YouTube 是等视频开始播放时才向页面要字幕的，所以一个还没播的视频，页面手上根本没有东西可读。现在扩展会等视频开始，照实告诉你它还没开始，并且不会为一份页面马上就要免费给你的字幕花掉一个额度。
- 广告挡在前面时不再花额度。广告自己也是一个视频，广告在放的时候页面要的是广告的字幕。现在扩展会等真正的视频接手播放器，而不是在广告还没放完时就放弃。

## v1.7.2 更新

- 面板不再说一个明明有字幕的视频没有字幕了。在 YouTube 里点另一个视频，以前扩展问得太早，那一刻页面还停在上一个视频，于是被算成"这个视频没有字幕"。现在它会等页面跟上来；页面还没准备好时，它会照实说页面没准备好，并给你一个真的会重试的按钮。
- 要现场做的字幕现在也能拿到了。一个视频的字幕第一次被要时，YouTube 正在写它，所以那一次特别慢；扩展会让页面去取，并且等它写完。
- 慢不再被当成失败，你自己关掉的字幕也还是关着的。

## v1.7.1 更新

- 字幕又读得出来了。YouTube 播放列表里那条地址是个模板，而 YouTube 对模板请求会返回空内容，所以免费那条路以前一条字幕都拿不到。扩展现在去要页面播放器真正用过的那条地址，那条才带得动字幕。
- OpenCode Go 能用了。以前每一次请求都在到达模型之前被挡回来，因为那个网关按会话 ID 路由，而扩展没带。
- 失败都用你的语言说。以前屏幕上会出现一句由后台用它的语言写成的句子；现在每一句都由面板自己说，并且会说是哪个服务商的 Key 没了。
- 每个出错页面都只有一个按钮，而且它做的就是它写的那个事。看不懂的失败会用一次真的重新查询再试一遍。

## v1.7.0 更新

- 字幕直接从你正在看的那个页面里读出来，所以大多数视频不花钱了。Supadata Key 现在是可选的，只有页面读不到的时候才会用到它。
- 超过一小时的视频会显示真实时间。第 90 分钟以前和第 150 分钟都写成"90:00"，现在写成"1:30:00"，点下去也真的跳到那个位置。
- 翻译失败会自己重试。网络抖一下，不会有一整段字幕永远停在原文。
- 没有字幕的视频只花一个额度，而不是每打开一次花一个。扩展会记一天，"重试"按钮每次都真的会重新查一次。
- 长视频滚动更顺了，因为扩展不再每秒向浏览器问同一个问题两遍。

## v1.6.0 更新

- 失败看得见了。哪里出了问题，面板会用一句人话写在屏幕上，不只是读屏用户听得到。存不下来的笔记会说出原因，而不是按钮悄悄变回原样。
- 纯键盘也能用。Shift 加方向键选字幕，那排「解释 / 笔记 / 生词」按钮就会弹出来。
- 弹窗把焦点圈在里面，关掉之后焦点还给打开它的按钮。
- 面板和设置页都尊重系统里的「减少动效」。
- 请求有截止时间了。字幕服务或同步服务不回答时，面板不会一直转圈；服务慢也不会被当成登录过期。
- 设备存储写满时不再悄悄丢笔记。扩展会申请无限制存储，优先丢掉还能再取回来的缓存来腾地方，并且告诉你扔了什么。
- 设置页里可以「删除我的账号」：账号、笔记、生词和复习进度都会从同步服务里删掉，本机这一份也一起删。
- 登录认发起它的那台设备。从别的浏览器复制过来的 token 会被拒绝，一条来路不明的链接切不到别人的账号。
- 复习区移到了生词表上面，因为它才是真正在等你去做的那部分。
- 资料库用你的语言说「刚刚」「3 分钟前」，不再显示英文缩写。


- 侧边栏现在有五个标签页：Transcript、Summary、Notes、Words 和 Library。原来的 Overview 变成了 Summary，而且它现在真的会写一份视频摘要，不只是列章节。
- 可以从字幕里挑出生词存进词汇本：选中一个词直接保存，或者让 AI 从你选中的那句话里挑出值得学的词。每个词都记着意思、出处句子和出现的时间点。
- 生词可以按计划复习，用的是网页控制台同样的四个评分。
- 资料库会保留你读过的视频 30 天，再打开时不再花字幕额度。
- 搜索字幕中的单词或短语，并依次查看所有匹配位置。
- 在 Transcript、Summary 和 Notes 中共用 Original、中文和双语设置。新视频默认保持 Original，不会自动消耗翻译 token。
- 只翻译当前可见的 Summary 和 Notes 内容，并通过小批次渐进显示和缓存结果。
- 选中字幕后，可以直接讲解内容或保存带时间戳的笔记。
- 页面跳转后保留字幕阅读位置，并在离开 YouTube 视频页面时自动关闭侧边栏。
- 使用 GitHub 登录，把笔记和生词备份到本项目的同步服务；在任意设备上用同一个 GitHub 账户登录即可看到它们。
- 点击笔记正文可以直接修改，改动会保存到本地并同步。
- GitHub 登录过期时，侧边栏会显示“Sync expired”提示，重新登录即可恢复备份。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要会使用命令行。把下面这段话发送给你的编程 Agent：

> 请把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome“加载已解压的扩展程序”使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。https://github.com/hibernate-pano/youtube-digest

你的 Agent 应该帮你：

1. 先询问你想把项目长期保存在哪里，再下载或克隆到那里，并告诉你准确的完整路径。如果你需要建议，可以推荐 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`。
2. 打开下方 Supadata 官方页面和你所选 AI 服务的官方页面，指导你创建自己的账号。
3. 指导你在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
4. 告诉你应该在扩展的“设置”页面哪个位置填写 API Key。
5. 打开一个带字幕的 YouTube 视频，确认字幕和翻译功能可以使用。

安装后请让这个文件夹留在原位。如果移动或删除它，Chrome 中加载的本地扩展会失效，需要从新的长期存放位置重新加载。

不要把 API Key 发送到 AI 对话、源代码、截图或公开消息中。请你自己在 YouTube Digest 的设置页面直接填写。编程 Agent 可以告诉你填写位置，但不需要看到 Key。

## 手动安装

如果你想自己操作：

1. 打开 [github.com/hibernate-pano/youtube-digest](https://github.com/hibernate-pano/youtube-digest)。
2. 点击 **Code**，再选择 **Download ZIP**。
3. 选择一个长期保留的文件夹，并把项目解压到这里。可选建议是 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`。你也可以使用其他文件夹。
4. 在 Chrome 地址栏打开 `chrome://extensions`。
5. 打开右上角的“开发者模式”。
6. 点击“加载已解压的扩展程序”。
7. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
8. 如果需要，可以在 Chrome 扩展菜单中固定 YouTube Digest。

这是一个本地加载的扩展，不会自动更新。下载新版或让 Agent 修改代码后，请在 `chrome://extensions` 中找到 YouTube Digest 并点击“重新加载”，然后刷新已经打开的 YouTube 页面。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

## 设置 API Key

YouTube Digest 需要一个你所选 AI 服务的 Key，另外可选配一个 Supadata Key：

1. **AI 服务 Key**，从 DeepSeek、MiniMax（国内版）或 OpenCode Go 中选择，用于生成摘要、讲解内容、翻译和自动润色笔记。这个是必需的。
2. **Supadata API Key**，只作为兜底。字幕直接从你已经打开的 YouTube 页面里读，所以大多数视频不需要它，也不消耗任何 Supadata 额度。如果你希望在本地读不到字幕的视频上还有一条退路，就配上它。

### 获取 Supadata API Key（可选）

1. 打开 Supadata 官方[注册页面](https://dash.supadata.ai/auth/sign-up)。
2. 创建账号并完成简短的新手引导。
3. Supadata 会在新手引导过程中自动生成 API Key。
4. 之后可以随时打开 [Supadata 控制台](https://dash.supadata.ai/)查找或管理 Key。
5. 复制 Key，并粘贴到 YouTube Digest 设置中的 **Supadata API key**。

如果页面流程发生变化，请查看 [Supadata 官方文档](https://docs.supadata.ai/)。

### 获取 DeepSeek API Key

1. 打开 DeepSeek 官方 [API Keys 页面](https://platform.deepseek.com/api_keys)。
2. 按照提示登录，或创建 DeepSeek 开放平台账号。
3. 点击 **Create new API key**，填写容易识别的名称，例如 `YouTube Digest`，然后创建 Key。
4. 立即复制 Key。完整 Key 可能只会显示一次。
5. 把 Key 粘贴到 YouTube Digest 设置中的 **DeepSeek API key**。
6. 如果 DeepSeek 提示余额不足，请在 DeepSeek 开放平台账号中充值后再试。

当前账号和接口说明请查看 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)。

### 获取 MiniMax API Key（国内版）

1. 打开 [MiniMax 开放平台](https://platform.minimaxi.com)，登录或注册账号。
2. 在账号设置中创建 API Key。
3. 复制 Key，粘贴到 YouTube Digest 设置中的 **MiniMax API key**。

YouTube Digest 通过 MiniMax 的 OpenAI 兼容接口使用 MiniMax M3 模型。

### 获取 OpenCode Go API Key

1. 打开 [opencode.ai/auth](https://opencode.ai/auth) 并登录。
2. 订阅 OpenCode Go，然后复制你的 API Key。
3. 粘贴到 YouTube Digest 设置中的 **OpenCode Go API key**。

OpenCode Go 是包含 DeepSeek V4 Flash 等多种开源编程模型的低价订阅服务。YouTube Digest 使用其中的 DeepSeek V4 Flash 模型。

在侧边栏中打开 **Settings**。你也可以在 `chrome://extensions` 的 YouTube Digest 卡片中打开扩展选项。Key 只能粘贴到这些设置输入框中。不要把 Key 发送到 AI 对话、项目文件、截图或公开消息中。

发布版本支持三个 AI 服务，接口地址和模型在设置中固定，不需要手动配置：

```text
DeepSeek:    Base URL https://api.deepseek.com          Model deepseek-v4-flash
MiniMax:     Base URL https://api.minimaxi.com/v1       Model MiniMax-M3
OpenCode Go: Base URL https://opencode.ai/zen/go/v1     Model deepseek-v4-flash
```

三个服务的 Key 可以同时保存，随时在设置中切换使用哪个服务，只有当前选中的服务会收到请求。DeepSeek 请求使用非思考模式以获得更快、更稳定的交互；其他服务使用各自的请求行为。如果想使用列表之外的服务或模型，请在设置中复制安全的自定义 prompt，让编程 Agent 修改你自己的本地副本。不要把任何 API Key 放进 prompt 或对话。

API Key 和设置保存在你设备上的 Chrome 扩展本地存储中。发布包不会包含或使用 `config.js`。

## 可选的 GitHub 同步

在设置页或侧边栏的 **Sign in** 按钮使用 GitHub 登录，可以把你的笔记和生词备份起来。你的笔记和生词保存在本项目自建的数据库中，地址是 `https://ytd.panbo.space`（运行在 Cloudflare Workers 上，数据库使用 Neon PostgreSQL），并通过你的 GitHub 账户 id 关联。数据不会写入你的 GitHub 账户，也不会创建任何 GitHub 仓库或 gist。每个账户的数据在服务端相互隔离：扩展按账户命名空间存储，服务端按已验证的令牌限定所有查询，换一个账户登录只会看到该账户自己的数据。同步是可选的：不登录时，所有数据仍只保存在本机，与之前完全一致；AI 和字幕请求也完全不经过同步服务。登录后，新保存的笔记和生词会自动镜像到云端（幂等，取最新编辑），在任意设备上用同一 GitHub 账户登录即可看到它们。

### 网页控制台

同一个服务还提供了一个小网页版，地址是 `https://ytd.panbo.space`。用 GitHub 登录后，不用装扩展，在任意设备的浏览器标签页里就能看到同一份数据：

- **Notes（笔记）**：你保存过的全部笔记，附带来源视频和跳转链接。
- **Favorites（收藏）**：你在侧边栏里标星的笔记。
- **Vocabulary（词汇）**：你收集过的单词，附带释义和原句。
- **Review（复习）**：这些单词的间隔复习队列，复习计划由服务端排定。
- **Export my data（导出数据）**：导出服务端为你账户保存的全部内容。

网页版刻意做成「以读为主」：它负责**看**和**复习**你看视频时收集的东西，侧边栏负责**收集**。两者连的是同一个数据库，账户隔离规则完全一致。

## 使用 YouTube Digest

1. 打开一个有字幕的普通 YouTube 视频页面。
2. 点击 YouTube Digest 扩展图标，打开侧边栏。
3. 阅读带时间戳的字幕，或选择 **Original**、**中文**、**双语**。
4. 在字幕中搜索单词或短语，并逐个查看匹配位置。
5. 打开 **Summary**，查看 AI 写的摘要、章节和重点引用。标签页会先告诉你这一次调用要花多少钱，再让你决定要不要付。
6. 选中字幕，获取 AI 内容讲解，或直接保存为笔记。
7. 从播放器或重点引用中保存笔记，之后可以在 **Notes** 中查看。点击笔记正文可以修改内容。
8. 在字幕中选中一个词，点 **Word** 存进 **Words** 词汇本；也可以打开 **Words**，让 AI 从你选中的那句话里挑出值得学的词。

## 当前支持范围

- Chrome 116 或更高版本。
- 标准的 `youtube.com/watch` 视频页面。
- 原生字幕。YouTube Digest 直接从你已经打开的 YouTube 页面里读字幕，不消耗任何字幕额度；只有在这样读不到的时候，才用 Supadata 兜底。YouTube Digest 会优先请求英文字幕，也可能显示其他可用的原生语言。
- 原文、简体中文和双语对照字幕，Transcript、Summary 和 Notes 共用同一个内容语言设置。
- 在字幕中搜索单词或短语，并用上一个、下一个按钮逐个查看匹配位置。
- AI 摘要、章节、重点引用、选中文本讲解、翻译和自动润色笔记。
- 带时间戳的笔记，可以从播放器、重点引用或选中的字幕保存，之后可以点击正文修改，也可以一键复制笔记正文或带时间戳的链接。
- 词汇本：从字幕里收下生词，记着释义、原句和出现的时间点，之后可以按计划复习。
- 资料库：保留你读过的视频 30 天，再打开时不再花字幕额度。
- 本地笔记、生词，以及最近字幕、摘要和翻译的本地缓存。
- 可选的 GitHub 同步：把已保存的笔记和生词同步到本项目的同步服务，每个 GitHub 账户的数据相互隔离。
- 发布版本的所有 AI 功能都使用 DeepSeek V4 Flash、MiniMax M3 或 OpenCode Go 的 DeepSeek V4 Flash。其他服务需要修改本地代码，不属于发布版本的支持范围。

Shorts、直播、私密视频、受访问限制的视频，以及没有原生字幕的视频可能无法使用。目前没有测试 Firefox、Safari、移动浏览器或其他 Chromium 浏览器。

YouTube Digest 强制使用 Supadata 的 `mode=native`，不会在没有原生字幕时请求 AI 生成转录，也不会在本地转录音频。

## 字幕成本

**大多数视频不花钱。** 字幕直接从你已经打开的 YouTube 页面里读，用的是页面本来就带着的字幕轨道。不用 API Key，不消耗额度，字幕文字也不会离开你的浏览器。

**Supadata 是兜底。** 只有在页面读不到的时候才会用到：YouTube 改了播放器暴露字幕的方式、标签页已经关了、或者这个视频压根没有字幕轨道。

截至 2026 年 10 月 20 日，[Supadata 价格页面](https://supadata.ai/pricing)显示免费版每月提供 **100 credits**，不需要信用卡，未使用的额度不会结转。价格可能变化，使用前请查看最新页面。

[Supadata 字幕接口文档](https://docs.supadata.ai/get-transcript)说明了不同模式的计费方式：

- 获取一次原生字幕消耗 **1 credit**，与视频时长无关。
- AI 生成字幕每分钟消耗 **2 credits**。YouTube Digest 不会使用这条路径，因为它强制使用 `mode=native`。
- 如果没有可用原生字幕，仍会消耗 **1 credit**。Supadata 此时返回 HTTP `206`，扩展会显示“No native subtitle track is available for this video.”，但额度已经消耗。

按照当前只获取原生字幕的方式，如果每次请求都成功，免费版每月大约可以兜底 100 个视频。查出来确实没有原生字幕的视频会被记一天，所以它只花一个额度，而不是每打开一次花一个。「重试」每次都会真的重新查一次，重新查是要花额度的。

DeepSeek 的额度与 Supadata 分开计算。YouTube Digest 不收款，也不转售 API 服务。建议为两个账号设置消费上限并定期查看用量。

## DeepSeek V4 Flash 价格

截至 2026 年 10 月 20 日，DeepSeek 官方[价格页面](https://api-docs.deepseek.com/quick_start/pricing/)列出的每 100 万 token 美元价格如下：

| Token 类型 | 非高峰 | 高峰 |
| --- | ---: | ---: |
| 缓存命中输入 | $0.003 | $0.006 |
| 缓存未命中输入 | $0.15 | $0.30 |
| 输出 | $0.60 | $1.20 |

高峰时段为周一至周五 UTC 01:00–04:00 和 06:00–10:00，中国法定节假日除外。其他时间使用非高峰价格，包括周末和中国法定节假日。

扩展发送的模型名是 `deepseek-v4-flash`。DeepSeek 官方页面说明这个旧名称仍然可用，但它对应的模型已经退役，请求由更新的 Flash 模型处理，并按上表的 Flash 价格计费。

一个实测的 20 分钟英文视频使用约 **32,600 个输入 token**，并在 43 个小批次中产生约 **3,500 到 4,500 个输出 token**。按当前价格，完整翻译该视频的费用约为：

- **非高峰：$0.002 到 $0.008 USD**。
- **高峰：$0.004 到 $0.015 USD**。

低值假设大部分重复输入命中 DeepSeek 缓存，高值假设输入未命中缓存。翻译按需执行并复用缓存，只翻译部分视频时费用会更低。使用前请查看官方页面确认最新价格。

## 用编程 Agent 改造成自己的版本

这是一个个人 Remix 项目，基于上游 [github.com/zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest)，上游版本不包含 GitHub 同步和网页版控制台。不接受上游 Issue 或 Pull Request。如果功能出错，或者你想增加新功能，请下载或 Fork 自己的副本，再让你的编程 Agent 帮你修复、改造和个性化。

YouTube Digest 使用原生 HTML、CSS 和 JavaScript，没有构建步骤，很适合用编程 Agent 做个人项目。你可以尝试：

- 增加更多翻译语言，并让每个人选择自己的学习语言。
- 为课程、访谈、教程、测评或研究视频增加自定义总结模板。
- 把词汇本导出到 Markdown、CSV、Anki 或其他学习工具。
- 增加个人主题筛选，只突出与你目标相关的章节。
- 增加本地模型选项，获得不同的隐私和成本方案。
- 改善键盘操作、字体大小和高对比度等无障碍体验。

请让 Agent 保留用户自带 API Key 的模式，不要把秘密写入源代码，并运行下方检查。分享自己的版本前，也要在真实视频上测试。

如果想使用其他 AI 服务或模型，请先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 YouTube Digest 项目文件夹。然后打开 YouTube Digest 设置并点击 **Copy customization prompt**。发送前替换 `[PROVIDER]` 和 `[MODEL]`，但不要加入任何 API Key。Agent 完成本地代码修改后，请你自己在它指出的设置位置填写 Key。

## 隐私和数据流向

YouTube Digest 会直接从扩展向服务商发送请求：

1. 字幕直接从你已经打开的 YouTube 页面里读出来。这条路上没有数据离开你的浏览器。
2. 只有读不到的时候，才把标准化的 YouTube 视频地址发送给 Supadata，用于获取原生字幕。
3. 当你使用 AI 功能时，把字幕和相关视频信息发送给你选择的 AI 服务。
4. 翻译或讲解等功能只发送当前需要的内容，例如选中的文本和上下文，或少量字幕分段。
5. API Key、设置、笔记和最近缓存保存在 Chrome 本地。

唯一的例外是上面介绍的可选 GitHub 同步。登录后，已保存的笔记会同时镜像到本项目自建的同步服务 `https://ytd.panbo.space`，该服务运行在 Cloudflare Workers 上，数据库使用 Neon PostgreSQL。登录使用 GitHub 的 OAuth 流程，服务只会返回你登录账户对应的数据。如果从不登录，笔记数据就不会离开你的设备。

YouTube Digest 没有账号系统、广告、分析统计或行为追踪。Supadata 和你选择的 AI 服务仍会按照各自的条款和隐私政策处理数据。所有数据流向（包括同步服务）的完整说明以 [PRIVACY.md](PRIVACY.md) 为准，另有一份便利译本 [PRIVACY.zh-CN.md](PRIVACY.zh-CN.md)。

## 常见问题

### YouTube 视频页面没有显示 Digest 按钮

- 在 `chrome://extensions` 中找到 YouTube Digest，点击“重新加载”，然后刷新 YouTube 页面。
- 确认当前页面是标准 `https://www.youtube.com/watch?...` 页面，而不是 Shorts、嵌入页面或直播页面。
- 按钮上写着 **Digest**，位于 YouTube 分享、收藏等按钮旁边。当前版本会在 YouTube 响应式操作栏变化时自动重新定位按钮，页面加载完成后可以稍等片刻。
- 如果你使用的是较早下载的版本，可以先横向调整一次 YouTube 窗口宽度让按钮出现，然后下载最新版，这样之后不再需要调整窗口。
- 如果按钮仍然没有出现，让你的编程 Agent 在这个具体视频页面检查 content script。

### 侧边栏无法打开

- 确认你打开的是 `https://www.youtube.com/...` 页面。侧边栏只在 YouTube 标签页启用，当前版本在切换到其他网站时会自动关闭它。
- 在 `chrome://extensions` 中确认 YouTube Digest 已启用，并点击“重新加载”。
- 重新加载扩展后，刷新 YouTube 页面。
- 侧边栏顶部有 **Settings** 按钮。在 YouTube 标签页点击扩展图标也会打开侧边栏。
- 如果问题仍然存在，让你的编程 Agent 检查扩展。

### YouTube Digest 提示需要设置

- 缺少密钥时，面板会显示标题 **API Keys Missing**，并提供一个 **Open Settings** 按钮。点击它，或从面板顶部的 **Settings** 按钮、`chrome://extensions` 中的 YouTube Digest 卡片、右键点击工具栏图标，都可以打开设置页。
- 保存你所选 AI 服务的 Key。Supadata Key 是可选的。扩展刚安装时也会自动打开设置页。
- 从支持的三个服务中选择：DeepSeek V4 Flash、MiniMax M3 或 OpenCode Go。接口地址和模型固定，没有需要填写的 Base URL 或 Model 字段。
- 如果设置提示旧的自定义服务已移除，请重新填写你所选服务的 Key。旧 AI Key 已安全清除，避免被错误用于其他服务。

### 找不到字幕

- 确认视频是公开的，并且有原生字幕。
- 确认 YouTube 标签页还开着并且在播放：字幕是从这个页面里读的。页面读不到时，YouTube Digest 才会退回到 Supadata，那时候就需要 Supadata Key。
- 检查 Supadata Key、剩余额度、限速和账号状态。
- 没有字幕的查询和手动重试也可能消耗额度。

YouTube Digest 不会自动改用 AI 生成字幕。

### AI 请求失败

- `401` 或 `403` 通常表示所选服务的 Key 或账号权限有问题。
- `429` 通常表示达到了所选服务的限速或消费上限。OpenCode Go 订阅套餐也有用量上限。
- 确认 Key 来自设置中所选服务对应的账号，并且账号有可用额度。
- 如果你把本地副本改成了其他模型，请再次使用设置中的自定义 prompt，让编程 Agent 检查本地实现。

### 同步提示“Sync expired”

- 你的笔记仍保存在这台设备上，但 GitHub 登录已过期，云端备份已经停止。
- 点击这个提示并重新使用 GitHub 登录，即可恢复同步。

不要在对话、截图或日志中分享 API Key、私密字幕或个人笔记。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run check
npm run package
```

`npm run check` 会校验公开发布的文件清单并扫描凭据泄漏；`npm run package` 会打包发布用的 ZIP。如果改动涉及同步后端，还需要运行后端自己的测试：

```bash
cd server && npm test
```

这些命令和 CI 工作流运行的一致。Agent 还应该在 Chrome 中重新加载扩展，并测试多个真实 YouTube 视频。自动检查通过，不代表真实服务请求和 YouTube 交互一定正常。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。
