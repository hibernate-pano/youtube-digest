const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* ============================================================
   A DOM small enough to read and real enough to test the panel.

   The panel is the product's main surface, so these tests drive the real
   sidepanel.js inside a sandbox instead of a copy of its logic. The stub
   understands the parts of the browser the panel relies on: selectors,
   attributes, the event path, focus, and the real markup of sidepanel.html.
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

  scrollIntoView() {}

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

function createSelection() {
  return {
    rangeCount: 0,
    isCollapsed: true,
    toString: () => "",
    getRangeAt: () => null,
    removeAllRanges() {
      this.rangeCount = 0;
      this.isCollapsed = true;
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
    setInterval: () => 0,
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
  };
}

const VIDEO_URL = "https://www.youtube.com/watch?v=videoA";

function transcriptPayload(label = "A") {
  return {
    success: true,
    transcript: [{ text: `${label} caption`, start: 0, duration: 2, language: "en" }],
    transcriptText: `${label} caption`,
    transcriptTextTimestamped: `[0:00] ${label} caption`,
    language: "en",
  };
}

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

function notePayload() {
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

/**
 * Boots a panel with a transcript, an analysis and a note on screen.
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
      if (message.action === "analyzeTranscript") return analysisPayload();
      if (message.action === "getNotes") return notePayload();
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true };
      }
      return { success: true };
    },
  });

  // The panel wires its controls when the document is ready.
  await harness.fire("DOMContentLoaded");
  await harness.helpers.startDigest("videoA", VIDEO_URL);
  await harness.flush();
  return harness;
}

// ============================================================
// P0-1: the explanation dialog
// ============================================================

test("the explanation modal is a dialog a screen reader can name", async () => {
  const harness = await createLoadedHarness();
  await harness.helpers.showExplanation("some selected words");

  const modal = harness.el("explainModal");
  assert.ok(modal, "the modal is on the page");

  const dialog = harness.document.querySelector(".explain-modal");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");

  const labelId = dialog.getAttribute("aria-labelledby");
  assert.ok(labelId, "the dialog names itself");
  const title = harness.el(labelId);
  assert.ok(title, "the title element exists");
  assert.equal(title.textContent.trim().length > 0, true);
});

test("the explanation modal takes the focus when it opens", async () => {
  const harness = await createLoadedHarness();
  await harness.helpers.showExplanation("some selected words");

  const dialog = harness.document.querySelector(".explain-modal");
  assert.ok(
    dialog.contains(harness.document.activeElement),
    "the focus is inside the dialog",
  );
  assert.ok(harness.document.activeElement);
});

test("Tab stays inside the explanation modal", async () => {
  const harness = await createLoadedHarness();
  await harness.helpers.showExplanation("some selected words");

  const dialog = harness.document.querySelector(".explain-modal");
  const closeButton = harness.el("closeExplain");
  closeButton.focus();

  const forward = await harness.fire("keydown", { key: "Tab" });
  assert.equal(forward.defaultPrevented, true, "Tab is trapped in the dialog");
  assert.equal(
    harness.document.activeElement?.getAttribute("id"),
    "closeExplain",
    "the focus cycles inside the dialog",
  );

  closeButton.focus();
  const backward = await harness.fire("keydown", { key: "Tab", shiftKey: true });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(harness.document.activeElement, closeButton);
  assert.ok(dialog.contains(harness.document.activeElement));
});

test("Escape closes the explanation modal", async () => {
  const harness = await createLoadedHarness();
  await harness.helpers.showExplanation("some selected words");
  assert.ok(harness.el("explainModal"));

  harness.fire("keydown", { key: "Escape" });
  assert.equal(
    harness.document.querySelector("#explainModal"),
    null,
    "the modal is gone",
  );
});

test("the explanation modal puts the focus back where it came from", async () => {
  const harness = await createLoadedHarness();

  const trigger = harness.document.createElement("button");
  trigger.textContent = "Explain";
  harness.document.body.appendChild(trigger);
  trigger.focus();

  await harness.helpers.showExplanation("some selected words", trigger);
  assert.notEqual(harness.document.activeElement, trigger);

  harness.fire("keydown", { key: "Escape" });
  assert.equal(
    harness.document.activeElement?.textContent,
    "Explain",
    "the focus returns to the control that opened the dialog",
  );
});

test("the panel behind the explanation modal is inert", async () => {
  const harness = await createLoadedHarness();
  await harness.helpers.showExplanation("some selected words");

  const content = harness.el("contentArea");
  assert.equal(content.inert, true, "the panel cannot be reached");
  assert.equal(harness.el("panelStatus").inert, false, "announcers stay live");

  harness.fire("keydown", { key: "Escape" });
  assert.equal(content.inert, false, "the panel comes back");
});

// ============================================================
// P0-2: the rows that looked like buttons
// ============================================================

test("the chapter timestamp is a real button inside a real list item", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.renderAnalysisResults(analysisPayload().analysis);

  const item = harness.document.querySelector("#chapterList .chapter-item");
  assert.ok(item, "the chapter is rendered");
  assert.equal(
    item.getAttribute("role"),
    null,
    "the list item keeps its list semantics",
  );

  const button = harness.document.querySelector("#chapterList .chapter-timestamp");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("type"), "button");
  assert.ok(
    button.getAttribute("aria-label"),
    "the button says what it does",
  );
  assert.match(button.getAttribute("aria-label"), /0:00/);
});

test("the quote timestamp is a real button", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.renderAnalysisResults(analysisPayload().analysis);

  const button = harness.document.querySelector("#quotesList .quote-timestamp");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("type"), "button");
  assert.ok(button.getAttribute("aria-label"));
});

test("the transcript timestamp is a real button", async () => {
  const harness = await createLoadedHarness();

  const button = harness.document.querySelector("#transcriptList .transcript-time");
  assert.ok(button, "the transcript row has a timestamp control");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("type"), "button");
  assert.ok(button.getAttribute("aria-label"));
});

test("the note timestamp is a real button", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.renderNotes(notePayload().notes, "videoA");

  const button = harness.document.querySelector("#notesList .note-timestamp");
  assert.ok(button, "the note has a timestamp control");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("type"), "button");
  assert.match(button.getAttribute("aria-label"), /1:05/);
});

test("the note text is operable with the keyboard", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.renderNotes(notePayload().notes, "videoA");

  const text = harness.document.querySelector("#notesList .note-text");
  assert.equal(text.getAttribute("role"), "button");
  assert.equal(text.getAttribute("tabindex"), "0");

  text.focus();
  harness.dispatch(text, "keydown", { key: "Enter" });
  await harness.flush();

  assert.equal(
    harness.document.querySelectorAll("#notesList .note-edit-input").length,
    1,
    "Enter opens the editor",
  );
});

test("Space opens the note editor and does not scroll the panel", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.renderNotes(notePayload().notes, "videoA");

  const text = harness.document.querySelector("#notesList .note-text");
  text.focus();
  const event = harness.dispatch(text, "keydown", { key: " " });
  await harness.flush();

  assert.equal(event.defaultPrevented, true, "Space does not scroll");
  assert.equal(
    harness.document.querySelectorAll("#notesList .note-edit-input").length,
    1,
  );
});

test("a control inside a row does not fire the row action twice", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.renderAnalysisResults(analysisPayload().analysis);

  const before = harness.sentMessages.length;
  const copyButton = harness.document.querySelector("#quotesList .quote-copy-btn");
  harness.dispatch(copyButton, "click");

  const seeks = harness.sentMessages
    .slice(before)
    .filter((message) => message?.action === "relayToContent");
  assert.equal(seeks.length, 0, "the quote did not seek");
});

test("the Note button on a key quote hands the quote over", async () => {
  const harness = await createLoadedHarness();
  harness.helpers.renderAnalysisResults(analysisPayload().analysis);

  const before = harness.sentMessages.length;
  const noteButton = harness.document.querySelector(
    "#quotesList .quote-save-note-btn",
  );
  assert.ok(noteButton, "the quote card offers a Note action");
  harness.dispatch(noteButton, "click");
  await harness.flush();

  const saves = harness.sentMessages
    .slice(before)
    .filter((message) => message?.action === "saveNote");
  assert.equal(saves.length, 1, "the Note action must save exactly one note");
  assert.equal(
    saves[0].quote,
    "A quote worth keeping",
    "the quote itself must travel with the request",
  );
  assert.equal(saves[0].timestamp, 30, "the note must point at the quote");
  assert.equal(saves[0].videoId, "videoA", "the note must belong to the video");
});

test("the transcript timestamp seeks even while text is selected", async () => {
  const harness = await createLoadedHarness();

  harness.selection.rangeCount = 1;
  harness.selection.isCollapsed = false;

  const before = harness.sentMessages.length;
  const button = harness.document.querySelector("#transcriptList .transcript-time");
  harness.dispatch(button, "click");

  const seeks = harness.sentMessages
    .slice(before)
    .filter((message) => message?.action === "relayToContent");
  assert.equal(seeks.length, 1, "the timestamp seeks the video");
});

// ============================================================
// P0-3: the panel talks to screen readers
// ============================================================

test("the panel keeps a live region that is always on the page", () => {
  const harness = createPanelHarness();

  const status = harness.el("panelStatus");
  assert.ok(status, "the status announcer exists");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.doesNotMatch(
    status.getAttribute("style") || "",
    /display:\s*none/,
    "a hidden live region is never announced",
  );

  const alert = harness.el("panelAlert");
  assert.ok(alert, "the alert announcer exists");
  assert.equal(alert.getAttribute("role"), "alert");
  assert.doesNotMatch(alert.getAttribute("style") || "", /display:\s*none/);
});

test("the panel announces that the digest is ready", async () => {
  const harness = await createLoadedHarness();
  assert.match(harness.el("panelStatus").textContent, /Digest ready/);
});

test("the panel announces a failure", async () => {
  const harness = createPanelHarness();
  harness.helpers.showError("Broken", "Something went wrong.");

  assert.match(harness.el("panelAlert").textContent, /Broken/);
  assert.match(harness.el("panelAlert").textContent, /Something went wrong/);
});

test("the panel announces the loading state", async () => {
  const harness = createPanelHarness();
  harness.helpers.updateLoading("Fetching transcript", "Reading captions");

  assert.equal(harness.el("loadingText").textContent, "Fetching transcript");
  assert.match(
    harness.el("panelStatus").textContent,
    /Fetching transcript/,
    "the loading state reaches the screen reader",
  );
});

// ============================================================
// P1-1: the tab bar
// ============================================================

test("the tab bar uses the tabs pattern", () => {
  const harness = createPanelHarness();

  const tablist = harness.el("tabsNav");
  assert.equal(tablist.getAttribute("role"), "tablist");

  const tabs = harness.all(".tab");
  assert.equal(tabs.length, 3);
  for (const tab of tabs) {
    assert.equal(tab.getAttribute("role"), "tab");
    assert.ok(tab.getAttribute("aria-selected"));
  }

  const panels = harness.all(".tab-panel");
  assert.equal(panels.length, 3);
  for (const panel of panels) {
    assert.equal(panel.getAttribute("role"), "tabpanel");
    const labelledBy = panel.getAttribute("aria-labelledby");
    assert.ok(labelledBy, "the panel names its tab");
    assert.ok(harness.el(labelledBy), "the tab it names exists");
  }
});

test("switching tabs updates aria-selected", async () => {
  const harness = await createLoadedHarness();

  harness.helpers.switchTab("overview");

  const overview = harness.document.querySelector('.tab[data-tab="overview"]');
  const transcript = harness.document.querySelector('.tab[data-tab="transcript"]');
  assert.equal(overview.getAttribute("aria-selected"), "true");
  assert.equal(transcript.getAttribute("aria-selected"), "false");
  assert.equal(overview.getAttribute("tabindex"), "0");
  assert.equal(transcript.getAttribute("tabindex"), "-1");
});

test("the arrow keys move between the tabs", async () => {
  const harness = await createLoadedHarness();

  const transcriptTab = harness.document.querySelector('.tab[data-tab="transcript"]');
  transcriptTab.focus();
  harness.dispatch(transcriptTab, "keydown", { key: "ArrowRight" });

  const overview = harness.document.querySelector('.tab[data-tab="overview"]');
  assert.equal(
    harness.document.activeElement?.getAttribute("data-tab"),
    "overview",
    "the focus moved to the next tab",
  );
  assert.equal(overview.getAttribute("tabindex"), "0");
});

// ============================================================
// P1-2: the panel speaks the interface language
// ============================================================

test("the panel copy follows the interface language", async () => {
  const harness = createPanelHarness({ language: "zh-CN" });
  await harness.helpers.loadPanelLanguage();

  const transcriptTab = harness.document.querySelector('.tab[data-tab="transcript"]');
  assert.equal(transcriptTab.textContent.trim(), "字幕");
  assert.equal(
    harness.document.documentElement.getAttribute("lang"),
    "zh-CN",
    "the document language follows the interface language",
  );
  assert.equal(
    harness.el("copyTranscriptBtn").textContent.trim(),
    "复制",
  );
  assert.equal(harness.el("tabsNav").getAttribute("aria-label"), "面板分区");
});

test("the static panel copy is all translated", () => {
  const harness = createPanelHarness();
  const document = harness.document;

  // Every piece of English text in the markup must sit in an element that
  // carries a data-i18n attribute, or the panel would show half English and
  // half Chinese.
  const offenders = [];
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.trim();
        if (!text || !/[A-Za-z]{2,}/.test(text)) continue;
        const owner = node.getAttribute?.("data-i18n") ? node : null;
        if (!owner) offenders.push(`${node.tagName}: ${text}`);
        continue;
      }
      visit(child);
    }
  };
  visit(document.body);

  assert.deepEqual(
    offenders,
    [],
    `these words never follow the interface language: ${offenders.join(", ")}`,
  );
});

// ============================================================
// P1-3: the selection toolbar
// ============================================================

test("the selection toolbar is clamped inside the panel", () => {
  const harness = createPanelHarness();

  assert.equal(
    harness.helpers.clampToolbarCenter(60, 146, 360),
    73,
    "a toolbar at the left edge moves in",
  );
  assert.equal(
    harness.helpers.clampToolbarCenter(20, 146, 360),
    73,
    "the Explain button is never cut off",
  );
  assert.equal(
    harness.helpers.clampToolbarCenter(180, 146, 360),
    180,
    "a toolbar in the middle stays where it is",
  );
  assert.equal(
    harness.helpers.clampToolbarCenter(340, 146, 360),
    287,
    "a toolbar at the right edge moves in",
  );
});

test("selecting text near the left edge keeps the toolbar on the panel", async () => {
  const harness = await createLoadedHarness();

  const row = harness.document.querySelector("#transcriptList .transcript-entry");
  const textNode = row.querySelector(".transcript-text").firstChild;
  harness.selection.rangeCount = 1;
  harness.selection.isCollapsed = false;
  harness.selection.toString = () => "A caption";
  harness.selection.getRangeAt = () => ({
    startContainer: textNode,
    endContainer: textNode,
    getBoundingClientRect: () => ({
      left: 20,
      right: 100,
      top: 100,
      bottom: 120,
      width: 80,
      height: 20,
    }),
  });

  harness.fire("mouseup");

  const tooltip = harness.el("explainTooltip");
  assert.ok(tooltip, "the toolbar is on the page");
  const left = Number.parseFloat(tooltip.style.left);
  assert.ok(
    left >= 73,
    `the toolbar starts inside the panel, got ${left}`,
  );
  assert.ok(left <= 360 - 73, "the toolbar ends inside the panel");
});

// The harness is exported so other test files can drive the panel the same
// way. The extension never reads this module.
module.exports = {
  createPanelHarness,
  createLoadedHarness,
  MiniElement,
  MiniDocument,
  MiniEvent,
  parseHtml,
};
