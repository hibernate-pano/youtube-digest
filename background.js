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
  try {
    let response;
    let data;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(
        YTD_SETTINGS.chatCompletionsUrl(settings.provider),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Always the active provider's own key: keys for inactive
            // providers are stored side by side but must never be sent.
            Authorization: `Bearer ${getActiveAiKey(settings)}`,
          },
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
    handleFetchTranscriptLocalFirst(message.videoId, message.tabId || null)
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
 * The video id comes back with the tracks, from the same player response.
 * The tab can be showing a different video than the one the panel asked for
 * - the user navigated while the request was on the wire - and reading that
 * video's captions would attach the wrong transcript to the right title.
 *
 * Runs in the page's MAIN world, where YouTube's player object lives. A
 * content script lives in an isolated world and cannot see it.
 *
 * @param {number} tabId the YouTube tab to read
 * @returns {Promise<{videoId: string, tracks: Array<{baseUrl: string, languageCode: string}>}|null>}
 */
async function readCaptionTracksFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          let playerResponse =
            document.getElementById("movie_player")?.getPlayerResponse?.() ||
            null;

          if (!playerResponse?.captions?.playerCaptionsTracklistRenderer) {
            const globalResponse = window.ytInitialPlayerResponse;
            if (globalResponse?.captions?.playerCaptionsTracklistRenderer) {
              playerResponse = globalResponse;
            }
          }

          if (!playerResponse?.captions?.playerCaptionsTracklistRenderer) {
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
                if (parsed?.captions?.playerCaptionsTracklistRenderer) {
                  playerResponse = parsed;
                  break;
                }
              } catch (error) {
                // A malformed inline script is not the one we want. Keep
                // looking: a page carries several of them.
              }
            }
          }

          const tracks =
            playerResponse?.captions?.playerCaptionsTracklistRenderer
              ?.captionTracks;
          if (!Array.isArray(tracks) || tracks.length === 0) return null;

          return {
            videoId: String(playerResponse?.videoDetails?.videoId || ""),
            tracks: tracks
              .filter(
                (track) => typeof track.baseUrl === "string" && track.baseUrl,
              )
              .map((track) => ({
                baseUrl: track.baseUrl,
                languageCode: track.languageCode || "",
              })),
          };
        } catch (error) {
          return null;
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
 * Picks the caption track to use.
 *
 * English comes first, because that is the language the product reads and
 * translates from. A track in any other language is better than no track at
 * all, so the first one is the fallback.
 *
 * @param {Array<{baseUrl: string, languageCode: string}>} tracks
 * @returns {{baseUrl: string, languageCode: string}|null}
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
 * Reads the subtitles straight out of the YouTube tab.
 *
 * Returns null on any failure, so the caller falls back to Supadata. The
 * local path is a bonus, never the only path: YouTube can change its page
 * internals at any time, and a video can have no caption track at all.
 *
 * The tab must be showing the video that was asked for. The user can
 * navigate while the request is on the wire, and the captions of the video
 * they navigated to would otherwise be handed over as if they belonged to
 * the video the panel is showing. A wrong transcript under the right title
 * is worse than no transcript at all.
 *
 * @param {number} tabId the YouTube tab to read
 * @param {string} expectedVideoId the video the caller wants
 * @returns {Promise<Object|null>} the transcript, or null
 */
async function tryLocalTranscript(tabId, expectedVideoId) {
  if (!tabId) return null;
  const captionTracks = await readCaptionTracksFromTab(tabId);
  if (!captionTracks) return null;

  // The page tells us which video it is showing. When it does not say, the
  // page is in a state we do not understand, and guessing is how the wrong
  // transcript gets attached to the right video.
  const pageVideoId = String(captionTracks.videoId || "");
  if (!pageVideoId) {
    debugLog(
      "[YouTube Digest BG] The page did not say which video it is showing",
    );
    return null;
  }
  if (expectedVideoId && pageVideoId !== expectedVideoId) {
    debugLog(
      `[YouTube Digest BG] The tab is showing ${pageVideoId}, not ${expectedVideoId}`,
    );
    return null;
  }

  const track = pickCaptionTrack(captionTracks.tracks);
  if (!track) return null;
  return await fetchTimedtextTranscript(
    track.baseUrl,
    track.languageCode || null,
  );
}

/**
 * Fetches the transcript for a video: locally first, Supadata as the backup.
 *
 * The local path is free and needs no key. It can fail when the page has no
 * caption track, when YouTube changed its internals, or when the tab is
 * gone. The Supadata path covers all of that, so the product still works
 * when the cheap path does not.
 *
 * @param {string} videoId the video to read
 * @param {number|null} tabId the YouTube tab, when there is one
 * @returns {Promise<Object>} the transcript or a failure
 */
async function handleFetchTranscriptLocalFirst(videoId, tabId) {
  if (tabId) {
    const local = await tryLocalTranscript(tabId, videoId);
    if (local?.success) {
      debugLog("[YouTube Digest BG] Transcript read locally:", videoId);
      return { ...local, source: "local" };
    }
    debugLog(
      "[YouTube Digest BG] Local captions unavailable, using the fallback",
    );
  }

  const remote = await handleFetchTranscript(videoId);
  if (remote.success) return { ...remote, source: "supadata" };

  // The local path was tried and did not work, and there is no key to fall
  // back on. Saying only "add a Supadata key" would hide the half of the
  // story the user can act on right now: the page had no captions to read.
  if (tabId && remote.error === "NO_SUPADATA_KEY") {
    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message:
        "This video has no subtitles that could be read, and no Supadata key is set to fall back on.",
    };
  }

  return remote;
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
async function handleFetchTranscript(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Supadata API key not configured. Open YouTube Digest Settings.",
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
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid. Open YouTube Digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 402) {
        return {
          success: false,
          error: "OUT_OF_CREDITS",
          message:
            "Your Supadata credits are exhausted. Add credits at dash.supadata.ai.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
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
        message: "Supadata returned an empty transcript for this video.",
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
      // The code is what the panel turns into a sentence. Only the failures
      // that never had a code of their own fall back to their message.
      error: error.code || error.message || "Failed to fetch transcript",
      code: error.code,
    };
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
      return {
        success: false,
        error: "NO_AI_KEY",
        message: `${getActiveProvider(settings).name} API key not configured. Open YouTube Digest Settings.`,
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
        message: "The AI provider rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "The AI provider rate-limited this request. Try again shortly.",
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
      return { success: false, error: "NO_AI_KEY", message: "AI key not configured. Open Settings." };
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
        message: `${getActiveProvider(settings).name} API key not configured.`,
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
  tryLocalTranscript,
  readCaptionTracksFromTab,
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
