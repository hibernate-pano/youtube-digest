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
  timedtextResponder = null,
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
        // A page can answer one caption URL and not another. The responder
        // says what this particular URL gets.
        if (timedtextResponder) {
          const answer = timedtextResponder(href);
          if (answer) {
            return {
              ok: answer.status === 200,
              status: answer.status,
              json: async () => answer.payload || {},
            };
          }
        }
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
        executeScript: async ({ target, world, func, args }) => {
          scriptedCalls.push({ target, world });
          // The page's own world: the worker asks the page what captions it
          // has, and the page answers.
          const result = func(...(args || []));
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
 *
 * A real page also remembers the caption requests it made. The URL of such
 * a request carries the token YouTube checks, and the template URL in the
 * track list does not, so this fake page can be told which requests the
 * player already made.
 *
 * @param {Object} sandbox the worker's sandbox
 * @param {Array|null} captionTracks the tracks in the player response
 * @param {string} videoId the video the page is showing
 * @param {Object} options
 * @param {string[]} options.usedCaptionUrls the caption URLs the page used
 * @param {string|null} options.playerLoadsTrack the URL the player requests
 *   when it is asked to load a track
 * @returns {{setOptionCalls: Array<Object>}} what the player was asked
 */
function installFakePage(
  sandbox,
  captionTracks,
  videoId = "dQw4w9WgXcQ",
  options = {},
) {
  const used = [...(options.usedCaptionUrls || [])];
  const setOptionCalls = [];

  const page = {
    getPlayerResponse: () => ({
      videoDetails: { videoId },
      captions: captionTracks
        ? {
            playerCaptionsTracklistRenderer: {
              captionTracks: captionTracks.map((track) => ({
                baseUrl: track.baseUrl,
                languageCode: track.languageCode,
                kind: track.kind,
              })),
            },
          }
        : undefined,
    }),
  };

  if (options.withPlayer) {
    page.setOption = (group, name, value) => {
      setOptionCalls.push({ group, name, value });
      if (
        group === "captions" &&
        (name === "track" || name === "load") &&
        options.playerLoadsTrack
      ) {
        used.push(options.playerLoadsTrack);
      }
    };
  }

  sandbox.document = {
    getElementById: (id) => (id === "movie_player" ? page : null),
    querySelectorAll: () => [],
  };
  sandbox.window = {};
  sandbox.performance = {
    getEntriesByType: (type) =>
      type === "resource" ? used.map((name) => ({ name })) : [],
  };

  return { setOptionCalls };
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

test("the captions of a different video are not used", async () => {
  const worker = loadWorker();
  // The user navigated while the request was on the wire. The tab is now
  // showing another video.
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=other",
        languageCode: "en",
      },
    ],
    "aaaaaaaaaaa",
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst(
    "dQw4w9WgXcQ",
    7,
  );

  assert.notEqual(
    result.source,
    "local",
    "another video's captions were handed over as this video's transcript",
  );
  assert.equal(
    worker.requests.filter((request) => request.url.includes("timedtext")).length,
    0,
    "the other video's captions were fetched at all",
  );
});

test("a page that does not say which video it is showing is not trusted", async () => {
  const worker = loadWorker();
  // The page is playing something, but it does not say what. The video id
  // is empty, so it cannot be checked against the one that was asked for.
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=abc",
        languageCode: "en",
      },
    ],
    "",
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("", 7);

  assert.notEqual(
    result.source,
    "local",
    "captions of an unidentified page were used",
  );
  assert.equal(
    worker.requests.filter((request) => request.url.includes("timedtext")).length,
    0,
    "the unidentified page's captions were fetched at all",
  );
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

test("without a key and without captions, the worker names the failure and stops", async () => {
  const worker = loadWorker({ hasSupadataKey: false });
  installFakePage(worker.sandbox, null);

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    "NO_SUPADATA_KEY",
    "the failure is reported as something the panel cannot act on",
  );
  assert.equal(
    result.message,
    undefined,
    "the worker wrote a sentence the panel cannot translate",
  );
});

test("a lookup that fails outright is reported with a code, not a sentence", async () => {
  const worker = loadWorker({
    supadata: Promise.reject(new Error("The network is down")),
  });

  const result = await worker.helpers.handleFetchTranscript("dQw4w9WgXcQ");

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    "TRANSCRIPT_FAILED",
    "the failure is reported as something the panel cannot act on",
  );
  assert.equal(
    result.message,
    undefined,
    "the worker wrote a sentence the panel cannot translate",
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

/* ============================================================
   C: the URL the page's player actually used

   The URL in the track list is a template. The player does not use it as
   it is: it signs the request with a token and its own client identity,
   and YouTube answers a template request with an empty body. So the
   caption URL that the page already used is the one that carries the
   subtitles.
   ============================================================ */

const USED_URL =
  "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=de-DE&pot=TOKEN&fmt=json3&c=WEB";

test("the caption URL the page already used is the one that is fetched", async () => {
  const worker = loadWorker();
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
      },
    ],
    "dQw4w9WgXcQ",
    { usedCaptionUrls: [USED_URL] },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the local path did not work");
  assert.equal(result.source, "local");
  const timedtext = worker.requests.filter((request) =>
    request.url.includes("timedtext"),
  );
  assert.equal(timedtext.length, 1, "the captions were not fetched once");
  assert.match(
    timedtext[0].url,
    /pot=TOKEN/,
    "the template URL was fetched instead of the one the page used",
  );
});

test("the page's URL is pointed at the track the product reads", async () => {
  const worker = loadWorker();
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
      },
    ],
    "dQw4w9WgXcQ",
    { usedCaptionUrls: [USED_URL] },
  );

  await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.match(
    timedtext.url,
    /lang=en/,
    "the German track the player loaded was read instead of the English one",
  );
  assert.match(
    timedtext.url,
    /pot=TOKEN/,
    "pointing the URL at another track threw the token away",
  );
});

test("a translated variant is not asked for by name", async () => {
  const worker = loadWorker();
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
      },
    ],
    "dQw4w9WgXcQ",
    {
      usedCaptionUrls: [
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&variant=asr&pot=TOKEN",
      ],
    },
  );

  await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.doesNotMatch(
    timedtext.url,
    /variant/,
    "the translated variant was asked for by name, which answers with nothing",
  );
});

test("a caption request without a token is not used", async () => {
  const worker = loadWorker({
    timedtextResponder: (url) =>
      url.includes("c=WEB")
        ? { status: 403, payload: {} }
        : { status: 200, payload: timedtextPayload(["A caption"]) },
  });
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
      },
    ],
    "dQw4w9WgXcQ",
    {
      // A request the page made without the proof-of-origin token. It is not
      // signed, so it cannot carry the captions.
      usedCaptionUrls: [
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=de-DE&c=WEB",
      ],
    },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the local path did not work");
  const timedtext = worker.requests.filter((request) =>
    request.url.includes("timedtext"),
  );
  assert.ok(
    timedtext.every((request) => !request.url.includes("c=WEB")),
    "an unsigned caption request the page made was sent",
  );
});

test("the page is asked to load the track when it has not used one yet", async () => {
  const worker = loadWorker();
  const { setOptionCalls } = installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
        kind: "asr",
      },
    ],
    "dQw4w9WgXcQ",
    {
      withPlayer: true,
      playerLoadsTrack:
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr&pot=TOKEN2",
    },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the local path did not work");
  const trackCall = setOptionCalls.find(
    (call) => call.group === "captions" && call.name === "track",
  );
  assert.ok(trackCall, "the page was never asked to load the track");
  assert.equal(trackCall.value.languageCode, "en");
  assert.equal(trackCall.value.kind, "asr");
  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.match(
    timedtext.url,
    /pot=TOKEN2/,
    "the URL the player made was not the one that was fetched",
  );
});

test("a caption request for another video is not used", async () => {
  const worker = loadWorker();
  const { setOptionCalls } = installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
      },
    ],
    "dQw4w9WgXcQ",
    {
      withPlayer: true,
      usedCaptionUrls: [
        "https://www.youtube.com/api/timedtext?v=otherVideo&lang=en&pot=TOKEN",
      ],
    },
  );

  await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.doesNotMatch(
    timedtext.url,
    /otherVideo/,
    "the captions of another video were fetched",
  );
  assert.ok(
    setOptionCalls.some(
      (call) => call.group === "captions" && call.name === "track",
    ),
    "the page was not asked to load the track",
  );
});

test("when the page's URL answers with nothing, the template URL is tried", async () => {
  const worker = loadWorker({
    timedtextResponder: (url) =>
      url.includes("pot=TOKEN")
        ? { status: 403, payload: {} }
        : { status: 200, payload: timedtextPayload(["A caption"]) },
  });
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
      },
    ],
    "dQw4w9WgXcQ",
    { usedCaptionUrls: [USED_URL] },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the fallback URL was not tried");
  assert.equal(result.transcript[0].text, "A caption");
  const timedtext = worker.requests.filter((request) =>
    request.url.includes("timedtext"),
  );
  assert.equal(timedtext.length, 3, "the template URL was not tried as well");
  assert.ok(
    timedtext.some((request) => !request.url.includes("pot=TOKEN")),
    "the template URL was never tried",
  );
});

test("the paid path takes over when the page has no caption URL at all", async () => {
  const worker = loadWorker({ timedtextStatus: 403 });
  installFakePage(
    worker.sandbox,
    [
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
      },
    ],
    "dQw4w9WgXcQ",
    {
      withPlayer: true,
      playerLoadsTrack:
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=TOKEN3",
    },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the paid path did not take over");
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    1,
    "the paid path was not used",
  );
});
