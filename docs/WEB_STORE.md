# Chrome Web Store 上架材料包

## 前置条件

- [ ] 注册 Chrome Web Store 开发者账号($5 一次性):https://chrome.google.com/webstore/devconsole
- [ ] 隐私政策 URL:https://ytd.panbo.space/privacy.html(已上线)
- [ ] 打包好的 ZIP:仓库根目录 npm run package 生成 dist/youtube-digest-v1.3.0.zip
  - 注意:商店不接受根目录直接打包,需要 zip 内包含 manifest.json(我们的脚本已满足)

## 商品信息

**名称**:YouTube Digest — Transcript, Translation & AI Notes

**一句话描述**:Turn any YouTube video into a learning resource: bilingual transcripts, AI overviews, and timestamped notes.

**详细描述**(建议直接粘贴):

```text
YouTube Digest turns captions into a readable, searchable learning resource.

• Original, Simplified Chinese, and aligned bilingual transcript views
• AI-generated overviews with chapters and key quotes
• Selected-text explanations
• Timestamped notes you can edit and replay
• Optional GitHub sign-in to back up your notes and review vocabulary
• Bring-your-own-key: no subscription, your keys, your data

How it works:
1. Open any YouTube video with captions
2. Click the YouTube Digest icon to open the side panel
3. Read, translate, explain, and take notes

This extension stores keys and notes locally in your Chrome profile. AI and
transcript features require your own Supadata and AI provider API keys.
Optional cloud sync stores your notes in your GitHub account. See the
Privacy page for details.
```

**类别**:Productivity / Education

**关键词**:youtube, transcript, subtitle, translation, bilingual, language learning, notes, AI summary, digest

**语言**:English(商店界面),界面支持 English / 简体中文

## 截图清单(需要 5 张,1280x800 或更大)

1. 侧边栏字幕(双语模式)—— 打开一个带字幕视频,切到「双语」
2. AI 概览 —— 点 Overview tab,显示章节+引用
3. 笔记列表 —— Notes tab,有几条笔记
4. 设置页 —— chrome://extensions 打开 options,显示两个 Key 输入框
5. Dashboard(可选)—— ytd.panbo.space 登录后的笔记列表

## 审核注意

- 权限声明:sidePanel、storage、tabs、scripting + host permissions(YouTube/Supadata/AI 服务/同步域名)——商店会展示,描述里已说明用途
- 隐私政策页已包含数据导出/删除说明,满足商店对账号系统的要求
- 无付费功能,无需商品内购买设置

## 提交步骤

1. https://chrome.google.com/webstore/devconsole 创建新商品
2. 上传 ZIP、填上面信息、传截图、填隐私政策 URL
3. 提交审核(通常 1-7 天)
4. 审核通过后,商店版不能访问你 GitHub App 的回调?不需要——商店版与本地版同一个 OAuth App,回调地址不变
