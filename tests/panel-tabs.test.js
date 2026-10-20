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

   The side panel is where the product lives, so these tests run the actual
   sidepanel.js inside a real DOM (jsdom) with the actual sidepanel.html.
   Every assertion is about what the user ends up seeing: text on the
   screen, a button that exists, a message that was sent to the worker.
   Nothing here checks the source text of a file - a test that reads the
   code proves only that the code says something, not that the product
   does it.
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
 * Boots the real panel against the real markup.
 *
 * The markup is loaded from sidepanel.html with the scripts removed, then
 * sidepanel.js is run inside the same window's context. That way the panel
 * finds the elements it asks for by id, exactly as it does in Chrome.
 */
function createPanel({
  sendMessageImpl,
  local = {},
  session = {},
  language = "en",
  tabs = [],
  activeTab = "",
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
    // The window's own AbortController: jsdom's addEventListener only
    // accepts its own AbortSignal, and the panel passes one to listen for
    // the selection.
    AbortController: window.AbortController,
    setTimeout: (...args) => window.setTimeout(...args),
    clearTimeout: (...args) => window.clearTimeout(...args),
    setInterval: (...args) => window.setInterval(...args),
    clearInterval: (...args) => window.clearInterval(...args),
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
        sendMessage: async (tabId, message) => {
          sentMessages.push(message);
          return { success: true };
        },
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
    el: (id) => window.document.getElementById(id),
    all: (selector) => [...window.document.querySelectorAll(selector)],
    text: (id) => window.document.getElementById(id)?.textContent?.trim() || "",
    visible: (id) => {
      const element = window.document.getElementById(id);
      if (!element) return false;
      if (element.hidden) return false;
      return true;
    },
    click: async (element) => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
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

function analysisPayload(extra = {}) {
  return {
    success: true,
    analysis: {
      summary: "The video argues that spaced repetition beats cramming.",
      chapters: [
        { title: "Intro", timestamp: "0:00", timestampSeconds: 0, summary: "Why habits matter" },
      ],
      keyQuotes: [{ quote: "Memory is a muscle", timestamp: "0:30", timestampSeconds: 30 }],
      ...extra,
    },
  };
}

/**
 * The message router every test shares: it answers the panel the way the
 * worker does, and it records what the panel asked for.
 */
function workerRouter(overrides = {}) {
  const calls = [];
  const router = async (message) => {
    calls.push(message);
    const override = overrides[message.action];
    if (typeof override === "function") return override(message);
    if (override !== undefined) return override;
    switch (message.action) {
      case "checkConfig":
        return { hasSupadataKey: true, hasAiKey: true };
      case "fetchTranscript":
        return transcriptPayload();
      case "analyzeTranscript":
        return analysisPayload();
      case "getNotes":
        return { success: true, notes: [] };
      case "syncNotes":
        return { success: true };
      case "getGithubSession":
        return { success: false };
      case "getVocabulary":
        return { success: true, items: [] };
      case "getDueReviews":
        return { success: true, reviews: [] };
      case "relayToContent":
        return { success: true, response: { currentTime: 42 } };
      default:
        return { success: true };
    }
  };
  router.calls = calls;
  return router;
}

/**
 * A panel that has a video on screen: the transcript is loaded and the
 * overview has its chapters. This is the state most of the panel's features
 * are reached from.
 */
async function createLoadedPanel(options = {}) {
  const router = workerRouter(options.overrides);
  const panel = createPanel({
    ...options,
    sendMessageImpl: router,
  });
  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await flush();
  return { panel, router };
}

/* ============================================================
   B1: five tabs
   ============================================================ */

test("the panel offers five tabs, each with its own panel", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const tabs = panel.all(".tab");
  assert.equal(tabs.length, 5, "the panel should have five tabs");
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute("data-tab")),
    ["transcript", "overview", "notes", "words", "library"],
  );

  for (const tab of tabs) {
    const controlled = tab.getAttribute("aria-controls");
    assert.ok(controlled, `the ${tab.getAttribute("data-tab")} tab names its panel`);
    assert.ok(panel.el(controlled), `the panel of ${tab.getAttribute("data-tab")} exists`);
  }
});

test("the tabs are named in the language the user picked", async () => {
  const english = createPanel({ sendMessageImpl: workerRouter(), language: "en" });
  await english.helpers.loadPanelLanguage();
  assert.equal(english.el("tab-overview").textContent.trim(), "Summary");
  assert.equal(english.el("tab-words").textContent.trim(), "Words");
  assert.equal(english.el("tab-library").textContent.trim(), "Library");

  const chinese = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await chinese.helpers.loadPanelLanguage();
  assert.equal(chinese.el("tab-overview").textContent.trim(), "摘要");
  assert.equal(chinese.el("tab-words").textContent.trim(), "词汇");
  assert.equal(chinese.el("tab-library").textContent.trim(), "资料库");
});

test("the welcome page offers the vocabulary and the library without a video", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  await panel.helpers.updateWelcomeCounts();

  assert.equal(panel.el("welcomeWordsBtn").hidden, false, "the vocabulary entry is missing");
  assert.equal(panel.el("welcomeLibraryBtn").hidden, false, "the library entry is missing");

  await panel.click(panel.el("welcomeWordsBtn"));
  assert.equal(
    panel.document.querySelector('.tab[data-tab="words"]').getAttribute("aria-selected"),
    "true",
    "the vocabulary entry did not open the vocabulary tab",
  );

  await panel.click(panel.el("welcomeLibraryBtn"));
  assert.equal(
    panel.document.querySelector('.tab[data-tab="library"]').getAttribute("aria-selected"),
    "true",
    "the library entry did not open the library tab",
  );
});

test("the transcript, summary and notes tabs say so when there is no video", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  // The panel has to be on a screen with no video for the empty states to
  // mean anything: the welcome page covers the panel, so the results area
  // is what the user would see after they pick something.
  panel.helpers.showState("results");
  panel.helpers.updateEmptyStates();

  for (const id of ["emptyTranscript", "emptyOverview", "emptyNotes"]) {
    assert.equal(panel.el(id).hidden, false, `${id} is not shown without a video`);
  }
  for (const id of ["transcriptContent", "overviewContent", "notesContent"]) {
    assert.equal(panel.el(id).hidden, true, `${id} is shown without a video`);
  }
});

/* ============================================================
   B4: the summary asks before it spends
   ============================================================ */

test("opening the summary tab does not spend anything", async () => {
  const { panel, router } = await createLoadedPanel();

  await panel.helpers.switchTab("overview");

  assert.equal(
    router.calls.filter((call) => call.action === "analyzeTranscript").length,
    0,
    "opening the tab called the AI",
  );
  assert.equal(panel.el("summaryGate").hidden, false, "the gate is not shown");
  assert.match(panel.text("summaryGate"), /AI/i, "the gate does not name the AI");
});

test("the summary gate says what it will cost before the click", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderSummaryGate();

  const gate = panel.el("summaryGate");
  assert.equal(gate.hidden, false);
  assert.match(gate.textContent, /balance|provider|AI/i);
  assert.ok(panel.el("summaryGenerateBtn"), "there is no button to generate the summary");
});

test("pressing the generate button spends exactly one AI call", async () => {
  const { panel, router } = await createLoadedPanel();

  panel.helpers.renderSummaryGate();
  await panel.click(panel.el("summaryGenerateBtn"));

  assert.equal(
    router.calls.filter((call) => call.action === "analyzeTranscript").length,
    1,
    "the button did not make exactly one AI call",
  );
});

test("a generated summary replaces the gate with the summary itself", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisResults({
    summary: "The video argues that spaced repetition beats cramming.",
    chapters: [],
    keyQuotes: [],
  });

  assert.equal(panel.el("summaryGate").hidden, true, "the gate is still covering the summary");
  assert.equal(panel.el("summaryBlock").hidden, false, "the summary block is not shown");
  assert.match(
    panel.el("summaryText").textContent,
    /spaced repetition/,
    "the summary text is not on screen",
  );
});

test("the summary is the first thing on the summary tab", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const summary = panel.el("summaryText");
  const chapters = panel.el("chapterList");
  assert.ok(summary && chapters, "the summary tab is missing its parts");

  const order = [...panel.document.querySelectorAll("#panel-overview *")].indexOf(summary);
  const chapterOrder = [...panel.document.querySelectorAll("#panel-overview *")].indexOf(chapters);
  assert.ok(order >= 0, "the summary text is not in the summary panel");
  assert.ok(order < chapterOrder, "the summary is not above the chapters");
});

test("a failed summary leaves a real retry button", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure();

  const retry = panel.el("summaryRetryBtn");
  assert.ok(retry, "there is no retry button after a failure");
  assert.equal(retry.tagName, "BUTTON", "the retry is not a real button");
  assert.equal(retry.hidden, false);
  assert.equal(panel.el("summaryGate").hidden, false, "the gate did not come back");
});

test("a summary that is missing does not leave an empty shell", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisResults({ summary: "", chapters: [], keyQuotes: [] });

  assert.equal(panel.el("summaryBlock").hidden, true, "an empty summary block is on screen");
  assert.equal(panel.el("summaryText").textContent.trim(), "");
});

test("a summary without chapters or quotes says so instead of showing nothing", () => {
  // An empty list under a heading looks like the panel broke. The user
  // has to be told what actually happened: the model wrote a summary and
  // no chapters.
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisResults({
    summary: "The video argues that spaced repetition beats cramming.",
    chapters: [],
    keyQuotes: [],
  });

  const chapters = panel.el("chapterList");
  const quotes = panel.el("quotesList");
  assert.ok(chapters.children.length > 0, "the chapter list is empty and says nothing");
  assert.ok(quotes.children.length > 0, "the quote list is empty and says nothing");
  assert.match(
    chapters.textContent,
    /without any chapters/i,
    "the empty chapter list does not say why it is empty",
  );
  assert.match(
    quotes.textContent,
    /without any quotes/i,
    "the empty quote list does not say why it is empty",
  );
});

test("the summary tab does not promise quotes that only come with the summary", () => {
  // The quotes are part of the paid analysis. A placeholder that says
  // "the quotes will be extracted when you view this tab" tells the user
  // to wait for something that never happens on its own.
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const quotes = panel.el("quotesList");
  const text = quotes.textContent.toLowerCase();
  assert.ok(text.length > 0, "the quote list has no placeholder at all");
  assert.doesNotMatch(
    text,
    /when you view this tab/,
    "the placeholder promises quotes on view, but the quotes come with the summary",
  );
  assert.match(
    text,
    /with the summary/,
    "the placeholder does not say where the quotes come from",
  );
});

/* ============================================================
   B2: the vocabulary tab
   ============================================================ */

test("the vocabulary list shows the word, its meaning and a readable status", async () => {
  const router = workerRouter({
    getVocabulary: {
      success: true,
      items: [
        {
          id: "vocab_1",
          term: "spaced repetition",
          translation: "间隔重复",
          explanation: "Reviewing at growing intervals.",
          status: "reviewing",
          videoId: "videoA",
          videoTitle: "How to remember",
          timestampSeconds: 90,
        },
      ],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadVocabulary();

  const list = panel.el("wordsList");
  assert.match(list.textContent, /spaced repetition/, "the word is missing");
  assert.match(list.textContent, /间隔重复/, "the translation is missing");
  assert.match(list.textContent, /Reviewing at growing intervals/, "the explanation is missing");

  // The badge has to say what the status means to a learner. The raw value
  // from the database is not a word anyone can act on.
  const badge = list.querySelector(".word-status");
  assert.ok(badge, "the word has no status badge");
  assert.equal(badge.textContent.trim(), "Reviewing", "the badge does not read like a word");
  assert.doesNotMatch(badge.textContent, /\b(reviewing|learning|mastered)\b/);
});

test("the vocabulary entry names the video and the moment it came from", async () => {
  const router = workerRouter({
    getVocabulary: {
      success: true,
      items: [
        {
          id: "vocab_1",
          term: "spaced repetition",
          translation: "间隔重复",
          videoId: "videoA",
          videoTitle: "How to remember",
          timestampSeconds: 90,
        },
      ],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadVocabulary();

  const list = panel.el("wordsList");
  assert.match(list.textContent, /How to remember/, "the source video is missing");
  assert.match(list.textContent, /1:30/, "the timestamp is missing");
});

test("a word can be deleted", async () => {
  const router = workerRouter({
    getVocabulary: {
      success: true,
      items: [{ id: "vocab_1", term: "spaced repetition", translation: "间隔重复" }],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadVocabulary();

  const deleteButton = panel.el("wordsList").querySelector(".word-delete");
  assert.ok(deleteButton, "there is no delete button");
  await panel.click(deleteButton);

  const call = router.calls.find((message) => message.action === "deleteVocabulary");
  assert.ok(call, "the word was not deleted");
  assert.equal(call.vocabId, "vocab_1");
});

test("the review card offers the four grades the dashboard uses", async () => {
  const router = workerRouter({
    getDueReviews: {
      success: true,
      reviews: [
        {
          review: { dueAt: Date.now() - 1000, intervalDays: 1, ease: 2.5, reps: 1 },
          vocabulary: {
            id: "cloud-uuid-1",
            term: "spaced repetition",
            translation: "间隔重复",
            sentence: "Spaced repetition works.",
            videoId: "videoA",
            videoTitle: "How to remember",
          },
        },
      ],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadDueReviews();

  const grades = [...panel.all(".grade-btn")];
  assert.equal(grades.length, 4, "the review card does not offer four grades");
  assert.deepEqual(
    grades.map((button) => button.getAttribute("data-grade")),
    ["1", "2", "3", "5"],
    "the grades do not match the dashboard",
  );
});

test("grading a review sends the grade with the cloud id", async () => {
  const router = workerRouter({
    getDueReviews: {
      success: true,
      reviews: [
        {
          review: { dueAt: Date.now() - 1000, intervalDays: 1, ease: 2.5, reps: 1 },
          vocabulary: {
            id: "cloud-uuid-1",
            term: "spaced repetition",
            translation: "间隔重复",
          },
        },
      ],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadDueReviews();
  await panel.helpers.submitReviewGrade(3);

  const call = router.calls.find((message) => message.action === "submitReview");
  assert.ok(call, "the grade was not sent");
  assert.equal(call.grade, 3);
  assert.equal(call.vocabId, "cloud-uuid-1", "the local id was sent instead of the cloud id");
});

test("a signed out user is told to sign in, not shown an error", async () => {
  const router = workerRouter({ getDueReviews: { success: false, error: "NO_SESSION" } });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadDueReviews();

  assert.equal(panel.el("reviewSignedOut").hidden, false, "the sign-in prompt is missing");
  assert.match(panel.el("reviewSignedOut").textContent, /sign in/i);
  assert.equal(panel.el("reviewEmpty").hidden, true);
});

/* ============================================================
   B5: the library
   ============================================================ */

test("the library lists the cached videos, newest first", async () => {
  const now = Date.now();
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_old: {
        analysis: null,
        transcript: [],
        transcriptText: "",
        videoTitle: "Older video",
        channelName: "Channel A",
        timestamp: now - 5 * 24 * 60 * 60 * 1000,
      },
      digest_new: {
        analysis: { summary: "x", chapters: [], keyQuotes: [] },
        transcript: [],
        transcriptText: "",
        videoTitle: "Newer video",
        channelName: "Channel B",
        timestamp: now - 1000,
      },
    },
  });

  await panel.helpers.loadLibrary();

  const list = panel.el("libraryList");
  const titles = [...list.querySelectorAll(".library-title")].map((el) => el.textContent.trim());
  assert.deepEqual(titles, ["Newer video", "Older video"], "the library is not newest first");
});

test("the library says how long it keeps things", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  await panel.helpers.loadLibrary();

  assert.match(panel.el("libraryRetention").textContent, /30/);
  assert.match(panel.el("libraryRetention").textContent, /20/);
});

test("opening a cached video costs nothing", async () => {
  const router = workerRouter();
  const panel = createPanel({
    sendMessageImpl: router,
    local: {
      digest_videoA: {
        analysis: { summary: "Cached summary", chapters: [], keyQuotes: [] },
        transcript: [{ text: "cached caption", start: 0, duration: 2, language: "en" }],
        transcriptText: "cached caption",
        transcriptTextTimestamped: "[0:00] cached caption",
        videoTitle: "Cached video",
        channelName: "Channel",
        timestamp: Date.now(),
      },
    },
  });

  await panel.helpers.loadLibrary();
  await panel.helpers.openLibraryEntry({
    videoId: "videoA",
    videoTitle: "Cached video",
    channelName: "Channel",
    timestamp: Date.now(),
    analysis: { summary: "Cached summary", chapters: [], keyQuotes: [] },
    transcript: [{ text: "cached caption", start: 0, duration: 2, language: "en" }],
    transcriptText: "cached caption",
  });
  // A digest run that fires in the background would only show up in the
  // log a few ticks later, so the panel has to be given time to spend the
  // user's money before the test looks for the bill.
  await flush();

  assert.equal(
    router.calls.filter((call) => call.action === "fetchTranscript").length,
    0,
    "opening a cached video fetched the transcript again",
  );
  assert.equal(
    router.calls.filter((call) => call.action === "analyzeTranscript").length,
    0,
    "opening a cached video paid for a summary again",
  );
  assert.match(panel.el("transcriptList").textContent, /cached caption/, "the cached transcript is not on screen");
});

test("the library can be searched by title", async () => {
  const now = Date.now();
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_a: {
        analysis: null,
        transcript: [],
        transcriptText: "",
        videoTitle: "Learning Japanese",
        channelName: "Channel A",
        timestamp: now,
      },
      digest_b: {
        analysis: null,
        transcript: [],
        transcriptText: "",
        videoTitle: "Learning Python",
        channelName: "Channel B",
        timestamp: now,
      },
    },
  });

  await panel.helpers.loadLibrary();
  const search = panel.el("librarySearchInput");
  search.value = "Japanese";
  search.dispatchEvent(new panel.window.Event("input", { bubbles: true }));
  await flush();

  const titles = [...panel.el("libraryList").querySelectorAll(".library-title")].map((el) =>
    el.textContent.trim(),
  );
  assert.deepEqual(titles, ["Learning Japanese"], "the search did not filter the library");
});

/* ============================================================
   B3: the notes tab
   ============================================================ */

test("a note can be written in the panel and is saved with the current time", async () => {
  const { panel, router } = await createLoadedPanel();

  panel.el("quickNoteInput").value = "Remember this";
  await panel.click(panel.el("quickNoteSaveBtn"));

  const call = router.calls.find((message) => message.action === "saveNote");
  assert.ok(call, "the note was not saved");
  assert.equal(call.selectedText, "Remember this");
  assert.equal(call.videoId, "videoA");
  // The moment the video is at, not a placeholder: the panel asks the
  // content script, and the harness answers 42 seconds.
  assert.equal(call.timestamp, 42, "the note does not carry the moment it was written at");
});

test("the note counter shows the limit that really applies", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderNotes([], null);

  assert.match(panel.el("notesCount").textContent, /100/, "the counter does not show the limit");
});

test("a note can be starred", async () => {
  const router = workerRouter({
    getNotes: {
      success: true,
      notes: [
        {
          id: "note_1",
          text: "A note",
          videoTitle: "Video",
          timestamp: "0:00",
          timestampSeconds: 0,
          timestampedUrl: "https://youtu.be/videoA?t=0",
          starred: false,
        },
      ],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadNotes(null);

  const star = panel.el("notesList").querySelector(".note-star");
  assert.ok(star, "there is no star button on the note");
  await panel.click(star);

  const call = router.calls.find((message) => message.action === "setNoteStarred");
  assert.ok(call, "the star was not sent");
  assert.equal(call.noteId, "note_1");
  assert.equal(call.starred, true);
});

test("the notes export as Markdown that a person can paste into Obsidian", async () => {
  const router = workerRouter({
    getNotes: {
      success: true,
      notes: [
        {
          id: "note_1",
          text: "First idea",
          videoTitle: "How to remember",
          channelName: "Learning Lab",
          timestamp: "1:30",
          timestampSeconds: 90,
          timestampedUrl: "https://www.youtube.com/watch?v=videoA&t=90",
        },
      ],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });

  await panel.helpers.loadNotes(null);
  const markdown = panel.helpers.buildNotesMarkdown([
    {
      text: "First idea",
      videoTitle: "How to remember",
      channelName: "Learning Lab",
      timestamp: "1:30",
      timestampSeconds: 90,
      timestampedUrl: "https://www.youtube.com/watch?v=videoA&t=90",
    },
  ]);

  assert.match(markdown, /How to remember/, "the video title is missing");
  assert.match(markdown, /Learning Lab/, "the channel is missing");
  assert.match(markdown, /1:30/, "the timestamp is missing");
  assert.match(markdown, /https:\/\/www\.youtube\.com/, "the link is missing");
  assert.match(markdown, /First idea/, "the note text is missing");
});

/* ============================================================
   The selection toolbar's third button: Word
   ============================================================ */

test("the selection toolbar offers three actions", async () => {
  const { panel } = await createLoadedPanel();

  panel.helpers.setupExplainFeature();

  const tooltip = panel.document.querySelector(".explain-tooltip");
  assert.ok(tooltip, "the selection toolbar is missing");
  const buttons = [...tooltip.querySelectorAll("button")];
  assert.deepEqual(
    buttons.map((button) => button.className),
    ["explain-btn", "selection-note-btn", "selection-word-btn"],
    "the toolbar does not offer Explain, Note and Word",
  );
});

test("the word confirmation shows the words and the price before saving", async () => {
  const { panel } = await createLoadedPanel();

  panel.helpers.showWordConfirmation(
    [{ term: "spaced repetition", translation: "间隔重复", explanation: "Reviewing at growing intervals." }],
    "Spaced repetition works.",
    90,
  );

  const modal = panel.document.getElementById("wordModal");
  assert.ok(modal, "the confirmation dialog is missing");
  assert.match(modal.textContent, /spaced repetition/, "the word is not on screen");
  assert.match(modal.textContent, /间隔重复/, "the translation is not on screen");
  assert.match(modal.textContent, /AI|balance|provider/i, "the price is not on screen");

  const dialog = modal.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.ok(dialog.getAttribute("aria-labelledby"), "the dialog names itself");
});

test("saving the confirmed words stores every one of them", async () => {
  const router = workerRouter();
  const { panel } = await createLoadedPanel({ overrides: {} });
  void router;

  panel.helpers.showWordConfirmation(
    [
      { term: "spaced repetition", translation: "间隔重复" },
      { term: "retention", translation: "记忆留存" },
    ],
    "Spaced repetition works.",
    90,
  );

  const saveButton = panel.document
    .getElementById("wordModal")
    .querySelector(".primary-btn");
  await panel.click(saveButton);

  const saves = panel.sentMessages.filter((message) => message.action === "saveVocabulary");
  assert.equal(saves.length, 2, "not every word was saved");
  assert.equal(saves[0].entry.term, "spaced repetition");
  assert.equal(saves[0].entry.videoId, "videoA", "the word does not know its video");
  assert.equal(saves[0].entry.timestampSeconds, 90);
});

test("cancelling the word confirmation saves nothing", async () => {
  const { panel } = await createLoadedPanel();

  panel.helpers.showWordConfirmation([{ term: "spaced repetition" }], "A sentence.", 10);

  const cancel = panel.document
    .getElementById("wordModal")
    .querySelector(".enhance-btn");
  await panel.click(cancel);

  assert.equal(
    panel.sentMessages.filter((message) => message.action === "saveVocabulary").length,
    0,
    "cancelling still saved the words",
  );
  assert.equal(panel.document.getElementById("wordModal"), null, "the dialog stayed open");
});

/* ============================================================
   The library has to tell the truth
   ============================================================ */

test("the library button that says YouTube really goes to YouTube", async () => {
  const { panel } = await createLoadedPanel({
    local: {
      digest_other: {
        analysis: null,
        transcript: [],
        transcriptText: "",
        videoTitle: "An old video",
        channelName: "Channel",
        timestamp: Date.now(),
      },
    },
  });

  await panel.helpers.loadLibrary();
  const card = panel.el("libraryList").querySelector(".library-item");
  assert.ok(card, "the library has no entries");

  const buttons = [...card.querySelectorAll("button")];
  const labels = buttons.map((button) => button.textContent.trim());
  assert.ok(
    labels.some((label) => /youtube/i.test(label)),
    "there is no button that goes to YouTube",
  );
  assert.ok(
    labels.some((label) => /panel/i.test(label)),
    "there is no button that reads in the panel",
  );
});

test("the library's YouTube button opens a new tab on the video", async () => {
  const created = [];
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_other: {
        analysis: null,
        transcript: [],
        transcriptText: "",
        videoTitle: "An old video",
        channelName: "Channel",
        timestamp: Date.now(),
      },
    },
  });
  panel.window.chrome.tabs.create = (options) => created.push(options);

  await panel.helpers.loadLibrary();
  const youtubeButton = [...panel.el("libraryList").querySelectorAll("button")].find(
    (button) => /youtube/i.test(button.textContent),
  );
  await panel.click(youtubeButton);

  assert.equal(created.length, 1, "the button did not open anything");
  assert.match(created[0].url, /youtube\.com\/watch\?v=other/);
});

test("the library does not list the video the user is looking at", async () => {
  const { panel } = await createLoadedPanel();

  // The video on screen was cached by the run, so it IS in the store. The
  // library must still leave it out: it is "you are here", not "you read
  // this before".
  assert.ok(
    Object.keys(panel.storage.local.values).some((key) => key === "digest_videoA"),
    "the test did not cache the video on screen",
  );

  await panel.helpers.loadLibrary();

  const titles = [...panel.el("libraryList").querySelectorAll(".library-title")].map((el) =>
    el.textContent.trim(),
  );
  assert.equal(
    titles.length,
    0,
    `the video on screen is listed in the library: ${JSON.stringify(titles)}`,
  );
});

test("a saved copy says so, so a note is filed under the right video", async () => {
  const { panel } = await createLoadedPanel({
    local: {
      digest_other: {
        analysis: null,
        transcript: [],
        transcriptText: "",
        videoTitle: "An old video",
        channelName: "Channel",
        timestamp: Date.now(),
      },
    },
  });

  await panel.helpers.loadLibrary();
  const card = panel.el("libraryList").querySelector(".library-item");
  const readButton = [...card.querySelectorAll("button")].find((button) =>
    /panel/i.test(button.textContent),
  );
  await panel.click(readButton);

  const note = panel.el("cachedViewNote");
  assert.equal(note.hidden, false, "the panel does not say it shows a saved copy");
  assert.match(note.textContent, /saved copy/i);
});

/* ============================================================
   The summary gate states the price once
   ============================================================ */

test("the summary gate states the price once", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderSummaryGate();

  const gate = panel.el("summaryGate");
  const sentences = gate.textContent
    .split(/(?<=[.。])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const priceLines = sentences.filter((sentence) => /AI call|provider/i.test(sentence));
  assert.equal(
    priceLines.length,
    1,
    `the price is stated ${priceLines.length} times: ${JSON.stringify(priceLines)}`,
  );
});

/* ============================================================
   The note composer does not invent a moment
   ============================================================ */

test("the panel does not print a fake moment when it cannot read one", async () => {
  const { panel } = await createLoadedPanel({
    overrides: {
      relayToContent: { success: false, error: "No YouTube tab found" },
    },
  });

  await panel.helpers.refreshNotesCurrentTime();

  const label = panel.el("notesCurrentTime").textContent.trim();
  assert.ok(label.length > 0, "the panel says nothing about the moment");
  assert.doesNotMatch(label, /\b0:00\b/, "the panel invented a moment of 0:00");
});

test("the panel shows the real moment when it can read one", async () => {
  const { panel } = await createLoadedPanel();

  await panel.helpers.refreshNotesCurrentTime();

  assert.match(panel.el("notesCurrentTime").textContent, /42/, "the moment is not on screen");
});

/* ============================================================
   The note store's cap: the panel has to say so out loud
   ============================================================ */
test("the panel says when the store dropped old notes", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      ytd_notes_dropped: { total: 1, lastCount: 1, lastAt: Date.now() },
    },
  });

  await panel.helpers.renderNotes([], null);
  await flush();

  const notice = panel.el("notesDroppedNotice");
  assert.equal(notice.hidden, false, "the drop is not on screen");
  assert.match(notice.textContent, /1/, "the drop does not say how many");
});

test("the panel says nothing when nothing was dropped", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), local: {} });

  await panel.helpers.renderNotes([], null);
  await flush();

  assert.equal(panel.el("notesDroppedNotice").hidden, true, "the panel invented a loss");
});

test("the Chinese panel says the same thing in Chinese", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    language: "zh-CN",
    local: {
      ytd_notes_dropped: { total: 2, lastCount: 2, lastAt: Date.now() },
    },
  });

  await panel.helpers.loadPanelLanguage();
  await panel.helpers.renderNotes([], null);
  await flush();

  const notice = panel.el("notesDroppedNotice");
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /2/);
  assert.match(notice.textContent, /[一-鿿]/, "the notice is not in Chinese");
});
