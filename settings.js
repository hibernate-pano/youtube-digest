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
  const SERVER_BASE_URL = "https://youtube-digest-server.panbo362472407.workers.dev";
  const GITHUB_SESSION_KEY = "ytd_github_session";

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
