const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const SETTINGS = require("../settings.js");

/* ============================================================
   A stamp a reader can trust.

   A video longer than an hour used to be stamped in a way nobody could
   read. The ninetieth minute of a video was written "90:00", which looks
   exactly like the ninetieth second of a video written "1:30" and is
   easy to mistake for it. A reader who clicked such a stamp landed a
   whole hour away from the moment they meant.

   The stamp is now written in one shape everywhere: M:SS under an hour,
   H:MM:SS from an hour on. These tests hold that in place from both
   ends: they check the formatter itself, they check what the reader
   actually sees on screen, and they check that the model is told about
   the shape that is really there. A stamp the model cannot read is a
   stamp that gets rejected or misread, and a chapter the model placed at
   1:30:00 then lands in the wrong place.

   Every assertion is about a value a person or a model receives. Nothing
   here reads the source of a file and looks for a string in it.
   ============================================================ */

// The ninetieth minute of a video: 5400 seconds. The ninetieth second is
// 90 seconds, and the two used to be told apart by nothing at all.
const NINETY_MINUTES = 5400;
const HOUR_STAMP = "1:30:00";

// ============================================================
// The shared formatter
// ============================================================

test("a stamp under an hour stays in minutes and seconds", () => {
  assert.equal(SETTINGS.formatTimestamp(0), "0:00");
  assert.equal(SETTINGS.formatTimestamp(59), "0:59");
  assert.equal(SETTINGS.formatTimestamp(60), "1:00");
  assert.equal(SETTINGS.formatTimestamp(3599), "59:59");
});

test("a stamp from an hour on grows an hours part", () => {
  assert.equal(SETTINGS.formatTimestamp(3600), "1:00:00");
  assert.equal(SETTINGS.formatTimestamp(3661), "1:01:01");
  assert.equal(SETTINGS.formatTimestamp(7325), "2:02:05");
  assert.equal(SETTINGS.formatTimestamp(36000), "10:00:00");
});

test("the ninetieth minute no longer reads like the ninetieth second", () => {
  assert.equal(SETTINGS.formatTimestamp(NINETY_MINUTES), HOUR_STAMP);
  assert.equal(SETTINGS.formatTimestamp(90), "1:30");
  assert.notEqual(
    SETTINGS.formatTimestamp(NINETY_MINUTES),
    SETTINGS.formatTimestamp(90),
    "a minute and a second still look the same",
  );
});

test("a stamp that is not a number is the start of the video", () => {
  assert.equal(SETTINGS.formatTimestamp(-5), "0:00");
  assert.equal(SETTINGS.formatTimestamp("nonsense"), "0:00");
  assert.equal(SETTINGS.formatTimestamp(null), "0:00");
  assert.equal(SETTINGS.formatTimestamp(undefined), "0:00");
});

// ============================================================
// The worker
// ============================================================

/**
 * Loads the real service worker so the test can call the runtime's own
 * functions. The functions are top-level declarations, so they land on the
 * sandbox's global object.
 */
function loadBackgroundRuntime({ settings = {}, fetchImpl } = {}) {
  const listeners = { addListener() {} };
  const storage = { [SETTINGS.STORAGE_KEY]: settings };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    crypto: globalThis.crypto,
    // A timer of a second or less fires at once, so a poll that waits a
    // second does not make the test wait for it. A longer timer keeps its
    // delay but never holds the test process open.
    setTimeout: (fn, ms, ...args) => {
      const timer = setTimeout(fn, ms <= 1000 ? 0 : ms, ...args);
      if (ms > 1000) timer.unref?.();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: () => 0,
    clearInterval: () => {},
    importScripts() {},
    fetch: fetchImpl,
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async (key) => {
            if (key === null || key === undefined) return { ...storage };
            const requested = Array.isArray(key) ? key : [key];
            const result = {};
            for (const name of requested) {
              if (Object.hasOwn(storage, name)) result[name] = storage[name];
            }
            return result;
          },
          set: async () => {},
          remove: async () => {},
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
        close: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: { addListener() {} },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: async () => ({ success: true }),
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        create: async () => ({ id: 1, url: "" }),
        get: async () => null,
        sendMessage: async () => ({ success: true }),
      },
    },
    YTD_SETTINGS: SETTINGS,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox;
}

/**
 * A fetch that answers the three hosts the worker talks to: its own prompt
 * files, the transcript service and the AI provider. Every request is
 * recorded, so a test can look at the prompt the model really received.
 */
function backgroundFetch({
  chunks = [],
  asJob = false,
  modelAnswer = "{}",
  requests = [],
} = {}) {
  return async (url, init = {}) => {
    const target = String(url);
    requests.push({ url: target, init });

    if (target.startsWith("chrome-extension://")) {
      const file = target.replace("chrome-extension://test/", "");
      return { ok: true, status: 200, text: async () => read(file) };
    }
    if (target.includes("/v1/transcript/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "completed", content: chunks, lang: "en" }),
      };
    }
    if (target.startsWith("https://api.supadata.ai/v1/transcript")) {
      if (asJob) {
        return { ok: true, status: 202, json: async () => ({ jobId: "job-1" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: chunks, lang: "en" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: modelAnswer } }] }),
    };
  };
}

// One caption, ninety minutes into a video.
const LATE_CHUNK = {
  text: "the last thing the speaker says",
  offset: NINETY_MINUTES * 1000,
  duration: 2000,
  lang: "en",
};

const WORKER_SETTINGS = {
  provider: "deepseek",
  aiApiKey: "test-ai-key",
  supadataApiKey: "test-transcript-key",
};

test("the transcript the model reads carries the hours part", async () => {
  const runtime = loadBackgroundRuntime({
    settings: WORKER_SETTINGS,
    fetchImpl: backgroundFetch({ chunks: [LATE_CHUNK] }),
  });

  const result = await runtime.handleFetchTranscript("videoA");

  assert.equal(result.success, true);
  assert.equal(
    result.transcriptTextTimestamped,
    `[${HOUR_STAMP}] the last thing the speaker says`,
    "the marker the model reads is missing the hours part",
  );
});

test("a transcript that arrives as a job carries the same hours part", async () => {
  const runtime = loadBackgroundRuntime({
    settings: WORKER_SETTINGS,
    fetchImpl: backgroundFetch({ chunks: [LATE_CHUNK], asJob: true }),
  });

  const result = await runtime.handleFetchTranscript("videoA");

  assert.equal(result.success, true);
  assert.equal(
    result.transcriptTextTimestamped,
    `[${HOUR_STAMP}] the last thing the speaker says`,
    "the model would see a different transcript depending on which fetch ran",
  );
});

test("the length of a long video is read from its transcript", () => {
  const runtime = loadBackgroundRuntime();

  assert.equal(
    runtime.transcriptLengthSeconds("[0:00] the start\n[1:30:00] the end"),
    NINETY_MINUTES,
    "the hours part of the last marker was thrown away, so the video looks an hour short",
  );
});

test("a transcript cached by an older release is still read", () => {
  const runtime = loadBackgroundRuntime();

  // Before the fix the ninetieth minute was written "90:00". A transcript
  // cached by that release is still analyzed after an update.
  assert.equal(
    runtime.transcriptLengthSeconds("[0:00] the start\n[90:00] the end"),
    NINETY_MINUTES,
    "the old short form is no longer understood",
  );
});

test("the prompt the model receives describes the video in hours", async () => {
  const requests = [];
  const runtime = loadBackgroundRuntime({
    settings: WORKER_SETTINGS,
    fetchImpl: backgroundFetch({
      requests,
      modelAnswer: JSON.stringify({
        summary: "A long video about a long subject.",
        chapters: [
          {
            title: "The end",
            summary: "What happens at the end",
            timestampSeconds: NINETY_MINUTES,
          },
        ],
        keyQuotes: [{ quote: "A late quote", timestampSeconds: NINETY_MINUTES }],
      }),
    }),
  });

  // The length of the video is only known from the transcript. A worker
  // that cannot read the hours part of a marker believes the video ends
  // at zero, tells the model so, and throws every chapter away.
  const result = await runtime.handleAnalyzeTranscript(
    "[0:00] the start\n[1:30:00] the end",
    "A long video",
    "A channel",
    "A description",
    0,
  );

  assert.equal(result.success, true);

  const aiRequest = requests.find((request) =>
    request.url.includes("chat/completions"),
  );
  assert.ok(aiRequest, "the model was never asked");

  const messages = JSON.parse(aiRequest.init.body).messages;
  const userPrompt = messages.find((message) => message.role === "user").content;
  const systemPrompt = messages.find(
    (message) => message.role === "system",
  ).content;

  assert.match(
    userPrompt,
    new RegExp(`VIDEO DURATION: ${HOUR_STAMP} \\(${NINETY_MINUTES} seconds\\)`),
    "the model was told about a different length than the transcript shows",
  );
  assert.match(
    userPrompt,
    new RegExp(`\\[${HOUR_STAMP}\\] the end`),
    "the transcript the model reads lost its hours part",
  );
  assert.match(
    systemPrompt,
    /H:MM:SS/,
    "the prompt does not tell the model that a long video carries an hours part",
  );
  assert.match(
    systemPrompt,
    /1\*3600/,
    "the prompt does not tell the model how to turn an hours part into seconds",
  );

  // The chapters the panel is handed carry the same stamp.
  assert.equal(result.analysis.chapters[0].timestamp, HOUR_STAMP);
  assert.equal(result.analysis.keyQuotes[0].timestamp, HOUR_STAMP);
});

test("a note saved from a long video carries the hours part", async () => {
  const runtime = loadBackgroundRuntime({
    settings: WORKER_SETTINGS,
    fetchImpl: backgroundFetch({}),
  });

  const result = await runtime.handleSaveNote(
    "videoA",
    NINETY_MINUTES,
    "A long video",
    "A channel",
    "the text the reader picked",
    "",
  );

  assert.equal(result.success, true);
  assert.equal(
    result.note.timestamp,
    HOUR_STAMP,
    "the note the reader sees is stamped in a shape they cannot read",
  );
});

test("a note that comes back from the cloud carries the same stamp", () => {
  const runtime = loadBackgroundRuntime();

  const note = runtime.cloudToLocalNote({
    id: "cloud-1",
    clientId: "local-1",
    videoId: "videoA",
    videoTitle: "A long video",
    timestampSeconds: NINETY_MINUTES,
    note: "the text the reader picked",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  });

  assert.equal(
    note.timestamp,
    HOUR_STAMP,
    "the same note reads differently depending on where it was saved",
  );
});

// ============================================================
// The panel
// ============================================================

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
 * Boots the real panel against the real markup, in a real DOM.
 */
function createPanel({ sendMessageImpl, local = {}, session = {} } = {}) {
  const dom = new JSDOM(read("sidepanel.html"), {
    url: "chrome-extension://test/sidepanel.html",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;

  for (const script of [...window.document.querySelectorAll("script")]) {
    script.remove();
  }

  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session);
  const sentMessages = [];
  const sendMessage = async (message) => {
    sentMessages.push(message);
    if (sendMessageImpl) return sendMessageImpl(message);
    return { success: true };
  };

  const chromeStub = {
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
  };
  window.chrome = chromeStub;
  window.console = console;

  const context = vm.createContext({
    console,
    URL,
    TextDecoder,
    TextEncoder,
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
    chrome: chromeStub,
    YTD_SETTINGS: SETTINGS,
  });
  context.globalThis = context;
  context.window = window;
  vm.runInContext(read("sidepanel.js"), context, { filename: "sidepanel.js" });

  return {
    window,
    document: window.document,
    helpers: context.__YTD_PANEL_TESTING__,
    sentMessages,
    el: (id) => window.document.getElementById(id),
    all: (selector) => [...window.document.querySelectorAll(selector)],
  };
}

async function flush() {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const VIDEO_URL = "https://www.youtube.com/watch?v=videoA";

/**
 * The panel's worker, answering with a video that is ninety minutes long.
 *
 * The stored stamp is the old one, "90:00". A panel that shows the stored
 * string shows a stamp nobody can read; a panel that shows the seconds
 * shows the truth.
 */
function workerRouter(overrides = {}) {
  return async (message) => {
    const override = overrides[message.action];
    if (typeof override === "function") return override(message);
    if (override !== undefined) return override;
    switch (message.action) {
      case "checkConfig":
        return { hasSupadataKey: true, hasAiKey: true };
      case "fetchTranscript":
        return {
          success: true,
          transcript: [
            {
              text: "the last thing the speaker says",
              start: NINETY_MINUTES,
              duration: 2,
              language: "en",
            },
          ],
          transcriptText: "the last thing the speaker says",
          transcriptTextTimestamped: `[${HOUR_STAMP}] the last thing the speaker says`,
          language: "en",
        };
      case "getNotes":
        return {
          success: true,
          notes: [
            {
              id: "note-1",
              text: "the text the reader picked",
              videoId: "videoA",
              videoTitle: "A long video",
              timestamp: "90:00",
              timestampSeconds: NINETY_MINUTES,
              timestampedUrl: `${VIDEO_URL}&t=${NINETY_MINUTES}s`,
            },
          ],
        };
      case "syncNotes":
        return { success: true };
      case "getGithubSession":
        return { success: false };
      case "getVocabulary":
        return { success: true, items: [] };
      case "getDueReviews":
        return { success: true, reviews: [] };
      case "relayToContent":
        return { success: true, response: { currentTime: NINETY_MINUTES } };
      default:
        return { success: true };
    }
  };
}

test("the panel shows a chapter of a long video in hours", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await flush();

  panel.helpers.renderAnalysisResults({
    summary: "A long video about a long subject.",
    chapters: [
      {
        title: "The end",
        summary: "What happens at the end",
        timestamp: "90:00",
        timestampSeconds: NINETY_MINUTES,
      },
    ],
    keyQuotes: [
      {
        quote: "A late quote",
        timestamp: "90:00",
        timestampSeconds: NINETY_MINUTES,
      },
    ],
  });

  const chapter = panel.all(".chapter-timestamp")[0];
  assert.ok(chapter, "the chapter has no stamp on it");
  assert.equal(
    chapter.textContent.trim(),
    HOUR_STAMP,
    "the chapter the reader clicks reads like ninety seconds",
  );

  const quote = panel.all(".quote-timestamp")[0];
  assert.ok(quote, "the quote has no stamp on it");
  assert.equal(
    quote.textContent.trim(),
    HOUR_STAMP,
    "the quote the reader clicks reads like ninety seconds",
  );
});

test("the panel shows a note of a long video in hours", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await flush();
  await panel.helpers.loadNotes(null);
  await flush();

  const note = panel.all(".note-timestamp")[0];
  assert.ok(note, "the note has no stamp on it");
  assert.equal(
    note.textContent.trim(),
    HOUR_STAMP,
    "the note the reader clicks reads like ninety seconds",
  );
});

test("the panel shows a transcript row of a long video in hours", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await flush();

  const row = panel.all(".transcript-time")[0];
  assert.ok(row, "the transcript row has no stamp on it");
  assert.equal(
    row.textContent.trim(),
    HOUR_STAMP,
    "the transcript row reads like ninety seconds",
  );
});

// ============================================================
// Every path writes the same stamp
// ============================================================

test("every path that writes a stamp writes the same one", async () => {
  const requests = [];
  const runtime = loadBackgroundRuntime({
    settings: WORKER_SETTINGS,
    fetchImpl: backgroundFetch({
      requests,
      chunks: [LATE_CHUNK],
      modelAnswer: JSON.stringify({
        summary: "A long video about a long subject.",
        chapters: [
          {
            title: "The end",
            summary: "What happens at the end",
            timestampSeconds: NINETY_MINUTES,
          },
        ],
        keyQuotes: [{ quote: "A late quote", timestampSeconds: NINETY_MINUTES }],
      }),
    }),
  });

  const analysis = await runtime.handleAnalyzeTranscript(
    "[0:00] the start\n[1:30:00] the end",
    "A long video",
    "A channel",
    "A description",
    0,
  );
  const transcript = await runtime.handleFetchTranscript("videoA");
  const note = await runtime.handleSaveNote(
    "videoA",
    NINETY_MINUTES,
    "A long video",
    "A channel",
    "the text the reader picked",
    "",
  );
  const cloudNote = runtime.cloudToLocalNote({
    id: "cloud-1",
    clientId: "local-1",
    videoId: "videoA",
    videoTitle: "A long video",
    timestampSeconds: NINETY_MINUTES,
    note: "the text the reader picked",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  });

  const aiRequest = requests.find((request) =>
    request.url.includes("chat/completions"),
  );
  const messages = JSON.parse(aiRequest.init.body).messages;
  const userPrompt = messages.find((message) => message.role === "user").content;

  const stamps = {
    "the chapter the panel shows": analysis.analysis.chapters[0].timestamp,
    "the quote the panel shows": analysis.analysis.keyQuotes[0].timestamp,
    "the marker the model reads": transcript.transcriptTextTimestamped,
    "the duration the model is told": userPrompt.match(
      /VIDEO DURATION: (\S+)/,
    )[1],
    "the note the worker writes": note.note.timestamp,
    "the note the cloud returns": cloudNote.timestamp,
  };

  for (const [where, stamp] of Object.entries(stamps)) {
    assert.equal(
      stamp.includes(HOUR_STAMP),
      true,
      `${where} reads "${stamp}" instead of "${HOUR_STAMP}"`,
    );
  }
});
