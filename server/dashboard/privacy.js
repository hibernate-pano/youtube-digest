/* The privacy page speaks the user's language too.
   The dashboard already stores the chosen language in localStorage, so this
   page picks up the same choice without a second click. English is the
   fallback for every missing key, and the page keeps working when the
   script does not run at all: the HTML holds the English text. */

(function () {
  const LANG_KEY = "ytd_dashboard_lang";

  const COPY = {
    en: {
      pageTitle: "Privacy · YouTube Digest",
      brandSubtitle: "Privacy",
      languageLabel: "Language",
      backToDashboard: "Back to dashboard",
      heading: "Privacy",
      lastUpdated: "Last updated: {date}",
      whatThisIsHeading: "What this is",
      whatThisIs:
        "YouTube Digest is an open-source Chrome extension you install yourself (bring-your-own-key) with an optional GitHub-account sync service. This page covers both: the extension, and the sync service at ytd.panbo.space.",
      extensionHeading: "The extension",
      extensionIntro:
        "YouTube Digest has no account of its own, no analytics, no advertising and no telemetry. It reads the captions of the video you are watching and turns them into something you can search, translate and keep.",
      extensionHandlesHeading: "What it handles",
      handleVideo:
        "the video you are watching: its canonical URL, its video ID, and metadata such as the title, the channel, the description and the duration;",
      handleTranscript:
        "the transcript: its text and its timestamps, the text you select in it, and the transcript around it;",
      handleNotes:
        "what you keep: the notes you save, the words you keep for review, and the review schedule attached to them;",
      handleKeys: "your settings: your API keys and which provider you picked;",
      handleCache:
        "cached results: transcripts, summaries and translations, so that opening a video again costs nothing.",
      extensionGoesHeading: "Where that data goes",
      goesCaptionsLabel: "Captions",
      goesCaptions:
        "are read out of the page you are already watching. On that path nothing is sent to anybody.",
      goesSupadataLabel: "The fallback:",
      goesSupadata:
        "when the page cannot be read, the canonical video URL goes to Supadata, with your own key, to fetch the transcript. The key is optional, and the request asks for caption tracks only.",
      goesAiLabel: "The AI features:",
      goesAi:
        "the text you ask to be summarised, translated, explained or polished goes to the AI provider you chose in Settings, with your own key. That provider receives the transcript, the text you selected, and the title, channel and description of the video.",
      goesSessionLabel: "One extra header:",
      goesSession:
        "OpenCode Go routes on a session id, so a request to it also carries one. Your browser makes that id once, at random, and keeps it. It says nothing about you, it goes to that provider only, and nobody else has it.",
      extensionLocalHeading: "What stays on your device",
      extensionLocal:
        "Everything else stays in your Chrome profile: your API keys, your notes (the 100 most recent), your words (the 500 most recent), and a cache limited to 20 videos and 30 days. Your keys are never sent to the sync service. Settings can clear the cache, delete every note, or reset the extension's data.",
      extensionPermissionsHeading: "What the permissions are for",
      permSidePanel: "sidePanel: to show the panel beside the video.",
      permStorage: "storage: to keep your settings, keys, notes and cache on the device.",
      permUnlimited:
        "unlimitedStorage: so the cached transcripts, translations and summaries of long videos fit on the device. It sends nothing anywhere.",
      permTabs: "tabs: to find the YouTube tab you are watching.",
      permScripting:
        "scripting: to place the panel's controls on the YouTube page, and to read the captions that page already carries.",
      permHosts:
        "Host access to YouTube, Supadata, the AI providers and this sync service, for exactly those requests.",
      whatWeStoreHeading: "What the sync service stores",
      identityLabel: "Your GitHub identity",
      notesLabel: "Your notes",
      exportLabel: "Export:",
      deleteLabel: "Delete:",
      signOutLabel: "Sign out on this page",
      storeIdentity: " (id, login name) so your account can be recognised.",
      storeNotes:
        " that you write while watching a video, plus the words you keep for review and the review progress this service schedules for them. Words are collected in the extension; this service only stores them and schedules their reviews.",
      storeIsolation:
        "Data is stored in a Neon (PostgreSQL) database and is isolated per GitHub account: the server only ever serves the rows belonging to the authenticated user.",
      edgeHeading: "The network in between",
      edge:
        "This service runs on Cloudflare Workers, so Cloudflare's network handles every request before it reaches the application. Cloudflare processes the request's IP address and user agent for routing, abuse prevention and bot management, and may serve a challenge page instead of the application. That is Cloudflare's processing under its own terms and privacy policy.",
      neverHeading: "What we never do",
      neverAnalytics: "No advertising, analytics, or tracking.",
      neverSell:
        "No selling or sharing of your data with third parties.",
      neverProviders:
        "Transcript and AI requests go directly from the extension to Supadata and your chosen AI provider under their own terms; the sync service is not involved.",
      controlsHeading: "Your controls",
      controlExport:
        " download all your data as JSON from the dashboard (Export button).",
      controlDelete:
        " delete your account and all your data from the dashboard (Delete account button). This is permanent and cannot be undone.",
      controlSignOut:
        " only clears the sign-in this page keeps in your browser; the extension keeps its own session and keeps syncing. To stop the extension from syncing, click your account name in the side panel header. Either way your data stays in your account, and you can sign back in at any time.",
      securityHeading: "Security",
      security:
        "Sign-in uses GitHub OAuth; the extension stores only the access token this service issues, and that token expires after 30 days. There is no refresh token, so you sign in again once it expires. Connections are HTTPS. The database is not publicly accessible.",
      contactHeading: "Contact",
      contact:
        "Questions? Open an issue on the project repository (github.com/hibernate-pano/youtube-digest).",
    },
    "zh-CN": {
      pageTitle: "隐私 · YouTube Digest",
      brandSubtitle: "隐私",
      languageLabel: "语言",
      backToDashboard: "返回控制台",
      heading: "隐私",
      lastUpdated: "最后更新：{date}",
      whatThisIsHeading: "这是什么",
      whatThisIs:
        "YouTube Digest 是一个你自己安装的开源 Chrome 扩展（需要自备 API Key），并附带一个可选的 GitHub 账号同步服务。本页同时说明这两部分：扩展本身，以及 ytd.panbo.space 上的同步服务。",
      extensionHeading: "扩展本身",
      extensionIntro:
        "YouTube Digest 没有自己的账号体系，没有分析统计，没有广告，也没有行为追踪。它读出你正在看的视频的字幕，把它变成可以搜索、翻译和保存的东西。",
      extensionHandlesHeading: "它会处理什么",
      handleVideo:
        "你正在看的视频：它的标准地址、视频 ID，以及标题、频道、简介和时长等元信息；",
      handleTranscript:
        "字幕：它的文字和时间戳、你在里面选中的文字，以及它前后的上下文；",
      handleNotes:
        "你留下的东西：你保存的笔记、你收集来复习的单词，以及附着在它们上面的复习计划；",
      handleKeys: "你的设置：你的 API Key，以及你选了哪个服务商；",
      handleCache: "缓存结果：字幕、摘要和翻译，所以同一个视频再打开一次不花钱。",
      extensionGoesHeading: "这些数据去了哪里",
      goesCaptionsLabel: "字幕",
      goesCaptions: "是从你正在看的那个页面里读出来的。这条路上不发给任何人任何东西。",
      goesSupadataLabel: "兜底那条路：",
      goesSupadata:
        "当页面读不到时，标准的视频地址会带着你自己的 Key 发给 Supadata 去取字幕。这个 Key 是可选的，而且请求只要字幕轨道。",
      goesAiLabel: "AI 功能：",
      goesAi:
        "你要求摘要、翻译、讲解或润色的文字，会带着你自己的 Key 发给设置里选中的那个 AI 服务商。它会收到字幕、你选中的那段文字，以及视频的标题、频道和简介。",
      goesSessionLabel: "多出来的一个请求头：",
      goesSession:
        "OpenCode Go 按会话 ID 路由，所以发往它的请求会带一个。你的浏览器随机生成一次就保存下来。它不包含关于你的任何信息，只发给那个服务商，别人也拿不到。",
      extensionLocalHeading: "留在你设备上的东西",
      extensionLocal:
        "其余的全部留在你的 Chrome 用户配置里：你的 API Key、你的笔记（最近 100 条）、你的单词（最近 500 个），以及一个最多 20 个视频、保留 30 天的缓存。你的 Key 不会发给同步服务。设置里可以清缓存、删除全部笔记，或者重置扩展数据。",
      extensionPermissionsHeading: "这些权限用来做什么",
      permSidePanel: "sidePanel：在视频旁边显示面板。",
      permStorage: "storage：把设置、Key、笔记和缓存留在设备上。",
      permUnlimited:
        "unlimitedStorage：让长视频的字幕、翻译和摘要缓存能装得下。它不会把任何东西发出去。",
      permTabs: "tabs：找到你正在看的那个 YouTube 标签页。",
      permScripting:
        "scripting：在 YouTube 页面上放面板的控件，并读出那个页面本来就带着的字幕。",
      permHosts: "对 YouTube、Supadata、AI 服务商和本同步服务的域名访问权限，只用于上面那些请求。",
      whatWeStoreHeading: "同步服务保存什么",
      identityLabel: "你的 GitHub 身份",
      notesLabel: "你写下的笔记",
      exportLabel: "导出：",
      deleteLabel: "删除：",
      signOutLabel: "在这一页退出登录",
      storeIdentity: "（id、登录名），用来识别你的账户。",
      storeNotes:
        "，以及你为复习保存的单词和本服务为它们排定的复习进度。单词在扩展里收集，本服务只负责保存它们并安排复习。",
      storeIsolation:
        "数据保存在 Neon（PostgreSQL）数据库中，并按 GitHub 账户隔离：服务端只会返回已认证用户自己的数据。",
      edgeHeading: "中间的网络",
      edge:
        "本服务运行在 Cloudflare Workers 上，所以每个请求都会先经过 Cloudflare 的网络，才到达应用。Cloudflare 会为了路由、防滥用和机器人管理处理请求的 IP 地址和 User-Agent，并且可能在返回应用之前先返回一个验证页面。这属于 Cloudflare 按自己的条款和隐私政策做的处理。",
      neverHeading: "我们从不做的事",
      neverAnalytics: "不做广告，不做分析统计，不做行为追踪。",
      neverSell: "不出售你的数据，也不把它分享给第三方。",
      neverProviders:
        "字幕和 AI 请求由扩展直接发往 Supadata 和你选择的 AI 服务商，按它们各自的条款处理；同步服务不参与其中。",
      controlsHeading: "你可以控制什么",
      controlExport: "在控制台里把全部数据下载成 JSON（Export 按钮）。",
      controlDelete:
        "在控制台里删掉你的账户和全部数据（Delete account 按钮）。这个操作不可撤销。",
      controlSignOut:
        "只会清掉这个页面保存在浏览器里的登录状态；扩展有自己独立的会话，会继续同步。要让扩展停止同步，点侧边栏顶部的账户名。无论哪种方式，你的数据都留在账户里，随时可以重新登录。",
      securityHeading: "安全",
      security:
        "登录使用 GitHub OAuth；扩展只保存本服务签发的访问令牌，该令牌 30 天后过期。没有刷新令牌，所以过期后需要重新登录。连接一律使用 HTTPS。数据库不对外公开。",
      contactHeading: "联系",
      contact:
        "有问题？在项目仓库开 issue（github.com/hibernate-pano/youtube-digest）。",
    },
  };

  function normalizeLanguage(value) {
    const raw = String(value || "").trim();
    if (!raw) return "en";
    const lower = raw.toLowerCase();
    if (
      lower === "zh" ||
      lower === "zh-cn" ||
      lower === "zh-hans" ||
      lower === "zh-tw" ||
      lower === "zh-hant"
    ) {
      return "zh-CN";
    }
    return "en";
  }

  function readStoredLanguage() {
    try {
      return window.localStorage.getItem(LANG_KEY);
    } catch {
      // Private mode can refuse to store anything. The page still works.
      return null;
    }
  }

  function storeLanguage(language) {
    try {
      window.localStorage.setItem(LANG_KEY, language);
    } catch {
      // Nothing to do: the choice simply is not remembered.
    }
    // The sign-in page is rendered by the server, so the choice has to
    // travel there in a cookie the server can read.
    try {
      document.cookie =
        LANG_KEY +
        "=" +
        encodeURIComponent(language) +
        "; path=/; max-age=31536000; samesite=lax";
    } catch {
      // A blocked cookie only costs the next sign-in its language.
    }
  }

  function detectLanguage() {
    const fromUrl = new URLSearchParams(window.location.search).get("lang");
    if (fromUrl) return normalizeLanguage(fromUrl);
    const stored = readStoredLanguage();
    if (stored) {
      // The choice can predate the cookie, so it is stored again: the
      // server and the page then speak the same language.
      const chosen = normalizeLanguage(stored);
      storeLanguage(chosen);
      return chosen;
    }
    return normalizeLanguage(window.navigator && window.navigator.language);
  }

  function copy(key, params) {
    const language = copy.language || "en";
    const table = COPY[language] || COPY.en;
    const value = table[key] ?? COPY.en[key] ?? "";
    if (typeof value === "function") return value(params);
    return String(value).replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params || {}, name)
        ? String(params[name])
        : match,
    );
  }

  function applyCopy(language) {
    copy.language = language;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      const value = copy(key, { date: element.getAttribute("data-date") || "" });
      if (value) element.textContent = value;
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      const key = element.getAttribute("data-i18n-aria-label");
      const value = copy(key);
      if (value) element.setAttribute("aria-label", value);
    });
    document.documentElement.lang = language;
    document.title = copy("pageTitle");
    paintLangSwitch(language);
  }

  // The switcher has no rule in style.css, so the selected button is painted
  // through the CSSOM. Inline styles are forbidden by the page's own
  // Content-Security-Policy, and a style rule would have to be added to a
  // file the dashboard owns.
  function paintLangSwitch(language) {
    document.querySelectorAll("#langSwitch button").forEach((button) => {
      const selected = button.dataset.lang === language;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.style.background = selected ? "var(--accent-solid)" : "";
      button.style.color = selected ? "var(--on-accent)" : "";
      button.style.borderColor = selected ? "var(--accent-solid)" : "";
    });
  }

  function setLanguage(language) {
    storeLanguage(language);
    applyCopy(language);
  }

  function setup() {
    const language = detectLanguage();
    applyCopy(language);
    document.querySelectorAll("#langSwitch button").forEach((button) => {
      button.addEventListener("click", () => {
        setLanguage(button.dataset.lang);
      });
    });
  }

  window.YTD_PRIVACY = {
    copy,
    normalizeLanguage,
    detectLanguage,
    setLanguage,
    // The tables are exposed so the tests can check that a key has a
    // translation of its own, and not only the English fallback.
    tables: COPY,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
