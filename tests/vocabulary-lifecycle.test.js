/**
 * The vocabulary notebook must not lose the user's words.
 *
 * The extension had no way to capture a word, so this whole path was never
 * exercised by a real user: the backend was written for the web dashboard
 * and the extension side was left unfinished. The panel now captures words,
 * so the path runs for the first time - and three ways of losing a word
 * came with it.
 *
 * 1. A word captured while signed out disappeared the moment the user
 *    signed in. The notes have a migration for exactly this; the vocabulary
 *    had none, so signing in moved the reading namespace away from the
 *    words.
 * 2. A word deleted while offline came back on the next sync. The delete
 *    was sent once and dropped on failure, so the cloud kept the word and
 *    the next sync pulled it down again. The notes got a pending-delete
 *    record for this; the vocabulary did not.
 * 3. The 500-word cap dropped the oldest word silently. The notes got a
 *    "we dropped N" record and a panel message for this; the vocabulary
 *    did not.
 *
 * These tests drive the real cloud-sync.js against a fake storage and a
 * fake fetch, the way the service worker loads it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/** The accounts the fake server knows about, keyed by access token. */
const ACCOUNTS = {
  "alice-token": { login: "alice", githubId: 1001 },
  "bob-token": { login: "bob", githubId: 2002 },
};

/**
 * Loads cloud-sync.js into a sandbox with a fake storage and a fake fetch.
 *
 * The storage object is handed in, so a "restart" - which is what the
 * service worker does when it is suspended and woken up again - is a new
 * sandbox over the same storage.
 *
 * The sandbox gets the real console object, not a copy of it: the tests
 * below listen for the warnings the store prints, and a copy would keep
 * pointing at the original function.
 */
function loadCloudSync({ fetchImpl, storage = {} } = {}) {
  const calls = [];
  const sandbox = {
    console,
    URL,
    Date,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options: options || {} });
      return fetchImpl(url, options || {});
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (key === null || key === undefined) return { ...storage };
            if (Array.isArray(key)) {
              const out = {};
              for (const name of key) {
                if (Object.hasOwn(storage, name)) out[name] = storage[name];
              }
              return out;
            }
            return Object.hasOwn(storage, key) ? { [key]: storage[key] } : {};
          },
          async set(patch) {
            Object.assign(storage, patch);
          },
          async remove(key) {
            delete storage[key];
          },
        },
      },
      runtime: { sendMessage: async () => ({}) },
      tabs: {
        onUpdated: { addListener() {} },
        create: async () => ({ id: 1 }),
        remove: async () => {},
      },
    },
    // The real settings module, with only the network host swapped for the
    // test double.
    YTD_SETTINGS: {
      ...require("../settings.js"),
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  return { sandbox, calls, storage };
}

/**
 * The account a request belongs to.
 *
 * The token travels in the Authorization header, so this is how the fake
 * server tells Alice's requests from Bob's.
 */
function accountOf(options) {
  const headers = (options && options.headers) || {};
  const token = String(headers.Authorization || "").replace(/^Bearer\s+/, "");
  return ACCOUNTS[token] || null;
}

/** A word as it is stored on the device. */
function localWord(id, term, cloudId) {
  return {
    id,
    term,
    translation: "翻译",
    explanation: "an explanation",
    sentence: "the sentence the word came from",
    videoId: "abc123xyz",
    videoTitle: "A video",
    timestampSeconds: 42,
    status: "learning",
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    updatedAt: Date.parse("2026-01-01T00:00:00Z"),
    cloudId: cloudId === undefined ? "uuid-" + id : cloudId,
  };
}

/** A word as it comes back from the cloud. */
function cloudWord(id, term, updatedAt) {
  return {
    id: "uuid-" + id,
    term,
    translation: "翻译",
    sentenceTranslation: "an explanation",
    sentence: "the sentence the word came from",
    videoId: "abc123xyz",
    videoTitle: "A video",
    timestampSeconds: 42,
    status: "learning",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: updatedAt || "2026-01-01T00:00:00Z",
  };
}

/** The requests of one kind. */
function requestsOf(calls, method) {
  return calls.filter((call) => (call.options.method || "GET") === method);
}

/**
 * A plain copy of a value that came out of the sandbox.
 *
 * The sandbox has its own realm, so its arrays carry a different
 * prototype: a strict comparison against a literal would fail on the
 * prototype alone.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Captures the warnings the code prints while it runs. */
async function withWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    originalWarn(...args);
  };
  try {
    await run(warnings);
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

// ============================================================
// 1. A word captured while signed out survives signing in
// ============================================================

test("a word captured while signed out is still there after signing in", async () => {
  const storage = {};
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/api/me")) {
        const account = accountOf(options);
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: account }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          notes: [],
          vocabulary: [],
          serverTime: new Date().toISOString(),
        }),
      };
    },
  });

  // The user captures a word before signing in.
  const saved = await sandbox.handleSaveVocabulary({
    term: "ephemeral",
    translation: "短暂的",
    explanation: "lasting a very short time",
    sentence: "the trend proved ephemeral",
    videoId: "abc123xyz",
    videoTitle: "A video",
    timestampSeconds: 42,
  });
  assert.equal(saved.success, true, "the word was not saved");

  const before = await sandbox.handleGetVocabulary();
  assert.equal(before.items.length, 1, "the word is not there before signing in");

  // Now the user signs in.
  await sandbox.completeGithubLogin("alice-token", 1);

  const after = await sandbox.handleGetVocabulary();
  assert.equal(
    after.items.length,
    1,
    "the word disappeared when the user signed in: it was written to the " +
      "signed-out bucket and the signed-in namespace is a different key",
  );
  assert.equal(after.items[0].term, "ephemeral");
});

test("signing in uploads the words that were captured while signed out", async () => {
  const storage = {};
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/api/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: accountOf(options) }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          notes: [],
          vocabulary: [],
          serverTime: new Date().toISOString(),
        }),
      };
    },
  });

  await sandbox.handleSaveVocabulary({
    term: "ephemeral",
    translation: "短暂的",
    explanation: "lasting a very short time",
    sentence: "the trend proved ephemeral",
    videoId: "abc123xyz",
    videoTitle: "A video",
    timestampSeconds: 42,
  });

  await sandbox.completeGithubLogin("alice-token", 1);

  const pushed = requestsOf(calls, "POST").filter((call) =>
    String(call.url).includes("/api/vocabulary"),
  );
  assert.equal(
    pushed.length,
    1,
    "signing in did not upload the word: it is on the device but not in " +
      "the cloud, so it is gone if the device is lost",
  );
});

test("the words of a signed-out account are not handed to the next account", async () => {
  const storage = {};
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/api/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: accountOf(options) }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [], vocabulary: [] }),
      };
    },
  });

  await sandbox.handleSaveVocabulary({
    term: "ephemeral",
    translation: "短暂的",
    explanation: "lasting a very short time",
    sentence: "the trend proved ephemeral",
    videoId: "abc123xyz",
    videoTitle: "A video",
    timestampSeconds: 42,
  });

  // Alice signs in, so the word becomes hers.
  await sandbox.completeGithubLogin("alice-token", 1);
  const asAlice = await sandbox.handleGetVocabulary();
  assert.equal(asAlice.items.length, 1, "the word did not reach Alice");

  // Bob signs in on the same device.
  delete storage.ytd_github_session;
  await sandbox.completeGithubLogin("bob-token", 2);
  const asBob = await sandbox.handleGetVocabulary();
  assert.equal(
    asBob.items.length,
    0,
    "Bob inherited Alice's word: a word belongs to the account that took " +
      "it, never to whoever signs in next",
  );
});

test("a word that another account already took is not imported by the next one", async () => {
  // The bucket still holds a word that Alice took: her import moved the
  // word out of the bucket, but the bucket could not be cleared - the
  // device ran out of space, or the worker was killed right after the
  // move. The claim record is what stops Bob from taking the word.
  const storage = {
    ytd_vocabulary: [localWord("w1", "ephemeral", "")],
    ytd_vocabulary_claim: { ids: { w1: "1001" } },
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/api/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: accountOf(options) }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [], vocabulary: [] }),
      };
    },
  });

  // Bob signs in on a device that still holds Alice's word.
  await sandbox.completeGithubLogin("bob-token", 2);

  const asBob = await sandbox.handleGetVocabulary();
  assert.equal(
    asBob.items.length,
    0,
    "Bob inherited a word that Alice had already taken: the claim record " +
      "is the only thing that stops it",
  );

  // Alice can take her own word again - a retry must never lose it.
  const { sandbox: aliceSandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/api/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user: accountOf(options) }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [], vocabulary: [] }),
      };
    },
  });
  await aliceSandbox.completeGithubLogin("alice-token", 1);
  const asAlice = await aliceSandbox.handleGetVocabulary();
  assert.equal(
    asAlice.items.length,
    1,
    "Alice could not take her own word back: the import has to work for " +
      "the owner, not only for a stranger",
  );
});

// ============================================================
// 2. A word deleted while offline does not come back
// ============================================================

test("a deleted word does not come back when the cloud delete failed", async () => {
  const storage = {
    ytd_github_session: {
      token: "alice-token",
      login: "alice",
      githubId: 1001,
      savedAt: 1,
    },
    ytd_vocabulary_1001: [localWord("w1", "ephemeral", "uuid-w1")],
  };
  let networkUp = false;
  const fetchImpl = async (url, options) => {
    if (!networkUp) throw new Error("the network is down");
    if ((options && options.method) === "DELETE") {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        vocabulary: [cloudWord("w1", "ephemeral")],
        serverTime: new Date().toISOString(),
      }),
    };
  };

  const first = loadCloudSync({ storage, fetchImpl });

  // The user deletes the word while the network is down.
  await first.sandbox.handleDeleteVocabulary("w1");
  assert.equal(
    (storage.ytd_vocabulary_1001 || []).length,
    0,
    "the word is still on the device",
  );

  // The network comes back and the next sync runs - in a new worker, the
  // way it really happens: the MV3 service worker is suspended after half
  // a minute and woken up again, so the intent has to survive in storage.
  networkUp = true;
  const second = loadCloudSync({ storage, fetchImpl });
  await second.sandbox.fullSyncVocabulary();

  const after = plain(storage.ytd_vocabulary_1001 || []);
  assert.equal(
    after.length,
    0,
    "the deleted word came back: the delete was sent once and dropped on " +
      "failure, so the cloud still had it and the next sync pulled it down",
  );
});

test("a word deleted on this device is not deleted again on the server when it was re-captured", async () => {
  const storage = {
    ytd_github_session: {
      token: "alice-token",
      login: "alice",
      githubId: 1001,
      savedAt: 1,
    },
    ytd_vocabulary_1001: [localWord("w1", "ephemeral", "uuid-w1")],
  };
  let networkUp = false;
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (!networkUp) throw new Error("the network is down");
      if ((options && options.method) === "DELETE") {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          vocabulary: [cloudWord("w1", "ephemeral")],
          serverTime: new Date().toISOString(),
        }),
      };
    },
  });

  await sandbox.handleDeleteVocabulary("w1");

  // The user captures the same word again - the same word out of the same
  // sentence - before the next sync. The delete that is still on its way
  // belongs to the word that was there before.
  networkUp = true;
  const deletesBefore = requestsOf(calls, "DELETE").length;
  await sandbox.handleSaveVocabulary({
    term: "ephemeral",
    translation: "短暂的",
    explanation: "lasting a very short time",
    sentence: "the sentence the word came from",
    videoId: "abc123xyz",
    videoTitle: "A video",
    timestampSeconds: 42,
  });

  await sandbox.fullSyncVocabulary();

  const after = plain(storage.ytd_vocabulary_1001 || []);
  assert.equal(
    after.length,
    1,
    "the word the user captured again was eaten by the delete that was " +
      "still on its way",
  );
  assert.equal(
    requestsOf(calls, "DELETE").length,
    deletesBefore,
    "the server was asked to delete the word the user had just captured " +
      "again: the delete was older than the word and had become stale",
  );
});

test("a word delete survives a sync in which the server cannot be reached", async () => {
  const storage = {
    ytd_github_session: {
      token: "alice-token",
      login: "alice",
      githubId: 1001,
      savedAt: 1,
    },
    // A word that was never pushed: the server does not know its id, so
    // the delete has to look the id up in the server's own list.
    ytd_vocabulary_1001: [localWord("w1", "ephemeral", "")],
  };
  let networkUp = false;
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (!networkUp) throw new Error("the network is down");
      if ((options && options.method) === "DELETE") {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          vocabulary: [cloudWord("w1", "ephemeral")],
          serverTime: new Date().toISOString(),
        }),
      };
    },
  });

  await sandbox.handleDeleteVocabulary("w1");

  // The network comes back, but the server cannot be reached: the id
  // lookup fails.
  networkUp = true;
  let serverUp = false;
  const second = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (!serverUp) throw new Error("the server is down");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          vocabulary: [cloudWord("w1", "ephemeral")],
          serverTime: new Date().toISOString(),
        }),
      };
    },
  });
  await second.sandbox.fullSyncVocabulary();

  assert.equal(
    plain(storage.ytd_vocabulary_1001 || []).length,
    0,
    "the deleted word came back",
  );
  assert.equal(
    plain(storage["ytd_pending_vocab_deletes_1001"] || []).length,
    1,
    "the delete intent was thrown away even though the server could not be " +
      "reached: the word would come back on the next sync",
  );
});

test("the vocabulary sync reads the word list, not the note list", async () => {
  const storage = {
    ytd_github_session: {
      token: "alice-token",
      login: "alice",
      githubId: 1001,
      savedAt: 1,
    },
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if ((options && options.method) === "DELETE") {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      // The response carries both lists. The vocabulary sync has to take
      // the words out of it: the notes belong to another list, and a
      // note read as a word is a word with no term and no translation.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          notes: [
            {
              id: "note_1",
              clientId: "note_1",
              videoId: "abc123xyz",
              videoTitle: "A video",
              note: "a note",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          vocabulary: [cloudWord("w1", "ephemeral")],
          serverTime: new Date().toISOString(),
        }),
      };
    },
  });

  await sandbox.fullSyncVocabulary();

  const after = plain(storage.ytd_vocabulary_1001 || []);
  assert.equal(
    after.length,
    1,
    "the vocabulary sync read the wrong list: the note came down as a word",
  );
  assert.equal(after[0].term, "ephemeral");
});

test("a word captured again is not deleted from the server when the upload is slow", async () => {
  const storage = {
    ytd_github_session: {
      token: "alice-token",
      login: "alice",
      githubId: 1001,
      savedAt: 1,
    },
    ytd_vocabulary_1001: [localWord("w1", "ephemeral", "uuid-w1")],
  };
  let networkUp = false;
  // The server refuses every write, so the upload of the word the user
  // captured again never lands.
  const fetchImpl = async (url, options) => {
    if (!networkUp) throw new Error("the network is down");
    const method = (options && options.method) || "GET";
    if (method === "POST" || method === "DELETE") {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        vocabulary: [cloudWord("w1", "ephemeral")],
        serverTime: new Date().toISOString(),
      }),
    };
  };
  const { sandbox, calls } = loadCloudSync({ storage, fetchImpl });

  // The user deletes the word while the network is down.
  await sandbox.handleDeleteVocabulary("w1");

  // The network comes back, but the server refuses the upload. The user
  // captures the same word again.
  networkUp = true;
  await sandbox.handleSaveVocabulary({
    term: "ephemeral",
    translation: "短暂的",
    explanation: "lasting a very short time",
    sentence: "the sentence the word came from",
    videoId: "abc123xyz",
    videoTitle: "A video",
    timestampSeconds: 42,
  });

  const deletesBefore = requestsOf(calls, "DELETE").length;
  await sandbox.fullSyncVocabulary();

  assert.equal(
    requestsOf(calls, "DELETE").length,
    deletesBefore,
    "the server was asked to delete the word the user had just captured " +
      "again, only because the upload had not landed yet: the word is on " +
      "the device, so the delete must wait for it",
  );
  assert.equal(
    plain(storage.ytd_vocabulary_1001 || []).length,
    1,
    "the word the user captured again is not on the device any more",
  );
});

// ============================================================
// 3. The cap does not drop words silently
// ============================================================

test("the vocabulary store tells the user when it drops an old word", async () => {
  const storage = {};
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
  });

  const words = [];
  for (let index = 0; index < 500; index += 1) {
    words.push(localWord("w" + index, "term" + index, ""));
  }
  storage.ytd_vocabulary = words;

  const warnings = await withWarnings(async () => {
    await sandbox.handleSaveVocabulary({
      term: "term500",
      translation: "翻译",
      explanation: "an explanation",
      sentence: "a sentence",
      videoId: "abc123xyz",
      videoTitle: "A video",
      timestampSeconds: 42,
    });
  });

  assert.ok(
    warnings.some(
      (line) =>
        /word|vocab/i.test(line) && /dropped|discard|removed|500/i.test(line),
    ),
    `the user was not told that a word was dropped: ${JSON.stringify(warnings)}`,
  );

  // The user cannot see the console, so a warning there is not a signal.
  // The loss has to be written down where the panel can find it and say
  // it out loud.
  const record = plain(storage.ytd_vocabulary_dropped);
  assert.ok(
    record,
    "the store dropped a word and left no record the user could ever see",
  );
  assert.equal(
    Number(record.lastCount),
    1,
    `the record does not say how many words were dropped: ${JSON.stringify(record)}`,
  );
});

test("the panel knows the vocabulary store's cap", () => {
  // The panel shows how many words are kept. If the cap changes, that
  // number has to change with it, so it must not be a second copy of the
  // number that lives in the store. Both sides have to read the one
  // number that settings.js holds.
  const panel = read("sidepanel.js");
  const cloudSync = read("cloud-sync.js");
  const settings = read("settings.js");

  assert.match(
    settings,
    /MAX_LOCAL_VOCABULARY\s*=\s*\d+/,
    "settings.js does not hold the word cap",
  );
  assert.match(
    panel,
    /YTD_SETTINGS\.MAX_LOCAL_VOCABULARY/,
    "the panel keeps its own copy of the word limit instead of reading the shared one",
  );
  assert.match(
    cloudSync,
    /YTD_SETTINGS\.MAX_LOCAL_VOCABULARY/,
    "the store keeps its own copy of the word limit instead of reading the shared one",
  );
});
