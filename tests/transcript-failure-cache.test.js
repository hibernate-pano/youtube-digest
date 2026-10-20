const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* ============================================================
   A VIDEO WITHOUT CAPTIONS MUST NOT COST A CREDIT EVERY TIME.

   The captions of a video do not change while the user reads the panel.
   Asking Supadata again for the same answer is a credit the user pays
   for nothing, so the worker remembers the failure of a video that has
   no captions - and only that failure.

   These tests drive the real worker: the same background.js the browser
   runs, with a fake storage area and a fake Supadata.
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
 * A Supadata answer.
 */
function supadataResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * The answer Supadata gives for a video that has no captions at all.
 */
function noCaptionsResponse() {
  return supadataResponse(404, { message: "No subtitles found for this video." });
}

/**
 * The answer Supadata gives for a video whose transcript is empty.
 */
function emptyTranscriptResponse() {
  return supadataResponse(200, { content: [], lang: "en" });
}

/**
 * The answer Supadata gives when everything is fine.
 */
function captionResponse() {
  return supadataResponse(200, {
    content: [{ text: "A caption", offset: 0, duration: 900, lang: "en" }],
    lang: "en",
  });
}

/**
 * Loads the real service worker with a storage area and a Supadata that
 * the test can answer with whatever it wants.
 */
function loadWorker({
  supadata = null,
  hasSupadataKey = true,
  delayMs = 0,
} = {}) {
  const requests = [];
  const stored = {
    ytd_settings: hasSupadataKey
      ? { provider: "deepseek", aiApiKey: "test-ai", supadataApiKey: "test-key" }
      : { provider: "deepseek", aiApiKey: "test-ai" },
  };

  let messageListener = null;

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
        return {
          ok: true,
          status: 200,
          json: async () => timedtextPayload(["A caption", "Another caption"]),
        };
      }
      if (href.includes("api.supadata.ai")) {
        // A slow answer is what makes two callers overlap.
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (typeof supadata === "function") return supadata(href);
        if (supadata) return supadata;
        return captionResponse();
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          async get(keys) {
            if (keys === null || keys === undefined) return { ...stored };
            const requested = Array.isArray(keys) ? keys : [keys];
            const result = {};
            for (const key of requested) {
              if (Object.hasOwn(stored, key)) result[key] = stored[key];
            }
            return result;
          },
          async set(items) {
            Object.assign(stored, items);
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete stored[key];
            }
          },
        },
        session: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
      },
      action: { onClicked: { addListener() {} } },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
      scripting: {
        executeScript: async ({ func }) => [{ result: func() }],
      },
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
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
    storage: stored,
    sandbox,
    /**
     * Sends a message to the worker the way the panel does.
     */
    sendMessage: (message) =>
      new Promise((resolve) => {
        const kept = messageListener(message, {}, resolve);
        assert.equal(kept, true, "the worker did not keep the message channel open");
      }),
  };
}

/**
 * A fake document for the MAIN-world function to read.
 */
function installFakePage(sandbox, captionTracks, videoId = "videoA") {
  const page = {
    getPlayerResponse: () => ({
      videoDetails: { videoId },
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

/**
 * The lookups that cost the user a credit.
 */
function paidLookups(worker) {
  return worker.requests.filter((request) =>
    request.url.includes("api.supadata.ai"),
  );
}

/* ============================================================
   A: the failure is remembered
   ============================================================ */

test("a video without captions costs one credit, however often the panel looks at it", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  installFakePage(worker.sandbox, null);

  const first = await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  const second = await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  assert.equal(first.success, false);
  assert.equal(first.error, "NO_TRANSCRIPT");
  assert.equal(second.success, false);
  assert.equal(second.error, "NO_TRANSCRIPT");
  assert.equal(
    paidLookups(worker).length,
    1,
    "the second look at the same caption-less video spent another credit",
  );
});

test("the note flow does not pay for a caption-less video again", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  const note = await worker.helpers.handleFetchTranscript("videoA");

  assert.equal(note.success, false);
  assert.equal(
    paidLookups(worker).length,
    1,
    "the note flow paid for the answer the panel already had",
  );
});

test("a video whose transcript comes back empty is remembered as well", async () => {
  const worker = loadWorker({ supadata: emptyTranscriptResponse() });

  const first = await worker.helpers.handleFetchTranscript("videoA");
  const second = await worker.helpers.handleFetchTranscript("videoA");

  assert.equal(first.error, "EMPTY_TRANSCRIPT");
  assert.equal(second.error, "EMPTY_TRANSCRIPT");
  assert.equal(
    paidLookups(worker).length,
    1,
    "the empty transcript was looked up again",
  );
});

test("the remembered failure still says what went wrong", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  worker.storage["ytd_transcript_failed_videoA"] = {
    error: "NO_TRANSCRIPT",
    message: "No subtitles found for this video.",
    timestamp: Date.now(),
  };

  const remembered = await worker.helpers.handleFetchTranscript("videoA");

  assert.equal(
    paidLookups(worker).length,
    0,
    "the worker paid for a video it already knew the answer to",
  );
  assert.equal(
    remembered.error,
    "NO_TRANSCRIPT",
    "the code is gone, so the panel cannot tell the user what happened",
  );
  assert.match(
    remembered.message,
    /subtitles/i,
    "the user would be shown a bare code instead of a sentence",
  );
});

test("the remembered failure does not touch the cache the panel owns", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  const digestKeys = Object.keys(worker.storage).filter((key) =>
    key.startsWith("digest_"),
  );
  assert.deepEqual(
    digestKeys,
    [],
    "the worker wrote into the digest cache, which the panel owns",
  );
  assert.ok(
    worker.storage["ytd_transcript_failed_videoA"],
    "the failure was not remembered at all",
  );
});

/* ============================================================
   B: the local path is never blocked
   ============================================================ */

test("a video whose captions show up later is read for free", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  // The page has captions now. Reading them costs nothing, so the
  // remembered failure must not stand in the way.
  installFakePage(worker.sandbox, [
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en" },
  ]);
  const second = await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  assert.equal(second.success, true, "the remembered failure blocked the free path");
  assert.equal(second.source, "local");
  assert.equal(paidLookups(worker).length, 1);
});

/* ============================================================
   C: only the failures that describe the video are remembered
   ============================================================ */

test("a rate limit is not remembered, so the user can try again at once", async () => {
  const worker = loadWorker({
    supadata: supadataResponse(429, { message: "Too many requests" }),
  });
  installFakePage(worker.sandbox, null);

  const first = await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  const second = await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  assert.equal(first.error, "RATE_LIMITED");
  assert.equal(second.error, "RATE_LIMITED");
  assert.equal(
    paidLookups(worker).length,
    2,
    "the rate limit was remembered, so the user cannot try again right away",
  );
});

test("an empty balance is not remembered either", async () => {
  const worker = loadWorker({
    supadata: supadataResponse(402, { message: "Out of credits" }),
  });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  assert.equal(
    paidLookups(worker).length,
    2,
    "the empty balance was remembered, so topping up changes nothing",
  );
});

test("a rejected key is not remembered either", async () => {
  const worker = loadWorker({
    supadata: supadataResponse(401, { message: "Invalid key" }),
  });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  assert.equal(
    paidLookups(worker).length,
    2,
    "the rejected key was remembered, so a new key changes nothing",
  );
});

test("a network error is not remembered either", async () => {
  const worker = loadWorker({
    supadata: () => {
      throw new Error("the network is down");
    },
  });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  assert.equal(
    paidLookups(worker).length,
    2,
    "the network error was remembered, so the user cannot try again right away",
  );
});

test("a failure that is not about the video is never served from the memory", async () => {
  const worker = loadWorker({ supadata: captionResponse() });
  worker.storage["ytd_transcript_failed_videoA"] = {
    error: "RATE_LIMITED",
    message: "Too many requests.",
    timestamp: Date.now(),
  };

  const result = await worker.helpers.handleFetchTranscript("videoA");

  assert.equal(
    result.success,
    true,
    "the worker believed a rate limit that was written down by mistake",
  );
  assert.equal(paidLookups(worker).length, 1);
});

/* ============================================================
   D: one request at a time
   ============================================================ */

test("the panel and the note flow at the same time cost one credit", async () => {
  const worker = loadWorker({ supadata: captionResponse(), delayMs: 20 });
  installFakePage(worker.sandbox, null);

  const [panel, notes] = await Promise.all([
    worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7),
    worker.helpers.handleFetchTranscript("videoA"),
  ]);

  assert.equal(panel.success, true);
  assert.equal(notes.success, true);
  assert.equal(
    paidLookups(worker).length,
    1,
    "two callers that want the same video paid for two lookups",
  );
});

/* ============================================================
   E: the user can always ask again
   ============================================================ */

test("the user can ask for a caption-less video again", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  const asked = await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7, {
    force: true,
  });

  assert.equal(asked.error, "NO_TRANSCRIPT");
  assert.equal(
    paidLookups(worker).length,
    2,
    "the retry was answered from the memory, so the user's 'try again' did nothing",
  );
});

test("the panel's retry reaches the worker as a fresh lookup", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  const answer = await worker.sendMessage({
    action: "fetchTranscript",
    videoId: "videoA",
    tabId: 7,
    force: true,
  });

  assert.equal(answer.error, "NO_TRANSCRIPT");
  assert.equal(
    paidLookups(worker).length,
    2,
    "the worker ignored the force flag, so the user's 'try again' did nothing",
  );
});

test("a lookup that is not forced still comes out of the memory", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);
  const answer = await worker.sendMessage({
    action: "fetchTranscript",
    videoId: "videoA",
    tabId: 7,
  });

  assert.equal(answer.error, "NO_TRANSCRIPT");
  assert.equal(
    paidLookups(worker).length,
    1,
    "the worker paid for the video again without being asked to",
  );
});

/* ============================================================
   F: the memory does not last forever
   ============================================================ */

test("a remembered failure is forgotten after a day", async () => {
  const worker = loadWorker({ supadata: captionResponse() });
  worker.storage["ytd_transcript_failed_videoA"] = {
    error: "NO_TRANSCRIPT",
    message: "No subtitles found for this video.",
    timestamp: Date.now() - 25 * 60 * 60 * 1000,
  };

  const result = await worker.helpers.handleFetchTranscript("videoA");

  assert.equal(
    result.success,
    true,
    "the worker believed a failure that is two days old",
  );
  assert.equal(paidLookups(worker).length, 1);
});

test("the remembered failures do not stay in storage forever", async () => {
  const worker = loadWorker({ supadata: noCaptionsResponse() });
  worker.storage["ytd_transcript_failed_old"] = {
    error: "NO_TRANSCRIPT",
    message: "No subtitles found for this video.",
    timestamp: Date.now() - 25 * 60 * 60 * 1000,
  };
  installFakePage(worker.sandbox, null);

  await worker.helpers.handleFetchTranscriptLocalFirst("videoA", 7);

  assert.equal(
    worker.storage["ytd_transcript_failed_old"],
    undefined,
    "the failure that is two days old is still in storage",
  );
  assert.ok(
    worker.storage["ytd_transcript_failed_videoA"],
    "the fresh failure was thrown away with the old one",
  );
});
