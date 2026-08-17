# YouTube Digest — 安装指南(给朋友版)

> 预计耗时:15 分钟。需要:一台电脑、一个 Chrome 浏览器、一个 GitHub 账号(可选)。

## 一、准备两个 API Key(5 分钟)

YouTube Digest 不收费,但需要你自己申请两个免费 API Key(数据只发给这两个服务,不经过我们的服务器):

1. **Supadata Key**(用于拉取 YouTube 字幕)
   - 打开 https://dash.supadata.ai/auth/sign-up 注册
   - 注册后自动生成一个 key,复制保存
2. **DeepSeek Key**(用于 AI 摘要/翻译,也可选 MiniMax 或 OpenCode Go)
   - 打开 https://platform.deepseek.com/api_keys 注册并创建 key
   - 需要充一点点余额(几块钱够用很久,按量计费)

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
3. 粘贴 Supadata Key 和 DeepSeek Key,点保存

## 四、使用(1 分钟上手)

1. 打开一个有字幕的 YouTube 视频(英语学习视频最佳)
2. 侧边栏自动显示字幕,可以切换 原文 / 中文 / 双语
3. 点「Overview」看 AI 总结和章节
4. 看视频时按键盘 n 键(或点视频上的 📝)记笔记

## 五、(可选)开通云同步

1. 在 Settings 里点「Sign in with GitHub」登录
2. 笔记自动备份到云端,网页版管理:https://ytd.panbo.space/
3. 换电脑/浏览器,重新安装扩展后登录同一账号,数据就回来了

## 常见问题

- **没字幕**:视频没有原生字幕时无法使用(不支持自动转写)
- **AI 报错**:检查 DeepSeek 余额、key 是否粘贴完整
- **更新**:扩展不会自动更新,重新下载 ZIP 覆盖后,在 chrome://extensions 点「重新加载」
