/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
// cloud-sync.js holds the GitHub-account sync layer (notes, vocabulary,
// reviews, OAuth); it never touches AI code.
importScripts("settings.js", "cloud-sync.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

/**
 * The YouTube content script is not a trusted context: it cannot read
 * storage and cannot watch storage for changes. So it asks the background
 * for the interface language, and the background tells it when the
 * language changes.
 */
async function getUiLanguage() {
  const key = YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || "en";
}

/**
 * Tells the content scripts on open YouTube tabs that the interface
 * language changed, so the buttons already on the page follow it.
 */
function notifyContentScriptsOfLanguage(language) {
  try {
    chrome.tabs
      .query({ url: "https://www.youtube.com/*" })
      .then((tabs) => {
        (tabs || []).forEach((tab) => {
          chrome.tabs
            .sendMessage(tab.id, {
              action: "uiLanguageChanged",
              language,
            })
            .catch(() => {});
        });
      })
      .catch(() => {});
  } catch (error) {
    // No tabs API: the page keeps the language it has until it reloads.
  }
}

// The listener is optional chaining because a page without the storage event
// must not stop the service worker from starting.
chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const change = changes[YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY];
  if (!change) return;
  notifyContentScriptsOfLanguage(change.newValue);
});

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

/**
 * Returns the API key of the currently active AI provider. Keys for inactive
 * providers are kept in storage but never sent on requests.
 */
function getActiveAiKey(settings) {
  const provider = YTD_SETTINGS.getProvider(settings.provider);
  return settings[provider.apiKeyField] || "";
}

function getActiveProvider(settings) {
  return YTD_SETTINGS.getProvider(settings.provider);
}

/**
 * The session id for the AI gateways that route on one.
 *
 * The OpenCode Go gateway answers 400 MissingSessionID when the request
 * carries no session header, and it only reuses a prompt it already read
 * inside the same session. So the same id goes out on every request.
 *
 * The id is random and belongs to this browser. It says nothing about the
 * user, and two people never share one.
 */
let aiSessionIdPromise = null;

function createAiSessionId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // A browser without randomUUID still needs a stable id.
  return `ytd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function getAiSessionId() {
  if (!aiSessionIdPromise) {
    aiSessionIdPromise = (async () => {
      const key = YTD_SETTINGS.AI_SESSION_STORAGE_KEY;
      try {
        const stored = await chrome.storage.local.get(key);
        const existing = String(stored?.[key] || "").trim();
        if (existing) return existing;
        const created = createAiSessionId();
        await chrome.storage.local.set({ [key]: created });
        return created;
      } catch (error) {
        // The id only has to hold still while this worker lives. A storage
        // failure must not stop the AI request itself.
        return createAiSessionId();
      }
    })();
  }
  return aiSessionIdPromise;
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  const provider = getActiveProvider(settings);
  if (!getActiveAiKey(settings)) {
    const error = new Error(
      `${provider.name} API key not configured. Open YouTube Digest Settings.`,
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  // Capability flags live in the provider registry so request behavior stays
  // data-driven instead of provider-specific branches.
  if (provider.supportsJsonMode && responseFormat) {
    body.response_format = responseFormat;
  }
  if (provider.usesThinkingDisabled) {
    body.thinking = { type: "disabled" };
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  let sentResponseFormat = !!body.response_format;
  const headers = {
    "Content-Type": "application/json",
    // Always the active provider's own key: keys for inactive
    // providers are stored side by side but must never be sent.
    Authorization: `Bearer ${getActiveAiKey(settings)}`,
  };
  // Some gateways route on a session id and answer 400 without one. Which
  // header that is comes from the provider registry, not from a branch here.
  if (provider.sessionHeader) {
    headers[provider.sessionHeader] = await getAiSessionId();
  }
  try {
    let response;
    let data;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(
        YTD_SETTINGS.chatCompletionsUrl(settings.provider),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      // Receiving headers proves the provider is still making progress. The
      // provider may then send blank-line body chunks while a non-streaming
      // request queues.
      resetIdleTimeout();

      try {
        data = await readBoundedAiResponse(response, resetIdleTimeout);
      } catch (readError) {
        // An error body that is not JSON (e.g. a plain-text 400) must still
        // reach the status handling below so the request can be retried or
        // reported with the provider's status instead of a parse error.
        data = null;
        if (response.ok) throw readError;
      }
      // Safety net for endpoints that reject `response_format` with HTTP 400
      // despite the registry declaring JSON mode support: retry once without
      // the field before surfacing the error. The loose JSON parser tolerates
      // fences and stray prose, so prompt-only JSON still works.
      if (
        response.ok ||
        !(response.status === 400 && sentResponseFormat && attempt === 0)
      ) {
        break;
      }
      delete body.response_format;
      sentResponseFormat = false;
    }

    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      let message =
        errorData.error?.message ||
        errorData.message ||
        `AI provider error: ${response.status}`;
      if (response.status === 400) {
        message =
          `${message} (HTTP 400). The ${provider.name} model or request ` +
          "format may no longer be supported by this provider.";
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("AI provider returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "AI provider request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "AI provider request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("AI provider response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  if (!(tab.url || "").startsWith("https://www.youtube.com")) {
    void updatePanelForTab(tab.id, tab.url, tab.windowId);
    return;
  }

  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
async function closePanelForTab(tabId, windowId) {
  // Chrome 141 added an explicit close API. On older supported versions,
  // disabling the tab-specific panel below remains the compatibility path.
  if (typeof chrome.sidePanel.close !== "function") return;

  try {
    // This closes the tab-specific panel used by YouTube Digest.
    await chrome.sidePanel.close({ tabId });
    return;
  } catch (error) {
    // Chrome 145+ rejects tabId when the visible instance is global. Close
    // that instance by window instead.
  }

  if (Number.isInteger(windowId)) {
    await chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

async function updatePanelForTab(tabId, url, windowId) {
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  if (!isYouTube) {
    // Close the visible instance first. Then disable this tab so Chrome cannot
    // reopen the global default panel as navigation settles.
    await closePanelForTab(tabId, windowId);
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  // setOptions can reject if the tab just closed. Ignore that harmlessly.
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(() => {});
}

/**
 * Gets the best URL from a tab update that can change panel availability.
 * Chrome can apply tab-specific side-panel state before a navigation commits,
 * then reset it during the commit. Handling loading and complete gives the
 * first non-YouTube navigation a reliable second reconciliation.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// A tab started or completed navigation. Reconcile at both stages because
// Chrome can replace per-tab side-panel options while the page commits.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return; // Ignore title and favicon-only updates.
  void updatePanelForTab(tabId, url, tab.windowId);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePanelForTab(tabId, tab.url || tab.pendingUrl, windowId);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    // The tab id lets the worker read the captions out of the page itself
    // before it spends a Supadata credit. Without it the fallback is the
    // only path, which is exactly what happened before.
    handleFetchTranscriptLocalFirst(message.videoId, message.tabId || null, {
      // The user asked for this video to be looked up again, so the worker
      // must not answer it with the failure it remembers.
      force: message.force === true,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp, or save the exact text the side
    // panel already has - selected transcript text or a key quote.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
      message.quote,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "updateNote") {
    handleUpdateNote(message.noteId, message.text)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "setNoteStarred") {
    // Starring a note is its own operation, not a text edit. It must never
    // travel through the update path, because that path rewrites the note
    // body and would carry whatever the text happened to be.
    handleSetNoteStarred(message.noteId, message.starred)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getGithubSession") {
    handleGetGithubSession()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "startGithubLogin") {
    handleStartGithubLogin()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "logoutGithub") {
    handleLogoutGithub()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "syncNotes") {
    fullSyncNotes()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "extractVocabulary") {
    handleExtractVocabulary(message.sentence)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "saveVocabulary") {
    handleSaveVocabulary(message.entry)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVocabulary") {
    handleGetVocabulary()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteVocabulary") {
    handleDeleteVocabulary(message.vocabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "syncVocabulary") {
    fullSyncVocabulary()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getDueReviews") {
    handleGetDueReviews()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "submitReview") {
    handleSubmitReview(message.vocabId, message.grade)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getUiLanguage") {
    getUiLanguage()
      .then((language) => sendResponse({ success: true, language }))
      .catch(() => sendResponse({ success: false, language: "en" }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!getActiveAiKey(settings),
          // The panel says which provider's key is missing, in the user's
          // language. It can only do that if it knows which one it is.
          provider: getActiveProvider(settings).name,
        }),
      )
      // Keep the shape stable: a caller must be able to tell a broken
      // extension apart from a missing key.
      .catch((error) =>
        sendResponse({
          hasSupadataKey: false,
          hasAiKey: false,
          error: error.message,
        }),
      );
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    const openForTab = (targetTabId) => {
      try {
        chrome.sidePanel.setOptions({
          tabId: targetTabId,
          path: "sidepanel.html",
          enabled: true,
        });
        return Promise.resolve(chrome.sidePanel.open({ tabId: targetTabId }));
      } catch (error) {
        return Promise.reject(error);
      }
    };

    // The caller (the Digest button on the page) needs to know whether the
    // panel really opened. Reporting success before the promise settles
    // turned every failure into a button that did nothing.
    const respond = (opening) => {
      opening
        .then(() => {
          sendResponse({ success: true });
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
          sendResponse({
            success: false,
            error: err?.message || "Could not open the side panel.",
          });
        });
    };

    if (tabId) {
      respond(openForTab(tabId));
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            respond(openForTab(tabs[0].id));
            return;
          }
          sendResponse({ success: false, error: "No active tab to open." });
        })
        .catch((err) =>
          sendResponse({
            success: false,
            error: err?.message || "Could not find the active tab.",
          }),
        );
    }

    // Keep the message channel open for the asynchronous response.
    return true;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          tabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          debugLog("[YouTube Digest BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
          debugLog("[YouTube Digest BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING: LOCAL FIRST, SUPADATA AS THE FALLBACK
// ============================================================

/**
 * Reads the native caption tracks from the YouTube tab's own player state.
 *
 * The player response carries a playerCaptionsTracklistRenderer whose
 * captionTracks point at YouTube's own timedtext endpoint. The URL is
 * already signed by YouTube, so the subtitles can be fetched without an API
 * key and without spending a Supadata credit.
 *
 * Three sources are tried, in order: the live player object, the page's
 * global ytInitialPlayerResponse, and the inline <script> that defines it.
 * The third one matters because a page that has not started playing yet has
 * no player object but does have the script tag.
 *
 * The answer says which of three things is true, because the three need
 * different words later on:
 *
 *   - "tracks": the page has caption tracks for a video.
 *   - "no-tracks": the page knows which video it is showing, and that video
 *     has no subtitles. This is a property of the video, not of the moment.
 *   - "no-response": the page has no player response at all. It is still
 *     loading, and the same read a second later can work.
 *
 * The video id comes back with the tracks, from the same player response.
 * The tab can be showing a different video than the one the panel asked for
 * - the user navigated while the request was on the wire - and reading that
 * video's captions would attach the wrong transcript to the right title.
 *
 * Runs in the page's MAIN world, where YouTube's player object lives. A
 * content script lives in an isolated world and cannot see it.
 *
 * The URL in the track list is a template. The player does not use it as it
 * is: it signs a request with a proof-of-origin token and its own client
 * identity, and YouTube answers a template request with an empty body. The
 * URL the player actually used is the one that carries the captions, and
 * the page remembers it in its own resource timing list. That URL comes
 * back with the tracks.
 *
 * @param {number} tabId the YouTube tab to read
 * @returns {Promise<{state: string, videoId?: string, tracks?: Array<{baseUrl: string, languageCode: string, kind: string}>, usedUrl?: string|null}|null>}
 */
async function readCaptionTracksFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          // Every answer the page can give is collected, because the one
          // that carries the caption tracks is the one the page is really
          // using. A player object that throws is a page we cannot read.
          const responses = [];
          try {
            const live =
              document.getElementById("movie_player")?.getPlayerResponse?.() ||
              null;
            if (live) responses.push(live);
          } catch (error) {
            // A player that throws is not an answer.
          }
          try {
            if (window.ytInitialPlayerResponse) {
              responses.push(window.ytInitialPlayerResponse);
            }
          } catch (error) {
            // No global response. The inline script is still worth reading.
          }

          // The page has the player response inline before the player
          // object exists. A page that has not started playing yet is
          // exactly the case where the local path is most valuable.
          const marker = "var ytInitialPlayerResponse = ";
          for (const script of document.querySelectorAll("script")) {
            const text = script.textContent || "";
            const index = text.indexOf(marker);
            if (index === -1) continue;
            const start = index + marker.length;
            const end = text.indexOf(";", start);
            if (end === -1) continue;
            try {
              const parsed = JSON.parse(text.slice(start, end));
              if (parsed) responses.push(parsed);
            } catch (error) {
              // A malformed inline script is not the one we want. Keep
              // looking: a page carries several of them.
            }
          }

          const hasTracks = (response) => {
            const tracks =
              response?.captions?.playerCaptionsTracklistRenderer
                ?.captionTracks;
            return Array.isArray(tracks) && tracks.length > 0;
          };

          const playerResponse = responses.find(hasTracks) || null;

          if (!playerResponse) {
            // No answer carries caption tracks. A page with no player
            // response at all is still loading; a page that knows which
            // video it is showing is showing a video without subtitles.
            const anyResponse = responses[0] || null;
            if (!anyResponse) return { state: "no-response" };
            return {
              state: "no-tracks",
              videoId: String(anyResponse?.videoDetails?.videoId || ""),
            };
          }

          const tracks =
            playerResponse?.captions?.playerCaptionsTracklistRenderer
              ?.captionTracks;
          const videoId = String(playerResponse?.videoDetails?.videoId || "");

          // The caption request the page already made, if it made one. The
          // token in it is what YouTube checks, so a request without it is
          // not worth anything.
          let usedUrl = null;
          try {
            const entries = performance.getEntriesByType("resource");
            for (let index = entries.length - 1; index >= 0; index -= 1) {
              const name = entries[index]?.name || "";
              if (!name.includes("/api/timedtext")) continue;
              const url = new URL(name);
              if (videoId && url.searchParams.get("v") !== videoId) continue;
              if (!url.searchParams.get("pot")) continue;
              usedUrl = url.toString();
              break;
            }
          } catch (error) {
            // A page without resource timing has no used URL. The template
            // URL is still tried further down.
          }

          return {
            state: "tracks",
            videoId,
            usedUrl,
            tracks: tracks
              .filter(
                (track) => typeof track.baseUrl === "string" && track.baseUrl,
              )
              .map((track) => ({
                baseUrl: track.baseUrl,
                languageCode: track.languageCode || "",
                kind: track.kind || "",
              })),
          };
        } catch (error) {
          return { state: "no-response" };
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (error) {
    debugLog(
      "[YouTube Digest BG] Caption tracks unavailable:",
      error.message,
    );
    return null;
  }
}


/**
 * Asks the page to load a caption track and waits for the request it makes.
 *
 * The player only asks YouTube for the captions when it needs them, and a
 * user who never turns captions on never gets a caption request. The player
 * can be asked to load one, and the request it makes is the URL that works.
 *
 * The request has to be given time to finish. YouTube makes the automatic
 * captions when they are first asked for, and the page only lists a request
 * once it has come back. A deadline shorter than that would turn every
 * fresh video into a failure, when all it needed was a few more seconds.
 *
 * Runs in the page's MAIN world, where the player object lives.
 *
 * @param {number} tabId the YouTube tab to ask
 * @param {{videoId: string, languageCode: string, kind: string}} request
 * @returns {Promise<string|null>} the caption URL the page used, or null
 */
async function loadCaptionUrlInTab(tabId, request) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [request],
      func: async (wanted) => {
        const videoId = String(wanted?.videoId || "");
        const findUsed = () => {
          try {
            const entries = performance.getEntriesByType("resource");
            for (let index = entries.length - 1; index >= 0; index -= 1) {
              const name = entries[index]?.name || "";
              if (!name.includes("/api/timedtext")) continue;
              const url = new URL(name);
              if (videoId && url.searchParams.get("v") !== videoId) continue;
              if (!url.searchParams.get("pot")) continue;
              return url.toString();
            }
          } catch (error) {
            // No resource timing, no used URL.
          }
          return null;
        };

        let used = findUsed();
        if (used) return used;

        const player = document.getElementById("movie_player");
        if (!player) return null;
        // A player without options cannot be asked. Waiting for a request
        // that will never come would only delay the fallback.
        if (typeof player.setOption !== "function") return null;

        // Ask the player to load the track. The caption display is left
        // alone: the user did not ask for captions on their video, and
        // switching them on would be a change nobody asked for.
        try {
          player.setOption("captions", "load", true);
        } catch (error) {
          // Not every player build has this option.
        }
        try {
          player.setOption("captions", "track", {
            languageCode: wanted?.languageCode || "",
            kind: wanted?.kind || "",
          });
        } catch (error) {
          // Not every player build has this option.
        }
        // And ask it to reload the captions it already knows about. This is
        // the one that makes the page go and fetch them: a player that has
        // not started the video does not fetch them on its own, and a video
        // whose subtitles YouTube has not made yet is exactly the one the
        // user wants to read. The request this makes is the one that
        // carries the token the signed URL needs.
        try {
          player.setOption("captions", "reload", true);
        } catch (error) {
          // Not every player build has this option.
        }

        const deadline = Date.now() + (Number(wanted?.timeoutMs) || 0);
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          used = findUsed();
          if (used) return used;
        }
        return null;
      },
    });
    return results?.[0]?.result || null;
  } catch (error) {
    debugLog("[YouTube Digest BG] Caption request failed:", error.message);
    return null;
  }
}

/**
 * Points a caption URL at a specific track.
 *
 * The language and the kind are not part of the signed part of the URL, so
 * the URL the page used can be pointed at another track. The player loads
 * whatever track it likes best, which is often not the English one this
 * product reads.
 *
 * @param {string} url the caption URL the page used
 * @param {{languageCode: string, kind: string}} track the track to read
 * @returns {string} the URL for that track
 */
function captionUrlForTrack(url, track) {
  try {
    const parsed = new URL(url);
    if (track.languageCode) parsed.searchParams.set("lang", track.languageCode);
    if (track.kind) parsed.searchParams.set("kind", track.kind);
    else parsed.searchParams.delete("kind");
    // A variant is a translated version of another track. Asking for it by
    // name is what makes the request answer with nothing.
    parsed.searchParams.delete("variant");
    return parsed.toString();
  } catch (error) {
    return url;
  }
}

/**
 * Picks the caption track to use.
 *
 * English comes first, because that is the language the product reads and
 * translates from. A track in any other language is better than no track at
 * all, so the first one is the fallback.
 *
 * @param {Array<{baseUrl: string, languageCode: string, kind: string}>} tracks
 * @returns {{baseUrl: string, languageCode: string, kind: string}|null}
 */
function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const exact = tracks.find((track) => track.languageCode === "en");
  if (exact) return exact;
  const english = tracks.find((track) =>
    String(track.languageCode || "").startsWith("en"),
  );
  if (english) return english;
  return tracks[0];
}

/**
 * Turns YouTube's json3 caption payload into the chunks the panel uses.
 *
 * Each event carries a start time in milliseconds, an optional duration,
 * and the text pieces that have to be joined before they mean anything.
 *
 * @param {Object} json3 the parsed payload
 * @param {string|null} language the track's language
 * @returns {Array<{text: string, offset: number, duration: number, lang: string|null}>}
 */
function parseTimedtextJson3(json3, language) {
  const chunks = [];
  if (!json3 || !Array.isArray(json3.events)) return chunks;

  for (const event of json3.events) {
    if (!event || !Array.isArray(event.segs)) continue;
    let text = "";
    for (const seg of event.segs) {
      if (seg && typeof seg.utf8 === "string") text += seg.utf8;
    }
    text = text.replace(/\n/g, " ").trim();
    if (!text) continue;

    chunks.push({
      text,
      offset: typeof event.tStartMs === "number" ? event.tStartMs : 0,
      duration:
        typeof event.dDurationMs === "number" ? event.dDurationMs : 0,
      lang: language,
    });
  }
  return chunks;
}

/**
 * Builds the transcript the panel and the AI features read.
 *
 * The shape has to match the one the Supadata path produces, so nothing
 * downstream has to know where the subtitles came from.
 *
 * @param {Array<{text: string, offset: number, duration: number, lang?: string}>} chunks
 * @param {string|null} language the fallback language
 * @returns {Object|null} the transcript, or null when there is no usable text
 */
function buildTranscriptResult(chunks, language) {
  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";

  for (const chunk of chunks) {
    if (!chunk || !chunk.text) continue;
    // ">>" is YouTube's speaker-change marker, not a word.
    const cleanText = chunk.text.replace(/>> ?/g, "").trim();
    if (!cleanText) continue;

    const startSeconds = Math.floor((chunk.offset || 0) / 1000);
    const minutes = Math.floor(startSeconds / 60);
    const seconds = startSeconds % 60;
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    transcript.push({
      text: cleanText,
      start: startSeconds,
      duration: Math.floor((chunk.duration || 0) / 1000),
      language: chunk.lang || language || null,
    });

    transcriptTextPlain += cleanText + " ";
    transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
  }

  if (transcript.length === 0) return null;

  return {
    success: true,
    transcript,
    transcriptText: transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language: typeof language === "string" ? language : null,
  };
}

/**
 * Fetches the subtitles from YouTube's own timedtext endpoint.
 *
 * The track URL comes from the page's player state, so it is already signed
 * and needs no key. The request runs under a deadline: a page that never
 * answers must not hold the paid fallback behind it.
 *
 * @param {string} baseUrl the signed caption track URL
 * @param {string} language the track's language
 * @returns {Promise<Object|null>} the transcript, or null on any failure
 */
async function fetchTimedtextTranscript(baseUrl, language) {
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  let timerId = null;
  const deadline = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      if (controller) {
        try {
          controller.abort();
        } catch (error) {
          // The abort is best effort; the race below still settles.
        }
      }
      const error = new Error(
        "The local caption lookup did not answer in time.",
      );
      error.code = "LOCAL_TRANSCRIPT_TIMEOUT";
      reject(error);
    }, YTD_SETTINGS.LOCAL_TRANSCRIPT_TIMEOUT_MS);
  });

  try {
    const timedtextUrl = new URL(baseUrl);
    timedtextUrl.searchParams.set("fmt", "json3");

    const request = (async () => {
      const init = { method: "GET" };
      if (controller) init.signal = controller.signal;
      const response = await fetch(timedtextUrl.toString(), init);
      if (!response.ok) {
        debugLog(
          `[YouTube Digest BG] timedtext request failed: ${response.status}`,
        );
        return null;
      }
      const data = await response.json();
      const chunks = parseTimedtextJson3(data, language);
      if (chunks.length === 0) return null;
      return buildTranscriptResult(chunks, language);
    })();

    return await Promise.race([request, deadline]);
  } catch (error) {
    debugLog("[YouTube Digest BG] timedtext fetch failed:", error.message);
    return null;
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

/**
 * The reasons a local read can fail.
 *
 * Two of them describe the moment and two describe the video. The panel
 * cannot tell them apart from a single "it failed", and the difference
 * matters: a video without subtitles is a fact, while a page that has not
 * caught up yet is a moment that passes. Telling the user that a video
 * with subtitles has none is worse than saying nothing.
 */
const LOCAL_READ_REASONS = {
  // The page has no player response yet. It is still loading.
  PAGE_NOT_READY: "page-not-ready",
  // The page is showing another video: the user clicked one and the page
  // has not swapped its player response yet.
  OTHER_VIDEO: "other-video",
  // The page knows which video it is showing, and that video has no
  // subtitles.
  NO_CAPTIONS: "no-captions",
  // The subtitles are there and could not be fetched.
  READ_FAILED: "read-failed",
};

/**
 * The reasons a local read can be worth another attempt.
 *
 * The page catches up on its own, so reading again a moment later is
 * likely to work. A video without subtitles stays without subtitles, and
 * waiting for it would only be waiting for nothing.
 */
const RETRYABLE_LOCAL_READ_REASONS = new Set([
  LOCAL_READ_REASONS.PAGE_NOT_READY,
  LOCAL_READ_REASONS.OTHER_VIDEO,
]);

/**
 * Reads the subtitles straight out of the YouTube tab.
 *
 * The local path is a bonus, never the only path: YouTube can change its
 * page internals at any time, and a video can have no caption track at
 * all. So a failure here falls back to Supadata.
 *
 * The tab must be showing the video that was asked for. The user can
 * navigate while the request is on the wire, and the captions of the video
 * they navigated to would otherwise be handed over as if they belonged to
 * the video the panel is showing. A wrong transcript under the right title
 * is worse than no transcript at all.
 *
 * @param {number} tabId the YouTube tab to read
 * @param {string} expectedVideoId the video the caller wants
 * @returns {Promise<Object>} the transcript, or a failure with a reason
 */
async function tryLocalTranscript(tabId, expectedVideoId) {
  if (!tabId) {
    return { success: false, reason: LOCAL_READ_REASONS.PAGE_NOT_READY };
  }
  const captionTracks = await readCaptionTracksFromTab(tabId);
  if (!captionTracks || captionTracks.state === "no-response") {
    debugLog("[YouTube Digest BG] The page has no player response yet");
    return { success: false, reason: LOCAL_READ_REASONS.PAGE_NOT_READY };
  }

  // The page tells us which video it is showing. When it does not say, the
  // page is in a state we do not understand, and guessing is how the wrong
  // transcript gets attached to the right video.
  const pageVideoId = String(captionTracks.videoId || "");
  if (!pageVideoId) {
    debugLog(
      "[YouTube Digest BG] The page did not say which video it is showing",
    );
    return { success: false, reason: LOCAL_READ_REASONS.PAGE_NOT_READY };
  }
  if (expectedVideoId && pageVideoId !== expectedVideoId) {
    debugLog(
      `[YouTube Digest BG] The tab is showing ${pageVideoId}, not ${expectedVideoId}`,
    );
    return { success: false, reason: LOCAL_READ_REASONS.OTHER_VIDEO };
  }

  if (captionTracks.state === "no-tracks") {
    debugLog(
      `[YouTube Digest BG] The page has no subtitles for ${pageVideoId}`,
    );
    return { success: false, reason: LOCAL_READ_REASONS.NO_CAPTIONS };
  }

  const track = pickCaptionTrack(captionTracks.tracks || []);
  if (!track) {
    return { success: false, reason: LOCAL_READ_REASONS.NO_CAPTIONS };
  }

  // The URL in the track list is a template, and YouTube answers a
  // template request with an empty body. The URL the page's own player
  // used is the one that carries the captions. If the page has not used
  // one yet, ask it to make one.
  let usedUrl = captionTracks.usedUrl || null;
  if (!usedUrl) {
    usedUrl = await loadCaptionUrlInTab(tabId, {
      videoId: pageVideoId,
      languageCode: track.languageCode || "",
      kind: track.kind || "",
      // How long the page may take. The page answers in milliseconds when
      // it already has the captions and in seconds when YouTube has to make
      // them, and the difference decides whether this read works.
      timeoutMs: YTD_SETTINGS.LOCAL_CAPTION_REQUEST_TIMEOUT_MS,
    });
  }

  // The track the product wants first, then the track the player picked,
  // then the template. One of them answers; the others are free to fail.
  const candidates = [];
  if (usedUrl) {
    const wanted = captionUrlForTrack(usedUrl, track);
    candidates.push(wanted);
    if (wanted !== usedUrl) candidates.push(usedUrl);
  }
  candidates.push(track.baseUrl);

  for (const url of candidates) {
    const transcript = await fetchTimedtextTranscript(
      url,
      track.languageCode || null,
    );
    if (transcript) return transcript;
  }
  return { success: false, reason: LOCAL_READ_REASONS.READ_FAILED };
}

/**
 * Reads the subtitles again, after waiting for the page to catch up.
 *
 * YouTube swaps its player response about a second after the user clicks
 * another video. The panel asks right away, so the first read is often
 * too early, and the answer would be a lie about the video. Waiting for
 * the page is free, and it saves a credit when the paid fallback would
 * have been used.
 *
 * @param {number} tabId the YouTube tab to read
 * @param {string} expectedVideoId the video the caller wants
 * @returns {Promise<Object|null>} the transcript, or null
 */
async function waitForLocalTranscript(tabId, expectedVideoId) {
  const delays = YTD_SETTINGS.LOCAL_CAPTION_RETRY_DELAYS_MS || [];
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const attempt = await tryLocalTranscript(tabId, expectedVideoId);
    if (attempt?.success) return attempt;
    // A video without subtitles stays without subtitles. Waiting longer
    // would only be waiting for nothing.
    if (
      attempt?.reason &&
      !RETRYABLE_LOCAL_READ_REASONS.has(attempt.reason)
    ) {
      return null;
    }
  }
  return null;
}

/**
 * Fetches the transcript for a video: locally first, Supadata as the backup.
 *
 * The local path is free and needs no key. It can fail when the page has no
 * caption track, when YouTube changed its internals, or when the tab is
 * gone. The Supadata path covers all of that, so the product still works
 * when the cheap path does not.
 *
 * The remembered failure of the paid path never blocks the local one. A
 * video whose captions could not be read yesterday may have them today, and
 * reading them out of the page costs the user nothing.
 *
 * @param {string} videoId the video to read
 * @param {number|null} tabId the YouTube tab, when there is one
 * @param {Object} options
 * @param {boolean} options.force look the video up again even when the
 *   failure of the last lookup is remembered
 * @returns {Promise<Object>} the transcript or a failure
 */
async function handleFetchTranscriptLocalFirst(videoId, tabId, options = {}) {
  // Why the local read failed, when it did. The panel needs this to tell
  // "this video has no subtitles" apart from "the page was not ready yet":
  // the first is a fact about the video, the second is a moment that
  // passes, and they need different words and different actions.
  let localReason = null;

  if (tabId) {
    const local = await tryLocalTranscript(tabId, videoId);
    if (local?.success) {
      debugLog("[YouTube Digest BG] Transcript read locally:", videoId);
      return { ...local, source: "local" };
    }
    localReason = local?.reason || LOCAL_READ_REASONS.PAGE_NOT_READY;

    if (RETRYABLE_LOCAL_READ_REASONS.has(localReason)) {
      // The page is on its way to showing this video. Waiting for it is
      // free, and it is the difference between a transcript and a claim
      // that the video has no subtitles.
      debugLog(
        "[YouTube Digest BG] The page has not caught up yet, waiting:",
        localReason,
      );
      const again = await waitForLocalTranscript(tabId, videoId);
      if (again?.success) {
        debugLog(
          "[YouTube Digest BG] Transcript read locally after waiting:",
          videoId,
        );
        return { ...again, source: "local" };
      }
    }

    debugLog(
      "[YouTube Digest BG] Local captions unavailable, using the fallback",
    );
  }

  const remote = await handleFetchTranscript(videoId, options);
  if (remote.success) return { ...remote, source: "supadata" };

  // The worker does not own the words on the screen. It says what went
  // wrong with a code, and the panel turns that into a sentence in the
  // user's language. A sentence sent from here would arrive in this
  // language only, and on a Chinese screen it would be the one English
  // sentence the user sees.
  //
  // The panel says both halves of the story on its own: that the subtitles
  // could not be read, and that the fallback needs a key.
  //
  // "No key" is only the whole story when the page said the video has no
  // subtitles. When the page was simply not ready, the missing key is not
  // the reason the user is looking at an error, and the panel has to be
  // told the difference.
  if (
    remote.error === "NO_SUPADATA_KEY" &&
    localReason !== LOCAL_READ_REASONS.NO_CAPTIONS
  ) {
    return { success: false, error: "PAGE_NOT_READY" };
  }
  return remote;
}

// ============================================================
// THE TRANSCRIPT FAILURE CACHE
// ============================================================

// "This video has no captions" is a property of the video, not of the
// moment. Captions do not appear out of nowhere, so a lookup that failed
// that way is remembered for a day: opening the panel, switching tabs and
// coming back must not spend another Supadata credit on the same answer.
const TRANSCRIPT_FAILURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// The failure cache has a namespace of its own. The digest cache
// (digest_<videoId>) belongs to the panel, which writes it, reads it and
// evicts it, so nothing else may write under that name.
const TRANSCRIPT_FAILURE_CACHE_PREFIX = "ytd_transcript_failed_";

// The failures that describe the video itself. A missing key, an invalid
// key, an exhausted balance, a rate limit and a timeout describe the
// moment instead, so they are never remembered: the user has to be able to
// try those again at once.
const TRANSCRIPT_CACHEABLE_FAILURES = new Set([
  "NO_TRANSCRIPT",
  "EMPTY_TRANSCRIPT",
]);

// The lookups that are on the wire right now. The panel and the note flow
// can ask for the same video at the same moment; they join one request
// instead of paying for two.
const transcriptRequestsInFlight = new Map();

/**
 * The storage key a failed transcript lookup is remembered under.
 *
 * @param {string} videoId the video the lookup was for
 * @returns {string} the key
 */
function transcriptFailureCacheKey(videoId) {
  return `${TRANSCRIPT_FAILURE_CACHE_PREFIX}${videoId}`;
}

/**
 * Reads the remembered failure of a transcript lookup.
 *
 * A remembered failure is only worth something while it is fresh: a day
 * later the video may have captions after all, and the user may have a key
 * now. An entry that is too old is dropped on the way out.
 *
 * @param {string} videoId the video to look up
 * @returns {Promise<Object|null>} the remembered failure, or null
 */
async function readFailedTranscript(videoId) {
  if (!videoId) return null;

  try {
    const key = transcriptFailureCacheKey(videoId);
    const stored = await chrome.storage.local.get(key);
    const failure = stored[key];
    if (!failure) return null;

    const timestamp = Number(failure.timestamp) || 0;
    if (Date.now() - timestamp > TRANSCRIPT_FAILURE_CACHE_TTL_MS) {
      await chrome.storage.local.remove(key);
      return null;
    }

    // Only a failure that describes the video is worth serving from the
    // memory. Anything else was written by a version that thought
    // differently, and the user has to be able to try it again at once.
    const code = String(failure.error || "");
    if (!TRANSCRIPT_CACHEABLE_FAILURES.has(code)) {
      await chrome.storage.local.remove(key);
      return null;
    }

    return {
      success: false,
      error: code,
      message: String(failure.message || ""),
    };
  } catch (error) {
    debugLog(
      "[YouTube Digest BG] Failed-transcript cache read failed:",
      error,
    );
    return null;
  }
}

/**
 * Remembers a transcript failure that describes the video itself.
 *
 * @param {string} videoId the video that failed
 * @param {Object} result the failure the lookup produced
 * @returns {Promise<void>} nothing
 */
async function writeFailedTranscript(videoId, result) {
  if (!videoId || result?.success) return;
  if (!TRANSCRIPT_CACHEABLE_FAILURES.has(result.error)) return;

  try {
    await chrome.storage.local.set({
      [transcriptFailureCacheKey(videoId)]: {
        error: result.error,
        message: String(result.message || ""),
        timestamp: Date.now(),
      },
    });
    await pruneFailedTranscripts();
  } catch (error) {
    debugLog(
      "[YouTube Digest BG] Failed-transcript cache write failed:",
      error,
    );
  }
}

/**
 * Drops the remembered failures that are too old to be true.
 *
 * The failure cache is not part of the digest cache, so the eviction the
 * panel owns does not sweep it. Without this the entries would sit in
 * storage forever.
 *
 * @returns {Promise<void>} nothing
 */
async function pruneFailedTranscripts() {
  try {
    const stored = await chrome.storage.local.get(null);
    const expired = Object.keys(stored).filter((key) => {
      if (!key.startsWith(TRANSCRIPT_FAILURE_CACHE_PREFIX)) return false;
      const timestamp = Number(stored[key]?.timestamp) || 0;
      return Date.now() - timestamp > TRANSCRIPT_FAILURE_CACHE_TTL_MS;
    });
    if (expired.length === 0) return;
    await chrome.storage.local.remove(expired);
  } catch (error) {
    debugLog(
      "[YouTube Digest BG] Failed-transcript cache cleanup failed:",
      error,
    );
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function fetchTranscriptFromSupadata(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      // The worker says what went wrong with a code. The panel owns the
      // sentence the user reads, so that it can be said in their language.
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "en"); // Prefer English
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request. It runs under a deadline: a server that stops
    // answering used to leave the panel waiting forever, because the request
    // never came back and the service worker was suspended while it waited.
    const { response, data } = await YTD_SETTINGS.withRequestTimeout(
      async (signal) => {
        const init = {
          method: "GET",
          headers: {
            "x-api-key": settings.supadataApiKey,
          },
        };
        if (signal) init.signal = signal;
        const answer = await fetch(apiUrl.toString(), init);
        let payload = null;
        try {
          payload = await answer.json();
        } catch (error) {
          // A body that is not JSON is handled by the status checks below.
          // A request the deadline aborted is not: it has to surface as a
          // timeout, not as an empty transcript.
          if (signal && signal.aborted) throw error;
        }
        return { response: answer, data: payload };
      },
      YTD_SETTINGS.TRANSCRIPT_REQUEST_TIMEOUT_MS,
      () => {
        const error = new Error(
          "The transcript service did not answer within " +
            Math.round(YTD_SETTINGS.TRANSCRIPT_REQUEST_TIMEOUT_MS / 1000) +
            " seconds.",
        );
        error.code = YTD_SETTINGS.TRANSCRIPT_REQUEST_TIMEOUT;
        return error;
      },
    );

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = data || {};
      // A job without an id cannot be polled. Asking for "undefined" would
      // send sixty pointless requests instead of failing once.
      if (!jobData.jobId) {
        throw new Error("Supadata did not return a job id for this video.");
      }
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
      };
    }

    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
        };
      }
      if (response.status === 402) {
        return {
          success: false,
          error: "OUT_OF_CREDITS",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = ""; // Plain text for display/export
    let transcriptTextTimestamped = ""; // Timestamped text for AI analysis

    if (data.content && Array.isArray(data.content)) {
      for (const chunk of data.content) {
        if (chunk.text) {
          // Clean up caption artifacts:
          // ">>" = speaker change marker from YouTube auto-captions
          const cleanText = chunk.text.replace(/>> ?/g, "").trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

          // offset is in milliseconds, convert to seconds
          const startSeconds = Math.floor((chunk.offset || 0) / 1000);
          // The marker the model reads is written by the same formatter the
          // reader's stamp comes from. If the two could drift apart, a
          // chapter the model placed at 1:30:00 would be shown as 90:00 and
          // would point at a completely different minute.
          const timestamp = YTD_SETTINGS.formatTimestamp(startSeconds);

          transcript.push({
            text: cleanText,
            start: startSeconds,
            duration: Math.floor((chunk.duration || 0) / 1000),
            language: chunk.lang || data.lang || null,
          });

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + " ";

          // Timestamped text for the model (format: [M:SS] text, or
          // [H:MM:SS] for a video over an hour). This allows the model to
          // reference actual transcript positions.
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(), // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
      language: typeof data.lang === "string" ? data.lang : null,
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      // The code is what the panel turns into a sentence. The error's own
      // message is not sent: it is in this language only, and the panel is
      // the layer that speaks the user's.
      error: error.code || "TRANSCRIPT_FAILED",
      code: error.code,
    };
  }
}

/**
 * Fetches the transcript of a video, paying for it at most once.
 *
 * Three things keep the user from paying twice for the same answer:
 *
 * - A failure that describes the video itself is remembered for a day, so
 *   the second look at a caption-less video costs nothing.
 * - Two callers that want the same video at the same moment (the panel and
 *   the note flow) share the request that is already on the wire.
 * - A request that is on the wire is never sent a second time.
 *
 * The user can always ask for a fresh lookup. The panel's retry button
 * says so, and a video that has no captions must never be stuck for good.
 *
 * @param {string} videoId the video to read
 * @param {Object} options
 * @param {boolean} options.force ignore the remembered failure and look the
 *   video up again. The user asked for it, so the credit is theirs.
 * @returns {Promise<Object>} the transcript or a failure
 */
async function handleFetchTranscript(videoId, options = {}) {
  if (options?.force !== true) {
    const remembered = await readFailedTranscript(videoId);
    if (remembered) {
      debugLog(
        "[YouTube Digest BG] The failure of this video is remembered:",
        videoId,
      );
      return remembered;
    }
  }

  const running = transcriptRequestsInFlight.get(videoId);
  if (running) {
    debugLog(
      "[YouTube Digest BG] Joining the lookup that is already running:",
      videoId,
    );
    return running;
  }

  const request = fetchTranscriptFromSupadata(videoId).then(async (result) => {
    if (!result?.success) await writeFailedTranscript(videoId, result);
    return result;
  });
  transcriptRequestsInFlight.set(videoId, request);

  try {
    return await request;
  } catch (error) {
    // The lookup itself never throws, but the panel expects a failure it can
    // show, not an exception it has to make sense of.
    //
    // The failure is a code, never a sentence. The panel has a sentence for
    // every code, and a sentence from here would be in this language only.
    // The detail stays in the log, where it belongs.
    debugLog("[YouTube Digest BG] The transcript lookup failed:", error);
    return {
      success: false,
      error: error?.code || "TRANSCRIPT_FAILED",
      code: error?.code,
    };
  } finally {
    transcriptRequestsInFlight.delete(videoId);
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    // Every poll runs under a deadline too. One poll that never answers
    // would keep the whole job - and the service worker holding it - alive
    // for good.
    const { response, data } = await YTD_SETTINGS.withRequestTimeout(
      async (signal) => {
        const init = {
          headers: { "x-api-key": supadataApiKey },
        };
        if (signal) init.signal = signal;
        const answer = await fetch(
          `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
          init,
        );
        let payload = null;
        try {
          payload = await answer.json();
        } catch (error) {
          if (signal && signal.aborted) throw error;
        }
        return { response: answer, data: payload };
      },
      YTD_SETTINGS.TRANSCRIPT_REQUEST_TIMEOUT_MS,
      () => {
        const error = new Error(
          "The transcript service did not answer within " +
            Math.round(YTD_SETTINGS.TRANSCRIPT_REQUEST_TIMEOUT_MS / 1000) +
            " seconds.",
        );
        error.code = YTD_SETTINGS.TRANSCRIPT_REQUEST_TIMEOUT;
        return error;
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    if (data.status === "completed") {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = "";
      let transcriptTextTimestamped = "";

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, "").trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            // Same formatter as the synchronous path above: the model has to
            // see one transcript, not two that depend on which fetch ran.
            const timestamp = YTD_SETTINGS.formatTimestamp(startSeconds);

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000),
              language: chunk.lang || data.lang || null,
            });
            transcriptTextPlain += cleanText + " ";
            transcriptTextTimestamped += `[${timestamp}] ${chunk.text}\n`;
          }
        }
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: typeof data.lang === "string" ? data.lang : null,
      };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  // The job never finished. It is the same kind of failure as a request
  // that ran out of time, so it carries the same code.
  const timeoutError = new Error("Transcript processing timed out");
  timeoutError.code = YTD_SETTINGS.TRANSCRIPT_REQUEST_TIMEOUT;
  throw timeoutError;
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Where the transcript actually ends, in seconds.
 *
 * The markers are written by the same formatter the reader's stamp comes
 * from, so they are H:MM:SS for a video over an hour and M:SS for a shorter
 * one. A transcript cached by an older release still carries the short
 * shape, so both have to be understood here.
 *
 * That matters more than it looks. This number is the length the model is
 * told the video has, the ceiling every chapter timestamp is checked
 * against, and the point the last chapter has to come after. Read the long
 * shape as if it were the short one and a ninety-minute video looks an hour
 * short: the chapters stop at the fifty-minute mark, and nothing anywhere
 * reports a failure.
 *
 * @param {string} transcriptText - The timestamped transcript.
 * @returns {number} The last marked position in seconds, 0 when unmarked.
 */
function transcriptLengthSeconds(transcriptText) {
  const stamps =
    String(transcriptText || "").match(/\[\d+:\d{2}(?::\d{2})?\]/g) || [];
  if (!stamps.length) return 0;
  return YTD_SETTINGS.parseTimestampToSeconds(stamps[stamps.length - 1]) || 0;
}

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!getActiveAiKey(settings)) {
      // The worker says what went wrong with a code, and names the provider
      // so the panel can say it in the user's language. The sentence itself
      // belongs to the panel: a sentence from here is in this language only.
      return {
        success: false,
        error: "NO_AI_KEY",
        provider: getActiveProvider(settings).name,
      };
    }

    // The transcript text is already prefixed with [M:SS] or [H:MM:SS]
    // markers. Its LAST marker is the most reliable signal of where the
    // content actually ends — more trustworthy than the duration metadata,
    // which is sometimes missing or wrong. We use the larger of (metadata
    // duration, last transcript stamp).
    const lastTranscriptSeconds = transcriptLengthSeconds(transcriptText);

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    // The duration and the threshold are written in the same format the
    // markers are, so the model compares two numbers in one notation. A
    // threshold of "1:07:30" against markers of "1:30:00" is a comparison
    // it can make; "67:30" against "1:30:00" is not.
    const durationFormatted = YTD_SETTINGS.formatTimestamp(effectiveSeconds);
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = YTD_SETTINGS.formatTimestamp(lateThresholdSeconds);

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog(
      "[YouTube Digest] Requesting video analysis",
      YTD_SETTINGS.getProvider(settings.provider).model,
    );
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: YTD_SETTINGS.formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: YTD_SETTINGS.formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  return { summary: safeString(analysis?.summary, 2000), chapters, keyQuotes };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Builds a note id that cannot collide.
 *
 * The id is the cloud sync key (unique per user), so two notes saved in the
 * same millisecond used to overwrite each other silently: Date.now() alone
 * only has millisecond resolution.
 */
function createNoteId() {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `note_${Date.now()}_${random}`;
}

/**
 * Saves a note at a timestamp. Exact text is stored directly.
 *
 * The side panel hands over the words it already has: the selected
 * transcript text or a key quote. Other note requests find the relevant
 * transcript line and clean it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
  quoteText,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactText = [selectedText, quoteText]
      .filter((value) => typeof value === "string")
      .map((value) => value.replace(/\s+/g, " ").trim().slice(0, 3000))
      .find((value) => value.length > 0);

    // The panel already holds the exact text the user wants. Save it
    // directly, without a transcript fetch and without an AI cleanup
    // request: the quote the user picked must survive, and the user must
    // not pay for a second lookup or a second model call.
    if (exactText) {
      const note = {
        id: createNoteId(),
        videoId,
        videoTitle:
          typeof videoTitle === "string"
            ? videoTitle.slice(0, 500)
            : "Untitled Video",
        channelName:
          typeof channelName === "string" ? channelName.slice(0, 300) : "",
        timestamp: YTD_SETTINGS.formatTimestamp(safeTimestamp),
        timestampSeconds: safeTimestamp,
        timestampedUrl: `${canonicalVideoUrl}&t=${safeTimestamp}s`,
        text: exactText,
        rawText: exactText,
        createdAt: Date.now(),
      };

      await saveNoteToStorage(note);
      chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
      return { success: true, note };
    }

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // The stamp a reader sees comes from the shared formatter.
    const formattedTimestamp = YTD_SETTINGS.formatTimestamp(safeTimestamp);

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: createNoteId(),
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    // The code travels with the message: a note that did not fit into the
    // device's storage is a different problem from a failed edit, and the
    // panel can only say so if it knows which one happened.
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  // The active provider owns the key. Checking the DeepSeek field only meant
  // that a MiniMax or OpenCode Go user never got their notes cleaned up.
  if (!getActiveAiKey(settings)) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local, namespaced by the signed-in GitHub
 * account so one learner's data never leaks into another account's view.
 * When signed in, the note is also pushed to the sync server.
 */
async function handleExtractVocabulary(sentence) {
  try {
    const settings = await getSettings();
    if (!getActiveAiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        provider: getActiveProvider(settings).name,
      };
    }
    const cleanSentence = String(sentence || "").trim().slice(0, 4000);
    if (!cleanSentence) return { success: false, error: "EMPTY_SENTENCE" };
    const systemPrompt = await loadPromptSection("vocabulary.md", "System prompt");
    const userPrompt = await loadPromptSection("vocabulary.md", "User prompt", {
      sentence: cleanSentence,
    });
    const { text } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const parsed = parseLooseJson(text);
    const words = Array.isArray(parsed && parsed.words) ? parsed.words : [];
    const cleaned = words
      .filter((word) => word && typeof word.term === "string" && word.term.trim())
      .slice(0, 3)
      .map((word) => ({
        term: word.term.trim().slice(0, 200),
        translation: String(word.translation || "").trim().slice(0, 500),
        explanation: String(word.explanation || "").trim().slice(0, 500),
      }));
    return { success: true, words: cleaned };
  } catch (error) {
    return { success: false, error: error.message || "Vocabulary extraction failed" };
  }
}

/**
 * Saves a vocabulary entry locally (account-namespaced) and mirrors it to
 * the cloud when signed in. Deduped locally by (term, sentence).
 */

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!getActiveAiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        provider: getActiveProvider(settings).name,
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!getActiveAiKey(settings)) {
      return {
        success: false,
        error: `${getActiveProvider(settings).name} API key not configured`,
      };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleSaveNote,
  handleTranslateContent,
  mergeNotesForSync,
  cloudToLocalNote,
  localNoteToCloudPayload,
  formatSyncTimestamp,
  getGithubSession,
  cloudFetch,
  isSyncSessionExpired,
  markSyncSessionExpired,
  clearSyncSessionExpired,
  isSyncSessionExpiredForAccount,
  handleStartGithubLogin,
  fullSyncNotes,
  handleGetGithubSession,
  handleLogoutGithub,
  completeGithubLogin,
  startPendingLogin,
  consumePendingLoginNonce,
  saveNoteToStorage,
  handleGetNotes,
  handleDeleteNote,
  handleUpdateNote,
  handleSetNoteStarred,
  migrateLegacyLocalNotes,
  migrateLegacyLocalVocabulary,
  setStorageWithRecovery,
  evictCachedDigests,
  mergeVocabularyForSync,
  handleExtractVocabulary,
  handleSaveVocabulary,
  handleGetVocabulary,
  handleDeleteVocabulary,
  fullSyncVocabulary,
  handleGetDueReviews,
  handleSubmitReview,
  closePanelForTab,
  updatePanelForTab,
  handleFetchTranscript,
  handleFetchTranscriptLocalFirst,
  fetchTranscriptFromSupadata,
  readFailedTranscript,
  writeFailedTranscript,
  transcriptFailureCacheKey,
  tryLocalTranscript,
  readCaptionTracksFromTab,
  loadCaptionUrlInTab,
  captionUrlForTrack,
  pickCaptionTrack,
  parseTimedtextJson3,
  buildTranscriptResult,
  fetchTimedtextTranscript,
  cleanupNoteText,
  createNoteId,
};

// Persistent OAuth completion listener. The service worker may be suspended
// while the user authorizes on GitHub; MV3 keeps registered listeners and
// wakes the worker on tab events, so login completes even after a long pause.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = (tab && tab.url) || (changeInfo && changeInfo.url) || "";
  const marker = YTD_SETTINGS.SERVER_BASE_URL + "/auth/complete#access_token=";
  if (!url.startsWith(marker)) return;
  // The fragment carries the token and the nonce of the sign-in: the token
  // alone is not proof that this device asked for the sign-in.
  const fragment = url.slice(marker.length);
  const parts = fragment.split("&");
  const token = parts[0];
  let nonce = "";
  for (const part of parts.slice(1)) {
    if (part.startsWith("nonce=")) {
      try {
        nonce = decodeURIComponent(part.slice("nonce=".length));
      } catch (error) {
        nonce = "";
      }
    }
  }
  if (!token) return;
  void completeGithubLogin(token, tabId, nonce);
});
