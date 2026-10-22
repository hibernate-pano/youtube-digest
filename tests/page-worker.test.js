const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const SETTINGS = require("../settings.js");

/* ============================================================
   THE WORKER SEES THE PAGE, NOT THE PAGE'S GUESS.

   A content script lives in an isolated world: it cannot read the
   player's own objects, and the page's own text is not a reliable
   answer. YouTube swaps the page under the reader, so the title on the
   screen can belong to the video that is leaving while the address bar
   already names the next one.

   These tests drive the real worker with a real page behind it, and
   check what the user ends up with.
   ============================================================ */

/**
 * A caption payload in the shape YouTube's player returns.
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
 * Loads the real service worker with a fake YouTube page behind it.
 *
 * @param {Object} options
 * @param {boolean} options.hasSupadataKey whether a transcript key is set
 * @param {boolean} options.hasAiKey whether a model key is set
 * @param {Array} options.tabs the tabs the worker can see
 * @param {Object} options.page the page the worker reads
 * @returns {Object} the worker and the pieces a test needs
 */
function loadWorker({
  hasSupadataKey = false,
  hasAiKey = false,
  tabs = [],
  page = {},
  timedtext = timedtextPayload(["a caption", "the line the user heard"]),
} = {}) {
  const listeners = { addListener() {} };
  const messageListeners = [];
  const requests = [];
  const sentToTabs = [];
  const stored = {
    [SETTINGS.STORAGE_KEY]: {
      provider: "deepseek",
      ...(hasAiKey ? { aiApiKey: "test-ai-key" } : {}),
      ...(hasSupadataKey ? { supadataApiKey: "test-transcript-key" } : {}),
    },
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
    fetch: async (url) => {
      const href = String(url);
      requests.push({ url: href });
      if (href.includes("timedtext")) {
        return { ok: true, status: 200, json: async () => timedtext };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async (key) => {
            if (key === null || key === undefined) return { ...stored };
            const requested = Array.isArray(key) ? key : [key];
            const result = {};
            for (const name of requested) {
              if (Object.hasOwn(stored, name)) result[name] = stored[name];
            }
            return result;
          },
          set: async (values) => Object.assign(stored, values),
          remove: async (name) => {
            delete stored[name];
          },
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
        setOptions: async () => {},
        close: async () => {},
      },
      scripting: {
        executeScript: async ({ target, world, func, args }) => {
          // The page's own world: the worker asks the page what it is
          // showing, and the page answers.
          return [{ result: func(...(args || [])) }];
        },
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            messageListeners.push(listener);
          },
        },
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: async () => ({ success: true }),
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        create: async () => ({ id: 1, url: "" }),
        query: async (query) => {
          if (query && query.url) {
            return tabs.filter((tab) => String(tab.url || "").includes("youtube.com"));
          }
          if (query && query.active) {
            return tabs.filter((tab) => tab.active);
          }
          return tabs;
        },
        sendMessage: async (tabId, message) => {
          sentToTabs.push({ tabId, message });
          return { success: true, response: { from: tabId } };
        },
      },
    },
    YTD_SETTINGS: SETTINGS,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);

  installFakePage(sandbox, page);

  return {
    sandbox,
    requests,
    sentToTabs,
    stored,
    helpers: sandbox.__YTD_TRANSLATION_TESTING__,
    /** Asks the worker a question, the way the page or the panel does. */
    ask(message, sender = {}) {
      return new Promise((resolve) => {
        messageListeners.forEach((listener) => {
          listener(message, sender, resolve);
        });
      });
    },
  };
}

/**
 * Puts a YouTube page behind the worker.
 *
 * @param {Object} sandbox the worker's sandbox
 * @param {Object} page
 * @param {string} page.videoId the video the player is showing
 * @param {string} page.title the video's title
 * @param {string} page.author the video's channel
 * @param {string} page.description the video's description
 * @param {number} page.currentTime where the player is
 * @param {Array|null} page.captionTracks the tracks the player offers
 * @param {string|null} page.inlineResponse the player response the page
 *   carries inline, as JSON
 * @param {boolean} page.hasPlayer whether the player object exists
 * @param {Array} page.usedCaptionUrls the caption requests the page made
 * @returns {void}
 */
function installFakePage(
  sandbox,
  {
    videoId = "dQw4w9WgXcQ",
    title = "The video the player is showing",
    author = "The channel of the video",
    description = "The description of the video",
    currentTime = 42,
    captionTracks = null,
    inlineResponse = null,
    hasPlayer = true,
    usedCaptionUrls = [],
  } = {},
) {
  const player = {
    getPlayerResponse: () => ({
      videoDetails: {
        videoId,
        title,
        author,
        shortDescription: description,
        lengthSeconds: "212",
      },
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
    getCurrentTime: () => currentTime,
    getPlayerState: () => 1,
    getVideoData: () => ({ video_id: videoId }),
  };

  const scripts = [];
  if (inlineResponse) {
    scripts.push({
      textContent: `var ytInitialPlayerResponse = ${inlineResponse};`,
    });
  }

  sandbox.document = {
    getElementById: (id) => (id === "movie_player" && hasPlayer ? player : null),
    querySelectorAll: (selector) => (selector === "script" ? scripts : []),
  };
  sandbox.window = {};
  sandbox.performance = {
    getEntriesByType: (type) =>
      type === "resource" ? usedCaptionUrls.map((name) => ({ name })) : [],
  };
}

const CAPTION_URL =
  "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=TOKEN";

/* ============================================================
   A NOTE BELONGS TO ONE VIDEO
   ============================================================ */

test("the note belongs to the video the player is showing", async () => {
  const worker = loadWorker({
    page: {
      videoId: "videoB12345",
      title: "The title the player knows",
      author: "The channel the player knows",
    },
  });

  // The page is still showing the video that is leaving: its address
  // bar and its title are a moment behind the player.
  const answer = await worker.ask(
    {
      action: "saveNote",
      videoId: "videoA12345",
      timestamp: 39,
      videoTitle: "The title on the screen",
      channelName: "The channel on the screen",
      selectedText: "the words the user picked",
    },
    { tab: { id: 7 } },
  );

  assert.equal(
    answer.success,
    true,
    `the note was not saved: ${JSON.stringify(answer)}`,
  );
  assert.equal(
    answer.note.videoId,
    "videoB12345",
    "the note was filed under the video the address bar named",
  );
  assert.equal(
    answer.note.videoTitle,
    "The title the player knows",
    "the note carries the title that was on the screen",
  );
  assert.equal(
    answer.note.channelName,
    "The channel the player knows",
    "the note carries the channel that was on the screen",
  );
});

test("the note falls back to the page when the player cannot be read", async () => {
  const worker = loadWorker({ page: { hasPlayer: false } });

  const answer = await worker.ask(
    {
      action: "saveNote",
      videoId: "videoA12345",
      timestamp: 39,
      videoTitle: "The title on the screen",
      channelName: "The channel on the screen",
      selectedText: "the words the user picked",
    },
    { tab: { id: 7 } },
  );

  assert.equal(answer.success, true, "the note was not saved");
  assert.equal(
    answer.note.videoId,
    "videoA12345",
    "the page's own answer was thrown away even though there was no player to read",
  );
});

/* ============================================================
   A NOTE DOES NOT SPEND A CREDIT
   ============================================================ */

test("a note saved from the page does not spend a Supadata credit", async () => {
  const worker = loadWorker({
    hasSupadataKey: false,
    page: {
      captionTracks: [
        { baseUrl: CAPTION_URL, languageCode: "en", kind: "asr" },
      ],
      usedCaptionUrls: [CAPTION_URL],
    },
  });

  const answer = await worker.ask(
    {
      action: "saveNote",
      videoId: "dQw4w9WgXcQ",
      timestamp: 1,
      videoTitle: "A video",
      channelName: "A channel",
    },
    { tab: { id: 7 } },
  );

  assert.equal(
    answer.success,
    true,
    "the note was not saved, because the subtitles had to be paid for",
  );
  assert.match(
    answer.note.text,
    /the line the user heard/,
    "the note does not carry what was said at that moment",
  );
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    0,
    "a credit was spent on subtitles the page was already showing",
  );
});

test("the subtitles the page gives are the ones the note is made of", async () => {
  const worker = loadWorker({
    hasSupadataKey: false,
    page: {
      captionTracks: [
        { baseUrl: CAPTION_URL, languageCode: "en", kind: "asr" },
      ],
      usedCaptionUrls: [CAPTION_URL],
    },
  });

  const result = await worker.helpers.handleFetchTranscriptLocalFirst(
    "dQw4w9WgXcQ",
    7,
  );

  assert.equal(result.success, true, "the page's subtitles were not read");
  assert.equal(result.source, "local");
});

/* ============================================================
   THE RELAY ANSWERS THE TAB THE USER IS LOOKING AT
   ============================================================ */

test("the relay does not answer from a YouTube tab in the background", async () => {
  const worker = loadWorker({
    tabs: [
      { id: 1, url: "https://example.com/", active: true },
      { id: 2, url: "https://www.youtube.com/watch?v=other", active: false },
    ],
  });

  const answer = await worker.ask({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
  });

  assert.notEqual(
    answer.success,
    true,
    "the relay answered from a tab the user is not looking at",
  );
  assert.deepEqual(
    worker.sentToTabs,
    [],
    "the relay was sent to a tab in the background",
  );
});

test("the relay answers the tab the panel names", async () => {
  const worker = loadWorker({
    tabs: [
      { id: 1, url: "https://example.com/", active: true },
      { id: 2, url: "https://www.youtube.com/watch?v=theVideo", active: false },
    ],
  });

  const answer = await worker.ask({
    action: "relayToContent",
    tabId: 2,
    payload: { action: "getCurrentTime" },
  });

  assert.equal(answer.success, true, "the relay did not answer at all");
  assert.equal(worker.sentToTabs.length, 1, "the relay went to the wrong tab");
  assert.equal(worker.sentToTabs[0].tabId, 2);
});

test("the relay answers the YouTube tab in front of the user", async () => {
  const worker = loadWorker({
    tabs: [
      { id: 1, url: "https://www.youtube.com/watch?v=theVideo", active: true },
    ],
  });

  const answer = await worker.ask({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
  });

  assert.equal(answer.success, true, "the relay did not answer at all");
  assert.equal(worker.sentToTabs.length, 1);
  assert.equal(worker.sentToTabs[0].tabId, 1);
});

/* ============================================================
   THE PAGE'S OWN PLAYER RESPONSE IS READ
   ============================================================ */

test("the player response the page carries inline is read", async () => {
  // The JSON holds a semicolon inside a string, which is where a
  // response cut at the first semicolon comes apart.
  const inline = JSON.stringify({
    videoDetails: { videoId: "dQw4w9WgXcQ", title: "A video" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: CAPTION_URL, languageCode: "en", kind: "asr" },
        ],
      },
    },
    storyboards: { playerStoryboardSpecRenderer: { spec: "a;b;c" } },
  });
  assert.ok(inline.includes(";"), "the fixture has to hold a semicolon");

  const worker = loadWorker({
    page: { hasPlayer: false, inlineResponse: inline },
  });

  const tracks = await worker.helpers.readCaptionTracksFromTab(
    7,
    "dQw4w9WgXcQ",
  );

  assert.equal(tracks.state, "tracks", "the page's own response was not read");
  assert.equal(tracks.videoId, "dQw4w9WgXcQ");
  assert.equal(tracks.tracks.length, 1);
});

test("the response of another video is not used for this one", async () => {
  const inline = JSON.stringify({
    videoDetails: { videoId: "anotherVideo", title: "Another video" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: CAPTION_URL, languageCode: "en", kind: "asr" },
        ],
      },
    },
  });

  const worker = loadWorker({
    page: { hasPlayer: false, inlineResponse: inline },
  });

  const tracks = await worker.helpers.readCaptionTracksFromTab(
    7,
    "dQw4w9WgXcQ",
  );

  assert.notEqual(
    tracks.state,
    "tracks",
    "another video's subtitles were handed over as this video's",
  );
});

/* ============================================================
   EVERY PATH WRITES THE SAME STAMP
   ============================================================ */

test("the subtitles read out of the page carry the hours part too", () => {
  const worker = loadWorker();

  const result = worker.helpers.buildTranscriptResult(
    [
      {
        text: "the last thing the speaker says",
        offset: 5400 * 1000,
        duration: 2000,
        lang: "en",
      },
    ],
    "en",
  );

  assert.equal(
    result.transcriptTextTimestamped,
    "[1:30:00] the last thing the speaker says",
    "the marker the model reads is missing the hours part",
  );
});
