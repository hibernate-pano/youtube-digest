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
  localRetryDelays = null,
  captionRequestTimeout = null,
  captionStartTimeout = null,
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
  // The settings file assigns its own object when it runs, so an override
  // put into the sandbox before it is loaded is thrown away. A test that
  // asked for a quick timeout and quietly got the production one was
  // testing the wrong thing, and slowly.
  if (localRetryDelays) {
    sandbox.YTD_SETTINGS.LOCAL_CAPTION_RETRY_DELAYS_MS = localRetryDelays;
  }
  if (captionRequestTimeout !== null) {
    sandbox.YTD_SETTINGS.LOCAL_CAPTION_REQUEST_TIMEOUT_MS = captionRequestTimeout;
  }
  if (captionStartTimeout !== null) {
    sandbox.YTD_SETTINGS.LOCAL_CAPTION_START_TIMEOUT_MS = captionStartTimeout;
  }
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
 * @param {string[]} options.videoIds the videos the page shows, one per
 *   read. A page that swaps its video while the worker is reading it is
 *   what happens when the user clicks another video in YouTube.
 * @param {number} options.playerLoadsTrackAfterMs how long the page takes
 *   to finish the caption request it was asked for. YouTube makes the
 *   automatic captions when they are first asked for, and the page only
 *   lists the request once it has come back.
 * @param {number} options.playerStartsAfterMs how long the video takes to
 *   start playing. YouTube asks the page for the captions when the video
 *   plays, so a page that has not started yet has nothing to read.
 * @param {boolean} options.playerLoadsTrackOnlyWhenPlaying the page asks
 *   for the captions when the video starts, not when the player is asked.
 * @param {boolean} options.videoNeverStarts the video never plays, so the
 *   page never asks for the captions at all.
 * @param {string} options.playerVideoId the video the player is running
 *   right now. An advertisement is a different video, and the page asks for
 *   the advertisement's captions while it runs.
 * @param {number} options.playerVideoIdAfterMs how long the advertisement
 *   runs before the video takes the player over.
 * @param {number} options.playerState the state the player reports. 1 is
 *   playing, -1 is unstarted.
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
  const sequence = options.videoIds || null;
  let reads = 0;
  let asked = false;
  let playerState = Number(
    options.playerState ?? (options.videoNeverStarts ? -1 : 1),
  );
  // Which video the player is running right now. An advertisement is a
  // different video, and the page asks for the advertisement's captions,
  // not the ones the user wants.
  let runningVideoId = String(options.playerVideoId ?? videoId);

  // The page can be showing a different video than it was a moment ago.
  // The first read sees the first video in the list, the next read the
  // second, and the last one stays.
  const shownVideoId = () => {
    if (!sequence) return videoId;
    const index = Math.min(reads, sequence.length - 1);
    reads += 1;
    return sequence[index];
  };

  const page = {
    getPlayerResponse: () => ({
      videoDetails: { videoId: shownVideoId() },
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
    getPlayerState: () => playerState,
    getVideoData: () => ({ video_id: runningVideoId }),
  };

  // The page asks for the captions when the video starts playing. That is
  // what YouTube does, and it is why the read has to wait for the video.
  const pushTrack = () => {
    if (asked || !options.playerLoadsTrack) return;
    asked = true;
    // The page finishes the request after a while: YouTube makes the
    // captions when they are first asked for, and the page only lists the
    // request once it has come back.
    const delay = Number(options.playerLoadsTrackAfterMs || 0);
    if (delay > 0) {
      setTimeout(() => used.push(options.playerLoadsTrack), delay);
    } else {
      used.push(options.playerLoadsTrack);
    }
  };

  if (options.withPlayer) {
    page.setOption = (group, name, value) => {
      setOptionCalls.push({ group, name, value });
      if (
        group === "captions" &&
        (name === "track" || name === "load" || name === "reload") &&
        options.playerLoadsTrack &&
        !options.playerLoadsTrackOnlyWhenPlaying
      ) {
        pushTrack();
      }
    };
  }

  const startsAfterMs = Number(options.playerStartsAfterMs || 0);
  if (startsAfterMs > 0) {
    setTimeout(() => {
      playerState = 1;
      if (options.playerLoadsTrackOnlyWhenPlaying) pushTrack();
    }, startsAfterMs);
  }

  // The advertisement ends and the video takes over the player. The page
  // asks for the captions then, and not before.
  const adEndsAfterMs = Number(options.playerVideoIdAfterMs || 0);
  if (adEndsAfterMs > 0) {
    setTimeout(() => {
      runningVideoId = videoId;
      if (options.playerLoadsTrackOnlyWhenPlaying) pushTrack();
    }, adEndsAfterMs);
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

/* ============================================================
   B: the page has to catch up with the panel

   YouTube swaps its player response about a second after the user clicks
   another video. The panel asks right away, so the first read is often
   too early. A read that is too early must not become a claim that the
   video has no subtitles.
   ============================================================ */

test("the page is asked again when it has not caught up with the video yet", async () => {
  const worker = loadWorker({ localRetryDelays: [10] });
  // The page shows the old video for the first read and the new one for
  // the second, the way YouTube swaps its player after a click.
  installFakePage(
    worker.sandbox,
    [{ baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" }],
    "dQw4w9WgXcQ",
    { videoIds: ["oldVideo", "newVideo"] },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("newVideo", 7);

  assert.equal(result.success, true, "the worker gave up on the page too early");
  assert.equal(result.source, "local", "the subtitles were not read out of the page");
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    0,
    "a credit was spent on subtitles the page was about to hand over",
  );
});

test("a page that never catches up does not blame the video", async () => {
  const worker = loadWorker({
    hasSupadataKey: false,
    localRetryDelays: [10, 20],
  });
  // The page stays on another video for good.
  installFakePage(
    worker.sandbox,
    [{ baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" }],
    "otherVideo",
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    "PAGE_NOT_READY",
    "the video was blamed for a page that was not ready",
  );
  assert.notEqual(
    result.error,
    "NO_SUPADATA_KEY",
    "the missing key was blamed for a page that was not ready",
  );
});

test("a video the page says has no subtitles is still the video's own fault", async () => {
  const worker = loadWorker({ hasSupadataKey: false });
  // The page knows the video and the video has no caption tracks.
  installFakePage(worker.sandbox, null, "dQw4w9WgXcQ");

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    "NO_SUPADATA_KEY",
    "a video without subtitles is reported as a page that was not ready",
  );
});

test("the page is given the time to finish its own caption request", async () => {
  // The page has no caption URL yet, so the worker asks the player to load
  // the track. YouTube answers that request in seconds when it has to make
  // the captions, and the page only lists the request once it has come back.
  const worker = loadWorker({ captionRequestTimeout: 3000 });
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
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=TOKEN",
      // The page takes a moment to answer. The wait has to be long enough
      // for the answer, or the read gives up on a page that was about to
      // reply.
      playerLoadsTrackAfterMs: 900,
    },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the page was not waited for");
  assert.equal(result.source, "local", "the subtitles were not read out of the page");
  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.match(timedtext.url, /pot=TOKEN/, "the page's own caption URL was not used");
  // The URL in the track list is a template, and YouTube answers a template
  // with an empty body. A read that gives up on the page and uses the
  // template has not read anything at all.
  assert.equal(
    worker.requests.filter(
      (request) =>
        request.url.includes("timedtext") && !request.url.includes("pot="),
    ).length,
    0,
    "the worker gave up on the page and used the template URL",
  );
});

test("the page is given time to start the video before the read gives up", async () => {
  // YouTube asks the page for the captions when the video starts playing.
  // A page that is still showing an advertisement has no caption request to
  // read, and no amount of asking makes one. So the read waits for the
  // video, and the subtitles arrive without a credit.
  const worker = loadWorker({
    captionRequestTimeout: 500,
    captionStartTimeout: 3000,
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
      withPlayer: true,
      // The player says the video has not begun. It says so until the
      // video starts, and the page asks for the captions only then.
      playerState: -1,
      playerLoadsTrack:
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=TOKEN",
      playerLoadsTrackOnlyWhenPlaying: true,
      playerStartsAfterMs: 300,
    },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the page was not waited for");
  assert.equal(result.source, "local", "the subtitles were not read out of the page");
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    0,
    "a credit was spent on a video the page was about to hand over",
  );
  const timedtext = worker.requests.find((request) =>
    request.url.includes("timedtext"),
  );
  assert.match(timedtext.url, /pot=TOKEN/, "the page's own caption URL was not used");
  // The URL in the track list is a template, and YouTube answers a template
  // with an empty body. So a read that gives up on the page and uses the
  // template has not read anything at all, and would spend a credit to
  // find out.
  assert.equal(
    worker.requests.filter(
      (request) =>
        request.url.includes("timedtext") && !request.url.includes("pot="),
    ).length,
    0,
    "the worker fell back to the template URL, which comes back empty",
  );
});

test("a video behind an advertisement is waited for, and costs nothing", async () => {
  // An advertisement is a video of its own, and the page asks for the
  // advertisement's captions while it runs. The captions the user wants
  // arrive when the advertisement is over and the video takes the player
  // over. Giving up on the advertisement and reaching for the paid path
  // would spend a credit on subtitles the page was about to hand over.
  const worker = loadWorker({
    captionRequestTimeout: 300,
    captionStartTimeout: 3000,
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
      withPlayer: true,
      playerVideoId: "adVideo123",
      playerVideoIdAfterMs: 800,
      playerLoadsTrack:
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=TOKEN",
      playerLoadsTrackOnlyWhenPlaying: true,
    },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, true, "the advertisement was not waited out");
  assert.equal(result.source, "local", "the subtitles were not read out of the page");
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    0,
    "a credit was spent while an advertisement was playing",
  );
  assert.equal(
    worker.requests.filter(
      (request) =>
        request.url.includes("timedtext") && !request.url.includes("pot="),
    ).length,
    0,
    "the worker fell back to the template URL, which comes back empty",
  );
});

test("a video that has not started is said as such, and costs nothing", async () => {
  // The page has the tracks, but the video has not started, so the page
  // never asks for the captions. The user can start the video, and then
  // the subtitles are there. Charging a credit for that would be charging
  // for something the page was about to give away.
  const worker = loadWorker({
    captionRequestTimeout: 200,
    captionStartTimeout: 400,
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
      withPlayer: true,
      videoNeverStarts: true,
    },
  );

  const result = await worker.helpers.handleFetchTranscriptLocalFirst("dQw4w9WgXcQ", 7);

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    "VIDEO_NOT_STARTED",
    "a video that has not started is reported as something else",
  );
  assert.equal(
    worker.requests.filter((request) => request.url.includes("supadata")).length,
    0,
    "a credit was spent on a video that had not started playing",
  );
  assert.equal(
    worker.requests.filter((request) => request.url.includes("timedtext")).length,
    0,
    "the worker asked for captions it already knew the page had not made",
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
