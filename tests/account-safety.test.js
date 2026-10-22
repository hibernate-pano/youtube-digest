const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createStorageMock,
  loadBackgroundHelpers,
} = require("./helpers/background-harness.js");

/* ============================================================
   A sign-in that is not ours.

   Signing in is a link with a token in it, and a link can be copied and
   sent to somebody else. The nonce is what tells the two apart: the
   device keeps the nonce of the sign-in it started, and a link that
   carries a different one belongs to another account.

   The check has to hold while a sign-in is waiting. A device with a
   pending sign-in is exactly the device where a foreign link would do
   the most damage, because the foreign link arrives while the door is
   open.
   ============================================================ */

test("a sign-in that carries a nonce this device never issued is refused", async () => {
  const storageMock = createStorageMock({});
  const helpers = loadBackgroundHelpers({
    storageMock,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/me")) {
        return {
          ok: true,
          json: async () => ({
            user: { id: "1", githubId: 1001, login: "alice" },
          }),
        };
      }
      return { ok: true, json: async () => ({ notes: [], vocabulary: [] }) };
    },
  });

  // The device asked for a sign-in, so a nonce is waiting for it.
  const pending = await helpers.startPendingLogin();
  assert.ok(pending, "the device must have a nonce waiting for its sign-in");

  // Another sign-in, with a nonce of its own, must not be able to take the
  // place of the one this device started.
  const impostor = await helpers.completeGithubLogin(
    "token-mallory",
    null,
    "0123456789abcdef0123",
  );
  assert.equal(
    impostor.success,
    false,
    "a sign-in with a nonce this device never issued must be refused",
  );
  assert.equal(
    impostor.error,
    "This sign-in did not come from the extension.",
    "the panel needs to know the sign-in was not ours",
  );

  const stored = await storageMock.get(null);
  assert.equal(
    stored.ytd_github_session,
    undefined,
    "no session may come from a sign-in that is not ours",
  );

  // The refused attempt did not spend the nonce: the sign-in this device
  // started still finishes.
  const real = await helpers.completeGithubLogin("token-alice", null, pending);
  assert.equal(real.success, true, JSON.stringify(real));
});

/* ============================================================
   Two saves, one list.

   The local note store is read-modify-write: a save reads the list, adds
   its note and writes the list back. When two saves overlap, both read
   the same list and both write it, and the second write drops the note
   the first one added. The user pressed save twice and one note is
   gone.
   ============================================================ */

/**
 * A storage that hands out the value it had when the read started and
 * answers a tick later.
 *
 * The real storage answers with the list as it was when the read was
 * asked for, so two reads that overlap see the same list. A mock that
 * answers with the list as it is when the answer is written would hide
 * the race instead of reproducing it.
 */
function createOverlappingStorageMock(initial = {}) {
  const values = { ...initial };
  const copy = (value) => structuredClone(value);
  return {
    async get(keys) {
      const requested = keys === null ? Object.keys(values) : [].concat(keys);
      const snapshot = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) snapshot[key] = copy(values[key]);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      return snapshot;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        values[key] = copy(value);
      }
    },
    async remove(keys) {
      for (const key of [].concat(keys)) {
        delete values[key];
      }
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
  };
}

test("two notes saved at the same time do not lose one", async () => {
  const storageMock = createOverlappingStorageMock({});
  const helpers = loadBackgroundHelpers({ storageMock });

  await Promise.all([
    helpers.saveNoteToStorage({ id: "note-1", text: "first", createdAt: 1 }),
    helpers.saveNoteToStorage({ id: "note-2", text: "second", createdAt: 2 }),
  ]);

  const stored = await storageMock.get(null);
  const notes = stored.ytd_notes || [];
  assert.equal(notes.length, 2, "both notes must be in the store");
  assert.deepEqual(
    notes.map((note) => note.id).sort(),
    ["note-1", "note-2"],
    "the note of the first save must survive the second one",
  );
});

/* ============================================================
   The storage that holds the user's keys.

   The YouTube page is not a trusted context, so the extension locks its
   storage away from it. That lock is the reason the page cannot read the
   API keys. The call can fail, and a failure that only reaches the
   console is a failure the user never hears about - so the worker has to
   be able to say that the storage is open.
   ============================================================ */

/**
 * Loads the service worker in a sandbox whose storage lock can be made to
 * fail.
 *
 * The shared harness always lets the call succeed, and the whole point of
 * these tests is the call that fails, so the worker is loaded here.
 */
function loadWorker({
  storageMock = createStorageMock({}),
  setAccessLevelImpl = () => Promise.resolve(),
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) }),
} = {}) {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

  const messageListeners = [];
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: fetchImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: setAccessLevelImpl,
          get: (key) => storageMock.get(key),
          set: (values) => storageMock.set(values),
          remove: (keys) => storageMock.remove(keys),
        },
        onChanged: { addListener() {} },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
        open: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            messageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        query: async () => [],
        sendMessage: async () => {},
        create: async () => ({ id: 1 }),
      },
    },
    // The real settings module, with only the network host swapped for
    // the test double.
    YTD_SETTINGS: {
      ...require("../settings.js"),
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  // cloud-sync.js is imported by background.js through importScripts; the
  // test sandbox stubs importScripts, so it is loaded explicitly first.
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return { sandbox, messageListeners };
}

/** Sends a message through the worker's router and waits for the answer. */
function askWorker(messageListeners, message) {
  return new Promise((resolve) => {
    const keepGoing = messageListeners[0](message, {}, resolve);
    if (keepGoing !== true) resolve(undefined);
  });
}

test("the worker says the storage could not be locked away from the YouTube page", async () => {
  const { messageListeners } = loadWorker({
    setAccessLevelImpl: () =>
      Promise.reject(new Error("This browser cannot restrict storage access.")),
  });

  const answer = await askWorker(messageListeners, {
    action: "getStorageIsolation",
  });

  assert.equal(answer.success, true);
  assert.equal(
    answer.restricted,
    false,
    "the worker says the storage is locked when the lock failed",
  );
});

test("the worker says the storage is locked when it is", async () => {
  const { messageListeners } = loadWorker();

  const answer = await askWorker(messageListeners, {
    action: "getStorageIsolation",
  });

  assert.equal(answer.success, true);
  assert.equal(answer.restricted, true);
});

test("Delete all notes reaches the account through the worker", async () => {
  const calls = [];
  const storageMock = createStorageMock({
    ytd_github_session: {
      token: "jwt-token",
      login: "alice",
      githubId: 1001,
      savedAt: 1,
    },
  });
  const { messageListeners } = loadWorker({
    storageMock,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options: options || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, deleted: 4 }),
      };
    },
  });

  const answer = await askWorker(messageListeners, { action: "deleteAllNotes" });

  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(answer.deleted, 4);
  const deletions = calls.filter(
    (call) => (call.options.method || "GET") === "DELETE",
  );
  assert.equal(deletions.length, 1, "the account was never asked to delete the notes");
  assert.match(deletions[0].url, /\/api\/notes$/);
  assert.equal(deletions[0].options.headers.Authorization, "Bearer jwt-token");
});
