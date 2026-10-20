/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 * 3. Adding a timestamped "Note" button to the player controls
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 *
 * ------------------------------------------------------------------
 * HOW THE INJECTED UI IS STYLED
 * ------------------------------------------------------------------
 * The controls this script adds are part of the product, so every colour,
 * font and radius they use comes from the shared design tokens.
 *
 * tokens.css holds those tokens, but a content script cannot load it: the
 * stylesheet is served from the extension origin and the page decides what
 * it is allowed to load. So tokens.js mirrors the token values as
 * JavaScript (tests/tokens-sync.test.js proves the mirror cannot drift),
 * and this script turns them into ONE stylesheet that the document adopts.
 *
 * A constructable stylesheet is not something the page loads, so the page's
 * Content Security Policy does not apply to it. The injected UI therefore
 * renders with the product's tokens whatever the page allows, and nothing is
 * written into the page's DOM to carry the styling.
 *
 * The split between the two is deliberate:
 *   - Geometry (position, size, padding, flex) stays inline, because the
 *     page's own stylesheet must not be able to resize or reflow a control
 *     that sits inside YouTube's toolbar.
 *   - Appearance (colour, type, radius, shadow, hover, focus) comes from
 *     the token stylesheet, because that is what has to follow the theme.
 */

// ============================================================
// GLOBAL STATE
// ============================================================

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

let ytdNoteButton = null;
let ytdNoteLabel = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let ytdDigestLabel = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;

// ============================================================
// DESIGN TOKENS
// ============================================================

/**
 * tokens.js is loaded before this file by the manifest, so the shared token
 * table is already on the isolated world's global. It holds the same values
 * as tokens.css, which a content script cannot load: the stylesheet is
 * served from the extension origin and the page decides what it may load.
 */
const TOKEN_TABLE = globalThis.YTD_TOKENS || null;

/**
 * Every element this script injects carries this class, so a single rule
 * hands them all the same token values.
 */
const UI_CLASS = "ytd-ui";

/**
 * The token names as custom properties. The prefix keeps the page's own
 * custom properties out of the way: the page is free to use --accent.
 */
function tokenProperty(name) {
  return name.replace(/^--/, "--yd-");
}

function tokenDeclarations(tokens, indent = "  ") {
  return Object.entries(tokens)
    .map(([name, value]) => `${indent}${tokenProperty(name)}: ${value};`)
    .join("\n");
}

/**
 * Builds the one stylesheet that styles every control this script adds.
 *
 * The tokens are declared twice: once for the light theme, and once for
 * the dark theme. Which one applies is decided per control, because the
 * page decides: YouTube has an appearance setting of its own, and it does
 * not always follow the system.
 */
function buildInjectedStylesheet() {
  if (!TOKEN_TABLE) return "";

  const light = tokenDeclarations(TOKEN_TABLE.light);
  const dark = tokenDeclarations(TOKEN_TABLE.dark);

  return `
.${UI_CLASS} {
${light}
}

.${UI_CLASS}[data-theme="dark"] {
${dark}
}

/* ============================================================
   DIGEST BUTTON — the primary action, filled with the accent.
   ============================================================ */
#ytd-digest-button {
  background: var(--yd-accent-solid);
  color: var(--yd-on-accent);
  border-radius: var(--yd-r-lg);
  font-family: var(--yd-font-sans);
  font-size: var(--yd-fs-lg);
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.18s ease,
    transform 0.1s ease,
    opacity 0.18s ease;
}

#ytd-digest-button:hover:not(:disabled) {
  background: var(--yd-accent-hover);
  transform: scale(1.02);
}

#ytd-digest-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}

#ytd-digest-button:focus-visible {
  outline: 2px solid var(--yd-focus-ring);
  outline-offset: 2px;
}

/* ============================================================
   NOTE BUTTON — floats over the player, appears with the mouse.
   ============================================================ */
#ytd-note-button {
  background: var(--yd-accent-solid);
  color: var(--yd-on-accent);
  border-radius: var(--yd-r-pill);
  font-family: var(--yd-font-sans);
  font-size: var(--yd-fs-md);
  font-weight: 600;
  letter-spacing: 0.2px;
  box-shadow: var(--yd-shadow-accent);
  cursor: pointer;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;
}

#ytd-note-button svg {
  margin-right: 7px;
}

#ytd-note-button[data-state="idle"]:hover {
  background: var(--yd-accent-hover);
  box-shadow: var(--yd-shadow-accent-lg);
  transform: translateY(-1px);
}

#ytd-note-button[data-state="saving"] {
  opacity: 0.85;
  pointer-events: none;
}

#ytd-note-button[data-state="saved"] {
  background: var(--yd-sage);
  color: var(--yd-on-accent);
}

#ytd-note-button[data-state="error"] {
  background: var(--yd-danger);
  color: var(--yd-on-accent);
}

#ytd-note-button[data-hidden="true"] {
  opacity: 0;
  pointer-events: none;
}

#ytd-note-button:focus-visible {
  outline: 2px solid var(--yd-focus-ring);
  outline-offset: 2px;
}

/* ============================================================
   TOAST — the page's own notification surface.
   ============================================================ */
.ytd-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 999999;
  max-width: 350px;
  padding: 16px 20px;
  background: var(--yd-surface);
  border: 1px solid var(--yd-border);
  border-radius: var(--yd-r-lg);
  box-shadow: var(--yd-shadow-lg);
  color: var(--yd-text);
  font-family: var(--yd-font-sans);
  animation: ytd-toast-in 0.3s ease;
}

.ytd-toast[data-leaving="true"] {
  animation: ytd-toast-in 0.3s ease reverse;
}

.ytd-toast-title {
  margin-bottom: 6px;
  color: var(--yd-accent);
  font-weight: 700;
}

.ytd-toast-subtitle {
  margin-bottom: 8px;
  color: var(--yd-text-secondary);
  font-size: var(--yd-fs-sm);
}

.ytd-toast-body {
  color: var(--yd-text);
  font-size: var(--yd-fs-md);
  line-height: var(--yd-lh-body);
}

.ytd-toast-footer {
  margin-top: 10px;
}

/* A link that is also a target: small, but still big enough to hit, and
   bounded by the functional border so it reads as a control. */
.ytd-toast-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  padding: 4px 10px;
  border: 1px solid var(--yd-border-strong);
  border-radius: var(--yd-r-sm);
  background: var(--yd-accent-dim);
  color: var(--yd-accent);
  font-family: var(--yd-font-sans);
  font-size: var(--yd-fs-sm);
  font-weight: 600;
  text-decoration: none;
}

.ytd-toast-link:hover {
  background: var(--yd-accent-tint);
  color: var(--yd-accent-hover);
}

.ytd-toast-link:focus-visible {
  outline: 2px solid var(--yd-focus-ring);
  outline-offset: 2px;
}

@keyframes ytd-toast-in {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
`;
}

/**
 * Installs the token stylesheet on the document.
 *
 * A constructable stylesheet is the first choice because the page's Content
 * Security Policy does not govern it: it is not a resource the page loads.
 * If the browser refuses it, the same CSS is added as a <style> element,
 * which a page with a strict style-src can still block; the controls then
 * keep their geometry but lose their colours.
 */
function installInjectedStyles() {
  const cssText = buildInjectedStylesheet();
  if (!cssText) {
    console.error(
      "[YouTube Digest] tokens.js is not loaded, so the injected UI cannot be styled.",
    );
    return "none";
  }

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return "constructed";
  } catch (err) {
    debugLog("[YouTube Digest] Constructable stylesheet refused:", err);
  }

  try {
    const style = document.createElement("style");
    style.textContent = cssText;
    document.head.appendChild(style);
    return "style-element";
  } catch (err) {
    console.error("[YouTube Digest] Could not style the injected UI:", err);
    return "none";
  }
}

const INJECTED_STYLE_METHOD = installInjectedStyles();

// ============================================================
// THE PAGE'S THEME
// ============================================================

/**
 * Which theme the page is in.
 *
 * YouTube has an appearance setting of its own and it does not always
 * follow the system: a person can ask for a dark YouTube on a light
 * system, or a light YouTube on a dark system. The controls we inject sit
 * on the page, so they follow the page. Following the system instead puts
 * a dark button on a light page, which is what the page itself does when
 * it is asked to be light.
 */
let ytdPageTheme = "light";

function parsePaint(color) {
  const match =
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(
      String(color || "").trim(),
    );
  if (!match) return null;
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function paintLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * YouTube says so itself when it is dark: the document element carries a
 * "dark-theme" marker. That marker comes first, because the page's own
 * background can live on an inner element and stay white even when the
 * page around the controls is dark.
 */
function pageThemeMarker() {
  const root = document.documentElement;
  if (!root) return null;
  if (root.getAttribute("dark-theme") !== null) return "dark";

  const className = typeof root.className === "string" ? root.className : "";
  if (className.split(/\s+/).includes("dark-theme")) return "dark";

  return null;
}

/**
 * Reads the theme off the page's own paint. YouTube paints its background
 * dark when it is dark, so the colour of the page is the truth, whichever
 * way YouTube decides to get there.
 */
function detectPageTheme() {
  const marker = pageThemeMarker();
  if (marker) return marker;

  /* The page the controls sit on is the YouTube app; the document itself
     may be painted by something else entirely. */
  const surfaces = [];
  for (const selector of ["ytd-app", "yt-app-layout"]) {
    const element = document.querySelector(selector);
    if (element) surfaces.push(element);
  }
  surfaces.push(document.documentElement, document.body);

  for (const surface of surfaces) {
    const parsed = parsePaint(
      window.getComputedStyle(surface).backgroundColor,
    );
    if (!parsed || parsed.alpha === 0) continue;
    return paintLuminance(parsed.rgb) < 0.5 ? "dark" : "light";
  }

  // Nothing to measure: fall back to the system.
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch (err) {
    return "light";
  }
}

/**
 * Repaints the controls already on the page when the page changes theme.
 */
function refreshPageTheme() {
  const theme = detectPageTheme();
  if (theme === ytdPageTheme) return;
  ytdPageTheme = theme;
  document
    .querySelectorAll(`.${UI_CLASS}`)
    .forEach((element) => element.setAttribute("data-theme", theme));
}

function watchPageTheme() {
  refreshPageTheme();

  // YouTube repaints itself when its appearance changes.
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => refreshPageTheme()).observe(
      document.documentElement,
      {
        attributes: true,
        attributeFilter: ["class", "style", "dark-theme"],
      },
    );
  }

  // The system can change under the page.
  try {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    if (query && typeof query.addEventListener === "function") {
      query.addEventListener("change", () => refreshPageTheme());
    }
  } catch (err) {
    // No media query support: the page's own repaint is enough.
  }
}

/**
 * Stamps the page's theme onto a control that was just injected.
 */
function applyPageTheme(element) {
  element.setAttribute("data-theme", ytdPageTheme);
}

// ============================================================
// INTERFACE LANGUAGE
// ============================================================

/**
 * The interface languages the product ships. The same setting drives the
 * side panel, the settings page and the controls on the YouTube page.
 */
const SUPPORTED_LANGUAGES = ["en", "zh-CN"];

/**
 * The wording the injected controls use. English is the fallback: a key a
 * language does not have falls back to the English wording, exactly as the
 * side panel does it.
 */
const PANEL_COPY = {
  en: {
    digest: "Digest",
    opening: "Opening…",
    note: "Note",
    saving: "Saving…",
    saved: "Saved",
    error: "Error",
    noteSaved: "Note saved",
    copied: "Copied",
    openDigestAriaLabel: "Open YouTube Digest",
    couldNotOpenPanel: "Could not open the panel",
    openPanelHint:
      "Click the YouTube Digest icon in the Chrome toolbar to open the side panel.",
    couldNotSaveNote: "Could not save the note",
    videoNotPlaying:
      "The video is not playing yet. Wait for it to start and try again.",
    notAVideoPage:
      "This page does not look like a YouTube video. Open the video itself and try again.",
    saveFailed:
      "The extension could not reach the page. Try again in a moment.",
    tryAgain: "Try again in a moment.",
    savedAt: "Saved at {timestamp}.",
    savedToVideo: "The note was saved to this video.",
  },
  "zh-CN": {
    digest: "摘要",
    opening: "打开中…",
    note: "笔记",
    saving: "保存中…",
    saved: "已保存",
    error: "出错",
    noteSaved: "笔记已保存",
    copied: "已复制",
    /* The accessible name has to contain the visible label, so the wording
       the button shows ("摘要") is part of it. */
    openDigestAriaLabel: "打开 YouTube Digest 摘要面板",
    couldNotOpenPanel: "打不开侧边栏",
    openPanelHint:
      "请点击 Chrome 工具栏里的 YouTube Digest 图标来打开侧边栏。",
    couldNotSaveNote: "没能保存笔记",
    videoNotPlaying: "视频还没开始播放，等它播起来再试一次。",
    notAVideoPage:
      "这个页面看起来不是 YouTube 视频页，打开视频本身再试一次。",
    saveFailed: "扩展没能连上页面，过一会儿再试一次。",
    tryAgain: "过一会儿再试一次。",
    savedAt: "已保存在 {timestamp}。",
    savedToVideo: "笔记已经保存到这个视频。",
  },
};

let panelLanguage = "en";

/**
 * The language the interface is written in. Anything that is not a language
 * the product ships falls back to English.
 */
function normalizePanelLanguage(language) {
  return SUPPORTED_LANGUAGES.includes(language) ? language : "en";
}

/**
 * The wording for one language, with English filling in every key that
 * language does not have.
 */
function copyFor(language, table = PANEL_COPY) {
  const chosen = table[normalizePanelLanguage(language)] || table.en;
  return { ...table.en, ...chosen };
}

function panelCopy(key, params = {}) {
  const value = copyFor(panelLanguage)[key] ?? "";
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * Writes the current language onto the controls already on the page. The
 * controls are never re-injected: that would interrupt whatever the user
 * is doing on the page.
 */
function applyPanelCopy() {
  if (ytdDigestButton && ytdDigestLabel && !ytdDigestButton.disabled) {
    ytdDigestLabel.textContent = panelCopy("digest");
  }
  if (ytdDigestButton) {
    ytdDigestButton.setAttribute(
      "aria-label",
      panelCopy("openDigestAriaLabel"),
    );
  }
  if (ytdNoteButton && ytdNoteLabel) {
    if (ytdNoteButton.getAttribute("data-state") === "idle") {
      ytdNoteLabel.textContent = panelCopy("note");
    }
  }
}

function setPanelLanguage(language) {
  panelLanguage = normalizePanelLanguage(language);
  applyPanelCopy();
}

/**
 * Reads the interface language the user picked on the settings page.
 *
 * The content script cannot read storage: the background restricts storage
 * to trusted contexts on purpose, so that the page can never reach the
 * user's API keys. It asks the background instead, which is a trusted
 * context. Never throws: the controls must still work without it.
 */
async function loadPanelLanguage() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getUiLanguage",
    });
    setPanelLanguage(result?.language);
  } catch (error) {
    setPanelLanguage("en");
  }
}


// ============================================================
// VIDEO ID
// ============================================================

/**
 * A YouTube video ID is a short opaque string. Anything else is not a video
 * ID, and passing one on would store a broken link.
 */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * Reads the video ID out of wherever YouTube put it.
 *
 * YouTube serves the same video from several shapes of URL: the watch page
 * carries it in the query string, the short link and the embed, short and
 * live pages carry it in the path. A page that only looks at the query
 * string finds nothing on the others, and a note saved from such a page
 * has no video to point at.
 */
function extractVideoId(location) {
  let url;
  try {
    url = new URL(location.href);
  } catch (err) {
    return null;
  }

  const candidates = [];

  // youtu.be/<id> — the short link, which carries no query string at all.
  if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") {
    candidates.push(url.pathname.split("/")[1]);
  }

  // watch?v=<id>, and the query string every YouTube page keeps.
  candidates.push(url.searchParams.get("v"));

  // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  const VIDEO_PATH_PREFIXES = ["embed", "shorts", "live", "v"];
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length >= 2 &&
    VIDEO_PATH_PREFIXES.includes(segments[0].toLowerCase())
  ) {
    candidates.push(segments[1]);
  }

  for (const candidate of candidates) {
    if (candidate && VIDEO_ID_PATTERN.test(candidate)) return candidate;
  }

  return null;
}

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // The controls follow the page's theme and the user's language.
  watchPageTheme();
  void loadPanelLanguage();

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[YouTube Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[YouTube Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[YouTube Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video.html5-main-video");
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp (in seconds)
    debugLog("[YouTube Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "uiLanguageChanged") {
    // The background tells the page when the language changes, because the
    // content script cannot watch storage itself.
    setPanelLanguage(message.language);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[YouTube Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YouTube Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.className = UI_CLASS;
  digestButton.setAttribute("aria-label", panelCopy("openDigestAriaLabel"));
  // The label changes while the panel opens, so screen readers are told
  // about the state change instead of only the new text.
  digestButton.setAttribute("aria-live", "polite");

  const label = document.createElement("span");
  label.className = "ytd-digest-label";
  label.textContent = panelCopy("digest");
  digestButton.appendChild(label);

  ytdDigestLabel = label;

  // Geometry only. The page's own stylesheet must not be able to resize or
  // reflow a button that sits inside YouTube's toolbar, so the box is set
  // here and never in the page's hands. Everything the user sees as colour,
  // type or shape comes from the token stylesheet.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    margin-right: 8px;
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  const resetButton = () => {
    label.textContent = panelCopy("digest");
    digestButton.disabled = false;
  };

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[YouTube Digest] Digest button clicked");

    // Give the button a visible state. Chrome only allows sidePanel.open()
    // inside a user gesture, so the request can fail. Without a state the
    // user clicks a terracotta button and nothing happens at all.
    label.textContent = panelCopy("opening");
    digestButton.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[YouTube Digest] openSidePanel response:", result);
      if (result && result.success === false) {
        throw new Error(result.error || "Could not open the side panel.");
      }
      resetButton();
    } catch (err) {
      console.error("[YouTube Digest] Failed to open side panel:", err);
      resetButton();
      showToast(
        panelCopy("couldNotOpenPanel"),
        panelCopy("openPanelHint"),
      );
    }
  });

  ytdDigestButton = digestButton;
  applyPageTheme(digestButton);
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!window.location.pathname.includes("/watch")) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[YouTube Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[YouTube Digest Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[YouTube Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[YouTube Digest Content] Injecting note button");

  // The note button — a pill in the terracotta accent that floats over the
  // player. It starts hidden; visibility is controlled by mouse activity.
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.type = "button";
  noteButton.className = UI_CLASS;
  noteButton.setAttribute("data-state", "idle");

  const noteIcon = document.createElement("span");
  noteIcon.className = "ytd-note-icon";
  noteIcon.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
  `;

  const noteLabel = document.createElement("span");
  noteLabel.className = "ytd-note-label";
  noteLabel.textContent = panelCopy("note");

  noteButton.appendChild(noteIcon);
  noteButton.appendChild(noteLabel);

  // Geometry only: where the button sits over the player. Its colour, type
  // and shape come from the token stylesheet.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    border: none;
  `;

  ytdNoteButton = noteButton;
  ytdNoteLabel = noteLabel;
  applyPageTheme(noteButton);

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  // The button is on the page from the start, so it starts hidden: out of
  // the tab order and out of the screen reader's way until the pointer
  // brings it out.
  hideNoteButton();

  debugLog("[YouTube Digest Content] Note button injected");
}

/**
 * Shows the note button and puts it back in the tab order.
 *
 * A hidden button that is still focusable is a button a keyboard user can
 * land on without ever seeing it, so showing and hiding also move it in and
 * out of the accessibility tree.
 */
function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.setAttribute("data-hidden", "false");
  ytdNoteButton.removeAttribute("aria-hidden");
  ytdNoteButton.removeAttribute("tabindex");
}

/**
 * Hides the note button and takes it out of the tab order and out of the
 * accessibility tree.
 */
function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.setAttribute("data-hidden", "true");
  ytdNoteButton.setAttribute("aria-hidden", "true");
  ytdNoteButton.setAttribute("tabindex", "-1");
}

/**
 * Puts the note button into one of its states: idle, saving, saved or error.
 */
function setNoteButtonState(state, text) {
  if (!ytdNoteButton) return;
  ytdNoteButton.setAttribute("data-state", state);
  if (ytdNoteLabel) ytdNoteLabel.textContent = text;
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/watch")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[YouTube Digest] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest] No video element found");
    showToast(
      panelCopy("couldNotSaveNote"),
      panelCopy("videoNotPlaying"),
    );
    return;
  }

  const videoId = extractVideoId(window.location);
  if (!videoId) {
    console.error(
      "[YouTube Digest] No video ID on this page:",
      window.location.href,
    );
    showToast(
      panelCopy("couldNotSaveNote"),
      panelCopy("notAVideoPage"),
    );
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();

  setNoteButtonState("saving", panelCopy("saving"));

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      setNoteButtonState("saved", panelCopy("saved"));
      if (result.note) {
        showNoteSavedToast(result.note);
      } else {
        showToast(
          panelCopy("noteSaved"),
          panelCopy("savedAt", { timestamp: formatTimestamp(currentTime) }),
        );
      }
    } else {
      setNoteButtonState("error", panelCopy("error"));
      console.error("[YouTube Digest] Save note error:", result.error);
      showToast(
        panelCopy("couldNotSaveNote"),
        panelCopy("tryAgain"),
      );
    }
  } catch (err) {
    setNoteButtonState("error", panelCopy("error"));
    console.error("[YouTube Digest] Save note exception:", err);
    showToast(
      panelCopy("couldNotSaveNote"),
      panelCopy("saveFailed"),
    );
  }

  setTimeout(() => {
    setNoteButtonState("idle", panelCopy("note"));
  }, 2000);
}

/**
 * Turns a number of seconds into the m:ss the product shows everywhere.
 */
function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Shows a toast notification in the bottom-right corner of the page.
 * Every toast on the page uses this builder so they look the same.
 */
function showToast(
  title,
  body,
  {
    id = "ytd-toast",
    subtitle = "",
    footerHtml = "",
    dismissAfter = 5000,
  } = {},
) {
  // Remove existing toast
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = id;
  toast.className = `${UI_CLASS} ytd-toast`;
  applyPageTheme(toast);
  toast.innerHTML = `
    <div class="ytd-toast-title">${escapeHtmlForContent(title)}</div>
    ${subtitle ? `<div class="ytd-toast-subtitle">${escapeHtmlForContent(subtitle)}</div>` : ""}
    <div class="ytd-toast-body">${escapeHtmlForContent(body)}</div>
    ${footerHtml}
  `;

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  if (dismissAfter > 0) {
    setTimeout(() => {
      toast.setAttribute("data-leaving", "true");
      setTimeout(() => toast.remove(), 300);
    }, dismissAfter);
  }

  return toast;
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  if (!note) {
    showToast(panelCopy("noteSaved"), panelCopy("savedToVideo"));
    return;
  }

  const toast = showToast(
    panelCopy("noteSaved"),
    `"${note.text}"`,
    {
      id: "ytd-note-toast",
      subtitle: `${note.timestamp} — ${note.videoTitle}`,
      footerHtml: `
        <div class="ytd-toast-footer">
          <a class="ytd-toast-link" href="${escapeHtmlForContent(note.timestampedUrl)}">Copy link</a>
        </div>
      `,
    },
  );

  // Copy link handler
  const link = toast.querySelector(".ytd-toast-link");
  if (link) {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(note.timestampedUrl);
        e.target.textContent = panelCopy("copied");
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });
  }
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest Content] No video element found for seek");
    return;
  }

  debugLog("[YouTube Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  ytdNoteLabel = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  ["ytd-note-toast", "ytd-toast"].forEach((id) => {
    const existingToast = document.getElementById(id);
    if (existingToast) existingToast.remove();
  });

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});
