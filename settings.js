/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults, validation, and the reason codes the surfaces agree on, so it is
 * safe to publish.
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
   * The session id some AI gateways route on. The OpenCode Go gateway
   * answers 400 MissingSessionID when the request carries no session
   * header, and it reuses a cached prompt only inside one session. The id
   * belongs to this browser: it is random, stored once, and never leaves
   * the device except as a header on an AI request.
   */
  const AI_SESSION_STORAGE_KEY = "ytd_ai_session";

  /**
   * The gaps between the attempts to read the captions out of the page.
   *
   * YouTube swaps its player response about a second after the user clicks
   * another video, and the panel asks for the subtitles right away, so the
   * first read is often too early. These are the waits between the tries.
   * They add up to under three seconds, which is a spinner the user can
   * wait through, and a credit they never have to pay.
   */
  const LOCAL_CAPTION_RETRY_DELAYS_MS = [400, 600, 800, 1000];

  /**
   * Reason code for a sync request that ran out of time.
   *
   * The sync service is the extension's own backend, so a request that does
   * not answer within its budget means the service is unreachable - it says
   * nothing about the session. The code keeps the two apart: a timeout must
   * never be reported as a dead session, and a dead session must never be
   * reported as a timeout.
   */
  const SYNC_REQUEST_TIMEOUT = "SYNC_REQUEST_TIMEOUT";

  /**
   * Reason code for a transcript request that ran out of time.
   *
   * Same idea as the sync timeout, for the transcript API: a slow answer is
   * worth another try, not a sign-in prompt.
   */
  const TRANSCRIPT_REQUEST_TIMEOUT = "TRANSCRIPT_REQUEST_TIMEOUT";

  /**
   * Reason code for a local write that did not fit into the device's storage.
   *
   * The user has to hear about this one. A note that was never written is a
   * note the user believes is there and is not, and the panel can only say so
   * if the failure arrives as a code it knows.
   */
  const STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED";

  /**
   * How long a request to the sync service may take.
   *
   * The service answers in well under a second. The budget is generous
   * because a phone on a bad connection is not a broken service, but it is
   * finite: an MV3 service worker is suspended after roughly half a minute
   * of idleness, and a request that never ends takes the whole sync down
   * with it.
   */
  const CLOUD_REQUEST_TIMEOUT_MS = 20_000;

  /**
   * How long a transcript request may take.
   *
   * A transcript is a bigger answer than a sync reply, and the API may have
   * to extract the captions first, so it gets a longer budget than the sync
   * requests - and still a finite one.
   */
  const TRANSCRIPT_REQUEST_TIMEOUT_MS = 45_000;

  /**
   * How long the local caption lookup may take.
   *
   * The local path reads the page's own caption tracks and fetches them from
   * YouTube. It is the fast path - a second or two - and it is tried before
   * the paid one. A short deadline keeps a page that never answers from
   * delaying the paid fallback behind it.
   *
   * The first fetch of a video is the slow one: YouTube makes the automatic
   * captions when they are first asked for, and that takes the better part
   * of a minute on a long video. The deadline has to be longer than that
   * fetch, or the read loses a race it would have won a second later.
   */
  const LOCAL_TRANSCRIPT_TIMEOUT_MS = 30_000;

  /**
   * How long the page may be given to make its own caption request.
   *
   * The caption URL the worker can use is the one the page requested, and
   * the page only lists a request once it has finished. Asking the player
   * to load the track starts that request; on a video whose captions YouTube
   * has not made yet, it answers in seconds rather than milliseconds. A
   * deadline shorter than that turns every fresh video into a failure the
   * user has to ask about again.
   */
  const LOCAL_CAPTION_REQUEST_TIMEOUT_MS = 25_000;

  /**
   * Interface language preference. The settings page owns the preference, but
   * the side panel reads the same key so the shared GitHub sync header speaks
   * the same language the user picked there.
   */
  const UI_LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const SUPPORTED_UI_LANGUAGES = new Set(["en", "zh-CN"]);

  /**
   * Where the pending sign-in's nonce is kept.
   *
   * The nonce is only needed between asking for the sign-in and finishing
   * it, so it lives in the session store: it is gone when the browser
   * closes, and it is never part of the user's saved data.
   */
  const PENDING_LOGIN_NONCE_KEY = "ytd_pending_login_nonce";

  /**
   * Local storage namespace for saved notes.
   *
   * The namespace depends on the signed-in account so one learner's notes
   * never show up in another account's view: "ytd_notes" while signed out,
   * "ytd_notes_<githubId>" while signed in.
   *
   * This lives here because three different surfaces need to agree on it -
   * the sync layer writes it, the settings page deletes it, and the panel
   * reads it. When the rule lived only in cloud-sync.js, the settings page
   * deleted the signed-out key and silently left every note of a signed-in
   * user on the device while telling them the notes were gone.
   */
  const NOTES_STORAGE_KEY = "ytd_notes";

  /**
   * How many notes the local store keeps.
   *
   * The cap exists so the store cannot grow without bound, but a note that
   * disappears without a word is a note the user lost. So the number lives
   * here, in one place, and both the store that enforces it and the panel
   * that shows it read it from here. When the cap changes, the count the
   * user sees changes with it.
   */
  const MAX_LOCAL_NOTES = 100;

  /**
   * Where the store records that it had to drop notes.
   *
   * The panel reads this key and tells the user how many notes went, so
   * the loss is a fact on the screen and not a silent truncation.
   */
  const NOTES_DROPPED_KEY = "ytd_notes_dropped";

  /**
   * The drop record for one account.
   *
   * Notes are namespaced per account, so the record of a loss has to be too:
   * a drop that happened while signed in must not be shown to the same user
   * after they signed out and are looking at a different, much smaller store.
   */
  function notesDroppedKey(githubId) {
    const id = String(githubId || "").trim();
    return id ? `${NOTES_DROPPED_KEY}_${id}` : NOTES_DROPPED_KEY;
  }

  function notesStorageKey(githubId) {
    const id = String(githubId || "").trim();
    return id ? `${NOTES_STORAGE_KEY}_${id}` : NOTES_STORAGE_KEY;
  }

  /**
   * True for every storage key that holds saved notes, whatever account
   * they belong to. Used when wiping notes so no namespace is missed.
   *
   * The account id is always numeric, so only a numeric suffix counts.
   * A plain prefix check would also swallow unrelated keys that happen to
   * start with "ytd_notes_" - "ytd_notes_filter" holds the panel's notes
   * filter and must survive a notes wipe.
   */
  function isNotesStorageKey(key) {
    const name = String(key || "");
    if (name === NOTES_STORAGE_KEY) return true;
    if (!name.startsWith(`${NOTES_STORAGE_KEY}_`)) return false;
    return /^\d+$/.test(name.slice(NOTES_STORAGE_KEY.length + 1));
  }

  /**
   * The vocabulary notebook's storage namespace.
   *
   * Same rule as the notes: one namespace per account, so one learner's
   * words never show up in another account's view. It lives here for the
   * same reason the notes namespace does - the sync layer writes it and
   * the panel reads it, and a rule that only exists in one of them drifts.
   */
  const VOCABULARY_STORAGE_KEY = "ytd_vocabulary";

  function vocabularyStorageKey(githubId) {
    const id = String(githubId || "").trim();
    return id ? `${VOCABULARY_STORAGE_KEY}_${id}` : VOCABULARY_STORAGE_KEY;
  }

  /**
   * True for every storage key that holds saved words.
   */
  function isVocabularyStorageKey(key) {
    const name = String(key || "");
    if (name === VOCABULARY_STORAGE_KEY) return true;
    if (!name.startsWith(`${VOCABULARY_STORAGE_KEY}_`)) return false;
    return /^\d+$/.test(name.slice(VOCABULARY_STORAGE_KEY.length + 1));
  }

  /**
   * How many words the local store keeps.
   *
   * The cap exists so the store cannot grow without bound, but a word that
   * disappears without a word is a word the user lost - and a word is
   * exactly what a learner cannot afford to lose. So the number lives
   * here, in one place, and both the store that enforces it and the panel
   * that shows it read it from here.
   */
  const MAX_LOCAL_VOCABULARY = 500;

  /**
   * Where the store records that it had to drop words.
   *
   * The panel reads this key and tells the user how many words went, so
   * the loss is a fact on the screen and not a silent truncation.
   */
  const VOCABULARY_DROPPED_KEY = "ytd_vocabulary_dropped";

  /**
   * The drop record for one account.
   *
   * Words are namespaced per account, so the record of a loss has to be
   * too: a drop that happened while signed in must not be shown to the
   * same user after they signed out and are looking at a different, much
   * smaller store.
   */
  function vocabularyDroppedKey(githubId) {
    const id = String(githubId || "").trim();
    return id ? `${VOCABULARY_DROPPED_KEY}_${id}` : VOCABULARY_DROPPED_KEY;
  }

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
      // This gateway routes on a session id and answers 400 MissingSessionID
      // without one. The header name is the gateway's own, so it sits in the
      // registry next to the base URL and the model.
      sessionHeader: "x-opencode-session",
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

  /**
   * Turns a position inside a video into the stamp the whole product shows.
   *
   * Under an hour the stamp is M:SS. From an hour on it is H:MM:SS, because
   * "90:00" is unreadable on its own: a reader who sees it cannot tell
   * ninety minutes from ninety seconds, and clicking the wrong one lands
   * them a whole hour off. One hour, one minute and one second are written
   * "1:00:00" and "1:01:01"; the hour is not padded.
   *
   * Every surface that shows a position goes through here: the panel, the
   * transcript, the notes, the cloud copy of a note and the markers the
   * model reads. That is deliberate. When the reader's stamp and the
   * model's marker were produced by different code, they could drift apart,
   * and a chapter the model placed at 1:30:00 would be shown as 90:00.
   *
   * @param {number} seconds - The position inside the video.
   * @returns {string} The stamp, e.g. "0:59", "1:00", "1:30:00".
   */
  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes < 60) {
      return `${minutes}:${String(rest).padStart(2, "0")}`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  /**
   * Reads a stamp back into seconds.
   *
   * Two shapes exist. A video under an hour is stamped "M:SS", where the
   * minutes may run past 59 — "90:00" is the ninetieth minute, not ninety
   * seconds. A video over an hour is stamped "H:MM:SS". Two fields are
   * minutes and seconds, three fields are hours, minutes and seconds.
   *
   * The short shape is still read on purpose: a transcript cached by an
   * older release carries it, and that cached text is still analyzed after
   * an update. Reading only the long shape would make a ninety-minute
   * video look an hour shorter than it is, and the chapters would stop
   * early without anything failing.
   *
   * @param {string} value - A stamp, with or without its brackets.
   * @returns {number|null} The position in seconds, or null when unreadable.
   */
  function parseTimestampToSeconds(value) {
    const text = value === null || value === undefined ? "" : String(value).trim();
    const match = text.match(/^\[?(\d+):(\d{2})(?::(\d{2}))?\]?$/);
    if (!match) return null;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (match[3] === undefined) return first * 60 + second;
    return first * 3600 + second * 60 + Number(match[3]);
  }

  /**
   * The URL that starts the GitHub sign-in.
   *
   * The language travels with the request, because the page the user lands
   * on after GitHub is served by the sync service, not by the extension.
   * Without it, a reader who picked Chinese would be greeted in English.
   *
   * The nonce ties the sign-in to this client: the sync service hands it
   * back with the token, and a token that arrives without it is not ours.
   */
  function buildGithubLoginUrl(language, baseUrl, nonce) {
    const base = String(baseUrl || "").replace(/\/+$/, "");
    if (!base) throw new Error("The sync service URL is not configured.");
    const normalized = normalizeUiLanguage(language);
    const params = [`lang=${encodeURIComponent(normalized)}`];
    const cleanNonce = String(nonce || "").trim();
    if (/^[A-Za-z0-9_-]{16,64}$/.test(cleanNonce)) {
      params.push(`nonce=${encodeURIComponent(cleanNonce)}`);
    }
    return `${base}/api/auth/login?${params.join("&")}`;
  }

  /**
   * A random value that ties a sign-in to the client that started it.
   *
   * The sync service gives the nonce back with the token. A link that
   * carries somebody else's token carries no nonce, so it is ignored:
   * without this, a crafted link could switch the user to another account
   * and hand that account the notes saved on this device.
   */
  function createLoginNonce() {
    if (typeof crypto === "undefined" || !crypto.getRandomValues) return "";
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let nonce = "";
    for (const byte of bytes) nonce += byte.toString(16).padStart(2, "0");
    return nonce;
  }

  /**
   * True when a storage write failed because the device's storage is full.
   *
   * Chrome names the failure QuotaExceededError, but the message is all some
   * environments give, so both are looked at. A write that failed for any
   * other reason must not be treated as a full disk: the recovery for a full
   * disk throws data away, and that is the wrong thing to do to a note.
   */
  function isQuotaExceededError(error) {
    if (!error) return false;
    if (String(error.name || "") === "QuotaExceededError") return true;
    return /quota/i.test(String(error.message || ""));
  }

  /**
   * Runs a request under a deadline.
   *
   * A request that hangs must not hang the extension. The MV3 service worker
   * is suspended while it waits, the sync stops in the middle, and the user
   * is left with a spinner that never resolves.
   *
   * The deadline is enforced twice on purpose. An AbortController cancels the
   * request when the platform offers one, and the race rejects the promise
   * even when it does not - so the caller always gets an answer, and the
   * answer is the reason code the surface needs.
   *
   * @param {function(AbortSignal|undefined): Promise} request the request to run
   * @param {number} timeoutMs how long it may take
   * @param {function(): Error} onTimeout builds the error the deadline reports
   */
  function withRequestTimeout(request, timeoutMs, onTimeout) {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    let timerId = null;
    const deadline = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        if (controller) {
          try {
            controller.abort();
          } catch (error) {
            // The request is already gone; the deadline still reports.
          }
        }
        reject(
          typeof onTimeout === "function"
            ? onTimeout()
            : new Error("The request timed out."),
        );
      }, timeoutMs);
    });
    const started = (() => {
      try {
        return controller ? request(controller.signal) : request();
      } catch (error) {
        // A request that throws before it returns a promise still has to
        // reach the caller, and the deadline has to be cleaned up.
        return Promise.reject(error);
      }
    })();
    // The deadline can win while the request is still on the wire. Its own
    // failure is then nobody's job, and an unhandled rejection would take the
    // service worker down with it.
    Promise.resolve(started).catch(() => {});
    return Promise.race([started, deadline]).finally(() => {
      if (timerId !== null) clearTimeout(timerId);
    });
  }

  return {
    STORAGE_KEY,
    SERVER_BASE_URL,
    GITHUB_SESSION_KEY,
    SYNC_SESSION_EXPIRED,
    SYNC_EXPIRED_KEY,
    AI_SESSION_STORAGE_KEY,
    LOCAL_CAPTION_RETRY_DELAYS_MS,
    SYNC_REQUEST_TIMEOUT,
    TRANSCRIPT_REQUEST_TIMEOUT,
    STORAGE_QUOTA_EXCEEDED,
    CLOUD_REQUEST_TIMEOUT_MS,
    TRANSCRIPT_REQUEST_TIMEOUT_MS,
    LOCAL_TRANSCRIPT_TIMEOUT_MS,
    LOCAL_CAPTION_REQUEST_TIMEOUT_MS,
    UI_LANGUAGE_STORAGE_KEY,
    PENDING_LOGIN_NONCE_KEY,
    NOTES_STORAGE_KEY,
    MAX_LOCAL_NOTES,
    NOTES_DROPPED_KEY,
    notesStorageKey,
    notesDroppedKey,
    isNotesStorageKey,
    VOCABULARY_STORAGE_KEY,
    vocabularyStorageKey,
    isVocabularyStorageKey,
    MAX_LOCAL_VOCABULARY,
    VOCABULARY_DROPPED_KEY,
    vocabularyDroppedKey,
    SYNC_COPY,
    normalizeUiLanguage,
    translateSyncCopy,
    buildGithubLoginUrl,
    createLoginNonce,
    isQuotaExceededError,
    withRequestTimeout,
    PROVIDERS,
    KEY_FIELDS,
    getProvider,
    isKnownProvider,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
    formatTimestamp,
    parseTimestampToSeconds,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
