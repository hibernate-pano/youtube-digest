const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

/* ============================================================
   The panel, running for real.

   This harness boots the real sidepanel.js inside a real DOM with the real
   sidepanel.html, so a test can say what the user ends up seeing. The clock
   is the one piece the tests own: the panel waits between the translation
   attempts, and a test has to be able to move time forward without waiting
   for it.
   ============================================================ */

const root = path.resolve(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function createStorageArea(initial = {}, options = {}) {
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
      // A device can run out of room. The tests need to be able to say so.
      if (typeof options.onSet === "function") {
        const failure = options.onSet(items);
        if (failure) throw failure;
      }
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
 * A clock the tests control.
 *
 * The notice that a passing message disappears after a few seconds is timed,
 * so a test has to be able to move time forward without waiting for it.
 */
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  const schedule = (callback, delay, interval) => {
    const id = nextId++;
    const period = Math.max(1, Number(delay) || 1);
    timers.set(id, { callback, at: now + (interval ? period : 0), period, interval });
    return id;
  };

  return {
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: (id) => timers.delete(id),
    /**
     * Moves the clock forward and runs everything that comes due.
     */
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 1000; guard += 1) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        if (timer.interval) timer.at += timer.period;
        else timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
  };
}

/**
 * Boots the real panel against the real markup.
 */
function createPanel({
  sendMessageImpl,
  local = {},
  session = {},
  language = "en",
  onLocalSet = null,
} = {}) {
  const dom = new JSDOM(read("sidepanel.html"), {
    url: "chrome-extension://test/sidepanel.html",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;

  // The panel's own script tags are not executed: the panel is loaded here
  // explicitly so the tests can hand it a stubbed chrome API.
  for (const script of [...window.document.querySelectorAll("script")]) {
    script.remove();
  }

  const localArea = createStorageArea(local, { onSet: onLocalSet });
  const sessionArea = createStorageArea(session);
  localArea.values.ytd_options_language = language;

  const clock = createClock();
  const sentMessages = [];
  const sendMessage = async (message) => {
    sentMessages.push(message);
    if (sendMessageImpl) return sendMessageImpl(message);
    return { success: true };
  };

  const stub = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController: window.AbortController,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
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
    document: window.document,
    window,
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
        query: async () => [],
        sendMessage: async () => ({ success: true }),
        create() {},
      },
    },
    YTD_SETTINGS: require("../../settings.js"),
  };
  window.chrome = stub.chrome;
  window.console = console;

  const context = vm.createContext({
    ...stub,
    globalThis: undefined,
    window,
  });
  context.globalThis = context;
  context.window = window;
  vm.runInContext(read("sidepanel.js"), context, { filename: "sidepanel.js" });

  return {
    dom,
    window,
    document: window.document,
    sandbox: context,
    helpers: context.__YTD_PANEL_TESTING__,
    sentMessages,
    storage: { local: localArea, session: sessionArea },
    clock,
    el: (id) => window.document.getElementById(id),
    all: (selector) => [...window.document.querySelectorAll(selector)],
    text: (id) => window.document.getElementById(id)?.textContent?.trim() || "",
    click: async (element) => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await flush();
    },
    /**
     * Runs the panel's own boot, which is what wires the controls.
     */
    boot: async () => {
      window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
      await flush();
    },
    flush,
  };
}

async function flush() {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * The worker answers the way the real one does, so the panel sees a normal
 * panel and not a broken one.
 */
function workerRouter(overrides = {}) {
  const router = async (message) => {
    const override = overrides[message.action];
    if (typeof override === "function") return override(message);
    if (override !== undefined) return override;
    switch (message.action) {
      case "checkConfig":
        return { hasSupadataKey: true, hasAiKey: true };
      case "fetchTranscript":
        return {
          success: true,
          transcript: [{ text: "A caption", start: 0, duration: 2, language: "en" }],
          transcriptText: "A caption",
          transcriptTextTimestamped: "[0:00] A caption",
          language: "en",
        };
      case "analyzeTranscript":
        return { success: true, analysis: { chapters: [], keyQuotes: [] } };
      case "getNotes":
        return { success: true, notes: [] };
      case "getVocabulary":
        return { success: true, items: [] };
      case "getDueReviews":
        return { success: true, reviews: [] };
      default:
        return { success: true };
    }
  };
  return router;
}

module.exports = {
  createClock,
  createPanel,
  createStorageArea,
  flush,
  read,
  root,
  workerRouter,
};
