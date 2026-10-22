/**
 * The device's limits, and the sync that used to ignore them.
 *
 * The panel says "n / 100" next to the notes and the store keeps the
 * newest hundred. The sync, however, writes a merged list back, and the
 * merged list is as long as the account: a user with five hundred notes in
 * their account got all five hundred on the device, in a store that says
 * it keeps a hundred, and nothing was said about it.
 *
 * The limit belongs to the store, so every writer of a stored list has to
 * know it. These tests drive the sync the way the extension drives it and
 * check that the device still keeps its limit - and that the user is told
 * what the device did not take.
 *
 * The load is the way background.js loads it: as a script in a context
 * where the functions are globals.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createPanel, flush, workerRouter } = require("./helpers/panel-harness.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const settings = require("../settings.js");

const GITHUB_ID = 1001;
const SESSION = {
  token: "test-token",
  login: "tester",
  githubId: GITHUB_ID,
  savedAt: 1,
};

/** The server's clock, as an ISO timestamp. */
const serverTime = (ms) => new Date(ms).toISOString();

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/**
 * Loads cloud-sync.js into a sandbox that answers the two list endpoints
 * and records everything else.
 */
function loadCloudSync({
  cloudNotes = [],
  cloudWords = [],
  storage = {},
  pushFails = false,
} = {}) {
  const warnings = [];
  const sandbox = {
    console: { ...console, warn: (...args) => warnings.push(args.join(" ")) },
    URL,
    Date,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      const method = (options && options.method) || "GET";
      const target = String(url);
      if (method === "GET" && target.includes("/api/notes")) {
        return jsonResponse({ notes: cloudNotes, serverTime: serverTime(1000000) });
      }
      if (method === "GET" && target.includes("/api/vocabulary")) {
        return jsonResponse({
          vocabulary: cloudWords,
          serverTime: serverTime(1000000),
        });
      }
      if (pushFails) throw new Error("the server did not answer");
      return jsonResponse({ note: {}, vocabulary: {}, serverTime: serverTime(1000000) });
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (Array.isArray(key)) {
              const out = {};
              for (const k of key) if (k in storage) out[k] = storage[k];
              return out;
            }
            return key in storage ? { [key]: storage[key] } : {};
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
      tabs: { onUpdated: { addListener() {} }, create: async () => ({ id: 1 }) },
    },
    // The real settings module, with only the network host swapped for the
    // test double. A hand-written stub goes stale the moment settings.js
    // grows a function, which breaks the sync tests instead of the code
    // that was actually wrong.
    "YTD_SETTINGS": {
      ...settings,
      GITHUB_SESSION_KEY: "ytd_github_session",
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  return { sandbox, storage, warnings };
}

/** A note as the server sends it. The newest one is the last in the list. */
function cloudNote(index, base) {
  const at = base + index;
  return {
    id: `server_${index}`,
    clientId: `note_${index}`,
    videoId: "videoA",
    videoTitle: "Video",
    channelName: "Channel",
    timestampSeconds: index,
    quote: "",
    note: `note ${index}`,
    starred: false,
    createdAt: serverTime(at),
    updatedAt: serverTime(at),
  };
}

/** A word as the server sends it. */
function cloudWord(index, base) {
  const at = base + index;
  return {
    id: `word_${index}`,
    term: `word${index}`,
    translation: `translation ${index}`,
    sentence: `sentence ${index}`,
    sentenceTranslation: "",
    videoId: "videoA",
    videoTitle: "Video",
    timestampSeconds: index,
    status: "learning",
    createdAt: serverTime(at),
    updatedAt: serverTime(at),
  };
}

function signedInStorage(extra = {}) {
  return Object.assign(
    {
      ytd_github_session: SESSION,
    },
    extra,
  );
}

test("the device keeps its note limit when the account has more notes than it can hold", async () => {
  const limit = settings.MAX_LOCAL_NOTES;
  const total = limit + 50;
  const cloudNotes = [];
  for (let index = 0; index < total; index += 1) {
    cloudNotes.push(cloudNote(index, 1000000 + index * 1000));
  }
  const { sandbox, storage } = loadCloudSync({
    cloudNotes,
    storage: signedInStorage(),
  });

  await sandbox.fullSyncNotes();

  const namespace = settings.notesStorageKey(GITHUB_ID);
  const stored = storage[namespace] || [];
  assert.equal(
    stored.length,
    limit,
    `the device took ${stored.length} notes, but it says it keeps ${limit}`,
  );
  // The newest ones are the ones that stay: the panel shows the newest
  // first, and the older notes are the ones the account still has.
  const newest = stored[0];
  assert.equal(
    newest.text,
    `note ${total - 1}`,
    "the newest note of the account is not the first one on the device",
  );
  const oldest = stored[stored.length - 1];
  assert.equal(
    oldest.text,
    `note ${total - limit}`,
    "the device kept the wrong notes: the oldest ones should be the ones it let go of",
  );
});

test("the device keeps its word limit when the account has more words than it can hold", async () => {
  const limit = settings.MAX_LOCAL_VOCABULARY;
  const total = limit + 20;
  const cloudWords = [];
  for (let index = 0; index < total; index += 1) {
    cloudWords.push(cloudWord(index, 1000000 + index * 1000));
  }
  const { sandbox, storage } = loadCloudSync({
    cloudWords,
    storage: signedInStorage(),
  });

  await sandbox.fullSyncVocabulary();

  const namespace = settings.vocabularyStorageKey(GITHUB_ID);
  const stored = storage[namespace] || [];
  assert.equal(
    stored.length,
    limit,
    `the device took ${stored.length} words, but it says it keeps ${limit}`,
  );
});

test("the user is told that the account has more notes than the device keeps", async () => {
  const limit = settings.MAX_LOCAL_NOTES;
  const total = limit + 7;
  const cloudNotes = [];
  for (let index = 0; index < total; index += 1) {
    cloudNotes.push(cloudNote(index, 1000000 + index * 1000));
  }
  const { sandbox, storage } = loadCloudSync({
    cloudNotes,
    storage: signedInStorage(),
  });

  await sandbox.fullSyncNotes();

  const key = settings.notesDroppedKey(GITHUB_ID);
  const record = storage[key];
  assert.ok(
    record,
    "the device left notes out and left no record the user could ever see",
  );
  assert.equal(
    Number(record.lastCount),
    7,
    `the record does not say how many notes were left out: ${JSON.stringify(record)}`,
  );
  // The two drops are not the same news. A note that falls off when the
  // user saves is a note the device let go of; a note that falls off when
  // the account syncs is still in the account. The panel has to be able to
  // tell them apart, so the reason is written down.
  assert.equal(
    record.lastReason,
    "sync",
    `the record does not say why the notes were left out: ${JSON.stringify(record)}`,
  );
});

test("a note the server did not accept is never the one the device drops", async () => {
  const limit = settings.MAX_LOCAL_NOTES;
  // An account with more notes than the device can hold, and one local note
  // the server refuses. That note exists nowhere else, so the limit must
  // not touch it.
  const cloudNotes = [];
  for (let index = 0; index < limit + 10; index += 1) {
    cloudNotes.push(cloudNote(index, 1000000 + index * 1000));
  }
  const localOnly = {
    id: "note_local_only",
    videoId: "videoA",
    videoTitle: "Video",
    channelName: "Channel",
    timestampSeconds: 5,
    text: "the note the server never took",
    rawText: "the note the server never took",
    starred: false,
    // Older than every note of the account. The device keeps the newest
    // ones, so this note is the first one the limit would take - unless
    // the limit knows that this one exists nowhere else.
    createdAt: 500000,
    updatedAt: 500000,
    cloudId: "",
  };
  const { sandbox, storage } = loadCloudSync({
    cloudNotes,
    storage: signedInStorage({
      [settings.notesStorageKey(GITHUB_ID)]: [localOnly],
    }),
    pushFails: true,
  });

  await sandbox.fullSyncNotes();

  const namespace = settings.notesStorageKey(GITHUB_ID);
  const stored = storage[namespace] || [];
  assert.ok(
    stored.some((item) => item.id === "note_local_only"),
    "the device dropped the one note that was nowhere else",
  );
});

test("the panel says the notes are still in the account when the account is bigger than the device", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      ytd_notes_dropped: {
        total: 50,
        lastCount: 50,
        lastAt: Date.now(),
        lastReason: "sync",
      },
    },
  });
  await panel.helpers.loadNotesDroppedNotice();
  await flush();
  const notice = panel.el("notesDroppedNotice");
  assert.equal(notice.hidden, false, "the notice is not on screen");
  assert.match(
    notice.textContent,
    /still in your account/i,
    `the panel does not say where the notes are: ${notice.textContent}`,
  );
  assert.doesNotMatch(
    notice.textContent,
    /were removed/i,
    "the panel tells the user the notes are gone when they are in their account",
  );
});

test("the panel still says a note the device dropped was dropped", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      ytd_notes_dropped: {
        total: 1,
        lastCount: 1,
        lastAt: Date.now(),
        lastReason: "save",
      },
    },
  });
  await panel.helpers.loadNotesDroppedNotice();
  await flush();
  const notice = panel.el("notesDroppedNotice");
  assert.equal(notice.hidden, false, "the notice is not on screen");
  assert.match(
    notice.textContent,
    /removed/i,
    `the panel does not say what the device did: ${notice.textContent}`,
  );
});

test("the panel says the words are still in the account when the account is bigger than the device", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      ytd_vocabulary_dropped: {
        total: 80,
        lastCount: 80,
        lastAt: Date.now(),
        lastReason: "sync",
      },
    },
  });
  await panel.helpers.loadWordsDroppedNotice();
  await flush();
  const notice = panel.el("wordsDroppedNotice");
  assert.equal(notice.hidden, false, "the notice is not on screen");
  assert.match(
    notice.textContent,
    /still in your account/i,
    `the panel does not say where the words are: ${notice.textContent}`,
  );
  assert.doesNotMatch(
    notice.textContent,
    /were removed/i,
    "the panel tells the user the words are gone when they are in their account",
  );
});
