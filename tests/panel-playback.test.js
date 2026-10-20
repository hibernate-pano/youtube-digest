const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* ============================================================
   The playback poll must not search the browser's tabs.

   The panel follows the video by asking "what second are we at?"
   every 500ms. The relay behind `relayToContent` answers that question
   only after searching the browser's tabs, which is far too heavy to
   repeat twice a second. The panel already knows which tab holds the
   video, so the poll has to ask that tab directly and fall back to the
   relay only when the tab is gone.

   These tests drive the real sidepanel.js inside a real DOM (jsdom)
   with the real sidepanel.html, and they assert on what the panel did:
   which tab it asked, whether it went through the relay at all, and
   which transcript line ended up highlighted.
   ============================================================ */

const VIDEO_URL = "https://www.youtube.com/watch?v=videoA";
const YOUTUBE_TAB_ID = 42;

// Two captions long enough that the panel keeps them as two rows of
// their own, so "which line is highlighted" says which moment in the
// video the panel believes it is watching.
const FIRST_CAPTION =
  "The first caption is long enough to become a transcript row of its own.";
const SECOND_CAPTION =
  "The second caption is long enough to become a transcript row of its own.";

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

function transcriptPayload() {
  return {
    success: true,
    transcript: [
      { text: FIRST_CAPTION, start: 0, duration: 2, language: "en" },
      { text: SECOND_CAPTION, start: 30, duration: 2, language: "en" },
    ],
    transcriptText: `${FIRST_CAPTION} ${SECOND_CAPTION}`,
    transcriptTextTimestamped: `[0:00] ${FIRST_CAPTION}\n[0:30] ${SECOND_CAPTION}`,
    language: "en",
  };
}

/**
 * The message router the panel talks to. It answers the way the worker
 * does and records what the panel asked for.
 *
 * `relayCurrentTime` is the moment the relay would report. It is set to a
 * different second than the direct answer on purpose: a poll that took the
 * time from the wrong place would highlight the wrong line, and the test
 * would say so.
 */
function workerRouter({ relayCurrentTime = 0, relayFails = false } = {}) {
  const router = async (message) => {
    switch (message.action) {
      case "checkConfig":
        return { hasSupadataKey: true, hasAiKey: true };
      case "fetchTranscript":
        return transcriptPayload();
      case "getNotes":
        return { success: true, notes: [] };
      case "getVocabulary":
        return { success: true, items: [] };
      case "getGithubSession":
        return { success: false };
      case "syncNotes":
        return { success: true };
      case "relayToContent": {
        if (message.payload?.action === "getCurrentTime") {
          if (relayFails) return { success: false };
          return { success: true, response: { currentTime: relayCurrentTime } };
        }
        if (message.payload?.action === "getVideoInfo") {
          return {
            success: true,
            response: {
              title: "A video",
              channelName: "A channel",
              duration: 120,
              description: "A description",
            },
          };
        }
        return { success: true, response: {} };
      }
      default:
        return { success: true };
    }
  };
  return router;
}

/**
 * Boots the real panel against the real markup.
 *
 * `tabResponder` decides what the YouTube tab answers. Returning a value
 * is a tab that answers; throwing is a tab that is gone.
 */
function createPanel({
  sendMessageImpl,
  tabs = [],
  tabResponder = null,
} = {}) {
  const dom = new JSDOM(read("sidepanel.html"), {
    url: "chrome-extension://test/sidepanel.html",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;

  // The panel's own script tags are not executed: the panel is loaded here
  // so the tests can hand it a stubbed chrome API.
  for (const script of [...window.document.querySelectorAll("script")]) {
    script.remove();
  }

  // jsdom has no layout, so it has no scrolling either.
  window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
    this.scrollCalls = this.scrollCalls || [];
    this.scrollCalls.push(options);
  };

  const localArea = createStorageArea();
  const sessionArea = createStorageArea();
  localArea.values.ytd_options_language = "en";

  // The two kinds of message are kept apart on purpose: the whole point of
  // the fix is which of the two the poll uses.
  const runtimeMessages = [];
  const tabMessages = [];

  const sendMessage = async (message) => {
    runtimeMessages.push(message);
    if (sendMessageImpl) return sendMessageImpl(message);
    return { success: true };
  };

  const sendToTab = async (tabId, message) => {
    tabMessages.push({ tabId, message });
    if (tabResponder) return tabResponder(tabId, message);
    return { success: true };
  };

  // The poll is a timer. The tests drive it by hand, so the timer never
  // runs on its own and the messages it sends stay countable.
  const intervals = new Map();
  let nextIntervalId = 1;

  const stub = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController: window.AbortController,
    setTimeout: (...args) => window.setTimeout(...args),
    clearTimeout: (...args) => window.clearTimeout(...args),
    setInterval: (callback, delay) => {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
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
        query: async () => tabs,
        sendMessage: sendToTab,
        create() {},
      },
    },
    YTD_SETTINGS: require("../settings.js"),
  };

  const context = vm.createContext({ ...stub, globalThis: undefined, window });
  context.globalThis = context;
  context.window = window;
  vm.runInContext(read("sidepanel.js"), context, { filename: "sidepanel.js" });

  return {
    dom,
    window,
    document: window.document,
    sandbox: context,
    helpers: context.__YTD_PANEL_TESTING__,
    runtimeMessages,
    tabMessages,
    el: (id) => window.document.getElementById(id),
    all: (selector) => [...window.document.querySelectorAll(selector)],
    flush,
    /** The poll timers the panel has running right now. */
    pollCount: () => intervals.size,
    /** Runs the playback poll once, the way its timer would. */
    firePoll: async () => {
      for (const { callback } of [...intervals.values()]) {
        await callback();
      }
      await flush();
    },
  };
}

async function flush() {
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A panel with a transcript on screen and the poll running.
 */
async function createLoadedPanel(options = {}) {
  const panel = createPanel({
    tabs: [{ id: YOUTUBE_TAB_ID, url: VIDEO_URL }],
    ...options,
  });
  panel.document.dispatchEvent(new panel.window.Event("DOMContentLoaded"));
  await flush();
  return panel;
}

/**
 * The transcript lines on screen, and which one the panel believes the
 * video is playing right now.
 */
function playbackState(panel) {
  const rows = panel.all("#transcriptList .transcript-entry");
  const highlighted = rows.findIndex((row) =>
    row.classList.contains("active-playback"),
  );
  return { rows, highlighted };
}

/**
 * The polls that went through the worker, which is the expensive road.
 */
function relayPolls(panel) {
  return panel.runtimeMessages.filter(
    (message) =>
      message.action === "relayToContent" &&
      message.payload?.action === "getCurrentTime",
  );
}

test("the playback poll asks the YouTube tab directly instead of searching every tab", async () => {
  const panel = await createLoadedPanel({
    sendMessageImpl: workerRouter({ relayCurrentTime: 0 }),
    tabResponder: async () => ({ currentTime: 30, paused: false }),
  });

  assert.equal(panel.pollCount(), 1, "the poll is running");

  await panel.firePoll();

  const asked = panel.tabMessages.filter(
    (entry) => entry.message?.action === "getCurrentTime",
  );
  assert.equal(asked.length, 1, "the poll asked the tab once");
  assert.equal(asked[0].tabId, YOUTUBE_TAB_ID, "the poll asked the video's tab");

  assert.equal(
    relayPolls(panel).length,
    0,
    "the poll did not make the worker search the browser's tabs",
  );

  // The direct answer carries the time itself, not wrapped in a relay
  // envelope, so a poll that read the wrong place would highlight the
  // wrong line. The relay would have said 0; the tab said 30.
  const { rows, highlighted } = playbackState(panel);
  assert.equal(rows.length, 2, "the transcript has two lines");
  assert.equal(highlighted, 1, "the panel follows the second line");
});

test("the playback poll falls back to the relay when the YouTube tab is gone", async () => {
  const panel = await createLoadedPanel({
    sendMessageImpl: workerRouter({ relayCurrentTime: 30 }),
    tabResponder: async () => {
      throw new Error("Could not establish connection.");
    },
  });

  await panel.firePoll();

  const asked = panel.tabMessages.filter(
    (entry) => entry.message?.action === "getCurrentTime",
  );
  assert.equal(asked.length, 1, "the poll tried the tab first");
  assert.equal(asked[0].tabId, YOUTUBE_TAB_ID, "the poll tried the video's tab");

  assert.equal(
    relayPolls(panel).length,
    1,
    "the poll went through the worker once the tab could not answer",
  );

  const { rows, highlighted } = playbackState(panel);
  assert.equal(rows.length, 2, "the transcript has two lines");
  assert.equal(highlighted, 1, "the panel still follows the video");
});

test("the playback poll keeps running when the tab and the relay both fail", async () => {
  let relayCalls = 0;
  const panel = await createLoadedPanel({
    sendMessageImpl: async (message) => {
      if (
        message.action === "relayToContent" &&
        message.payload?.action === "getCurrentTime"
      ) {
        relayCalls += 1;
        if (relayCalls === 1) return { success: false };
        return { success: true, response: { currentTime: 30 } };
      }
      return workerRouter()(message);
    },
    tabResponder: async () => {
      throw new Error("Could not establish connection.");
    },
  });

  // The first poll finds nothing anywhere. It must not throw and it must
  // not take the poll down with it.
  await panel.firePoll();

  assert.equal(panel.pollCount(), 1, "the poll is still running");
  assert.equal(playbackState(panel).highlighted, -1, "nothing was highlighted");

  // The next poll finds the video again, so the panel picks up where it
  // left off instead of having stopped for good.
  await panel.firePoll();

  assert.equal(panel.pollCount(), 1, "the poll is still running");
  assert.equal(
    playbackState(panel).highlighted,
    1,
    "the panel follows the video again",
  );
});
