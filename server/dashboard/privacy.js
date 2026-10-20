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
      whatThisIsHeading: "What this service is",
      whatThisIs:
        "YouTube Digest is an open-source Chrome extension (bring-your-own-key) with an optional GitHub-account sync service. This page covers the sync service at ytd.panbo.space.",
      whatWeStoreHeading: "What we store",
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
      whatThisIsHeading: "这个服务是什么",
      whatThisIs:
        "YouTube Digest 是一个开源的 Chrome 扩展（需要自备 API Key），并附带一个可选的 GitHub 账号同步服务。本页说明的是 ytd.panbo.space 上的同步服务。",
      whatWeStoreHeading: "我们保存什么",
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

  window.YTD_PRIVACY = { copy, normalizeLanguage, detectLanguage, setLanguage };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
