/* The sign-in landing page speaks the user's language.
   The server already renders the page in the right language, using the
   language the extension asked for and the browser's own preference. This
   script only adds the switch, so a reader who lands on the wrong language
   can fix it without leaving the page.

   It follows the same rules as the dashboard's privacy page: the choice is
   remembered in localStorage, the URL wins over the stored choice, and the
   browser's language is the last resort. */

(() => {
  const LANG_KEY = "ytd_dashboard_lang";

  const COPY = {
    en: {
      signedIn: "Signed in to GitHub",
      body: "You can close this tab and return to YouTube Digest. Your notes, vocabulary and review progress are saved to your own account.",
      note: "Nothing was shared with anyone but the sync service you signed in to.",
      languageLabel: "Language",
    },
    "zh-CN": {
      signedIn: "已用 GitHub 登录",
      body: "你可以关掉这个标签页，回到 YouTube Digest。你的笔记、生词和复习进度都保存在你自己的账户里。",
      note: "除了你登录的同步服务，没有任何人拿到这些数据。",
      languageLabel: "语言",
    },
  };

  function normalizeLanguage(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
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
    if (stored) return normalizeLanguage(stored);
    // The server rendered the page in the language it chose. Trusting that
    // keeps the page from changing language under the reader.
    const rendered = document.documentElement.getAttribute("data-lang");
    if (rendered) return normalizeLanguage(rendered);
    return normalizeLanguage(window.navigator && window.navigator.language);
  }

  function applyCopy(language) {
    const table = COPY[language] || COPY.en;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const value = table[element.getAttribute("data-i18n")];
      if (value) element.textContent = value;
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      const value = table[element.getAttribute("data-i18n-aria-label")];
      if (value) element.setAttribute("aria-label", value);
    });
    document.documentElement.lang = language;
    document.title = COPY[language].signedIn + " · YouTube Digest";
    document
      .querySelectorAll("#langSwitch button")
      .forEach((button) => {
        button.setAttribute(
          "aria-pressed",
          button.dataset.lang === language ? "true" : "false",
        );
      });
  }

  function setup() {
    const language = detectLanguage();
    applyCopy(language);
    document.querySelectorAll("#langSwitch button").forEach((button) => {
      button.addEventListener("click", () => {
        const chosen = normalizeLanguage(button.dataset.lang);
        storeLanguage(chosen);
        applyCopy(chosen);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
