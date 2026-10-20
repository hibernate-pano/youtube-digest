const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* ============================================================
   THE SUBTITLES COME OUT OF THE PAGE FIRST.

   A Supadata credit is a credit the user pays for. Reading the captions
   out of the YouTube tab costs nothing and needs no key, so it is tried
   first and the paid service is the fallback.

   These tests drive the real worker: the same background.js the browser
   runs, with a page that has (or does not have) caption tracks.
   ============================================================ */

/**
 * A YouTube timedtext payload in the shape the player actually returns.
 */
function timedtextPayload(lines) {
  return {
    events: lines.map((line, index) => ({
      tStartMs: index * 1000,
      dDurationMs: 900,
      segs: [{ utf8: line }],
    })),
  };
}

/**
 * Loads the real service worker with a fake YouTube tab.
 *
 * The tab is faked through chrome.scripting, the same way the browser
 * would run the page's own code in the MAIN world.
 */
function loadWorker({
  timedtext = timedtextPayload(["A caption", "Another caption"]),
  timedtextStatus = 200,
  supadata = null,
  hasSupadataKey = true,
} = {}) {
  const listeners = { addListener() {} };
  const requests = [];
  const scriptedCalls = [];
  const stored = {
    ytd_settings: hasSupadataKey
      ? { provider: "deepseek", aiApiKey: "test-ai", supadataApiKey: "test-supadata" }
      : { provider: "deepseek", aiApiKey: "test-ai" },
  };

  const sandbox = {
    console,
    URL,
    Date,
    TextDecoder,
    TextEncoder,
    AbortController,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    importScripts() {},
    fetch: async (url, options) => {
      const href = String(url);
      requests.push({ url: href, options });

      if (href.includes("timedtext")) {
        if (timedtextStatus !== 200) {
          return { ok: false, status: timedtextStatus, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => timedtext };
      }
      if (href.includes("api.supadata.ai")) {
        if (supadata) return supadata;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ text: "A caption", offset: 0, duration: 900, lang: "en" }],
            lang: "en",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) =>
            key && Object.hasOwn(stored, key) ? { [key]: stored[key] } : {},
          set: async (values) => Object.assign(stored, values),
          remove: async () => {},
        },
        session: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
      scripting: {
        executeScript: async ({ target, world, func }) => {
          scriptedCalls.push({ target, world });
          // The page's own world: the worker asks the page what captions it
          // has, and the page answers.
          const result = func();
          return [{ result }];
        },
      },
      runtime: {
        onInstalled: listeners,
        onMessage: { addListener() {} },
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        create: async () => ({ id: 1 }),
      },
    },
    YTD_SETTINGS: {
      ...require("../settings.js"),
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("settings.js"), sandbox);
  sandbox.YTD_SETTINGS.SERVER_BASE_URL = "https://sync.test";
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);

  return {
    helpers: sandbox.__YTD_TRANSLATION_TESTING__,
    requests,
    scriptedCalls,
    sandbox,
    hasSupadataKey,
  };
}

/**
 * A fake document for the MAIN-world function to read.
 *
 * The function the worker injects looks for the player response in three
 * places. The test plants it in the first one, which is the live player.
 */
function installFakePage(sandbox, captionTracks) {
  const page = {
    getPlayerResponse: () => ({
      captions: captionTracks
        ? {
            playerCaptionsTracklistRenderer: {
              captionTracks: captionTracks.map((track) => ({
                baseUrl: track.baseUrl,
                languageCode: track.languageCode,
              })),
            },
          }
        : undefined,
    }),
  };
  sandbox.document = {
    getElementById: (id) => (id === "movie_player" ? page : null),
    querySelectorAll: () => [],
  };
  sandbox.window = {};
}

/* ============================================================
   A: the local path
   ============================================================ */

test("the subtitles are read out of the page without a Supadata credit", async () => {
  const worker = loadWorker();
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" },
  ]);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the local path did not work");
  assert.equal(result.source, "local");
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    0,
    "a credit was spent even though the page had the captions",
  );
  assert.equal(
    worker.requests.filter((request) => request.url.includes("timedtext")).length,
    1,
    "the captions were not fetched from the page",
  );
});

test("the local path produces the same shape as the paid one", async () => {
  const worker = loadWorker();
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" },
  ]);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.ok(Array.isArray(result.transcript));
  assert.equal(result.transcript.length, 2);
  assert.equal(result.transcript[0].text, "A caption");
  assert.equal(result.transcript[0].start, 0);
  assert.equal(result.transcript[1].text, "Another caption");
  assert.equal(result.transcript[1].start, 1);
  assert.match(result.transcriptTextTimestamped, /^\[0:00\] A caption$/m);
  assert.ok(result.transcriptText.length > 0);
});

test("the English track is preferred over the others", async () => {
  const worker = loadWorker();
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh", languageCode: "zh" },
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en", languageCode: "en" },
  ]);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true);
  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.match(timedtext.url, /lang=en/, "the Chinese track was used");
});

test("a track in any language is better than no track at all", async () => {
  const worker = loadWorker();
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=pt", languageCode: "pt" },
  ]);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "a non-English track was thrown away");
  assert.equal(result.source, "local", "the Portuguese track was not used");
  assert.equal(result.language, "pt");
  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.match(timedtext.url, /lang=pt/, "the Portuguese track was not fetched");
});

test("the speaker marker is not part of the caption", async () => {
  const worker = loadWorker({
    timedtext: timedtextPayload([">> A caption"]),
  });
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" },
  ]);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.transcript[0].text, "A caption");
});

/* ============================================================
   B: the fallback
   ============================================================ */

test("the paid path takes over when the page has no captions", async () => {
  const worker = loadWorker({
    supadata: {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: "A caption", offset: 0, duration: 900, lang: "en" }],
        lang: "en",
      }),
    },
  });
  installFakePage(worker.sandbox, null);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true);
  assert.equal(result.source, "supadata");
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    1,
    "the fallback did not run",
  );
});

test("the paid path takes over when the page has no tab", async () => {
  const worker = loadWorker({
    supadata: {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: "A caption", offset: 0, duration: 900, lang: "en" }],
        lang: "en",
      }),
    },
  });
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" },
  ]);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", null);

  assert.equal(result.success, true);
  assert.equal(result.source, "supadata");
});

test("the paid path takes over when the page's captions cannot be fetched", async () => {
  const worker = loadWorker({
    timedtextStatus: 403,
    supadata: {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: "A caption", offset: 0, duration: 900, lang: "en" }],
        lang: "en",
      }),
    },
  });
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" },
  ]);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true);
  assert.equal(result.source, "supadata");
});

test("without a key and without captions, the product says both things", async () => {
  const worker = loadWorker({ hasSupadataKey: false });
  installFakePage(worker.sandbox, null);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, false);
  assert.equal(result.error, "NO_TRANSCRIPT");
  assert.match(
    result.message,
    /no subtitles/i,
    "the panel is not told that the video has no subtitles",
  );
  assert.match(
    result.message,
    /Supadata/i,
    "the panel is not told that the fallback needs a key",
  );
});

/* ============================================================
   C: the panel and the settings page
   ============================================================ */

test("the panel tells the worker which tab to read", () => {
  const source = read("sidepanel.js");
  assert.match(
    source,
    /action:\s*"fetchTranscript"[\s\S]{0,200}?tabId:\s*youtubeTabId/,
    "the panel does not tell the worker which tab the video is on",
  );
});

test("the panel does not stop at a missing Supadata key", () => {
  const source = read("sidepanel.js");
  // The AI key is what the summary and the translation need. The Supadata
  // key is only the fallback, so it must not be a dead end on its own.
  assert.doesNotMatch(
    source,
    /if\s*\(\s*!configStatus\?\.hasSupadataKey\s*\)\s*\{\s*showConfigError/,
    "a missing Supadata key still blocks the whole panel",
  );
  // Both keys missing is still a dead end. The check has to keep that case.
  assert.match(
    source,
    /if\s*\(\s*!configStatus\?\.hasSupadataKey\s*&&\s*!configStatus\?\.hasAiKey\s*\)/,
    "the panel no longer stops when both keys are missing",
  );
});

test("the settings page saves without a Supadata key", () => {
  const source = read("options.js");
  assert.doesNotMatch(
    source,
    /if\s*\(\s*!settings\.supadataApiKey\s*\)\s*\{[^}]*addSupadataKey/,
    "the settings page still refuses to save without a Supadata key",
  );
});

test("the settings page says the Supadata key is optional", () => {
  const source = read("options.js");
  assert.match(
    source,
    /supadataHelp:[\s\S]{0,200}?Optional\./,
    "the settings page does not say the key is optional",
  );
  assert.match(
    read("options.html"),
    /data-i18n="supadataHelp"[\s\S]{0,200}?Optional\./,
    "the static page does not say the key is optional",
  );
});
