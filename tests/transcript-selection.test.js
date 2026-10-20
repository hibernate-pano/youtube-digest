const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// ============================================================
// A DOM stand-in
//
// The panel is the product's main surface, so these tests drive the real
// sidepanel.js inside a vm sandbox instead of asserting on its source text.
// The stub below is deliberately small: it stores what the panel writes so a
// test can observe it, and it understands just enough CSS to answer the
// queries the panel actually makes.
// ============================================================

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function splitList(value) {
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Parses "#id", "tag", ".class" and "[attr=value]" into one token set. */
function parseSimple(selector) {
  const tokens = { tag: null, id: null, classes: [], attrs: [] };
  const pattern =
    /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g;
  let match;
  while ((match = pattern.exec(selector)) !== null) {
    if (match[1]) tokens.tag = match[1].toLowerCase();
    else if (match[2]) tokens.id = match[2];
    else if (match[3]) tokens.classes.push(match[3]);
    else if (match[4]) tokens.attrs.push([match[4], match[5] ?? ""]);
  }
  return tokens;
}

function matchesSimple(element, tokens) {
  if (!element || typeof element.matchesSimple !== "function") return false;
  if (tokens.tag && element.tagName !== tokens.tag) return false;
  if (tokens.id && element.id !== tokens.id) return false;
  for (const name of tokens.classes) {
    if (!element.classList.contains(name)) return false;
  }
  for (const [name, value] of tokens.attrs) {
    if (element.getAttribute(name) !== value) return false;
  }
  return true;
}

/** Matches a descendant chain such as "#transcriptList .transcript-entry". */
function matchesChain(element, chain) {
  const parts = chain.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (!matchesSimple(element, parseSimple(parts[parts.length - 1]))) return false;

  let ancestor = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const token = parseSimple(parts[index]);
    let found = null;
    while (ancestor) {
      if (matchesSimple(ancestor, token)) {
        found = ancestor;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (!found) return false;
    ancestor = found.parentElement;
  }
  return true;
}

function matchesSelector(element, selector) {
  return splitList(selector).some((part) => matchesChain(element, part));
}

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.parentElement = null;
    this.parentNode = null;
    this.childNodes = [];
  }

  get textContent() {
    return this.nodeValue;
  }
}

class FakeElement {
  constructor(tagName = "div", owner = null) {
    this.tagName = String(tagName).toLowerCase();
    this.nodeType = 1;
    this.owner = owner;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.value = "";
    this.scrollTop = 0;
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.scrollIntoViewCalls = [];
    this._classes = new Set();
    this._id = "";
    this._text = null;
    this._html = null;

    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  get id() {
    return this._id;
  }

  set id(value) {
    this._id = String(value ?? "");
    this.owner?.registerElement(this);
  }

  get className() {
    return [...this._classes].join(" ");
  }

  set className(value) {
    this._classes = new Set(
      String(value ?? "")
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this._html = null;
  }

  get innerHTML() {
    if (this._html !== null) return this._html;
    return escapeText(this._text ?? "");
  }

  set innerHTML(value) {
    this._html = String(value ?? "");
    this._text = null;
    this.children = [];
    const parsed = parseHtml(this._html, this.owner);
    for (const child of parsed.children) this.appendChild(child);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    if (Object.hasOwn(this.attributes, name)) return this.attributes[name];
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      if (Object.hasOwn(this.dataset, key)) return this.dataset[key];
    }
    return null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== listener),
    );
  }

  /** Fires every listener registered for `type` and returns the events used. */
  dispatch(type, event = {}) {
    const payload = Object.assign(
      {
        type,
        target: this,
        currentTarget: this,
        preventDefault() {},
        stopPropagation() {},
      },
      event,
    );
    for (const listener of this.listeners.get(type) || []) {
      listener(payload);
    }
    return payload;
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.parentNode = this;
    child.isConnected = true;
    return child;
  }

  appendText(value) {
    const node = new FakeText(value);
    this.appendChild(node);
    return node;
  }

  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    if (index === -1) this.appendChild(child);
    else {
      child.parentElement?.removeChild(child);
      this.children.splice(index, 0, child);
      child.parentElement = this;
      child.parentNode = this;
    }
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }

  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index === -1) return previous;
    previous.parentElement = null;
    next.parentElement?.removeChild(next);
    this.children.splice(index, 1, next);
    next.parentElement = this;
    next.parentNode = this;
    return previous;
  }

  normalize() {}

  contains(node) {
    if (node === this) return true;
    return this.children.some(
      (child) => child === node || child.contains?.(node) === true,
    );
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matchesSimple?.(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  matchesSimple(selector) {
    return splitList(selector).some((part) =>
      matchesSimple(this, parseSimple(part)),
    );
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  scrollIntoView(options) {
    this.scrollIntoViewCalls.push(options || {});
  }
}

/** A tiny HTML parser: enough for the markup the panel assigns itself. */
function parseHtml(html, owner) {
  const root = new FakeElement("div", owner);
  const stack = [root];
  const tokens = html.match(/<[^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      stack[stack.length - 1].appendText(token);
      continue;
    }
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = token.endsWith("/>");
    const inner = token.slice(1, token.length - (selfClosing ? 2 : 1));
    const nameMatch = /^([a-zA-Z][\w-]*)/.exec(inner);
    if (!nameMatch) continue;
    const element = new FakeElement(nameMatch[1], owner);
    const rest = inner.slice(nameMatch[1].length);
    const attrPattern = /([a-zA-Z-]+)\s*=\s*"([^"]*)"|([a-zA-Z-]+)(?=\s|$)/g;
    let attr;
    while ((attr = attrPattern.exec(rest)) !== null) {
      if (attr[1]) element.setAttribute(attr[1], attr[2]);
      else if (attr[3]) element.setAttribute(attr[3], "");
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing) stack.push(element);
  }
  return root;
}

// ============================================================
// The panel harness
// ============================================================

const PANEL_ELEMENT_IDS = [
  "welcomeState",
  "loadingState",
  "errorState",
  "resultsState",
  "uploadState",
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
  "transcriptSearchPrevBtn",
  "transcriptSearchNextBtn",
  "notesFilterThis",
  "notesFilterAll",
  "settingsBtn",
  "syncBtn",
  "syncAccount",
  "copyTranscriptBtn",
  "exportTranscriptBtn",
];

const TAB_NAMES = ["transcript", "overview", "notes"];

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
 * Builds a sandbox that runs the real sidepanel.js.
 *
 * The chrome stub behaves like the browser: `tabs.query` honours the
 * `active`/`lastFocusedWindow`/`url` filters, so a panel that asked for "any
 * YouTube tab" would really receive a background tab here.
 */
function createPanelHarness({
  sendMessageImpl = async () => ({ success: true }),
  local = {},
  session = {},
  tabs = [],
  focusedWindowId = 1,
} = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const sentMessages = [];
  const tabMessages = [];
  const timers = new Map();
  const intervals = new Map();
  const frames = [];
  let nextTimerId = 1;

  const registerElement = (element) => {
    if (element.id) elements.set(element.id, element);
    return element;
  };
  const owner = { registerElement };

  const body = new FakeElement("body", owner);
  const document = {
    readyState: "complete",
    body,
    head: new FakeElement("head"),
    addEventListener(type, handler, options = {}) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push({ handler, signal: options?.signal });
    },
    removeEventListener() {},
    querySelectorAll: (selector) =>
      body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new FakeElement(tag, owner),
    createTextNode: (text) => new FakeText(text),
    createDocumentFragment: () => new FakeElement("fragment", owner),
    createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
    execCommand: () => true,
  };

  for (const id of PANEL_ELEMENT_IDS) {
    const element = new FakeElement("div", owner);
    element.id = id;
    registerElement(element);
  }

  // The tab bar and its panels, wired the way sidepanel.html wires them.
  const tabsNav = elements.get("tabsNav");
  body.appendChild(tabsNav);
  for (const name of TAB_NAMES) {
    const tab = new FakeElement("button", owner);
    tab.dataset.tab = name;
    tab.setAttribute("data-tab", name);
    tab.classList.add("tab");
    if (name === "transcript") tab.classList.add("active");
    tabsNav.appendChild(tab);

    const panel = new FakeElement("div", owner);
    panel.dataset.panel = name;
    panel.setAttribute("data-panel", name);
    panel.classList.add("tab-panel");
    if (name === "transcript") panel.classList.add("active");
    body.appendChild(panel);
  }

  // The transcript list has to live inside the document so that
  // `#transcriptList .transcript-entry` queries resolve.
  const transcriptList = elements.get("transcriptList");
  body.appendChild(transcriptList);
  body.appendChild(elements.get("contentArea"));
  body.appendChild(elements.get("followPlaybackBtn"));
  body.appendChild(elements.get("transcriptSearchInput"));
  body.appendChild(elements.get("transcriptSearchCount"));
  body.appendChild(elements.get("transcriptSearchPrevBtn"));
  body.appendChild(elements.get("transcriptSearchNextBtn"));
  body.appendChild(elements.get("transcriptSearchClearBtn"));
  body.appendChild(elements.get("notesFilterThis"));
  body.appendChild(elements.get("notesFilterAll"));
  body.appendChild(elements.get("settingsBtn"));
  body.appendChild(elements.get("syncBtn"));
  body.appendChild(elements.get("syncAccount"));
  body.appendChild(elements.get("copyTranscriptBtn"));
  body.appendChild(elements.get("exportTranscriptBtn"));
  body.appendChild(elements.get("chapterList"));
  body.appendChild(elements.get("quotesList"));
  body.appendChild(elements.get("notesList"));

  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session);

  const sendMessage = async (message) => {
    sentMessages.push(message);
    return sendMessageImpl(message);
  };

  const selection = {
    rangeCount: 0,
    isCollapsed: true,
    text: "",
    range: null,
    removeAllRangesCalls: 0,
    toString() {
      return this.text;
    },
    getRangeAt() {
      return this.range;
    },
    removeAllRanges() {
      this.removeAllRangesCalls += 1;
      this.rangeCount = 0;
      this.isCollapsed = true;
      this.text = "";
      this.range = null;
    },
  };

  const clock = { now: Date.now() };
  class SandboxDate extends Date {
    static now() {
      return clock.now;
    }
  }

  const sandbox = {
    console,
    Date: SandboxDate,
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
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    CSS: { escape: (value) => value },
    navigator: { clipboard: { writeText: async () => {} } },
    window: {
      getSelection: () => selection,
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
        onChanged: { addListener() {} },
      },
      windows: { getCurrent: () => Promise.resolve({ id: focusedWindowId }) },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        query: async (query = {}) => {
          let matches = tabs.slice();
          if (query.active === true) {
            matches = matches.filter((tab) => tab.active);
          }
          if (query.lastFocusedWindow === true) {
            matches = matches.filter(
              (tab) => tab.windowId === focusedWindowId,
            );
          }
          if (typeof query.url === "string") {
            matches = matches.filter((tab) => tab.url?.startsWith(query.url));
          }
          return matches;
        },
        get: async (tabId) => tabs.find((tab) => tab.id === tabId) || null,
        sendMessage: async (tabId, payload) => {
          tabMessages.push({ tabId, payload });
          return { success: true };
        },
        create: async () => ({ id: 99 }),
      },
    },
    YTD_SETTINGS: require("../settings.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);

  const harness = {
    sandbox,
    helpers: sandbox.__YTD_PANEL_TESTING__,
    document,
    body,
    elements,
    sentMessages,
    tabMessages,
    selection,
    local: localArea,
    session: sessionArea,
    el: (id) => elements.get(id) || null,
    tabs: () => body.querySelectorAll(".tab"),
    panels: () => body.querySelectorAll(".tab-panel"),
    transcriptRows: () => body.querySelectorAll(".transcript-entry"),
    tooltip: () => elements.get("explainTooltip") || null,

    /** Sets the browser text selection the panel will observe. */
    selectText(text, range) {
      selection.rangeCount = range ? 1 : 0;
      selection.isCollapsed = !range;
      selection.text = text;
      selection.range = range || null;
    },

    /** Moves the sandbox clock forward, so "recently scrolled" windows pass. */
    advanceClock(milliseconds) {
      clock.now += milliseconds;
    },

    /** Runs the queued requestAnimationFrame callbacks. */
    flushFrames() {
      while (frames.length > 0) {
        const callback = frames.shift();
        callback(0);
      }
    },

    /** Runs the queued timers (the 150ms view-state save). */
    flushTimers() {
      for (const [id, timer] of [...timers.entries()]) {
        timers.delete(id);
        timer.callback();
      }
    },

    /** Runs one playback-tracking tick. */
    async firePlaybackTick() {
      const timer = [...intervals.values()].find(
        (candidate) => candidate.delay === 500,
      );
      assert.ok(timer, "playback tracking must be running");
      await timer.callback();
    },

    /** Every seek the panel asked for, through either channel. */
    seeks() {
      const relayed = sentMessages
        .filter(
          (message) =>
            message.action === "relayToContent" &&
            message.payload?.action === "seekTo",
        )
        .map((message) => message.payload);
      const direct = tabMessages
        .filter((message) => message.payload?.action === "seekTo")
        .map((message) => message.payload);
      return [...relayed, ...direct];
    },

    /** Fires a document-level event and awaits the async handlers. */
    async fireDocument(type, event = {}) {
      const handlers = documentListeners.get(type) || [];
      for (const { handler, signal } of handlers) {
        if (signal?.aborted) continue;
        await handler(
          Object.assign(
            { type, target: body, preventDefault() {}, stopPropagation() {} },
            event,
          ),
        );
      }
    },

    /** Fires a DOMContentLoaded and waits for the panel to boot. */
    async boot() {
      await harness.fireDocument("DOMContentLoaded");
      await harness.flushMicrotasks();
    },

    async flushMicrotasks() {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };

  return harness;
}

const VIDEO_URL = "https://www.youtube.com/watch?v=videoA";

// The panel groups captions into transcript rows, so the captions have to be
// long enough and end on a sentence boundary to stay two separate rows.
const FIRST_CAPTION =
  "The first caption explains how the panel restores a saved reading position.";
const SECOND_CAPTION =
  "The second caption explains how a selected row seeks the video to its timestamp.";

function transcriptPayload(label = "A") {
  return {
    success: true,
    transcript: [
      { text: FIRST_CAPTION, start: 0, duration: 2, language: "en" },
      { text: SECOND_CAPTION, start: 30, duration: 2, language: "en" },
    ],
    transcriptText: FIRST_CAPTION,
    transcriptTextTimestamped: `[0:00] ${FIRST_CAPTION}`,
    language: "en",
  };
}

/** Boots a panel that already shows a transcript for `videoA`. */
async function openPanel(options = {}) {
  const state = { currentTime: 0 };
  const defaultSendMessage = async (message) => {
    if (message.action === "checkConfig") {
      return { hasSupadataKey: true, hasAiKey: true };
    }
    if (message.action === "fetchTranscript") return transcriptPayload();
    if (message.action === "getNotes") return { success: true, notes: [] };
    if (message.action === "getGithubSession") return { success: false };
    if (message.action === "relayToContent") {
      if (message.payload?.action === "getCurrentTime") {
        return { success: true, response: { currentTime: state.currentTime } };
      }
      return { success: true };
    }
    return { success: true };
  };

  const harness = createPanelHarness({
    ...options,
    sendMessageImpl: options.sendMessageImpl ?? defaultSendMessage,
  });
  harness.setCurrentTime = (seconds) => {
    state.currentTime = seconds;
  };
  await harness.boot();
  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flushMicrotasks();
  harness.flushFrames();
  await harness.flushMicrotasks();
  return harness;
}

// ============================================================
// Selecting text in the transcript
// ============================================================

test("a transcript row click seeks the video to that row's timestamp", async () => {
  const harness = await openPanel();

  const rows = harness.transcriptRows();
  assert.equal(rows.length, 2, "the transcript must render one row per caption");

  rows[1].dispatch("click");
  await harness.flushMicrotasks();

  const seeks = harness.seeks();
  assert.equal(seeks.length, 1, "a row click must seek exactly once");
  assert.equal(seeks[0].seconds, 30);
});

test("a transcript row click does not seek while text is selected", async () => {
  const harness = await openPanel();
  const rows = harness.transcriptRows();

  const row = rows[1];
  harness.selectText(SECOND_CAPTION, {
    startContainer: row,
    endContainer: row,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 100 }),
  });

  let prevented = false;
  let stopped = false;
  row.dispatch("click", {
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });

  const seeks = harness.seeks();
  assert.equal(seeks.length, 0, "a selection click must not move the video");
  assert.equal(prevented, true, "the click must be cancelled");
  assert.equal(stopped, true, "the click must not reach the row");
});

test("the selection toolbar offers Explain and Note for the selected words", async () => {
  const harness = await openPanel();
  const row = harness.transcriptRows()[1];

  harness.selectText(SECOND_CAPTION, {
    startContainer: row,
    endContainer: row,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 100 }),
  });
  await harness.fireDocument("mouseup");

  const tooltip = harness.tooltip();
  assert.ok(tooltip, "the selection toolbar must exist");
  assert.equal(tooltip.style.display, "flex", "the toolbar must be visible");
  assert.ok(
    tooltip.querySelector(".explain-btn"),
    "the toolbar must offer an Explain action",
  );
  assert.ok(
    tooltip.querySelector(".selection-note-btn"),
    "the toolbar must offer a Note action",
  );
});

test("the Note action saves the selected words with the row's timestamp", async () => {
  const harness = await openPanel();
  const row = harness.transcriptRows()[1];

  harness.selectText(SECOND_CAPTION, {
    startContainer: row,
    endContainer: row,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 100 }),
  });
  await harness.fireDocument("mouseup");

  const noteButton = harness.tooltip().querySelector(".selection-note-btn");
  await noteButton.dispatch("click");
  await harness.flushMicrotasks();

  const saves = harness.sentMessages.filter(
    (message) => message.action === "saveNote",
  );
  assert.equal(saves.length, 1, "the Note action must save exactly one note");
  assert.equal(saves[0].selectedText, SECOND_CAPTION);
  assert.equal(saves[0].timestamp, 30, "the note must point at the selected row");
});

test("interacting with the selection toolbar keeps the text selected", async () => {
  const harness = await openPanel();
  const row = harness.transcriptRows()[1];

  harness.selectText(SECOND_CAPTION, {
    startContainer: row,
    endContainer: row,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 100 }),
  });
  await harness.fireDocument("mouseup");

  const tooltip = harness.tooltip();
  let prevented = false;
  let stopped = false;
  tooltip.dispatch("mousedown", {
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });

  assert.equal(prevented, true, "the toolbar must swallow the mousedown");
  assert.equal(stopped, true, "the toolbar must keep the click to itself");
  assert.equal(
    harness.selection.removeAllRangesCalls,
    0,
    "the selection must survive the interaction",
  );
  assert.equal(harness.selection.text, SECOND_CAPTION);
});

test("leaving Transcript dismisses its selection actions", async () => {
  const harness = await openPanel();
  const row = harness.transcriptRows()[1];

  harness.selectText(SECOND_CAPTION, {
    startContainer: row,
    endContainer: row,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 100 }),
  });
  await harness.fireDocument("mouseup");
  assert.equal(harness.tooltip().style.display, "flex");

  harness.tabs().find((tab) => tab.dataset.tab === "overview").dispatch("click");
  harness.flushFrames();

  assert.equal(harness.tooltip().style.display, "none");
  assert.equal(
    harness.selection.removeAllRangesCalls,
    1,
    "the browser range must be cleared too",
  );
});

// ============================================================
// Reading position
// ============================================================

test("Notes opens at its newest item and Transcript keeps its position", async () => {
  const harness = await openPanel();
  const contentArea = harness.el("contentArea");

  contentArea.scrollTop = 420;
  harness.tabs().find((tab) => tab.dataset.tab === "notes").dispatch("click");
  harness.flushFrames();
  assert.equal(contentArea.scrollTop, 0, "Notes must open at the top");

  harness.tabs().find((tab) => tab.dataset.tab === "transcript").dispatch("click");
  harness.flushFrames();
  assert.equal(
    contentArea.scrollTop,
    420,
    "Transcript must come back to the reading position",
  );
});

test("the transcript view restores without resuming automatic scrolling", async () => {
  const harness = await openPanel({
    session: {
      ytd_transcript_view_state: {
        videoA: { scrollTop: 275, updatedAt: Date.now() },
      },
    },
  });

  const contentArea = harness.el("contentArea");
  assert.equal(
    contentArea.scrollTop,
    275,
    "the saved reading position must be restored",
  );

  // Playback continues while the user reads: the panel must not drag the
  // transcript back to the spoken line.
  await harness.firePlaybackTick();

  const scrolled = harness.transcriptRows().some(
    (row) => row.scrollIntoViewCalls.length > 0,
  );
  assert.equal(
    scrolled,
    false,
    "a restored reading position must not resume automatic scrolling",
  );
  assert.equal(
    harness.el("followPlaybackBtn").style.display,
    "block",
    "the user must be able to resume following the playback",
  );
});

test("a manual scroll stops the panel from following the playback", async () => {
  const harness = await openPanel();
  const contentArea = harness.el("contentArea");
  const rows = harness.transcriptRows();

  // The panel follows the playback until the user scrolls away.
  harness.setCurrentTime(0);
  await harness.firePlaybackTick();
  assert.equal(
    rows[0].scrollIntoViewCalls.length,
    1,
    "the panel must follow the playback by default",
  );

  // Now the user scrolls by hand. The panel ignores scroll events it caused
  // itself, so the clock has to move past that window first.
  harness.advanceClock(2000);
  contentArea.dispatch("scroll");

  harness.setCurrentTime(30);
  await harness.firePlaybackTick();
  assert.equal(
    rows[1].scrollIntoViewCalls.length,
    0,
    "a manual scroll must stop the panel from following the playback",
  );
  assert.equal(
    harness.el("followPlaybackBtn").style.display,
    "block",
    "the user must be offered a way to resume following the playback",
  );
});

// ============================================================
// Which tab the panel belongs to
// ============================================================

test("the first non-YouTube navigation is checked again after commit", () => {
  const helpers = createPanelHarness().sandbox.__YTD_TRANSCRIPT_TESTING__;

  assert.equal(
    helpers.getNavigationUrl({ status: "loading" }, { pendingUrl: "https://a" }),
    "https://a",
    "a loading tab must be judged by its pending url",
  );
  assert.equal(
    helpers.getNavigationUrl({ status: "complete" }, { url: "https://b" }),
    "https://b",
    "a committed tab must be judged by its url",
  );
  assert.equal(
    helpers.getNavigationUrl({ status: "loading" }, { url: "https://c" }),
    "https://c",
    "a tab without a pending url falls back to its url",
  );
  assert.equal(
    helpers.getNavigationUrl({ title: "x" }, { url: "https://d" }),
    "",
    "an unrelated tab event must not be treated as a navigation",
  );
});

test("the panel never borrows a background YouTube tab", async () => {
  const harness = createPanelHarness({
    tabs: [
      // A background YouTube tab comes first on purpose: a panel that asked
      // for "any YouTube tab" would pick this one.
      {
        id: 2,
        url: "https://www.youtube.com/watch?v=videoB",
        active: false,
        windowId: 1,
      },
      {
        id: 1,
        url: "https://www.youtube.com/watch?v=videoA",
        active: true,
        windowId: 1,
      },
    ],
    sendMessageImpl: async (message) => {
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true };
      }
      if (message.action === "fetchTranscript") {
        return {
          success: true,
          transcript: [
            { text: "caption", start: 0, duration: 2, language: "en" },
          ],
          transcriptText: "caption",
          transcriptTextTimestamped: "[0:00] caption",
          language: "en",
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "getGithubSession") return { success: false };
      return { success: true };
    },
  });

  await harness.boot();
  await harness.flushMicrotasks();

  assert.equal(
    harness.sandbox.__YTD_PANEL_TESTING__.getState().currentVideoId,
    "videoA",
    "the panel must follow the tab in front of the user, not a background tab",
  );
});
