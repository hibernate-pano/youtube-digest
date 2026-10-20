/**
 * A fake YouTube page for the content script.
 *
 * The content script runs in the page, so it can only be tested against a
 * page that behaves like one: elements that hold styles, attributes and
 * listeners, a document that adopts stylesheets, and a window with a
 * location. This harness provides that, and runs the real content.js
 * inside a VM context so the tests exercise the shipped script.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const contentScript = fs.readFileSync(path.join(root, "content.js"), "utf8");
const tokensScript = fs.readFileSync(path.join(root, "tokens.js"), "utf8");

class FakeElement {
  constructor({
    id = "",
    width = 100,
    height = 36,
    inMetadata = false,
    inPrimary = false,
  } = {}) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.inMetadata = inMetadata;
    this.inPrimary = inPrimary;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.attributes = {};
    this.disabled = false;
    this.className = "";
    this._text = "";
    this._html = null;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this._html = null;
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children.map((child) => child.textContent || "").join("");
  }

  set innerHTML(value) {
    this._html = String(value ?? "");
    this._text = "";
    this.children = [];
  }

  get innerHTML() {
    if (this._html !== null) return this._html;
    return this._text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }

  closest(selector) {
    if (selector === "ytd-watch-metadata" && this.inMetadata) return this;
    if (selector === "#primary" && this.inPrimary) return this;
    return null;
  }

  querySelector(selector) {
    // The harness does not parse markup, so every query returns a stub that
    // accepts the calls the content script makes on it.
    return new FakeElement();
  }

  querySelectorAll(selector) {
    const matches = [];

    for (const child of this.children) {
      if (
        selector === "#top-level-buttons-computed" &&
        child.id === selector.slice(1)
      ) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }

    return matches;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    this[name] = value;
  }

  getAttribute(name) {
    if (Object.hasOwn(this.attributes, name)) return this.attributes[name];
    return null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    delete this[name];
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
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
}

/**
 * A stylesheet that only remembers its text, which is all the content
 * script needs from one.
 */
class FakeStyleSheet {
  constructor() {
    this.cssText = "";
  }

  replaceSync(text) {
    this.cssText = String(text ?? "");
  }
}

const DEFAULT_LOCATION = {
  href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  search: "?v=dQw4w9WgXcQ",
  pathname: "/watch",
  hostname: "www.youtube.com",
};

/**
 * Builds a page, runs the real content script in it and hands back the
 * pieces a test needs to look at.
 */
function createHarness({
  sendMessage,
  location,
  withPlayer = false,
  pageBackground = "rgb(255, 255, 255)",
  appBackground = "rgba(0, 0, 0, 0)",
  language = "en",
} = {}) {
  const actionRows = [];
  const fallbackRows = [];
  const elements = [];
  const documentListeners = {};
  const windowListeners = {};
  const observers = [];
  const timers = new Map();
  const runtimeListeners = [];
  let nextTimerId = 1;
  let currentPageBackground = pageBackground;
  let currentAppBackground = appBackground;
  let storedLanguage = language;

  /* The YouTube app, which is what paints the page the controls sit on. */
  const app = new FakeElement({ id: "ytd-app" });

  // The player and the video in it, for the tests that exercise the note
  // button. The content script looks them up by selector.
  const player = createPlayerContainer();
  const video = new FakeElement({ id: "html5-main-video" });
  video.currentTime = 42;
  video.duration = 212;
  video.paused = false;

  const body = new FakeElement();
  const documentElement = new FakeElement();

  const document = {
    readyState: "loading",
    body,
    head: new FakeElement(),
    documentElement,
    adoptedStyleSheets: [],
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-watch-metadata #actions-inner") return actionRows;
      if (selector === "#ytd-digest-button") {
        return elements.filter(
          (element) => element.id === "ytd-digest-button" && element.isConnected,
        );
      }
      if (selector.includes("top-level-buttons-computed")) return fallbackRows;
      if (selector === ".ytd-ui") {
        return elements.filter(
          (element) =>
            element.className &&
            element.className.split(/\s+/).includes("ytd-ui") &&
            element.isConnected,
        );
      }
      return [];
    },
    querySelector(selector) {
      if (selector === "ytd-app") return app;
      if (!withPlayer) return null;
      if (selector.includes("movie_player")) return player;
      if (selector.includes("html5-main-video")) return video;
      return null;
    },
    getElementById(id) {
      return elements.find((element) => element.id === id && element.isConnected);
    },
    createElement() {
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
  };

  const context = vm.createContext({
    console,
    document,
    CSSStyleSheet: FakeStyleSheet,
    URL,
    window: {
      location: { ...DEFAULT_LOCATION, ...(location || {}) },
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      },
      getComputedStyle(element) {
        const isPage = element === documentElement || element === body;
        return {
          display: element.display || "flex",
          visibility: element.visibility || "visible",
          position: element.style?.position || "relative",
          backgroundColor: isPage
            ? currentPageBackground
            : element === app
              ? currentAppBackground
              : "rgba(0, 0, 0, 0)",
        };
      },
      matchMedia(query) {
        return {
          media: query,
          matches: false,
          addEventListener() {},
          removeEventListener() {},
        };
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          },
        },
        async sendMessage(message) {
          if (sendMessage) return sendMessage(message);
          if (message.action === "getUiLanguage") {
            return { success: true, language: storedLanguage };
          }
          return { success: true };
        },
      },
    },
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
      }
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
    clearInterval() {},
  });

  // tokens.js first, exactly as the manifest loads them: the content
  // script reads the token table from the global it leaves behind.
  vm.runInContext(tokensScript, context);
  vm.runInContext(contentScript, context);

  return {
    context,
    actionRows,
    fallbackRows,
    elements,
    documentListeners,
    windowListeners,
    observers,
    player,
    video,
    /** Repaints the page, the way YouTube does when its appearance changes. */
    setPageBackground(color) {
      currentPageBackground = color;
    },
    /** Repaints the YouTube app, which is what the page is made of. */
    setAppBackground(color) {
      currentAppBackground = color;
    },
    /** Changes the interface language the way the settings page does. */
    setLanguage(value) {
      storedLanguage = value;
      // The background tells the content script about the change.
      runtimeListeners.forEach((listener) =>
        listener({ action: "uiLanguageChanged", language: value }, {}, () => {}),
      );
    },
    /** The CSS the content script handed to the document. */
    stylesheet() {
      const sheet = document.adoptedStyleSheets[0];
      return sheet ? sheet.cssText : "";
    },
    flushTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

/**
 * A visible YouTube action row with the native button group inside it.
 */
function createActionRow({ width, height }) {
  const row = new FakeElement({
    id: "actions-inner",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  const buttonGroup = new FakeElement({
    id: "top-level-buttons-computed",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  row.appendChild(buttonGroup);
  return { row, buttonGroup };
}

/**
 * A player container with a video in it, which is what the note button
 * needs before it can be injected.
 */
function createPlayerContainer() {
  const container = new FakeElement({ id: "movie_player", width: 640, height: 360 });
  container.style.position = "relative";
  return container;
}

module.exports = {
  FakeElement,
  FakeStyleSheet,
  createHarness,
  createActionRow,
  createPlayerContainer,
};
