const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* ============================================================
   The panel, running for real.

   These tests cover the way the panel talks to the user: the visible
   notice, the sentences a failure is shown with, the language of every
   label, and the order the Words tab puts its sections in. They drive the
   real sidepanel.js inside a real DOM with the real sidepanel.html, so an
   assertion is about what the user ends up seeing.
   ============================================================ */

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

  const localArea = createStorageArea(local);
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
    YTD_SETTINGS: require("../settings.js"),
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

/* ============================================================
   A: a failure has to be visible
   ============================================================ */

test("a failure is shown on screen, not only to a screen reader", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.announceAlert("Could not save. Try again.");

  const notice = panel.el("panelToast");
  assert.equal(notice.hidden, false, "the failure is invisible to everyone");
  assert.equal(
    panel.el("panelToastText").textContent,
    "Could not save. Try again.",
    "the visible notice does not carry the message",
  );
  assert.equal(
    panel.el("panelAlert").textContent,
    "Could not save. Try again.",
    "the screen reader lost the message",
  );
});

test("a passing message goes away on its own", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.announceStatus("Note saved.");
  assert.equal(panel.el("panelToast").hidden, false);

  panel.clock.advance(4000);
  assert.equal(
    panel.el("panelToast").hidden,
    true,
    "the message is still on screen long after it was stale",
  );
});

test("an error waits for the user and can be dismissed", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await panel.boot();

  panel.helpers.announceAlert("Could not save. Try again.");

  panel.clock.advance(60_000);
  assert.equal(
    panel.el("panelToast").hidden,
    false,
    "the error disappeared on its own, so the user may never read it",
  );

  await panel.click(panel.el("panelToastClose"));
  assert.equal(panel.el("panelToast").hidden, true, "the error cannot be dismissed");
});

test("a passing message does not wipe an error the user has not read", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.announceAlert("Could not save. Try again.");
  panel.helpers.announceStatus("Note saved.");

  assert.equal(
    panel.el("panelToastText").textContent,
    "Could not save. Try again.",
    "a passing message replaced an error",
  );
});

test("a state the panel already shows is not repeated on screen", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  // The error screen takes over the panel and says what went wrong.
  panel.helpers.showError("Error", "Something went wrong.");

  assert.equal(
    panel.el("panelToast").hidden,
    true,
    "the failure is on screen twice",
  );
  assert.match(
    panel.el("panelAlert").textContent,
    /Something went wrong/,
    "the screen reader lost the failure",
  );
});

test("the notice cannot swallow a click meant for the panel", () => {
  const css = read("sidepanel.css");

  // A notice that takes pointer events would sit on top of the content and
  // eat the clicks the user meant for the content.
  const bar = css.match(/\.panel-toast\s*\{[^}]*\}/);
  assert.ok(bar, "the notice has no rule of its own");
  assert.match(bar[0], /position:\s*fixed;/, "the notice is not out of the flow");
  assert.match(
    bar[0],
    /pointer-events:\s*none;/,
    "the notice eats the clicks meant for the content",
  );
});

// ============================================================
// B: a failure code is not a sentence
// ============================================================

test("our own failure code becomes a sentence the user can read", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure({ error: "NO_AI_KEY" });

  const item = panel.el("chapterList").children[0];
  const message = item.children[0].textContent;
  assert.doesNotMatch(message, /NO_AI_KEY/, "the code reached the user");
  assert.ok(message.trim().length > 10, "the failure has no explanation");
});

test("the provider's own message is still shown", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure({
    error: "NO_AI_KEY",
    message: "DeepSeek V4 Flash API key not configured.",
  });

  const item = panel.el("chapterList").children[0];
  assert.match(
    item.children[0].textContent,
    /API key not configured/,
    "the provider's own words were hidden",
  );
});

test("every failure code has a sentence in both languages", async () => {
  const english = createPanel({ sendMessageImpl: workerRouter() });
  const chinese = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await chinese.helpers.loadPanelLanguage();

  const codes = [
    "NO_AI_KEY",
    "INVALID_AI_KEY",
    "NO_SUPADATA_KEY",
    "INVALID_SUPADATA_KEY",
    "NO_TRANSCRIPT",
    "EMPTY_TRANSCRIPT",
    "OUT_OF_CREDITS",
    "RATE_LIMITED",
    "EMPTY_SENTENCE",
    "AI_IDLE_TIMEOUT",
    "AI_HARD_TIMEOUT",
    "SYNC_SESSION_EXPIRED",
  ];

  for (const code of codes) {
    const englishText = english.helpers.panelFailureMessage({ error: code });
    assert.notEqual(englishText, code, `${code} is shown as a code`);
    assert.ok(englishText.trim().length > 10, `${code} has no English sentence`);

    const chineseText = chinese.helpers.panelFailureMessage({ error: code });
    assert.notEqual(chineseText, code, `${code} is shown as a code in Chinese`);
    assert.ok(chineseText.trim().length > 4, `${code} has no Chinese sentence`);
    assert.notEqual(
      chineseText,
      englishText,
      `${code} says the same thing in both languages`,
    );
  }
});

// ============================================================
// C: a failure has to look like a failure
// ============================================================

test("a failed summary is painted as a failure", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure({ error: "NO_AI_KEY" });

  const chapter = panel.el("chapterList").children[0];
  assert.equal(
    chapter.style.color,
    "var(--danger)",
    "the failure is painted in the accent colour, so it looks like content",
  );
  const quote = panel.el("quotesList").children[0];
  assert.equal(quote.style.color, "var(--danger)");
});

// ============================================================
// D: no hardcoded English left behind
// ============================================================

/**
 * Removes the ${...} expressions from a template literal.
 *
 * What is left is the markup itself, so the words between two tags can be
 * read without stumbling over a JavaScript expression.
 */
function stripTemplateExpressions(template) {
  let result = "";
  let index = 0;
  while (index < template.length) {
    if (template.startsWith("${", index)) {
      let depth = 1;
      index += 2;
      while (index < template.length && depth > 0) {
        const character = template[index];
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        index += 1;
      }
      result += " ";
      continue;
    }
    result += template[index];
    index += 1;
  }
  return result;
}

test("the panel has no hardcoded English left in its user-visible strings", () => {
  const source = read("sidepanel.js");
  // The copy table is the one place where English is written on purpose.
  const code = source.replace(/const PANEL_COPY = \{[\s\S]*?\n\};/, "");

  const offenders = [];

  for (const match of code.matchAll(/\.textContent\s*=\s*"([^"]*)"/g)) {
    if (/[A-Za-z]{2,}/.test(match[1])) {
      offenders.push(`textContent = "${match[1]}"`);
    }
  }

  for (const match of code.matchAll(/\.innerHTML\s*=\s*`([\s\S]*?)`/g)) {
    const markup = stripTemplateExpressions(match[1]);
    for (const text of markup.matchAll(/>([^<>]*[A-Za-z]{2,}[^<>]*)</g)) {
      offenders.push(`innerHTML writes "${text[1].trim()}"`);
    }
  }

  // The note delete button carries an English default because the release
  // gate checks for that exact string. The panel replaces it with the
  // translated label on the next line, so the user never reads the English.
  const allowed = new Set(['aria-label="Delete note"', 'title="Delete note"']);
  for (const match of code.matchAll(/\b(?:aria-label|title)="([^"${]*)"/g)) {
    if (!/[A-Za-z]{2,}/.test(match[1])) continue;
    if (allowed.has(match[0])) continue;
    offenders.push(match[0]);
  }

  assert.deepEqual(
    offenders,
    [],
    `these words never follow the interface language: ${offenders.join(", ")}`,
  );
});

test("the copy button answers in the panel's language", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await panel.helpers.loadPanelLanguage();

  panel.helpers.startDigest("videoA", "https://www.youtube.com/watch?v=videoA");
  await flush();

  const button = panel.el("copyTranscriptBtn");
  const original = button.textContent;
  await panel.click(button);

  assert.equal(
    button.textContent,
    "已复制",
    "the copy button still speaks English on a Chinese panel",
  );
  assert.notEqual(button.textContent, original);
});

// ============================================================
// E: the library speaks the user's language
// ============================================================

test("a video read a moment ago says so", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const now = Date.now();
  assert.equal(panel.helpers.formatRelativeTime(now - 20_000), "just now");
  assert.equal(panel.helpers.formatRelativeTime(now - 3 * 60_000), "3 min ago");
  assert.equal(panel.helpers.formatRelativeTime(now - 5 * 3_600_000), "5 h ago");
  assert.equal(panel.helpers.formatRelativeTime(now - 3 * 86_400_000), "3 d ago");
  assert.equal(panel.helpers.formatRelativeTime(now - 90 * 86_400_000), "3 mo ago");
});

test("the library says how long ago in the panel's language", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await panel.helpers.loadPanelLanguage();

  const now = Date.now();
  assert.equal(panel.helpers.formatRelativeTime(now - 20_000), "刚刚");
  assert.equal(panel.helpers.formatRelativeTime(now - 3 * 86_400_000), "3 天前");
});

test("the library card shows when the video was read", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_videoB: {
        videoTitle: "A saved video",
        channelName: "A channel",
        timestamp: Date.now() - 30_000,
        analysis: { summary: "A summary" },
      },
    },
  });

  await panel.helpers.loadLibrary();

  const card = panel.el("libraryList").children[0];
  assert.match(card.textContent, /just now/, "the card has no time on it");
});

test("an empty library and a search with no results say different things", async () => {
  const empty = createPanel({ sendMessageImpl: workerRouter() });
  await empty.helpers.loadLibrary();
  const emptyText = empty.el("libraryList").textContent.trim();
  assert.ok(emptyText.length > 0, "the empty library says nothing");

  const searching = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_videoB: {
        videoTitle: "A saved video",
        channelName: "A channel",
        timestamp: Date.now() - 1000,
      },
    },
  });
  await searching.helpers.loadLibrary();

  const input = searching.el("librarySearchInput");
  input.value = "nothing matches this";
  input.dispatchEvent(new searching.window.Event("input", { bubbles: true }));
  await flush();

  const noResultsText = searching.el("libraryList").textContent.trim();
  assert.ok(noResultsText.length > 0, "the empty search says nothing");
  assert.notEqual(
    noResultsText,
    emptyText,
    "a search that found nothing says the same thing as an empty library",
  );
});

// ============================================================
// F: review comes before the word list
// ============================================================

test("review comes before the word list", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const sections = [...panel.el("panel-words").children].filter((element) =>
    element.classList.contains("section"),
  );
  const reviewIndex = sections.findIndex((element) =>
    element.querySelector("#reviewArea"),
  );
  const wordsIndex = sections.findIndex((element) =>
    element.querySelector("#wordsList"),
  );

  assert.ok(reviewIndex >= 0, "the review section is gone");
  assert.ok(wordsIndex >= 0, "the vocabulary section is gone");
  assert.ok(
    reviewIndex < wordsIndex,
    "the review is still below the whole word list",
  );
});

test("the first control of the Words tab is the review", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const controls = panel.all("#panel-words button");
  assert.ok(controls.length > 0, "the Words tab has no controls");
  assert.equal(
    controls[0].id,
    "reviewCard",
    "a keyboard user still has to walk past the word list to reach the review",
  );
});
