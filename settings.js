/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";

  /**
   * Cloud sync backend (GitHub account sync for notes, vocabulary, and
   * review progress). This is the Cloudflare Worker URL; the extension never
   * holds OAuth secrets — it only stores the bearer token issued after login.
   * Local development: set this to "http://localhost:8787" and run
   * "npm run dev" inside server/.
   */
  const SERVER_BASE_URL = "https://ytd.panbo.space";
  const GITHUB_SESSION_KEY = "ytd_github_session";

  /**
   * Reason code attached to every sync result whose request the server
   * rejected with 401. The backend issues 30-day session tokens and exposes no
   * refresh endpoint, so a 401 is terminal rather than retryable: the cloud
   * mirror stops silently unless a surface reads this code and asks the user to
   * sign in again. Kept here because cloud-sync.js (service worker) and
   * sidepanel.js (panel) both load this file and must agree on the literal.
   */
  const SYNC_SESSION_EXPIRED = "SYNC_SESSION_EXPIRED";

  /**
   * Persisted latch for the expired state. The MV3 service worker is suspended
   * after ~30s idle and the panel may be closed when a background mirror write
   * fails, so a runtime broadcast alone would drop the signal. The latch lives
   * in chrome.storage.local and is cleared by the next successful sync or
   * login.
   */
  const SYNC_EXPIRED_KEY = "ytd_sync_expired";

  /**
   * Interface language preference. The settings page owns the preference, but
   * the side panel reads the same key so the shared GitHub sync header speaks
   * the same language the user picked there.
   */
  const UI_LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const SUPPORTED_UI_LANGUAGES = new Set(["en", "zh-CN"]);

  /**
   * Copy for the GitHub sync chip in the panel header. The signed-in and
   * signed-out labels already ship in the markup; these strings cover the
   * tooltip, the accessible name, and the expired-session state.
   */
  const SYNC_COPY = {
    en: {
      signedInTitle: ({ login }) => `Signed in as ${login}. Click to sign out.`,
      expiredLabel: "Sync expired",
      expiredTitle:
        "Your notes are still saved on this device, but the cloud backup stopped because the GitHub session expired. Click to sign in again and resume syncing.",
    },
    "zh-CN": {
      signedInTitle: ({ login }) => `已登录为 ${login}。点击退出登录。`,
      expiredLabel: "同步已过期",
      expiredTitle:
        "笔记仍保存在这台设备上，但 GitHub 登录已过期，云端备份已停止。点击重新登录以恢复同步。",
    },
  };

  function normalizeUiLanguage(language) {
    return SUPPORTED_UI_LANGUAGES.has(language) ? language : "en";
  }

  function translateSyncCopy(language, key, params = {}) {
    const normalizedLanguage = normalizeUiLanguage(language);
    const value =
      SYNC_COPY[normalizedLanguage][key] ?? SYNC_COPY.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  /**
   * Registry of supported AI providers. Base URLs and models are fixed for
   * each provider so users never configure them by hand. API key fields are
   * stored side by side so users can switch providers without re-entering keys.
   *
   * Capability flags keep request behavior data-driven: background.js reads
   * them instead of branching on provider ids.
   * - usesThinkingDisabled: the endpoint accepts `thinking: {type: "disabled"}`.
   * - supportsJsonMode: the endpoint accepts `response_format`; providers
   *   without it rely on prompt-only JSON plus the loose parser, and
   *   background.js retries once without `response_format` if an endpoint
   *   still rejects it with HTTP 400.
   */
  const PROVIDERS = Object.freeze({
    deepseek: {
      id: "deepseek",
      name: "DeepSeek V4 Flash",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKeyField: "aiApiKey",
      usesThinkingDisabled: true,
      supportsJsonMode: true,
    },
    minimax: {
      id: "minimax",
      name: "MiniMax M3",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
      apiKeyField: "minimaxApiKey",
      usesThinkingDisabled: false,
      supportsJsonMode: true,
    },
    "opencode-go": {
      id: "opencode-go",
      name: "OpenCode Go · DeepSeek V4 Flash",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4-flash",
      apiKeyField: "opencodeGoApiKey",
      usesThinkingDisabled: false,
      supportsJsonMode: true,
    },
  });

  const DEFAULT_PROVIDER_ID = "deepseek";
  const KEY_FIELDS = Object.freeze(
    Object.values(PROVIDERS).map((provider) => provider.apiKeyField),
  );

  function isKnownProvider(id) {
    return Object.hasOwn(PROVIDERS, id);
  }

  function getProvider(id) {
    return PROVIDERS[isKnownProvider(id) ? id : DEFAULT_PROVIDER_ID];
  }

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalizeKey(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalize(input = {}) {
    const legacyCustom = isLegacyCustom(input);
    const providerId = isKnownProvider(input.provider)
      ? input.provider
      : DEFAULT_PROVIDER_ID;
    const provider = PROVIDERS[providerId];

    const normalized = {
      provider: providerId,
      // The legacy "custom" provider never reuses its old AI key: the wrong
      // key could silently be sent to a different service.
      aiApiKey: legacyCustom ? "" : normalizeKey(input.aiApiKey),
      minimaxApiKey: normalizeKey(input.minimaxApiKey),
      opencodeGoApiKey: normalizeKey(input.opencodeGoApiKey),
      supadataApiKey: normalizeKey(input.supadataApiKey),
      // Derived from the provider registry and kept only for storage
      // compatibility with earlier releases. Production code reads the
      // registry; do not treat these fields as configurable.
      aiBaseUrl: provider.baseUrl,
      aiModel: provider.model,
    };
    if (legacyCustom) normalized.aiApiKey = "";
    return normalized;
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl(providerId) {
    return `${getProvider(providerId).baseUrl}/chat/completions`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  return {
    STORAGE_KEY,
    SERVER_BASE_URL,
    GITHUB_SESSION_KEY,
    SYNC_SESSION_EXPIRED,
    SYNC_EXPIRED_KEY,
    UI_LANGUAGE_STORAGE_KEY,
    SYNC_COPY,
    normalizeUiLanguage,
    translateSyncCopy,
    PROVIDERS,
    KEY_FIELDS,
    getProvider,
    isKnownProvider,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
