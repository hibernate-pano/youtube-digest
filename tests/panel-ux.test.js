const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A very small DOM stand-in. It is deliberately dumb: it stores what the
 * panel writes so a test can assert on it, and it mimics the two behaviours
 * the panel depends on (innerHTML replaces children, textContent escapes).
 */
class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName;
    this.id = id;
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.scrollTop = 0;
    this._text = "";
    this._html = null;
    this._classes = new Set();
    this.classList = {
      add: (name) => {
        this._classes.add(name);
      },
      remove: (name) => {
        this._classes.delete(name);
      },
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this._html = null;
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children
      .map((child) => (child.textContent !== undefined ? child.textContent : ""))
      .join("");
  }

  set innerHTML(value) {
    this._html = String(value ?? "");
    this._text = "";
    this.children = [];
  }

  get innerHTML() {
    if (this._html !== null) return this._html;
    return escapeText(this._text);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    if (name === "id") return this.id;
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  removeEventListener() {}

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = this.children.indexOf(before);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) =>
      typeof child.contains === "function" ? child.contains(node) : false,
    );
  }

  // The panel only queries for elements it created itself, so a stub is enough.
  querySelector() {
    return new FakeElement();
  }

  querySelectorAll() {
    return [];
  }

  scrollIntoView() {}
}

const PANEL_ELEMENT_IDS = [
  "welcomeState",
  "loadingState",
  "errorState",
  "resultsState",
  "tabsNav",
  "transcriptModeControl",
  "contentArea",
  "videoInfo",
  "videoTitle",
  "videoChannel",
  "loadingText",
  "loadingSubtext",
  "errorTitle",
  "errorMessage",
  "errorBtn",
  "transcriptList",
  "chapterList",
  "quotesList",
  "notesList",
  "notesIntro",
  "langSpinner",
  "followPlaybackBtn",
  "transcriptSearchInput",
  "transcriptSearchClearBtn",
  "transcriptSearchCount",
  "notesFilterThis",
  "notesFilterAll",
  "settingsBtn",
  "syncBtn",
  "syncAccount",
  "copyTranscriptBtn",
  "exportTranscriptBtn",
];

function createStorageArea(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...values };
      const requested = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) result[key] = values[key];
      }
      return result;
    },
    async set(items) {
      Object.assign(values, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
  };
}

/**
 * Drives the real sidepanel.js inside a vm sandbox with a hand-written DOM.
 * The panel is the product's main surface, so the tests exercise the actual
 * file instead of a copy of its logic.
 */
function createPanelHarness({
  sendMessageImpl,
  local = {},
  session = {},
  tabs = [],
  activeTab = "",
  beforeLocalSet = null,
} = {}) {
  const elements = [];
  const documentListeners = new Map();
  const storageListeners = [];
  const tabUpdatedListeners = [];
  const timers = new Map();
  const sentMessages = [];
  let nextTimerId = 1;

  const register = (element) => {
    elements.push(element);
    return element;
  };

  const document = {
    readyState: "complete",
    body: register(new FakeElement("body")),
    head: register(new FakeElement("head")),
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: (selector) =>
      activeTab && selector === ".tab.active"
        ? { dataset: { tab: activeTab } }
        : null,
    getElementById: (id) => elements.find((el) => el.id === id) || null,
    createElement: (tag) => register(new FakeElement(tag)),
    createTextNode: (text) => ({ nodeValue: String(text) }),
    createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
    execCommand: () => true,
  };

  for (const id of PANEL_ELEMENT_IDS) {
    register(new FakeElement("div", id));
  }

  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session);
  if (beforeLocalSet) {
    const originalSet = localArea.set.bind(localArea);
    localArea.set = async (items) => {
      await beforeLocalSet(items);
      return originalSet(items);
    };
  }

  const sendMessage = async (message) => {
    sentMessages.push(message);
    if (sendMessageImpl) return sendMessageImpl(message);
    return { success: true };
  };

  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    setTimeout: (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delay, interval: true });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: () => 0,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    CSS: { escape: (value) => value },
    navigator: { clipboard: { writeText: async () => {} } },
    window: {
      getSelection: () => null,
      close() {},
      scrollY: 0,
      addEventListener() {},
    },
    document,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage,
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      storage: {
        local: localArea,
        session: sessionArea,
        onChanged: {
          addListener(listener) {
            storageListeners.push(listener);
          },
        },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: {
        onUpdated: {
          addListener(listener) {
            tabUpdatedListeners.push(listener);
          },
        },
        onActivated: { addListener() {} },
        // The front tab can change while the panel works, so the harness
        // accepts a function that returns the current tab.
        query: async () => (typeof tabs === "function" ? tabs() : tabs),
        sendMessage: async () => ({ success: true }),
        create() {},
      },
    },
    YTD_SETTINGS: require("../settings.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);

  return {
    sandbox,
    helpers: sandbox.__YTD_PANEL_TESTING__,
    document,
    elements,
    sentMessages,
    storage: { local: localArea, session: sessionArea },
    el: (id) => document.getElementById(id),
    fire: async (type) => {
      const handlers = documentListeners.get(type) || [];
      for (const handler of handlers) {
        await handler({
          type,
          preventDefault() {},
          stopPropagation() {},
        });
      }
    },
    fireStorageChange: (changes) => {
      for (const listener of storageListeners) listener(changes, "local");
    },
    // Reproduces a YouTube navigation: the extension hears about the new
    // URL the way Chrome reports it.
    fireTabUpdate: (tabId, changeInfo, tab) => {
      for (const listener of tabUpdatedListeners) {
        listener(tabId, changeInfo, tab);
      }
    },
    // Runs the timers the panel scheduled, e.g. the debounced refresh that
    // a navigation starts.
    runTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
    // Everything the panel put on screen inside one element, whether it
    // arrived as markup or as child elements.
    htmlOf: (id) => {
      const element = document.getElementById(id);
      if (!element) return "";
      return [
        element.innerHTML,
        ...element.children.map((child) => child.innerHTML),
      ].join("");
    },
    flush: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const VIDEO_URL = "https://www.youtube.com/watch?v=videoA";

function transcriptPayload(label) {
  return {
    success: true,
    transcript: [{ text: `${label} caption`, start: 0, duration: 2, language: "en" }],
    transcriptText: `${label} caption`,
    transcriptTextTimestamped: `[0:00] ${label} caption`,
    language: "en",
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================
// P0-3: the first-run dead end
// ============================================================

test("the panel finds the video in every shape YouTube serves one", () => {
  const harness = createPanelHarness();
  const { extractVideoId } = harness.helpers;

  const shapes = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ];

  for (const [url, expected] of shapes) {
    assert.equal(
      extractVideoId(url),
      expected,
      `${url} should yield ${expected}`,
    );
  }

  // A page with no video has to say so, rather than handing over something
  // that is not an id.
  for (const url of [
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/watch?v=short",
    "not a url at all",
  ]) {
    assert.equal(
      extractVideoId(url),
      null,
      `${url} should yield no video`,
    );
  }
});

test("the panel starts with only a Supadata key", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: false };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "syncNotes") return { success: true };
      if (message.action === "getGithubSession") return { success: false };
      return { success: true };
    },
  });

  await harness.fire("DOMContentLoaded");

  assert.notEqual(
    harness.el("errorState").style.display,
    "block",
    "a missing AI key must not block the transcript",
  );
});

test("a broken background is reported with its own message, not a missing key", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "checkConfig") {
        return { error: "Extension context invalidated." };
      }
      return { success: true };
    },
  });

  await harness.fire("DOMContentLoaded");

  assert.equal(harness.el("errorState").style.display, "block");
  assert.match(harness.el("errorMessage").textContent, /Extension context invalidated/);
  assert.doesNotMatch(harness.el("errorMessage").textContent, /API key/);
});

test("adding the missing key later brings the panel back to life", async () => {
  let hasKey = false;
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "checkConfig") {
        return { hasSupadataKey: hasKey, hasAiKey: false };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "syncNotes") return { success: true };
      if (message.action === "getGithubSession") return { success: false };
      return { success: true };
    },
  });

  await harness.fire("DOMContentLoaded");
  assert.equal(harness.el("errorState").style.display, "block");

  hasKey = true;
  harness.fireStorageChange({
    ytd_settings: { oldValue: {}, newValue: { supadataApiKey: "sd_test" } },
  });
  await harness.flush();

  assert.notEqual(harness.el("errorState").style.display, "block");
});

test("opening the panel does not pull the whole vocabulary list", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "syncNotes") return { success: true };
      if (message.action === "getGithubSession") return { success: false };
      return { success: true };
    },
  });

  await harness.fire("DOMContentLoaded");

  const actions = harness.sentMessages.map((message) => message.action);
  assert.equal(actions.includes("syncVocabulary"), false);
});

// ============================================================
// P1-3: every Supadata failure needs its own title
// ============================================================

test("every Supadata failure gets its own title", async () => {
  const cases = [
    ["NO_SUPADATA_KEY", /API key missing/i],
    ["INVALID_SUPADATA_KEY", /Invalid API key/i],
    ["RATE_LIMITED", /Too many requests/i],
    ["NO_TRANSCRIPT", /No transcript found/i],
    ["EMPTY_TRANSCRIPT", /Empty transcript/i],
    ["OUT_OF_CREDITS", /Out of credits/i],
  ];

  for (const [code, expected] of cases) {
    const harness = createPanelHarness({
      sendMessageImpl: async (message) => {
        if (message.action === "fetchTranscript") {
          return { success: false, error: code, message: `raw ${code}` };
        }
        if (message.action === "getNotes") return { success: true, notes: [] };
        return { success: true };
      },
    });

    await harness.helpers.startDigest("videoA", VIDEO_URL);

    assert.match(
      harness.el("errorTitle").textContent,
      expected,
      `expected a dedicated title for ${code}`,
    );
  }
});

test("an invalid Supadata key offers a way to fix it", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid.",
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);

  assert.equal(harness.el("errorBtn").textContent, "Open Settings");
});

// ============================================================
// P0-2: the analysis error must be readable, not a raw code
// ============================================================

test("an analysis failure shows the provider message, never the error code", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "analyzeTranscript") {
        return {
          success: false,
          error: "NO_AI_KEY",
          message:
            "DeepSeek V4 Flash API key not configured. Open YouTube Digest Settings.",
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.helpers.triggerAnalysis();

  const chapterItem = harness.el("chapterList").children[0];
  const message = chapterItem.children[0].textContent;
  assert.match(message, /API key not configured/);
  assert.doesNotMatch(message, /NO_AI_KEY/);

  const button = chapterItem.children.find(
    (child) => child.className === "enhance-btn",
  );
  assert.ok(button, "the missing key must offer an Open Settings button");
  assert.equal(button.textContent, "Open Settings");
});

// ============================================================
// A failed analysis must not leave the panel in a dead state
// ============================================================

test("a failed analysis releases the Overview tab so it can be retried", async () => {
  let analysisCalls = 0;
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return {
          success: false,
          error: "NO_AI_KEY",
          message: "DeepSeek V4 Flash API key not configured.",
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.helpers.triggerAnalysis();

  assert.equal(
    harness.helpers.getState().isAnalysisLoading,
    false,
    "the analysis flag stayed set, so the Overview tab is dead for the rest of the panel's life",
  );

  // The user fixes the key and comes back: the tab has to run again.
  await harness.helpers.triggerAnalysis();
  assert.equal(
    analysisCalls,
    2,
    "the second attempt never reached the provider",
  );
});

// ============================================================
// P0-B: a stale transcript must never land on the next video
// ============================================================

test("a slow transcript for the previous video never lands on the new one", async () => {
  const first = deferred();
  const second = deferred();
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") {
        return message.videoId === "videoA" ? first.promise : second.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  const digestA = harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();
  const digestB = harness.helpers.startDigest(
    "videoB",
    "https://www.youtube.com/watch?v=videoB",
  );
  await harness.flush();

  second.resolve(transcriptPayload("B"));
  await digestB;
  assert.equal(harness.helpers.getState().currentTranscriptText, "B caption");

  first.resolve(transcriptPayload("A"));
  await digestA;

  assert.equal(harness.helpers.getState().currentVideoId, "videoB");
  assert.equal(
    harness.helpers.getState().currentTranscriptText,
    "B caption",
    "the stale transcript overwrote the current one",
  );
  const rendered = harness.el("transcriptList").children
    .map((child) => child.innerHTML)
    .join("");
  assert.doesNotMatch(rendered, /A caption/);
});

// ============================================================
// P0-A: a stale analysis must never land on the next video
// ============================================================

test("a slow analysis for the previous video never lands on the new one", async () => {
  const analysis = deferred();
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "analyzeTranscript") return analysis.promise;
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  const analysisRun = harness.helpers.triggerAnalysis();
  await harness.flush();

  await harness.helpers.startDigest(
    "videoB",
    "https://www.youtube.com/watch?v=videoB",
  );
  await harness.flush();

  analysis.resolve({
    success: true,
    analysis: {
      chapters: [
        {
          title: "Chapter from A",
          summary: "Summary from A",
          timestamp: "0:00",
          timestampSeconds: 0,
        },
      ],
      keyQuotes: [],
    },
  });
  await analysisRun;

  assert.equal(
    harness.helpers.getState().currentAnalysis,
    null,
    "the stale analysis was accepted for the wrong video",
  );
  const chapters = harness.el("chapterList").children
    .map((child) => child.innerHTML)
    .join("");
  assert.doesNotMatch(chapters, /Chapter from A/);

  const cached = harness.storage.local.values.digest_videoB;
  assert.ok(cached, "the new video should still own a cache entry");
  assert.equal(cached.analysis, null);
});

// ============================================================
// P0-C: a failed interface translation must stay retryable
// ============================================================

test("a failed interface translation offers a retry", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  harness.helpers.setTranscriptMode("zh");
  harness.helpers
    .getState()
    .interfaceTranslationFailures.add(
      "videoA:zh:overview:chapter-0-title:Chapter title",
    );

  const html = harness.helpers.renderLocalizedContent(
    "Chapter title",
    "overview",
    "chapter-0-title",
  );

  assert.match(html, /data-interface-retry-surface="overview"/);
  assert.match(html, /data-interface-retry-id="chapter-0-title"/);
});

test("changing video clears the failed interface translations", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  harness.helpers
    .getState()
    .interfaceTranslationFailures.add(
      "videoA:zh:overview:chapter-0-title:Chapter title",
    );
  harness.helpers
    .getState()
    .interfaceTranslationInFlight.add("videoA:zh:overview:quote-0:Quote");

  await harness.helpers.startDigest(
    "videoB",
    "https://www.youtube.com/watch?v=videoB",
  );

  assert.equal(harness.helpers.getState().interfaceTranslationFailures.size, 0);
  assert.equal(harness.helpers.getState().interfaceTranslationInFlight.size, 0);
});

test("changing video drops the translation caches of other videos", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  const state = harness.helpers.getState();
  state.transcriptParagraphCache.set("videoA:zh:semantic:segment-0", "A");
  state.interfaceTranslationCache.set("videoA:zh:overview:quote-0:Quote", "A");

  await harness.helpers.startDigest(
    "videoB",
    "https://www.youtube.com/watch?v=videoB",
  );

  assert.equal(harness.helpers.getState().transcriptParagraphCache.size, 0);
  assert.equal(harness.helpers.getState().interfaceTranslationCache.size, 0);
});

// ============================================================
// P3-3: the notes filter survives a panel reopen
// ============================================================

test("the notes filter survives a panel reopen", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.loadNotesFilter();
  harness.helpers.setNotesFilter(true);
  await harness.flush();

  assert.equal(harness.storage.local.values.ytd_notes_filter, "all");

  // A fresh panel document reads the preference back.
  const reopened = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
    local: { ...harness.storage.local.values },
  });
  await reopened.helpers.loadNotesFilter();

  assert.equal(reopened.helpers.getState().notesFilterShowAll, true);
  assert.equal(reopened.el("notesFilterAll").getAttribute("aria-pressed"), "true");
});

// ============================================================
// P2-1 / P2-2: the panel is honest about cost and speaks the user's language
// ============================================================

test("the panel discloses that it spends the user's own credits", () => {
  const html = read("sidepanel.html");
  assert.match(html, /id="costNote"/);
  assert.match(html, /Supadata credit/);
  assert.match(html, /provider balance/);
});

test("the panel copy is complete in both languages", () => {
  const source = read("sidepanel.js");
  const table = source.match(/const PANEL_COPY = \{[\s\S]*?\n\};/);
  assert.ok(table, "the panel needs a copy table");

  const enSection = table[0].split('"zh-CN":')[0];
  const zhSection = table[0].split('"zh-CN":')[1] || "";
  const en = [...enSection.matchAll(/^\s{4}([A-Za-z0-9]+):/gm)].map((m) => m[1]);
  const zh = [...zhSection.matchAll(/^\s{4}([A-Za-z0-9]+):/gm)].map((m) => m[1]);

  assert.ok(en.length > 10, "the copy table should cover the panel copy");
  assert.deepEqual(zh, en, "both languages must expose the same keys");
  assert.doesNotMatch(table[0], /—/, "the copy must not use em dashes");
});

test("every translated element in the panel has a copy entry", () => {
  const html = read("sidepanel.html");
  const source = read("sidepanel.js");
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 8, "the panel should translate its main surfaces");
  for (const key of keys) {
    assert.match(
      source,
      new RegExp(`\\b${key}:`),
      `missing copy entry for ${key}`,
    );
  }
});

// ============================================================
// P2-5: the dead "key moments" feature is gone
// ============================================================

test("the dead key-moment timeline feature is fully removed", () => {
  const panel = read("sidepanel.js");
  const background = read("background.js");
  const content = read("content.js");
  const prompt = read("prompts/analysis.md");

  assert.doesNotMatch(panel, /keyMoments/);
  assert.doesNotMatch(background, /keyMoments/);
  assert.doesNotMatch(content, /keyMoments/);
  assert.doesNotMatch(content, /highlightKeyMoments/);
  assert.doesNotMatch(prompt, /keyMoments/);
  assert.doesNotMatch(content, /key moment/i);
});

test("clicking the retry button asks for the failed translation again", async () => {
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  harness.helpers.setTranscriptMode("zh");
  harness.helpers
    .getState()
    .interfaceTranslationFailures.add(
      "videoA:zh:overview:chapter-0-title:Chapter title",
    );

  let prevented = false;
  harness.helpers.handleInterfaceRetryClick({
    target: {
      closest: () => ({
        getAttribute: (name) =>
          name === "data-interface-retry-surface" ? "overview" : "chapter-0-title",
      }),
    },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  });

  assert.equal(prevented, true, "the row click must not seek the video");
  assert.equal(harness.helpers.getState().interfaceTranslationFailures.size, 0);
});

test("a mode change invalidates the translation that is still on the wire", async () => {
  const pendingTranslations = [];
  let releaseSettingsWrite;
  const settingsWrite = new Promise((resolve) => {
    releaseSettingsWrite = resolve;
  });

  const harness = createPanelHarness({
    activeTab: "overview",
    beforeLocalSet: async (items) => {
      const modes = items.ytd_display_language_modes_by_video;
      // Only the second switch is slow: that is the one the in-flight
      // translation has to survive.
      if (modes?.videoA?.mode === "bilingual") {
        await settingsWrite;
      }
    },
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "analyzeTranscript") {
        return {
          success: true,
          analysis: {
            chapters: [
              {
                title: "Chapter A",
                summary: "Summary A",
                timestamp: "0:00",
                timestampSeconds: 0,
              },
            ],
            keyQuotes: [],
          },
        };
      }
      if (message.action === "translateContent") {
        return new Promise((resolve) => pendingTranslations.push(resolve));
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.helpers.triggerAnalysis();

  // The user switches to Chinese: the overview translation goes out.
  const chinese = harness.helpers.handleDisplayLanguageModeChange("zh");
  await harness.flush();
  assert.equal(pendingTranslations.length, 1);

  // Before the settings write finishes, the user switches to bilingual.
  const bilingual = harness.helpers.handleDisplayLanguageModeChange("bilingual");
  await harness.flush();

  // The translation for the previous mode comes back while the settings
  // write is still pending.
  pendingTranslations[0]({
    success: true,
    translatedContent: {
      segments: [{ id: "chapter-0-title", text: "第一章" }],
    },
  });
  await harness.flush();

  assert.equal(
    harness.helpers.getState().interfaceTranslationCache.size,
    0,
    "a response for the previous mode was accepted",
  );

  releaseSettingsWrite();
  await harness.flush();
  // The new mode asks again; let that request finish too.
  pendingTranslations[1]?.({
    success: true,
    translatedContent: { segments: [{ id: "chapter-0-title", text: "第一章" }] },
  });
  await chinese;
  await bilingual;
});

// ============================================================
// The work the user pays for must happen once, and must not
// be thrown away
// ============================================================

function analysisPayload() {
  return {
    success: true,
    analysis: {
      chapters: [
        {
          title: "Opening",
          summary: "What the video is about",
          timestamp: "0:00",
          timestampSeconds: 0,
        },
      ],
      keyQuotes: [
        {
          quote: "A quote worth keeping",
          timestamp: "0:30",
          timestampSeconds: 30,
        },
      ],
    },
  };
}

/**
 * A panel that is ready to work: a Supadata key, an AI key and a YouTube
 * tab in front of it.
 */
function createYoutubeHarness(options = {}) {
  return createPanelHarness({
    tabs: options.tabs ?? [{ id: 7, url: VIDEO_URL }],
    sendMessageImpl: async (message) => {
      if (options.sendMessageImpl) {
        const custom = await options.sendMessageImpl(message);
        if (custom !== undefined) return custom;
      }
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true };
      }
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "analyzeTranscript") return analysisPayload();
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "syncNotes") return { success: true };
      if (message.action === "getGithubSession") return { success: false };
      return { success: true };
    },
  });
}

test("opening the panel on a YouTube video buys one transcript, not two", async () => {
  const transcript = deferred();
  let transcriptLookups = 0;
  const harness = createYoutubeHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") {
        transcriptLookups += 1;
        return transcript.promise;
      }
      return undefined;
    },
  });

  // The panel opens: the boot path asks for the transcript of the video.
  const boot = harness.fire("DOMContentLoaded");
  await harness.flush();
  assert.equal(transcriptLookups, 1, "the panel never asked for the transcript");

  // YouTube finishes loading the page and the extension hears about the
  // navigation while the first lookup is still on the wire.
  harness.fireTabUpdate(
    7,
    { url: VIDEO_URL },
    { id: 7, url: VIDEO_URL, active: true, windowId: 1 },
  );
  harness.runTimers();
  await harness.flush();

  transcript.resolve(transcriptPayload("A"));
  await boot;
  await harness.flush();

  assert.equal(
    transcriptLookups,
    1,
    "the panel paid for the same transcript twice",
  );
  assert.equal(
    harness.helpers.getState().currentTranscriptText,
    "A caption",
    "the transcript never reached the panel",
  );
});

test("a paid analysis survives the refresh a navigation starts", async () => {
  const analysis = deferred();
  let analysisCalls = 0;
  let frontTab = { id: 7, url: VIDEO_URL };
  const harness = createYoutubeHarness({
    tabs: () => [frontTab],
    sendMessageImpl: async (message) => {
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return analysis.promise;
      }
      return undefined;
    },
  });

  await harness.fire("DOMContentLoaded");
  await harness.flush();

  // The user opens the Overview tab: the analysis goes out and is paid for.
  const run = harness.helpers.triggerAnalysis();
  await harness.flush();
  assert.match(harness.htmlOf("chapterList"), /Generating overview/);

  // The user moves to another video and back while the AI is still working.
  // The refresh the first navigation scheduled fires for the video that is
  // on screen now, so the panel runs the digest for it again.
  harness.fireTabUpdate(
    7,
    { url: "https://www.youtube.com/watch?v=videoB" },
    {
      id: 7,
      url: "https://www.youtube.com/watch?v=videoB",
      active: true,
      windowId: 1,
    },
  );
  frontTab = { id: 7, url: VIDEO_URL };
  harness.runTimers();
  await harness.flush();

  analysis.resolve(analysisPayload());
  await run;
  await harness.flush();

  assert.equal(analysisCalls, 1, "the analysis was paid for more than once");
  assert.doesNotMatch(
    harness.htmlOf("chapterList"),
    /Generating overview/,
    "the Overview tab is stuck on the loading message",
  );
  assert.match(
    harness.htmlOf("chapterList"),
    /Opening/,
    "the paid analysis was thrown away",
  );
});

test("a second analysis for the same video joins the one on the wire", async () => {
  const analysis = deferred();
  let analysisCalls = 0;
  const harness = createYoutubeHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return analysis.promise;
      }
      return undefined;
    },
  });

  await harness.fire("DOMContentLoaded");
  await harness.flush();

  const first = harness.helpers.triggerAnalysis();
  await harness.flush();

  // The panel runs the digest for the same video again - a navigation
  // refresh does exactly that - while the analysis is still working.
  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();

  // The user comes back to the Overview tab.
  const second = harness.helpers.triggerAnalysis();
  await harness.flush();

  assert.equal(analysisCalls, 1, "the same analysis was paid for twice");

  analysis.resolve(analysisPayload());
  await first;
  await second;
  await harness.flush();

  assert.match(harness.htmlOf("chapterList"), /Opening/);
});

test("a second transcript lookup for the same video joins the one on the wire", async () => {
  const transcript = deferred();
  let transcriptLookups = 0;
  const harness = createYoutubeHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") {
        transcriptLookups += 1;
        return transcript.promise;
      }
      return undefined;
    },
  });

  const first = harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();
  const second = harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();

  assert.equal(transcriptLookups, 1, "the same transcript was bought twice");

  transcript.resolve(transcriptPayload("A"));
  await first;
  await second;
  await harness.flush();

  assert.equal(harness.helpers.getState().currentTranscriptText, "A caption");
});

test("the previous video's chapters and quotes do not survive a video change", async () => {
  const harness = createYoutubeHarness();

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.helpers.triggerAnalysis();
  await harness.flush();
  assert.match(harness.htmlOf("chapterList"), /Opening/);
  assert.match(harness.htmlOf("quotesList"), /A quote worth keeping/);

  await harness.helpers.startDigest(
    "videoB",
    "https://www.youtube.com/watch?v=videoB",
  );
  await harness.flush();

  assert.doesNotMatch(
    harness.htmlOf("chapterList"),
    /Opening/,
    "the chapters of the previous video are still on screen",
  );
  assert.doesNotMatch(
    harness.htmlOf("quotesList"),
    /A quote worth keeping/,
    "the quotes of the previous video are still on screen",
  );
  assert.equal(
    harness.helpers.getState().currentAnalysis,
    null,
    "the analysis of the previous video is still loaded",
  );
});

test("a re-run for the same video does not invalidate the work in flight", async () => {
  const harness = createYoutubeHarness();

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  const afterFirst = harness.helpers.getState();
  assert.equal(afterFirst.videoTicket, 1, "the video ticket must follow the video");

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  const afterSecond = harness.helpers.getState();

  assert.equal(
    afterSecond.videoTicket,
    afterFirst.videoTicket,
    "a re-run for the same video changed the video ticket",
  );
  assert.equal(
    afterSecond.digestRunCount,
    afterFirst.digestRunCount + 1,
    "a re-run for the same video is still a run",
  );
});

test("the panel does not fall back to the video the user already left", async () => {
  let frontTab = { id: 7, url: VIDEO_URL };
  const harness = createYoutubeHarness({
    tabs: () => [frontTab],
    sendMessageImpl: async (message) => {
      if (message.action === "relayToContent") {
        // The user moves to another video while the title is on the wire.
        frontTab = {
          id: 7,
          url: "https://www.youtube.com/watch?v=videoB",
        };
        return {
          success: true,
          response: { title: "Video A", channelName: "Channel A" },
        };
      }
      return undefined;
    },
  });

  await harness.helpers.checkCurrentTab();
  await harness.flush();

  assert.equal(
    harness.helpers.getState().currentVideoId,
    null,
    "the panel digested the video the user already left",
  );
  assert.equal(harness.helpers.getState().currentTranscriptText, null);
});

test("a translation that arrives after the language changed is kept for its video", async () => {
  const pendingTranslations = [];
  let translationRequests = 0;
  const harness = createPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "fetchTranscript") return transcriptPayload("A");
      if (message.action === "translateContent") {
        translationRequests += 1;
        const request = message;
        return new Promise((resolve) => {
          pendingTranslations.push(() =>
            resolve({
              success: true,
              translatedContent: {
                segments: request.content.segments.map((segment) => ({
                  id: segment.id,
                  text: `译:${segment.text}`,
                })),
              },
            }),
          );
        });
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return { success: true };
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();

  // The user asks for Chinese: the translation goes out and is paid for.
  const chinese = harness.helpers.handleDisplayLanguageModeChange("zh");
  await harness.flush();
  assert.equal(translationRequests, 1, "the translation never left the panel");

  // The user changes their mind before it lands.
  const original = harness.helpers.handleDisplayLanguageModeChange("original");
  await harness.flush();

  // The paid translation arrives after the panel moved on.
  pendingTranslations[0]();
  await chinese;
  await original;
  await harness.flush();

  // Asking for Chinese again must not pay for the same text twice.
  const chineseAgain = harness.helpers.handleDisplayLanguageModeChange("zh");
  await harness.flush();
  assert.equal(
    translationRequests,
    1,
    "the same translation was paid for twice",
  );
  await chineseAgain;
});

test("the Overview tab says what the analysis costs when it starts", async () => {
  const analysis = deferred();
  const harness = createYoutubeHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "analyzeTranscript") return analysis.promise;
      return undefined;
    },
  });

  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();

  const run = harness.helpers.triggerAnalysis();
  await harness.flush();

  const message = harness.htmlOf("chapterList");
  assert.match(message, /Generating overview/);
  assert.match(
    message,
    /AI balance/,
    "the cost of the analysis is not stated where the user triggers it",
  );

  analysis.resolve(analysisPayload());
  await run;
});
