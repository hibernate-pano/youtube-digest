# YouTube Digest:安装指南(给朋友版)

> 预计耗时:15 分钟。需要:一台电脑、一个 Chrome 浏览器、一个 GitHub 账号(可选)。

## 一、准备 API Key(5 分钟)

YouTube Digest 本身不收费。你需要自己申请**一个 AI 服务的 Key**(摘要和翻译要用它)。

字幕是直接从你正在看的那个 YouTube 页面里读出来的:不用 Key、不消耗额度、字幕文字也不会离开你的浏览器。
只有当页面读不到字幕时,扩展才会退回到 Supadata 兜底,那时候才需要一个 Supadata Key(可选)。
数据只会发给你自己填了 Key 的那些服务;只有你用 GitHub 登录之后,已保存的笔记才会同步到本项目自建的同步服务。

1. **AI 服务 Key**(用于 AI 摘要/翻译,DeepSeek / MiniMax / OpenCode Go 任选其一)
   - DeepSeek:打开 https://platform.deepseek.com/api_keys 注册并创建 key
   - 需要充一点点余额(几块钱够用很久,按量计费)
2. **Supadata Key**(可选,只在页面读不到字幕时兜底)
   - 打开 https://dash.supadata.ai/auth/sign-up 注册
   - 注册后自动生成一个 key,复制保存
   - 免费版每月 100 条。填了就多一条退路,没填也完全能用

## 二、安装扩展(5 分钟)

1. 下载项目 ZIP:https://github.com/hibernate-pano/youtube-digest → Code → Download ZIP
2. 解压到固定文件夹(以后不要移动它)
3. 打开 Chrome,地址栏输入 chrome://extensions 回车
4. 打开右上角「开发者模式」开关
5. 点「加载已解压的扩展程序」,选择解压出来的文件夹
6. 工具栏出现 YouTube Digest 图标(右键可固定)

## 三、配置(3 分钟)

1. 打开任意 YouTube 视频,点扩展图标打开侧边栏
2. 点右上角 Settings
3. 粘贴 AI 服务的 Key(Supadata Key 可选,可留空),点保存

## 四、使用(1 分钟上手)

1. 打开一个有字幕的 YouTube 视频(英语学习视频最佳)
2. 侧边栏自动显示字幕,可以切换 原文 / 中文 / 双语
3. 点「Summary」看 AI 总结和章节
4. 看视频时按键盘 n 键(或把鼠标移到视频上,点出现的 **Note** 按钮)记笔记

## 五、(可选)开通云同步

1. 在 Settings 里点「Sign in with GitHub」登录
2. 笔记会同步到本项目自建的同步服务 https://ytd.panbo.space/,登录后也可以在网页版查看和管理笔记:https://ytd.panbo.space/
3. 换电脑/浏览器,重新安装扩展后登录同一账号,数据就回来了
4. 不登录也一样能用,只是笔记只留在这台设备上,不会上传到任何服务器

## 常见问题

- **没字幕**:扩展会先从页面读字幕,读不到才用 Supadata 兜底。两个都没有时,面板会直接告诉你「这个视频没有能读到的字幕」,而不是一直转圈
- **AI 报错**:检查 DeepSeek 余额、key 是否粘贴完整
- **更新**:扩展不会自动更新,重新下载 ZIP 覆盖后,在 chrome://extensions 点「重新加载」
