const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settings = require("../settings.js");

/**
 * THE RUNTIME MUST SURVIVE A BAD DAY.
 *
 * Three things used to go wrong, all of them invisible to the user:
 *
 * - A request that never came back hung the sync forever. The MV3 service
 *   worker was suspended while it waited, so the user's notes simply stopped
 *   moving, and a slow server was reported as a dead session.
 * - A full storage failed the write and told nobody. The note was not there,
 *   and the panel said nothing.
 * - The import that moves the signed-out notes into the account could be
 *   interrupted between its steps, and the last step deleted the whole
 *   signed-out bucket - including the notes that belonged to somebody else.
 *
 * These tests drive the real runtime files the way background.js loads them.
 */

/**
 * A stand-in for chrome.storage that behaves like the real one and can also
 * run out of room.
 *
 * The size accounting is the same one the runtime uses to decide how much to
 * free: the length of the key plus the length of the serialized value.
 */
function createStorageMock(initial = {}, options = {}) {
  const values = { ...initial };
  const quotaBytes = options.quotaBytes ?? Infinity;
  const sizeOf = (value) => {
    try {
      const json = JSON.stringify(value);
      return typeof json === "string" ? json.length : 0;
    } catch (error) {
      return 0;
    }
  };
  const sizeOfAll = (entries) =>
    Object.entries(entries).reduce(
      (sum, [key, value]) => sum + key.length + sizeOf(value),
      0,
    );

  const mock = {
    values,
    // A key that the next write has to fail on. It is how a crash in the
    // middle of a multi-step operation is reproduced.
    failNextSetFor: null,
    totalBytes() {
      return sizeOfAll(values);
    },
    async get(keys) {
      if (keys === null) {
        const all = {};
        for (const [key, value] of Object.entries(values)) {
          all[key] = structuredClone(value);
        }
        return all;
      }
      const requested = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
      }
      return result;
    },
    async set(items) {
      for (const key of Object.keys(items)) {
        if (mock.failNextSetFor === key) {
          mock.failNextSetFor = null;
          throw new Error(`The write of ${key} did not finish.`);
        }
      }
      const next = { ...values, ...items };
      if (sizeOfAll(next) > quotaBytes) {
        const error = new Error(
          "QUOTA_BYTES: The quota has been exceeded.",
        );
        error.name = "QuotaExceededError";
        throw error;
      }
      Object.assign(values, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
  };
  return mock;
}

/**
 * Timers the test drives by hand.
 *
 * The runtime's deadlines are tens of seconds long, so a test cannot wait
 * them out. The fake records the timers and lets the test fire the one it
 * cares about.
 */
function createFakeTimers() {
  const timers = [];
  let nextId = 1;
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.push({ id, callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.active = false;
    },
    activeCount(delay) {
      return timers.filter((entry) => entry.active && entry.delay === delay)
        .length;
    },
    /**
     * Fires the timer with this delay as soon as it exists.
     *
     * The runtime reaches the request through several awaits, so the timer
     * is not there yet when the test asks for it.
     */
    async fire(delay) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const timer = timers.find((entry) => entry.active && entry.delay === delay);
        if (timer) {
          timer.active = false;
          timer.callback();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.fail(`No timer with a delay of ${delay} was ever started.`);
    },
  };
}

/**
 * Loads cloud-sync.js and background.js the way the service worker does.
 */
function loadHelpers({
  storage = createStorageMock({
    ytd_settings: {
      provider: "deepseek",
      aiApiKey: "test-key",
      supadataApiKey: "supadata-key",
    },
  }),
  fetchImpl = async () => ({ ok: true, json: async () => ({}) }),
  timers = createFakeTimers(),
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    Date,
    TextDecoder,
    TextEncoder,
    AbortController,
    crypto: globalThis.crypto,
    fetch: fetchImpl,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: (key) => storage.get(key),
          set: (values) => storage.set(values),
          remove: (keys) => storage.remove(keys),
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
      // The real module, with only the deployment value redirected: the
      // worker reads its codes and its timeout helper from here, so a
      // hand-written copy would test a module that no longer exists.
      ...require("../settings.js"),
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  // The shared module is loaded inside the sandbox as well, so the timeout
  // helper runs with the test's fake timers instead of the real ones: the
  // deadlines are tens of seconds long, and a test cannot wait them out.
  vm.runInNewContext(read("settings.js"), sandbox);
  sandbox.YTD_SETTINGS.SERVER_BASE_URL = "https://sync.test";
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return { helpers: sandbox.__YTD_TRANSLATION_TESTING__, storage, timers };
}

const SESSION = {
  token: "token-alice",
  login: "alice",
  githubId: 1001,
  savedAt: 1000,
};

/**
 * Fails the test instead of hanging when the runtime never gives up.
 *
 * A runtime that waits forever is exactly the bug these tests are about, so
 * the test must not wait forever either.
 */
function within(promise, ms = 2000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("The runtime never gave up on the request.")),
        ms,
      ),
    ),
  ]);
}

// ============================================================
// A. A REQUEST THAT NEVER ANSWERS
// ============================================================

test("a sync request that never answers is given up on, with a timeout code", async () => {
  const timers = createFakeTimers();
  const { helpers } = loadHelpers({
    timers,
    fetchImpl: () => new Promise(() => {}),
  });

  const pending = helpers.cloudFetch("/api/notes", { token: SESSION.token });
  await timers.fire(settings.CLOUD_REQUEST_TIMEOUT_MS);

  await assert.rejects(within(pending), (error) => {
    assert.equal(error.code, settings.SYNC_REQUEST_TIMEOUT);
    assert.notEqual(error.code, settings.SYNC_SESSION_EXPIRED);
    return true;
  });
});

test("a timed out sync request is not reported as an expired session", async () => {
  const timers = createFakeTimers();
  const storage = createStorageMock({ ytd_github_session: SESSION });
  const { helpers } = loadHelpers({
    storage,
    timers,
    fetchImpl: () => new Promise(() => {}),
  });

  const pending = helpers.cloudFetch("/api/notes", { token: SESSION.token });
  await timers.fire(settings.CLOUD_REQUEST_TIMEOUT_MS);
  await within(pending).catch(() => {});

  // A slow server says nothing about the token. Sending the user to the
  // sign-in screen here would be a lie.
  assert.equal(await helpers.isSyncSessionExpiredForAccount(), false);
  assert.equal(storage.values.ytd_sync_expired, undefined);
});

test("a rejected session is still an expired session, not a timeout", async () => {
  const timers = createFakeTimers();
  const { helpers } = loadHelpers({
    timers,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "token rejected" }),
    }),
  });

  await assert.rejects(
    helpers.cloudFetch("/api/notes", { token: SESSION.token }),
    (error) => {
      assert.equal(error.code, settings.SYNC_SESSION_EXPIRED);
      assert.notEqual(error.code, settings.SYNC_REQUEST_TIMEOUT);
      return true;
    },
  );
  // The deadline must not fire for a request that answered.
  assert.equal(timers.activeCount(settings.CLOUD_REQUEST_TIMEOUT_MS), 0);
});

test("a transcript request that never answers is given up on, with a timeout code", async () => {
  const timers = createFakeTimers();
  const { helpers } = loadHelpers({
    timers,
    fetchImpl: () => new Promise(() => {}),
  });

  const pending = helpers.handleFetchTranscript("abc123xyz");
  await timers.fire(settings.TRANSCRIPT_REQUEST_TIMEOUT_MS);
  const result = await within(pending);

  assert.equal(result.success, false);
  assert.equal(result.error, settings.TRANSCRIPT_REQUEST_TIMEOUT);
  assert.equal(result.code, settings.TRANSCRIPT_REQUEST_TIMEOUT);
});

test("a transcript request that answers is not turned into a timeout", async () => {
  const timers = createFakeTimers();
  const { helpers } = loadHelpers({
    timers,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        lang: "en",
        content: [{ text: "hello", offset: 0, duration: 2, lang: "en" }],
      }),
    }),
  });

  const result = await helpers.handleFetchTranscript("abc123xyz");
  assert.equal(result.success, true);
  assert.equal(result.transcriptText, "hello");
  assert.equal(timers.activeCount(settings.TRANSCRIPT_REQUEST_TIMEOUT_MS), 0);
});

test("a sync that times out reports a timeout and not an expired session", async () => {
  const timers = createFakeTimers();
  const storage = createStorageMock({ ytd_github_session: SESSION });
  const { helpers } = loadHelpers({
    storage,
    timers,
    fetchImpl: () => new Promise(() => {}),
  });

  const pending = helpers.fullSyncNotes();
  await timers.fire(settings.CLOUD_REQUEST_TIMEOUT_MS);
  const result = await within(pending);

  assert.equal(result.success, false);
  assert.equal(result.code, settings.SYNC_REQUEST_TIMEOUT);
  assert.equal(result.expired, false);
  assert.equal(
    storage.values.ytd_sync_expired,
    undefined,
    "a slow server must not raise the re-login chip",
  );
});

test("a word that does not fit into the storage fails with a reason code", async () => {
  const storage = createStorageMock(
    { ytd_vocabulary: [{ id: "word_1", term: "keep", sentence: "x".repeat(2000) }] },
    { quotaBytes: 100 },
  );
  const { helpers } = loadHelpers({ storage });

  const result = await helpers.handleSaveVocabulary({
    term: "insight",
    translation: "洞察",
    sentence: "She shared a deep insight.",
    videoId: "abc123xyz",
  });

  assert.equal(result.success, false);
  assert.equal(result.code, settings.STORAGE_QUOTA_EXCEEDED);
  const after = await storage.get(null);
  assert.equal(
    after.ytd_vocabulary.length,
    1,
    "the word that was already there must survive the failed write",
  );
});

test("a timed out upload leaves the note on the device and does not duplicate it", async () => {
  const timers = createFakeTimers();
  const storage = createStorageMock({ ytd_github_session: SESSION });
  const requests = [];
  let uploadsTimeOut = true;
  const { helpers } = loadHelpers({
    storage,
    timers,
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (uploadsTimeOut) return new Promise(() => {});
      if (options.method === "POST") {
        return { ok: true, json: async () => ({ note: { id: "server-1" } }) };
      }
      return { ok: true, json: async () => ({ notes: [] }) };
    },
  });

  const note = {
    id: "note_1",
    videoId: "abc123xyz",
    videoTitle: "Video",
    channelName: "Channel",
    timestamp: "01:00",
    timestampSeconds: 60,
    text: "a note worth keeping",
    createdAt: 1000,
  };

  // The upload hangs and is given up on.
  const saving = helpers.saveNoteToStorage(note);
  await timers.fire(settings.CLOUD_REQUEST_TIMEOUT_MS);
  await within(saving);

  // The note is on the device: the timeout never cost the user their note.
  const afterTimeout = await storage.get(null);
  assert.equal(afterTimeout.ytd_notes_1001.length, 1);
  assert.equal(afterTimeout.ytd_notes_1001[0].id, "note_1");
  assert.equal(
    afterTimeout.ytd_notes_1001[0].cloudId,
    undefined,
    "a note whose upload timed out has no server id yet",
  );

  // The next sync sends it again. The server keys the note by its client
  // id, so the retry updates the row instead of adding a second one.
  uploadsTimeOut = false;
  requests.length = 0;
  const sync = await within(helpers.fullSyncNotes());
  assert.equal(sync.success, true);

  const pushes = requests.filter(
    (request) => request.method === "POST" && request.body,
  );
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.clientId, "note_1");

  const afterSync = await storage.get(null);
  assert.equal(afterSync.ytd_notes_1001.length, 1);
});

// ============================================================
// B. A STORAGE THAT IS FULL
// ============================================================

test("the extension asks for unlimited storage", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(
    manifest.permissions.includes("unlimitedStorage"),
    "the extension stores transcripts, notes and words in chrome.storage.local, " +
      "which is capped at 10 MB without this permission",
  );
});

test("a full storage drops the oldest cached video and saves the note anyway", async () => {
  const storage = createStorageMock(
    {
      digest_old: { timestamp: 1000, transcriptText: "o".repeat(400) },
      digest_new: { timestamp: 2000, transcriptText: "n".repeat(400) },
    },
    { quotaBytes: 1000 },
  );
  const { helpers } = loadHelpers({ storage });

  const note = {
    id: "note_1",
    videoId: "abc123xyz",
    videoTitle: "Video",
    channelName: "Channel",
    timestamp: "01:00",
    timestampSeconds: 60,
    text: "a note worth keeping",
    createdAt: 1000,
  };

  await helpers.saveNoteToStorage(note);

  const after = await storage.get(null);
  assert.equal(after.ytd_notes.length, 1, "the note was saved");
  assert.equal(
    after.digest_old,
    undefined,
    "the oldest cached video made room for it",
  );
  assert.ok(after.digest_new, "the newer cached video is still there");
  assert.ok(
    after.ytd_storage_reclaimed,
    "the user has to hear that a cached video was dropped",
  );
});

test("a storage that stays full fails with a reason code instead of pretending", async () => {
  const storage = createStorageMock(
    { ytd_notes: [{ id: "old", text: "x".repeat(2000) }] },
    { quotaBytes: 100 },
  );
  const { helpers } = loadHelpers({ storage });

  const result = await helpers.handleSaveNote(
    "abc123xyz",
    60,
    "Video",
    "Channel",
    "the text the user picked",
    null,
  );

  assert.equal(result.success, false);
  assert.equal(result.code, settings.STORAGE_QUOTA_EXCEEDED);
});

test("a full storage that cannot be freed keeps the note that was already there", async () => {
  const storage = createStorageMock(
    { ytd_notes: [{ id: "old", text: "keep me" }] },
    { quotaBytes: 100 },
  );
  const { helpers } = loadHelpers({ storage });

  await assert.rejects(
    helpers.saveNoteToStorage({
      id: "note_1",
      videoId: "abc123xyz",
      text: "new",
      createdAt: 1000,
    }),
    (error) => {
      assert.equal(error.code, settings.STORAGE_QUOTA_EXCEEDED);
      return true;
    },
  );

  const after = await storage.get(null);
  assert.equal(
    after.ytd_notes[0].text,
    "keep me",
    "a failed write must not take the notes that are already there with it",
  );
});

// ============================================================
// C. AN IMPORT THAT IS INTERRUPTED
// ============================================================

test("the import leaves the notes of another account where they are", async () => {
  const storage = createStorageMock({
    ytd_notes: [
      { id: "note_a", text: "belongs to the first account", createdAt: 1000 },
      { id: "note_b", text: "was saved while signed out", createdAt: 2000 },
    ],
    ytd_notes_claim: { ids: { note_a: "1001" } },
  });
  const { helpers } = loadHelpers({ storage });

  const added = await helpers.migrateLegacyLocalNotes(2002);
  assert.equal(added, 1);

  const after = await storage.get(null);
  assert.equal(
    after.ytd_notes_2002.length,
    1,
    "the note that was saved while signed out moved into the account",
  );
  assert.equal(after.ytd_notes_2002[0].id, "note_b");
  assert.ok(
    after.ytd_notes,
    "the signed-out bucket must not be deleted as a whole",
  );
  assert.equal(
    after.ytd_notes.length,
    1,
    "the note of the other account stays in the bucket",
  );
  assert.equal(after.ytd_notes[0].id, "note_a");
});

test("the import runs twice without moving a note twice", async () => {
  const storage = createStorageMock({
    ytd_notes: [{ id: "note_a", text: "a note", createdAt: 1000 }],
  });
  const { helpers } = loadHelpers({ storage });

  assert.equal(await helpers.migrateLegacyLocalNotes(1001), 1);
  const afterFirst = await storage.get(null);
  assert.equal(afterFirst.ytd_notes_1001.length, 1);
  assert.equal(afterFirst.ytd_notes, undefined, "the bucket is empty now");

  assert.equal(await helpers.migrateLegacyLocalNotes(1001), 0);
  const afterSecond = await storage.get(null);
  assert.equal(afterSecond.ytd_notes_1001.length, 1);
});

test("an import that dies before the copy keeps the note and keeps it claimed", async () => {
  const storage = createStorageMock({
    ytd_notes: [{ id: "note_a", text: "a note", createdAt: 1000 }],
  });
  const { helpers } = loadHelpers({ storage });

  // The copy into the account namespace does not finish.
  storage.failNextSetFor = "ytd_notes_1001";
  await assert.rejects(helpers.migrateLegacyLocalNotes(1001));

  const afterCrash = await storage.get(null);
  assert.ok(
    afterCrash.ytd_notes,
    "the note must still be in the signed-out bucket",
  );
  assert.equal(afterCrash.ytd_notes.length, 1);
  assert.equal(
    afterCrash.ytd_notes_claim.ids.note_a,
    "1001",
    "the ownership was recorded before the copy, so no other account can take it",
  );

  // Another account must not pick the note up.
  assert.equal(await helpers.migrateLegacyLocalNotes(2002), 0);
  const afterOther = await storage.get(null);
  assert.equal(afterOther.ytd_notes_2002, undefined);

  // The account that owns it can finish the job later.
  assert.equal(await helpers.migrateLegacyLocalNotes(1001), 1);
  const afterRetry = await storage.get(null);
  assert.equal(afterRetry.ytd_notes_1001.length, 1);
  assert.equal(afterRetry.ytd_notes, undefined);
});

test("an import that cannot record the ownership moves nothing", async () => {
  const storage = createStorageMock({
    ytd_notes: [{ id: "note_a", text: "a note", createdAt: 1000 }],
  });
  const { helpers } = loadHelpers({ storage });

  storage.failNextSetFor = "ytd_notes_claim";
  assert.equal(await helpers.migrateLegacyLocalNotes(1001), 0);

  const after = await storage.get(null);
  assert.ok(after.ytd_notes, "the note stays where it is");
  assert.equal(
    after.ytd_notes_1001,
    undefined,
    "without the ownership nothing may move: the next account would take it",
  );
});

test("the words follow the same rules as the notes", async () => {
  const storage = createStorageMock({
    ytd_vocabulary: [
      { id: "word_a", term: "belong", createdAt: 1000 },
      { id: "word_b", term: "borrow", createdAt: 2000 },
    ],
    ytd_vocabulary_claim: { ids: { word_a: "1001" } },
  });
  const { helpers } = loadHelpers({ storage });

  const added = await helpers.migrateLegacyLocalVocabulary(2002);
  assert.equal(added, 1);

  const after = await storage.get(null);
  assert.equal(after.ytd_vocabulary_2002.length, 1);
  assert.equal(after.ytd_vocabulary_2002[0].id, "word_b");
  assert.equal(after.ytd_vocabulary.length, 1, "the other account's word stays");
  assert.equal(after.ytd_vocabulary[0].id, "word_a");
});
