# Chrome Web Store 上架材料包

> **当前状态：尚未上架。** 扩展现在只以「从 GitHub 本地安装」的方式分发，README 里
> 「不在 Chrome Web Store 上架」的说法与事实一致。本材料包是**为将来上架准备的**，
> 不是当前的分发方式。
>
> 如果决定真的上架，这几处必须一起改，否则会变成一个不实的产品页面：
>
> 1. `README.md` / `README.zh-CN.md`：删掉「not available through the Chrome Web
>    Store」这句话，改成商店链接。
> 2. `manifest.json`：`version` 与 `package.json` 一起 bump（发布门禁会比对两者）。
> 3. 商店描述里的「local install」措辞：改成「从 Chrome Web Store 安装」。
> 4. 商店截图：全部换成当前界面拍的（见「截图清单」）。

## 前置条件

- [ ] 注册 Chrome Web Store 开发者账号（$5 一次性）：https://chrome.google.com/webstore/devconsole
- [ ] 隐私政策 URL：见下面「隐私政策 URL」一节。**线上只有一页**，它自带中英文切换。
- [ ] 打包好的 ZIP：仓库根目录 npm run package 生成 dist/youtube-digest-v1.7.1.zip
  - 注意：商店不接受根目录直接打包，需要 zip 内包含 manifest.json（我们的脚本已满足）
  - v1.7.1 的包现在有 27 个文件，SHA-256 以 `npm run package`
    当次输出为准，不要抄旧记录
- [ ] 数据使用披露表单（Data use disclosure）：勾选项必须和「商品信息」里的说法一致，
  尤其是 Supadata 和三个 AI 服务商。这张表和隐私政策对不上是常见的打回原因。

### 隐私政策 URL

线上只有**一个**隐私政策页面，它自带 English / 简体中文 切换：

| 语言 | URL |
| --- | --- |
| 英文 | https://ytd.panbo.space/privacy |
| 中文 | https://ytd.panbo.space/privacy?lang=zh-CN |

- `/privacy.html` 会 307 跳到 `/privacy`，商店表单里填 `/privacy` 就行。
- **没有单独的中文政策文件。** 中文版是同一个页面按 `?lang=zh-CN` 渲染的结果，
  页面右上角也有语言切换按钮。中文读者看到的还是同一个地址。
- **线上这一页只覆盖同步服务**（`ytd.panbo.space`），没有写 Supadata
  和 AI 服务商。扩展的完整隐私政策在仓库里：`PRIVACY.md`（英文，权威版）和
  `PRIVACY.zh-CN.md`（中文便利译本），两者内容一致。
- **上架前必须补上的差距**：商店的「隐私政策 URL」要能回答扩展全部的数据处理问题。
  现在这个地址只能回答同步服务那部分。要么把 `PRIVACY.md` 全文发布到一个公开、
  稳定的地址，要么把线上这一页扩写成完整政策。两条路都行，但都要在提交前做完。

## 商品信息

### 名称与描述的合规核对

Chrome Web Store 开发者后台的实际限制：

| 项目 | 商店限制 |
| --- | --- |
| 名称 | 最多 75 个字符 |
| 简短描述 | 最多 132 个字符 |
| 详细描述 | 最多 16000 个字符 |
| 截图 | 1 到 5 张，每张 1280x800 或 640x400 |
| 名称内容 | 不能有促销词、emoji 或无关符号；用别人的商标要有授权 |

逐条核对结果：

| 项目 | 现在的写法 | 字符数 | 结论 |
| --- | --- | ---: | --- |
| 名称 | `YouTube Digest: Transcript, Translation & AI Notes` | 50 | 通过（上限 75） |
| 简短描述 | `Turn any YouTube video into a learning resource: bilingual transcripts, AI overviews, and timestamped notes.` | 108 | 通过（上限 132） |
| 详细描述 | 见下 | 1941 | 通过（上限 16000） |
| `manifest.json` 的 description | `Turn YouTube videos into learning resources with transcripts, bilingual translation, AI overviews, and notes.` | 109 | 通过（上限 132），且与简短描述说的是同一件事 |
| 名称里的促销词 | 无 | - | 通过 |
| 名称里的 emoji | 无 | - | 通过 |
| 名称里的无关符号 | 只有 `:` `,` `&` | - | 通过 |
| 名称里的商标 | 有 `YouTube` | - | **有风险**，见下 |

两个需要知情的判断：

1. **名称里的 `YouTube` 是审核风险点。** 商店政策要求不要在名称里用别人的商标，
   除非有授权。`YouTube Digest` 说的是它做的事（处理 YouTube 视频），属于描述性
   用法，但这仍是审核可能提出的一点。如果被打回，备选名称
   `Video Digest: Transcript, Translation & Notes`；换名要同时改 `manifest.json`
   的 `name`（那个文件不在本文档组的改动范围内）。
2. **名称从破折号改成冒号。** 原来的写法是 `YouTube Digest — Transcript, ...`
   （51 字符）。破折号既超了 50 字符，也和本仓库「发布文案里不用破折号」的规矩
   不一致（`tests/release.test.js` 会检查 README 和 manifest 的文案）。改成冒号
   后正好 50 字符，两种口径都过得去。

`manifest.json` 的 `name` 仍然是 `YouTube Digest`：Chrome 扩展卡片上显示的是这个
短名，商店名称是它的超集，两边不冲突。

**名称**：YouTube Digest: Transcript, Translation & AI Notes

**一句话描述**：Turn any YouTube video into a learning resource: bilingual transcripts, AI overviews, and timestamped notes.

**详细描述**（建议直接粘贴）：

```text
YouTube Digest turns the captions of a YouTube video into a study resource you can read, search, and keep.

FEATURES
• Read the transcript, a Simplified Chinese translation, or the two side by side
• Search the transcript for a word or phrase and step through every match
• Get an AI-written summary with chapters and key quotes
• Explain any selected sentence, and see what the call costs before you pay for it
• Save timestamped notes, correct them later, and jump back to that moment
• Build a vocabulary notebook from the transcript and review the words on a schedule
• Read the transcript for free, straight out of the page you are watching
• Keep a 30-day library of the videos you already read, so opening one again costs nothing
• Export the transcript as a text file and your notes as Markdown
• Sign in with GitHub to back up your notes and words, and read them on any device in the web dashboard

HOW TO USE
1. Open a YouTube video that has captions
2. Click the YouTube Digest icon to open the side panel
3. Read, translate, search, explain, and take notes
4. Save the words worth learning and review them later

Bring your own API keys. The transcript is read out of the YouTube page you are
already watching, so most videos cost nothing and no transcript key is needed.
A key from DeepSeek, MiniMax, or OpenCode Go runs the AI features. You pay those
providers directly. YouTube Digest does not sell credits or subscriptions, and
never sees your keys.

Your keys, settings, notes, and words stay in your Chrome profile. Only the notes
and words you choose to back up are mirrored to this project's own sync service,
linked to your GitHub account. There is no advertising, no analytics, and no
telemetry. The privacy policy linked from this listing describes every data flow.

The extension needs one AI provider key before it can do anything. A Supadata key
is optional and only used as a fallback when the page cannot be read.
```

**类别**：Productivity / Education

**关键词**：youtube, transcript, subtitle, translation, bilingual, language learning, notes, AI summary, digest

**语言**：English（商店界面），界面支持 English / 简体中文。商店允许一个商品挂多个语言
的 listing，中文版可以上架后再补。

### 描述里承诺的功能，逐条对过产品

| 描述里的说法 | 产品里是否真的存在 | 在哪里 |
| --- | --- | --- |
| 原文 / 简体中文 / 双语字幕 | 有 | 侧边栏顶部的 Original / 中文 / Bilingual |
| 字幕搜索并逐个跳转 | 有 | Transcript 标签页的搜索框和上下按钮 |
| AI 摘要 + 章节 + 重点引用 | 有 | Summary 标签页 |
| 选中文本讲解 | 有 | 选中字幕后弹出的工具条里的 Explain |
| 调用前先显示这次要花多少钱 | 有 | Summary 标签页的费用提示 |
| 带时间戳的笔记，可修改，可跳回视频 | 有 | Notes 标签页 |
| 生词本 + 定期复习 | 有 | Words 标签页（复习在同一页） |
| 30 天视频库 | 有 | Library 标签页 |
| 导出字幕为文本文件 | 有 | Transcript 标签页的 Export |
| 导出笔记为 Markdown | 有 | Notes 标签页的 Export Markdown |
| GitHub 登录备份笔记和生词 | 有 | 设置页 / 侧边栏的登录按钮 |
| 网页控制台 | 有 | `https://ytd.panbo.space`（Notes / Favorites / Vocabulary / Review / Export / Delete my account） |

## 截图清单

商店的截图字段是**上传图片文件**，不是填 URL。绝对 URL 的用处是：它们是这些图片
稳定可用的下载地址（README 里用的是相对路径，复制到别处贴不出来）。文件名里有
空格，URL 里必须写成 `%20`。

**5 张已经齐了**，都在 `store/` 目录，全部是 1280x800（商店要的 16:10）：

| 文件 | 拍的是什么 | 怎么来的 |
| --- | --- | --- |
| `store/01-summary.png` | YouTube 播放页 + 侧边栏 Summary 标签页：AI 摘要和章节 | 仓库根目录的 `YouTube Digest demo.jpg`（2660x1560，比例不对）。顶部补了 103px 的白边（那一行本来就是纯白，接缝看不出来），再缩到 1280x800 |
| `store/02-bilingual.png` | 同一支视频，侧边栏 Transcript 标签页的双语字幕 | 同上，来源是 `YouTube Digest demo bilingual.jpg` |
| `store/03-transcript.png` | 侧边栏 Transcript 标签页：搜索框、导出、从 0:02 开始的全字幕 | 真实浏览器里拍的（640x400 的视口，2 倍像素密度） |
| `store/04-notes.png` | 侧边栏 Notes 标签页：一条带时间戳的笔记和它的操作按钮 | 同上 |
| `store/05-library.png` | 侧边栏 Library 标签页：读过的视频 | 同上 |

raw 地址（合并并推送之后才有效）：

```text
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/01-summary.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/02-bilingual.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/03-transcript.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/04-notes.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/05-library.png
```

> 这些链接指向 `main` 分支。`store/` 目录目前只在工作分支上，还没进 `main`，
> 所以现在打开是 404；合并并推送之后才有效。

### 截图是怎么拍的（换机器重拍时照着做）

浏览器的侧边栏没法直接截图，所以侧边栏是**当成一个标签页**打开的：画面里没有
浏览器地址栏，看起来就是一个 640x400 的面板。视口用 640x400、像素密度 2，
截图就是 1280x800。面板会跟着播放器的位置滚动，所以拍之前把字幕列表滚回顶部，
把要拍的那张卡片滚到画面中间。

前两张（`01`、`02`）不是这么拍的：它们是从仓库根目录那两张演示图裁出来的。
那两张图是真实浏览器的整屏截图，比例是 1.71 而不是商店要的 1.6，横向裁哪边都会
切掉东西（左边是 YouTube 的 logo，右边是面板的 Library 标签），所以改成在顶部
补一条白边——那一行本来就是纯白，接缝看不出来。

### 拍不到的那几张

- **生词本（Words 标签页）**：需要能用的 AI Key。当前存着的 Key 已经过期
  （DeepSeek 报 401，OpenCode Go 报 `api_key_expired`），生词、摘要、翻译、
  讲解这几条路现在都跑不起来。换一个能用的 Key 之后就能拍。
- **设置页（Options）**：四个 Key 输入框（Supadata、DeepSeek、MiniMax、
  OpenCode Go），不是旧材料里写的「两个」。
- **网页控制台（Dashboard）**：登录后的 Notes / Favorites / Vocabulary / Review，
  以及 Export 和 Delete my account 按钮。控制台不是扩展本身，但商店描述里提到了
  它，给一张更完整。
- **视频页上的 Digest 按钮**：`.review/` 里没有这张。

商店最多 5 张，现在这 5 张已经把位置占满了。生词本那张换到 AI Key 之后，
替换掉第 5 张（资料库）就行。

`.review/` 那 6 张是内部图：420x900 的竖图，尺寸商店不收，右上角还显示着
GitHub 登录名。它们不参与上架。

## 审核注意

- 权限声明：sidePanel、storage、tabs、scripting、unlimitedStorage + host permissions（YouTube/Supadata/AI 服务/同步域名）。商店会展示这些权限，描述里已说明用途
  - `unlimitedStorage` 的理由（填到商店的权限说明框里）：
    "Raises the local storage limit from Chrome's default 10 MB to unlimited, so the cached transcripts, translations, and summaries of long videos fit on the device. The data stays in your Chrome profile and is never sent anywhere."
- 隐私政策页已包含数据导出/删除说明，满足商店对账号系统的要求
- 无付费功能，无需商品内购买设置
- 数据使用披露表单要如实勾选：同步服务会处理你的 GitHub 标识、笔记、生词和复习进度，这些都要勾
  - 字幕现在是**从页面里读的**，不发给任何第三方。Supadata 那一项按「用户自己填了 Key、
    且页面读不到时才会发生」来勾，不要写成默认行为
- 名称里的 `YouTube` 商标风险见上面「名称与描述的合规核对」
- 商店版和本地版用同一个 GitHub OAuth App，回调地址不变，不需要改服务器

## 提交步骤

1. https://chrome.google.com/webstore/devconsole 创建新商品
2. 填名称、简短描述、详细描述、类别、关键词、语言
3. 上传 ZIP、图标、截图（先按「截图清单」把图准备好）
4. 填隐私政策 URL（同步服务那页）和支持邮箱
5. 填 Single purpose：一句说清这个扩展的单一用途，例如
   "Turns the captions of a YouTube video into a searchable transcript with translation, notes, and vocabulary"
6. 填数据使用披露表单
7. 提交审核（通常 1-7 天）

## 上架前还差什么

诚实地列一遍，按重要性排：

- [x] **截图**。5 张 1280x800 已经在 `store/` 目录里，商店的 5 个位置正好。
- [ ] **隐私政策 URL 的内容**。线上那页只覆盖同步服务，没覆盖 Supadata 和 AI
      服务商。要么把 `PRIVACY.md` 发布出去，要么把线上那页扩写。
- [ ] **图标**。`icons/icon128.png` 是 128x128 的 PNG，尺寸对；但它带 alpha 通道，
      商店对图标的要求是不要有透明问题，上传前在后台预览里看一眼。
- [ ] **支持邮箱**。商店要求一个有人看的联系方式，仓库现在没有。
- [ ] **`manifest.json` 的 `name`**。如果因为商标问题换商店名称，这个文件要同步改
      （不在本文档组的改动范围内）。
- [x] **版本号**。`manifest.json` 和 `package.json` 已经一起 bump 到 **1.7.1**，
      `dist/youtube-digest-v1.7.1.zip` 已生成。上架时用这个包。
