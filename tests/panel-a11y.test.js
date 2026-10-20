const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* ============================================================
   Keyboard reachability and motion in the side panel.

   The panel is the product's main surface, so these tests drive the real
   sidepanel.js inside a sandbox instead of a copy of its logic, and they
   read the real sidepanel.css and options.css for the rules a stylesheet
   has to carry. The DOM stub understands the parts of the browser the panel
   relies on: selectors, attributes, the event path, focus, and the real
   markup of sidepanel.html.
   ============================================================ */

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function camelToDash(name) {
  return String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function dashToCamel(name) {
  return String(name).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ""));
}

/* ---------- selectors ---------- */

function parseCompound(part) {
  const compound = { tag: null, id: null, classes: [], attrs: [] };
  const pattern = /(\[[^\]]+\]|[.#]?[\w-]+)/g;
  let match;
  while ((match = pattern.exec(part))) {
    const token = match[0];
    if (token.startsWith(".")) {
      compound.classes.push(token.slice(1));
    } else if (token.startsWith("#")) {
      compound.id = token.slice(1);
    } else if (token.startsWith("[")) {
      const body = token.slice(1, -1);
      const equals = body.indexOf("=");
      if (equals === -1) {
        compound.attrs.push({ name: body.trim(), value: null });
      } else {
        compound.attrs.push({
          name: body.slice(0, equals).trim(),
          value: body
            .slice(equals + 1)
            .trim()
            .replace(/^["']|["']$/g, ""),
        });
      }
    } else {
      compound.tag = token.toUpperCase();
    }
  }
  return compound;
}

function parseSelector(selector) {
  return String(selector)
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => group.split(/\s+/).map(parseCompound));
}

function matchesCompound(element, compound) {
  if (compound.tag && element.tagName !== compound.tag) return false;
  if (compound.id && element.getAttribute("id") !== compound.id) return false;
  for (const name of compound.classes) {
    if (!element.classList.contains(name)) return false;
  }
  for (const attr of compound.attrs) {
    const value = element.getAttribute(attr.name);
    if (value === null) return false;
    if (attr.value !== null && value !== attr.value) return false;
  }
  return true;
}

function matchesSelector(element, alternatives) {
  return alternatives.some((chain) => {
    // The element matches the last part of the chain; every part before it
    // must match one of its ancestors, the way a descendant selector reads.
    let index = chain.length - 1;
    if (!matchesCompound(element, chain[index])) return false;
    index -= 1;
    let node = element.parentElement;
    while (index >= 0) {
      if (!node) return false;
      if (matchesCompound(node, chain[index])) index -= 1;
      node = node.parentElement;
    }
    return true;
  });
}

/* ---------- events ---------- */

class MiniEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key;
    this.shiftKey = Boolean(init.shiftKey);
    this.target = init.target || null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediateStopped = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.propagationStopped = true;
    this.immediateStopped = true;
  }
}

function invokeListeners(node, event, capture) {
  const listeners = node.listeners?.get(event.type);
  if (!listeners) return;
  for (const entry of [...listeners]) {
    if (entry.capture !== capture) continue;
    if (entry.once && entry.called) continue;
    event.currentTarget = node;
    if (entry.once) entry.called = true;
    entry.listener.call(node, event);
    if (event.immediateStopped) return;
  }
}

/* ---------- nodes ---------- */

class MiniText {
  constructor(text, raw = false) {
    this.nodeType = 3;
    this.nodeValue = String(text ?? "");
    this.parentNode = null;
    this.raw = raw;
  }

  get textContent() {
    return this.raw ? stripTags(this.nodeValue) : this.nodeValue;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1
      ? this.parentNode
      : null;
  }
}

class MiniElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument || null;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.value = "";
    this.scrollTop = 0;
    this.inert = false;
    this.clientWidth = 360;
    this.scrollIntoViewCalls = [];
    // The selection toolbar is 146px wide in the browser. The stub reports
    // the same width so the clamp can be tested.
    this.offsetWidth = 146;
    this._classes = new Set();
    this._rawHtml = null;
    this._dataset = new Map();

    const element = this;
    this.dataset = new Proxy(this._dataset, {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        return target.get(dashToCamel(prop));
      },
      set(target, prop, value) {
        if (typeof prop !== "string") return false;
        target.set(dashToCamel(prop), String(value));
        element.setAttribute(`data-${camelToDash(prop)}`, String(value));
        return true;
      },
      has(target, prop) {
        return target.has(dashToCamel(prop));
      },
      ownKeys(target) {
        return [...target.keys()];
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true };
      },
    });

    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on =
          force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  get className() {
    return [...this._classes].join(" ");
  }

  set className(value) {
    this._classes = new Set(
      String(value || "")
        .split(/\s+/)
        .filter(Boolean),
    );
    this.attributes.set("class", this.className);
  }

  get type() {
    return this.getAttribute("type") || "";
  }

  set type(value) {
    this.setAttribute("type", value);
  }

  get title() {
    return this.getAttribute("title") || "";
  }

  set title(value) {
    this.setAttribute("title", value);
  }

  get disabled() {
    return this.getAttribute("disabled") !== null;
  }

  set disabled(value) {
    if (value) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }

  get lang() {
    return this.getAttribute("lang") || "";
  }

  set lang(value) {
    this.setAttribute("lang", value);
  }

  get id() {
    return this.getAttribute("id") || "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const text = String(value);
    this.attributes.set(key, text);
    if (key === "class") {
      this._classes = new Set(text.split(/\s+/).filter(Boolean));
    } else if (key.startsWith("data-")) {
      this._dataset.set(dashToCamel(key.slice(5)), text);
    }
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  get textContent() {
    return this.childNodes
      .map((child) => (child.textContent !== undefined ? child.textContent : ""))
      .join("");
  }

  set textContent(value) {
    this._rawHtml = null;
    this.childNodes = [];
    if (value === "" || value === null || value === undefined) return;
    const node = new MiniText(value);
    node.parentNode = this;
    this.childNodes.push(node);
  }

  get innerHTML() {
    if (this._rawHtml !== null) return this._rawHtml;
    return this.childNodes
      .map((child) =>
        child.nodeType === 1
          ? `<${child.tagName.toLowerCase()}>${child.innerHTML}</${child.tagName.toLowerCase()}>`
          : child.textContent,
      )
      .join("");
  }

  set innerHTML(value) {
    const html = String(value ?? "");
    this._rawHtml = html;
    this.childNodes = [];
    if (!html.trim()) return;
    if (!this.ownerDocument) {
      const node = new MiniText(html, true);
      node.parentNode = this;
      this.childNodes.push(node);
      return;
    }
    // The browser parses the markup, so the stub does too: the panel hands
    // out elements it built from a template string.
    const parsed = parseHtml(html, this.ownerDocument);
    for (const child of [...parsed.childNodes]) {
      child.parentNode = null;
      this.appendChild(child);
    }
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1
      ? this.parentNode
      : null;
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    if (child.ownerDocument === undefined) child.ownerDocument = this.ownerDocument;
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") {
        const text = new MiniText(node);
        text.parentNode = this;
        this.childNodes.push(text);
        continue;
      }
      this.appendChild(node);
    }
  }

  insertBefore(child, before) {
    child.parentNode?.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index === -1) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((candidate) => candidate !== child);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    node.parentNode?.removeChild(node);
    parent.childNodes[index] = node;
    node.parentNode = parent;
    this.parentNode = null;
  }

  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    node.parentNode?.removeChild(node);
    parent.childNodes.splice(index + 1, 0, node);
    node.parentNode = parent;
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    let current = node.parentNode;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  matches(selector) {
    return matchesSelector(this, parseSelector(selector));
  }

  closest(selector) {
    const alternatives = parseSelector(selector);
    let node = this;
    while (node && node.nodeType === 1) {
      if (matchesSelector(node, alternatives)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const alternatives = parseSelector(selector);
    const found = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (matchesSelector(child, alternatives)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({
      listener,
      capture: Boolean(options?.capture),
      once: Boolean(options?.once),
      called: false,
    });
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    this.listeners.set(
      type,
      listeners.filter((entry) => entry.listener !== listener),
    );
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    const path = [];
    let node = this;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    if (this.ownerDocument) path.push(this.ownerDocument);

    for (let index = path.length - 1; index > 0; index -= 1) {
      if (event.propagationStopped) break;
      invokeListeners(path[index], event, true);
    }
    invokeListeners(this, event, true);
    invokeListeners(this, event, false);
    for (let index = 1; index < path.length; index += 1) {
      if (event.propagationStopped) break;
      invokeListeners(path[index], event, false);
    }
    return !event.defaultPrevented;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  scrollIntoView(options) {
    this.scrollIntoViewCalls.push(options || {});
  }

  setSelectionRange() {}
}

class MiniDocument {
  constructor() {
    this.nodeType = 9;
    this.listeners = new Map();
    this.activeElement = null;
    this.readyState = "complete";
    this.documentElement = new MiniElement("html", this);
    this.head = new MiniElement("head", this);
    this.body = new MiniElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag) {
    return new MiniElement(tag, this);
  }

  createTextNode(text) {
    return new MiniText(text);
  }

  createTreeWalker() {
    return { nextNode: () => null, currentNode: null };
  }

  execCommand() {
    return true;
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }

  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({
      listener,
      capture: Boolean(options?.capture),
      once: Boolean(options?.once),
      called: false,
    });
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    this.listeners.set(
      type,
      listeners.filter((entry) => entry.listener !== listener),
    );
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    invokeListeners(this, event, true);
    invokeListeners(this, event, false);
    return !event.defaultPrevented;
  }
}

/* ---------- the real markup ---------- */

function parseHtml(html, document) {
  const source = String(html).replace(/<!--[\s\S]*?-->/g, "");
  const pattern = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*)\s*(\/?)>/g;
  const root = document.createElement("div");
  const stack = [root];
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const text = source.slice(lastIndex, match.index);
    if (text.trim()) {
      const node = document.createTextNode(decodeEntities(text));
      node.parentNode = stack[stack.length - 1];
      stack[stack.length - 1].childNodes.push(node);
    }
    lastIndex = pattern.lastIndex;

    const tag = match[0];
    const rawAttrs = match[2] || "";
    const selfClosing = match[3];
    const name = match[1].toLowerCase();
    if (tag.startsWith("</")) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName === name.toUpperCase()) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const element = document.createElement(name);
    const attrPattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
    let attr;
    while ((attr = attrPattern.exec(rawAttrs || "")) !== null) {
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      element.setAttribute(attr[1], decodeEntities(value));
    }
    element.parentNode = stack[stack.length - 1];
    stack[stack.length - 1].childNodes.push(element);

    const isVoid = VOID_TAGS.has(name);
    if (!isVoid && !selfClosing) stack.push(element);
  }
  return root;
}

/* ---------- the panel harness ---------- */

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
 * The browser selection the panel observes.
 *
 * It keeps the range it was given, so a test can tell that the panel put the
 * selection back instead of leaving the user with nothing selected.
 */
function createSelection() {
  return {
    rangeCount: 0,
    isCollapsed: true,
    text: "",
    range: null,
    toString() {
      return this.text;
    },
    getRangeAt() {
      return this.range;
    },
    removeAllRanges() {
      this.rangeCount = 0;
      this.isCollapsed = true;
      this.text = "";
      this.range = null;
    },
    addRange(range) {
      this.rangeCount = 1;
      this.isCollapsed = false;
      this.range = range;
    },
  };
}

function createPanelHarness({
  sendMessageImpl,
  local = {},
  session = {},
  tabs = [],
  activeTab = "",
  language = "en",
  reducedMotion = false,
} = {}) {
  const document = new MiniDocument();
  const parsed = parseHtml(read("sidepanel.html"), document);
  const body = parsed.querySelector("body");
  for (const child of [...body.childNodes]) {
    document.body.appendChild(child);
  }
  const parsedHtml = parsed.querySelector("html");
  if (parsedHtml) {
    for (const [key, value] of parsedHtml.attributes) {
      document.documentElement.setAttribute(key, value);
    }
  }

  const selection = createSelection();
  const sentMessages = [];
  const timers = new Map();
  const intervals = [];
  let nextTimerId = 1;

  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session);
  if (language) localArea.values.ytd_options_language = language;

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
    setInterval: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval: () => {},
    requestAnimationFrame: (callback) => {
      if (typeof callback === "function") callback(0);
      return 0;
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    CSS: { escape: (value) => String(value) },
    navigator: { clipboard: { writeText: async () => {} } },
    window: {
      getSelection: () => selection,
      close() {},
      scrollY: 0,
      scrollX: 0,
      innerWidth: 360,
      addEventListener() {},
      // The panel asks the browser the same way the stylesheet does, so the
      // system setting reaches the behaviour and not only the looks.
      matchMedia: (query) => ({
        media: query,
        matches: reducedMotion && query.includes("prefers-reduced-motion"),
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      }),
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
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        query: async () => tabs,
        sendMessage: async (tabId, message) => {
          sentMessages.push(message);
          return { success: true };
        },
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
    selection,
    sentMessages,
    storage: { local: localArea, session: sessionArea },
    el: (id) => document.getElementById(id),
    all: (selector) => document.querySelectorAll(selector),
    fire: async (type, init = {}) => {
      const event = new MiniEvent(type, init);
      document.dispatchEvent(event);
      await new Promise((resolve) => setImmediate(resolve));
      return event;
    },
    dispatch: (element, type, init = {}) => {
      const event = new MiniEvent(type, init);
      element.dispatchEvent(event);
      return event;
    },
    flush: async () => {
      for (let round = 0; round < 4; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    /** Sets the browser text selection the panel will observe. */
    selectText(text, range) {
      selection.rangeCount = range ? 1 : 0;
      selection.isCollapsed = !range;
      selection.text = text;
      selection.range = range || null;
    },

    /** Runs the panel's playback tick, the one the timer would call. */
    fireInterval: async () => {
      for (const callback of intervals) {
        await callback();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/* ============================================================
   The panel under test
   ============================================================ */

const VIDEO_URL = "https://www.youtube.com/watch?v=videoA";

function transcriptPayload() {
  return {
    success: true,
    transcript: [
      { text: "First caption", start: 0, duration: 2, language: "en" },
      { text: "Second caption", start: 30, duration: 2, language: "en" },
    ],
    transcriptText: "First caption",
    transcriptTextTimestamped: "[0:00] First caption",
    language: "en",
  };
}

/**
 * Boots a panel with a transcript on screen.
 */
async function createLoadedHarness(options = {}) {
  const harness = createPanelHarness({
    ...options,
    sendMessageImpl: async (message) => {
      if (options.sendMessageImpl) {
        const custom = await options.sendMessageImpl(message);
        if (custom !== undefined) return custom;
      }
      if (message.action === "fetchTranscript") return transcriptPayload();
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { currentTime: 0 } };
      }
      if (message.action === "getNotes") {
        return {
          success: true,
          notes: [
            {
              id: "note-1",
              text: "A saved note",
              videoId: "videoA",
              videoTitle: "A video",
              timestamp: "1:05",
              timestampSeconds: 65,
              timestampedUrl: `${VIDEO_URL}&t=65s`,
            },
          ],
        };
      }
      if (message.action === "getVocabulary") {
        return {
          success: true,
          items: [
            {
              id: "word-1",
              term: "spaced repetition",
              translation: "间隔重复",
              status: "learning",
              videoId: "videoA",
              videoTitle: "A video",
              timestampSeconds: 30,
            },
          ],
        };
      }
      return { success: true };
    },
  });

  await harness.fire("DOMContentLoaded");
  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();
  return harness;
}

/**
 * A range over the first transcript row, the way the browser hands a
 * selection to the panel.
 */
function transcriptRange(harness, text) {
  const row = harness
    .el("transcriptList")
    .querySelector(".transcript-entry");
  const content = row.querySelector(".transcript-text");
  return {
    startContainer: content,
    endContainer: content,
    startOffset: 0,
    endOffset: text.length,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 100 }),
  };
}

/**
 * A short name for an element.
 *
 * A failed assertion prints the two values, and a whole page of elements
 * would bury the message. The name says the same thing in one word.
 */
function nameOf(element) {
  if (!element) return "none";
  return (
    element.getAttribute?.("id") ||
    element.getAttribute?.("class") ||
    element.tagName?.toLowerCase() ||
    "unknown"
  );
}

/* ============================================================
   A. The selection toolbar has to answer the keyboard too
   ============================================================ */

test("a keyboard selection opens the selection toolbar", async () => {
  const harness = await createLoadedHarness();
  harness.selectText("First caption", transcriptRange(harness, "First caption"));

  await harness.fire("keyup", { key: "ArrowDown", shiftKey: true });

  const toolbar = harness.el("explainTooltip");
  assert.ok(toolbar, "the toolbar exists");
  assert.equal(toolbar.style.display, "flex", "the toolbar is on the screen");
});

test("a keyboard selection puts the focus in the toolbar", async () => {
  const harness = await createLoadedHarness();
  harness.selectText("First caption", transcriptRange(harness, "First caption"));

  await harness.fire("keyup", { key: "ArrowDown", shiftKey: true });

  assert.equal(
    harness.document.activeElement?.getAttribute("class"),
    "explain-btn",
    "the first action has the focus",
  );
});

test("the arrow keys move between the toolbar's actions", async () => {
  const harness = await createLoadedHarness();
  harness.selectText("First caption", transcriptRange(harness, "First caption"));
  await harness.fire("keyup", { key: "ArrowDown", shiftKey: true });

  harness.dispatch(harness.document.activeElement, "keydown", {
    key: "ArrowRight",
  });
  assert.equal(
    harness.document.activeElement?.getAttribute("class"),
    "selection-note-btn",
    "the focus moves to the next action",
  );

  harness.dispatch(harness.document.activeElement, "keydown", { key: "End" });
  assert.equal(
    harness.document.activeElement?.getAttribute("class"),
    "selection-word-btn",
    "End reaches the last action",
  );
});

test("Escape closes the toolbar and gives the transcript the focus back", async () => {
  const harness = await createLoadedHarness();
  harness.selectText("First caption", transcriptRange(harness, "First caption"));
  await harness.fire("keyup", { key: "ArrowDown", shiftKey: true });

  harness.dispatch(harness.document.activeElement, "keydown", { key: "Escape" });

  assert.equal(
    harness.el("explainTooltip").style.display,
    "none",
    "the toolbar is gone",
  );
  assert.equal(
    harness.document.activeElement?.getAttribute("id"),
    "transcriptList",
    "the focus is back in the transcript",
  );
  assert.equal(
    harness.selection.text,
    "First caption",
    "the words are still selected",
  );
  assert.equal(harness.selection.rangeCount, 1, "the selection survived");
});

test("the transcript is a place the keyboard can land", async () => {
  const harness = await createLoadedHarness();

  assert.equal(
    harness.el("transcriptList").getAttribute("tabindex"),
    "0",
    "the transcript list is a stop the keyboard can reach",
  );
});

test("a mouse selection still opens the toolbar and leaves the focus alone", async () => {
  const harness = await createLoadedHarness();
  harness.selectText("First caption", transcriptRange(harness, "First caption"));

  await harness.fire("mouseup");

  assert.equal(
    harness.el("explainTooltip").style.display,
    "flex",
    "the toolbar is on the screen",
  );
  assert.notEqual(
    harness.document.activeElement?.getAttribute("class"),
    "explain-btn",
    "a mouse user is already pointing at the text",
  );
});

test("a selection outside the transcript opens no toolbar", async () => {
  const harness = await createLoadedHarness();
  const outside = harness.el("notesIntro");
  harness.selectText("Some note", {
    startContainer: outside,
    endContainer: outside,
    startOffset: 0,
    endOffset: 8,
    getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 100 }),
  });

  await harness.fire("keyup", { key: "ArrowDown", shiftKey: true });

  assert.equal(
    harness.el("explainTooltip").style.display,
    "none",
    "the toolbar stays away from text that is not the transcript",
  );
});

/* ============================================================
   B. The word confirmation dialog has to hold the focus
   ============================================================ */

function openWordDialog(harness, trigger) {
  harness.helpers.showWordConfirmation(
    [{ term: "spaced repetition", translation: "间隔重复" }],
    "A sentence worth keeping.",
    30,
    trigger,
  );
  return harness.document.querySelector("#wordModal .explain-modal");
}

test("the word dialog is a dialog a screen reader can name", async () => {
  const harness = await createLoadedHarness();
  const dialog = openWordDialog(harness, null);

  assert.ok(dialog, "the dialog is on the page");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const labelId = dialog.getAttribute("aria-labelledby");
  assert.ok(labelId, "the dialog names itself");
  assert.ok(harness.el(labelId), "the title element exists");
});

test("the word dialog takes the focus when it opens", async () => {
  const harness = await createLoadedHarness();
  const dialog = openWordDialog(harness, null);

  assert.ok(
    dialog.contains(harness.document.activeElement),
    "the focus is inside the dialog",
  );
});

test("Tab stays inside the word dialog", async () => {
  const harness = await createLoadedHarness();
  const dialog = openWordDialog(harness, null);

  const items = dialog.querySelectorAll("button");
  assert.ok(items.length > 1, "the dialog has more than one control");
  const first = items[0];
  const last = items[items.length - 1];

  last.focus();
  const forward = await harness.fire("keydown", { key: "Tab" });
  assert.equal(forward.defaultPrevented, true, "Tab is trapped in the dialog");
  assert.equal(
    nameOf(harness.document.activeElement),
    nameOf(first),
    "the focus cycles back to the first control",
  );

  first.focus();
  const backward = await harness.fire("keydown", { key: "Tab", shiftKey: true });
  assert.equal(backward.defaultPrevented, true, "Shift+Tab is trapped too");
  assert.equal(
    nameOf(harness.document.activeElement),
    nameOf(last),
    "the focus walks back to the last control",
  );
});

test("Escape closes the word dialog and gives the focus back", async () => {
  const harness = await createLoadedHarness();
  const trigger = harness.document.createElement("button");
  trigger.id = "word-trigger";
  trigger.textContent = "Word";
  harness.document.body.appendChild(trigger);
  trigger.focus();

  openWordDialog(harness, trigger);
  assert.notEqual(
    nameOf(harness.document.activeElement),
    "word-trigger",
    "the focus left the button for the dialog",
  );

  await harness.fire("keydown", { key: "Escape" });

  assert.equal(
    harness.document.querySelector("#wordModal"),
    null,
    "the dialog is gone",
  );
  assert.equal(
    nameOf(harness.document.activeElement),
    "word-trigger",
    "the focus goes back to the control that opened the dialog",
  );
});

test("the panel behind the word dialog is inert", async () => {
  const harness = await createLoadedHarness();
  openWordDialog(harness, null);

  assert.equal(harness.el("contentArea").inert, true, "the panel is out of reach");
  assert.equal(harness.el("panelStatus").inert, false, "announcers stay live");

  await harness.fire("keydown", { key: "Escape" });
  assert.equal(harness.el("contentArea").inert, false, "the panel comes back");
});

test("the Word action leaves the toolbar on screen so the focus can come back", async () => {
  const harness = await createLoadedHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "extractVocabulary") {
        return {
          success: true,
          words: [{ term: "spaced repetition", translation: "间隔重复" }],
        };
      }
      return undefined;
    },
  });
  harness.selectText("First caption", transcriptRange(harness, "First caption"));
  await harness.fire("keyup", { key: "ArrowDown", shiftKey: true });

  const wordButton = harness
    .el("explainTooltip")
    .querySelector(".selection-word-btn");
  harness.dispatch(wordButton, "click");
  await harness.flush();

  assert.ok(harness.el("wordModal"), "the dialog is open");
  assert.equal(
    harness.el("explainTooltip").style.display,
    "flex",
    "the toolbar stays behind the dialog",
  );

  await harness.fire("keydown", { key: "Escape" });
  assert.equal(
    nameOf(harness.document.activeElement),
    "selection-word-btn",
    "the focus goes back to the Word button",
  );
});

/* ============================================================
   C. A user who asked for less movement gets less movement
   ============================================================ */

/**
 * The rules a stylesheet keeps behind a media query.
 */
function mediaBlock(css, query) {
  const start = css.indexOf(query);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  return "";
}

test("the panel turns its movement off for a user who asked for less of it", () => {
  for (const file of ["sidepanel.css", "options.css"]) {
    const block = mediaBlock(read(file), "@media (prefers-reduced-motion: reduce)");
    assert.ok(block, `${file} has a rule for less movement`);
    assert.match(
      block,
      /animation-duration:\s*0\.01ms\s*!important/,
      `${file} stops the animations`,
    );
    assert.match(
      block,
      /transition-duration:\s*0\.01ms\s*!important/,
      `${file} stops the transitions`,
    );
    assert.match(
      block,
      /animation-iteration-count:\s*1\s*!important/,
      `${file} stops the endless animations`,
    );
  }
});

test("a shortened animation still ends on a visible state", () => {
  const css = read("sidepanel.css");

  // The panel fades its panels in. If the animation were simply removed,
  // the element would keep the opacity the keyframe started with.
  const fadeIn = css.match(/@keyframes\s+fadeIn\s*\{([\s\S]*?)\n\}/);
  assert.ok(fadeIn, "the panel has a fade-in");
  const from = fadeIn[1].match(/from\s*\{([^}]*)\}/);
  const to = fadeIn[1].match(/to\s*\{([^}]*)\}/);
  assert.match(from[1], /opacity:\s*0/, "the fade starts invisible");
  assert.match(to[1], /opacity:\s*1/, "the fade ends visible");

  const toolbar = css.match(/@keyframes\s+selectionToolbarIn\s*\{([\s\S]*?)\n\}/);
  assert.ok(toolbar, "the toolbar has an entrance");
  const toolbarTo = toolbar[1].match(/to\s*\{([^}]*)\}/);
  assert.match(toolbarTo[1], /opacity:\s*1/, "the toolbar ends visible");
});

test("the loading bar keeps its light on when it stops moving", () => {
  const css = read("sidepanel.css");
  const block = mediaBlock(css, "@media (prefers-reduced-motion: reduce)");

  // The bar sweeps a highlight across an empty track, so the highlight has
  // to move inside the bar when the sweep stops.
  assert.match(
    block,
    /\.loading-bar::after\s*\{[^}]*animation:\s*none/,
    "the highlight stops sweeping",
  );
  assert.match(
    block,
    /\.loading-bar::after\s*\{[^}]*left:\s*0/,
    "the highlight stays inside the bar",
  );
});

test("the panel does not scroll smoothly for a user who asked for less movement", async () => {
  const harness = await createLoadedHarness({ reducedMotion: true });

  await harness.fireInterval();

  const row = harness
    .el("transcriptList")
    .querySelector(".transcript-entry");
  assert.ok(row.scrollIntoViewCalls.length > 0, "the panel scrolled to the line");
  assert.equal(
    row.scrollIntoViewCalls[0].behavior,
    "auto",
    "the scroll does not move",
  );
});

test("the panel scrolls smoothly when the user has not asked for less movement", async () => {
  const harness = await createLoadedHarness();

  await harness.fireInterval();

  const row = harness
    .el("transcriptList")
    .querySelector(".transcript-entry");
  assert.ok(row.scrollIntoViewCalls.length > 0, "the panel scrolled to the line");
  assert.equal(
    row.scrollIntoViewCalls[0].behavior,
    "smooth",
    "the scroll moves",
  );
});

/* ============================================================
   D. The tab order and the focus ring
   ============================================================ */

/**
 * How an element is displayed.
 *
 * The panel writes the inline style it wants at runtime, so the live value
 * wins over the one the markup came with.
 */
function displayOf(node) {
  const live = node.style?.display;
  if (live) return live;
  const attribute = node.getAttribute?.("style") || "";
  const match = attribute.match(/display\s*:\s*([^;]+)/);
  return match ? match[1].trim() : "";
}

/**
 * Tells whether the user can see the element at all.
 *
 * The browser only puts what it can show in the tab order, so the test has
 * to know the same things the stylesheet knows.
 */
function isHidden(element) {
  let node = element;
  while (node && node.nodeType === 1) {
    if (node.hidden === true) return true;
    if (node.getAttribute("hidden") !== null) return true;
    if (displayOf(node) === "none") return true;
    // Only the tab the user is on is on the screen.
    if (
      node.classList?.contains("tab-panel") &&
      !node.classList.contains("active")
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * The controls a keyboard can reach, in the order it reaches them.
 */
function tabOrder(root) {
  const items = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      if (isReachable(child)) items.push(child);
      visit(child);
    }
  };
  visit(root);
  return items;
}

function isReachable(element) {
  if (element.getAttribute("disabled") !== null) return false;
  const tabindex = element.getAttribute("tabindex");
  if (tabindex === "-1") return false;
  const tag = element.tagName.toLowerCase();
  const focusable =
    ["a", "button", "input", "select", "textarea"].includes(tag) ||
    tabindex !== null;
  if (!focusable) return false;
  return !isHidden(element);
}

/**
 * Asserts that the named controls are met in the given order.
 */
function assertOrder(order, names, message) {
  let previous = -1;
  for (const name of names) {
    const index = order.indexOf(name);
    assert.notEqual(index, -1, `${message}: ${name} must be reachable`);
    assert.ok(index > previous, `${message}: ${name} comes after the one before`);
    previous = index;
  }
}

function tabOrderNames(root) {
  return tabOrder(root).map(
    (element) =>
      element.getAttribute("id") ||
      element.getAttribute("class") ||
      element.tagName.toLowerCase(),
  );
}

test("the transcript is met in the order it is shown", async () => {
  const harness = await createLoadedHarness();

  const order = tabOrderNames(harness.el("panel-transcript"));

  assertOrder(
    order,
    [
      "copyTranscriptBtn",
      "exportTranscriptBtn",
      "transcriptSearchInput",
      "transcriptList",
      "transcript-time",
    ],
    "the transcript controls",
  );
});

test("the notes are met in the order they are shown", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.switchTab("notes");

  const order = tabOrderNames(harness.el("panel-notes"));

  assertOrder(
    order,
    [
      "notesFilterThis",
      "notesFilterAll",
      "quickNoteInput",
      "quickNoteSaveBtn",
      "exportNotesBtn",
      "note-timestamp",
    ],
    "the note controls",
  );
});

test("the vocabulary is met in the order it is shown", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.switchTab("words");
  await harness.flush();

  const order = tabOrderNames(harness.el("panel-words"));

  assertOrder(
    order,
    ["wordsRefreshBtn", "word-delete", "word-source"],
    "the vocabulary controls",
  );
});

test("the selection toolbar is met in the order it is shown", async () => {
  const harness = await createLoadedHarness();
  harness.selectText("First caption", transcriptRange(harness, "First caption"));
  await harness.fire("mouseup");

  const order = tabOrderNames(harness.el("explainTooltip"));

  assertOrder(
    order,
    ["explain-btn", "selection-note-btn", "selection-word-btn"],
    "the toolbar actions",
  );
});

test("every control in the panel has a visible focus ring", () => {
  for (const file of ["sidepanel.css", "options.css"]) {
    const css = read(file);
    assert.match(
      css,
      /:where\(a, button, input, textarea, select, \[tabindex\]\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/,
      `${file} gives every control a ring`,
    );
  }

  // The search field is the one control that turns the ring off, because
  // its container draws the ring instead.
  const panelCss = read("sidepanel.css");
  const withoutRing = panelCss.match(/[.#][\w-]+\s*\{[^}]*outline:\s*0;/g) || [];
  assert.equal(
    withoutRing.length,
    1,
    "only the search field turns the ring off",
  );
  assert.match(withoutRing[0], /transcript-search-input/);
  assert.match(
    panelCss,
    /\.transcript-search:focus-within\s*\{[^}]*border-color:\s*var\(--focus-ring\)/,
    "the search container draws the ring",
  );
});

/* ============================================================
   C. A note that did not save says why
   ============================================================ */

test("a note from the selection toolbar that did not save says why", async () => {
  const harness = await createLoadedHarness({
    sendMessageImpl: async (message) => {
      if (message.action === "saveNote") {
        return {
          success: false,
          error: "The device storage is full: the note could not be saved.",
          code: "STORAGE_QUOTA_EXCEEDED",
        };
      }
      return undefined;
    },
  });

  harness.selectText("First caption", transcriptRange(harness, "First caption"));
  await harness.fire("mouseup");

  const noteButton = harness.document.querySelector(".selection-note-btn");
  assert.ok(noteButton, "the selection toolbar has no note button");
  harness.dispatch(noteButton, "click");
  await harness.flush();

  const toast = harness.el("panelToastText");
  assert.match(
    toast.textContent,
    /storage is full/i,
    "the reason the note was lost is not on screen",
  );
  assert.doesNotMatch(
    toast.textContent,
    /STORAGE_QUOTA_EXCEEDED/,
    "the code reached the user",
  );
});
