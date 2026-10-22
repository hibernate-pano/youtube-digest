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
>    这一轮已经 bump 到 1.8.0。
> 3. 商店描述里的「local install」措辞：改成「从 Chrome Web Store 安装」。
> 4. 商店截图：这一轮已经重拍，五张都是现在的界面、同一支视频（见「截图清单」）。

## 前置条件

- [ ] 注册 Chrome Web Store 开发者账号（$5 一次性）：https://chrome.google.com/webstore/devconsole
- [ ] 隐私政策 URL：见下面「隐私政策 URL」一节。**线上只有一页**，它自带中英文切换。
- [ ] 打包好的 ZIP：仓库根目录 npm run package 生成 dist/youtube-digest-v1.8.0.zip
  - 注意：商店不接受根目录直接打包，需要 zip 内包含 manifest.json（我们的脚本已满足）
  - 打包脚本会用 `scripts/verify-package.js` 把包里的每个文件和仓库里的那一份对一遍，
    对不上就直接失败，所以这个包一定是从当前代码打的
  - SHA-256 以 `npm run package` 当次输出为准，不要抄旧记录
  - `dist/` 里还留着以前版本打的包。打包脚本会把该上传的那一个点名，其余列成
    「not for upload」——上传那个，不要上传别的
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
- **这一页现在覆盖整个产品**（扩展 + 同步服务）：扩展处理什么、字幕和 AI 请求
  分别去了哪里、哪些东西留在设备上、每个权限用来做什么，都写在上面，中英文都有。
  仓库里另有一份完整政策：`PRIVACY.md`（英文，权威版）和 `PRIVACY.zh-CN.md`
  （中文便利译本），三者内容一致。
- [ ] **线上这一页要跟仓库里的政策对齐。** 本轮改了退出登录、删除账号、
      「删除全部笔记」、导出、账号上限、浏览器的名字、无字幕视频的 24 小时
      记忆这几处说法，仓库里的两份政策已经改完，线上这一页还没改。改完，
      三者才真的内容一致。
- 商店表单里填 `https://ytd.panbo.space/privacy` 就行。

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
| 详细描述 | 见下 | 2634 | 通过（上限 16000） |
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
• Export the transcript as a text file and copy your notes as Markdown
• Sign in with GitHub to mirror your notes, words and review progress, and read them on any device in the web dashboard

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

Your keys, settings, notes, and words stay in your Chrome profile. When you sign
in with GitHub, the notes, words and review progress you save are mirrored to
your own account on this project's own sync service, linked to your GitHub
account. Signing out stops the mirroring and removes this browser's copy.
There is no advertising, no analytics, and no telemetry. The privacy policy
linked from this listing describes every data flow.

The extension works without any key: the transcript, the search, the notes and
the library all run on your own machine. One AI provider key (DeepSeek, MiniMax,
or OpenCode Go) turns on the summary, the translation, the explanations, the
tidying of a transcript line into a note, and the extraction of words, and the
panel says which half is waiting for one. A Supadata key is optional and only
used as a fallback when the page cannot be read. The spaced review of your
words needs a GitHub sign-in, because the review schedule is kept on the sync
service. An account can hold 20,000 notes and words together; when the limit is
reached the service refuses the new note and tells you how many are already
there.
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
| AI 摘要 + 章节 + 重点引用 | 有 | Summary 标签页（需要 AI 服务商 Key） |
| 选中文本讲解 | 有 | 选中字幕后弹出的工具条里的 Explain（需要 AI 服务商 Key） |
| 调用前先显示这次要花多少钱 | 有 | Summary 标签页的费用提示 |
| 带时间戳的笔记，可修改，可跳回视频 | 有 | Notes 标签页。面板里写的笔记一字不改地保存；视频页面的 Note 按钮才会请 AI 整理字幕 |
| 生词本 + 定期复习 | 有，但各有一个前提 | Words 标签页（复习在同一页）。挑生词需要 AI 服务商 Key；复习需要 GitHub 登录，因为计划存在同步服务上 |
| 30 天视频库 | 有 | Library 标签页 |
| 导出字幕为文本文件 | 有 | Transcript 标签页的 Export |
| 复制笔记为 Markdown | 有，但只复制到剪贴板，不生成文件 | Notes 标签页的 Export Markdown |
| GitHub 登录后镜像笔记、生词和复习进度 | 有 | 设置页 / 侧边栏的登录按钮。退出登录会停止镜像并清除这台浏览器上的副本 |
| 网页控制台 | 有 | `https://ytd.panbo.space`（Notes / Favorites / Vocabulary / Review / Export / Delete my account） |

## 截图清单

商店的截图字段是**上传图片文件**，不是填 URL。绝对 URL 的用处是：它们是这些图片
稳定可用的下载地址（README 里用的是相对路径，复制到别处贴不出来）。文件名里有
空格，URL 里必须写成 `%20`。

**5 张在位，尺寸对，内容就是现在的产品。** 都在 `store/` 目录，全部是 1280x800
（商店要的 16:10）。五张是**同一个视频**（演示图里那支 Sam Altman 的访谈），
因为商品页如果一张图是这支视频、下一张是另一支，看起来像两次会话拼在一起。
它们不是手工拼的，是脚本从现在的面板上拍下来再贴进演示图的，所以产品改了
以后重跑两条命令就能重新生成，不会再落后一个版本。

| 文件 | 拍的是什么 | 怎么来的 |
| --- | --- | --- |
| `store/01-summary.png` | YouTube 播放页 + 侧边栏 Summary 标签页：AI 摘要、章节、要点 | 面板由 `node scripts/panel-review.js --store` 拍（450x780，2 倍像素密度），再由 `node scripts/store-shots.js` 贴进仓库根目录的 `YouTube Digest demo.jpg`（2660x1560），整幅缩到 1280x800 |
| `store/02-bilingual.png` | 同一支视频，侧边栏 Transcript 标签页的双语字幕 | 同上，底图是 `YouTube Digest demo bilingual.jpg` |
| `store/03-notes.png` | 侧边栏 Notes 标签页：带时间戳的笔记和它的操作按钮 | 同上 |
| `store/04-words.png` | 侧边栏 Words 标签页：复习卡片和生词本 | 同上 |
| `store/05-library.png` | 侧边栏 Library 标签页：读过的视频 | 同上 |

raw 地址（合并并推送之后才有效）：

```text
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/01-summary.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/02-bilingual.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/03-notes.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/04-words.png
https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/store/05-library.png
```

> 这些链接指向 `main` 分支。`store/` 目录目前只在工作分支上，还没进 `main`，
> 所以现在打开是 404；合并并推送之后才有效。

### 截图是怎么拍的（换机器重拍时照着做）

```bash
node scripts/panel-review.js --store   # 拍面板，每个标签页一张，写进 .review-store/
node scripts/store-shots.js             # 贴进演示图，写出 store/ 里的五张
node scripts/store-shots.js --check     # 重拍一遍跟仓库里的比，不一致就退出 1
```

浏览器的侧边栏没法直接截图，所以侧边栏是**当成一个标签页**打开的：画面里没有
浏览器地址栏，看起来就是一个面板。视口用 450x780、像素密度 2，拍出来正好是
900x1560，和演示图里侧边栏那一栏的宽度一模一样（那一栏从 x=1760 开始，宽度
900，是量出来的不是估出来的），所以贴进去不用缩放，字不会糊。

演示图是 2660x1560，比例不是商店要的 16:10。整幅缩到 1280x800，上下各留一条
白边：那一行本来就是纯白，接缝看不出来。侧边栏按自己 450x780 的版面画，
标题、标签页、按钮都是现在这一版的。

### 拍不到的那几张

商店最多 5 张，现在这 5 张已经把位置占满了。下面这些拍得到，但没地方放：

- **设置页（Options）**：四个 Key 输入框（Supadata、DeepSeek、MiniMax、
  OpenCode Go），不是旧材料里写的「两个」。
- **网页控制台（Dashboard）**：登录后的 Notes / Favorites / Vocabulary / Review，
  以及 Export 和 Delete my account 按钮。控制台不是扩展本身，但商店描述里提到了
  它，给一张更完整。
- **视频页上的 Digest 按钮**：`.review/` 里没有这张。

`.review/` 那 6 张是内部图：420x900 的竖图，尺寸商店不收，右上角还显示着
GitHub 登录名。它们不参与上架。

## 审核注意

- 权限声明：sidePanel、storage、tabs、scripting、unlimitedStorage + host permissions（YouTube/Supadata/AI 服务/同步域名）。商店会展示这些权限，描述里已说明用途
  - `unlimitedStorage` 的理由（填到商店的权限说明框里）：
    "Raises the local storage limit from Chrome's default 10 MB to unlimited, so the cached transcripts, translations, and summaries of long videos fit on the device. The data stays in your Chrome profile and is never sent anywhere."
- 隐私政策页已包含数据导出/删除说明，满足商店对账号系统的要求
- 无付费功能，无需商品内购买设置
- 数据使用披露表单要如实勾选：同步服务会处理你的 GitHub 标识、笔记、生词和复习进度，
  这些都要勾；另外还有一次会话期间使用的浏览器随机 id，它会被发到服务端但只活在
  那次会话里，表单里也要按实际处理情况如实填
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
      五张是同一个视频、同一版界面，由脚本从现在的面板生成（见上面的「截图是怎么拍的」）。
- [x] **隐私政策 URL 的内容**。线上那一页已经扩写成完整政策：扩展部分（数据处理、
      数据流向、留在设备上的东西、权限用途）加上原来的同步服务部分，中英文都有。
- [ ] **线上隐私页和仓库政策对齐**。这一轮改了退出登录、删除账号、「删除全部笔记」、
      导出、账号上限、浏览器的名字、无字幕视频的 24 小时记忆这几处说法，仓库里的
      `PRIVACY.md` 和 `PRIVACY.zh-CN.md` 已经改完，线上那一页还没改。
- [x] **图标**。`store/icon128.png` 是 128x128 的 RGB PNG（没有 alpha 通道，
      商店拒绝带透明的图标）。`icons/icon128.png` 保持带透明，扩展自己的工具栏图标
      需要圆角。上架时用 `store/` 这一张。
- [ ] **支持邮箱**。商店要求一个有人看的联系方式，仓库现在没有。
- [ ] **`manifest.json` 的 `name`**。如果因为商标问题换商店名称，这个文件要同步改
      （不在本文档组的改动范围内）。
- [x] **版本号**。`manifest.json` 和 `package.json` 已经一起 bump 到 **1.8.0**，
      两个 README 的更新说明里都写着这一版。
- [x] **重新打包**。`dist/youtube-digest-v1.8.0.zip` 已经用现在的代码打出来，
      27 个文件，SHA-256 以那次 `npm run package` 的输出为准。上架前如果代码又动了，
      再跑一次 `npm run package` 重打：打包脚本会自己用 `scripts/verify-package.js`
      把包里的每一个文件和仓库里的那一份对一遍，对不上就直接失败；所以这个包一定
      是从当前代码打的。`dist/` 里还有旧版本打的包，不要上传它们——脚本会点名
      该上传哪一个。
