/**
 * The sync at the size a real account reaches.
 *
 * Every time the panel opened, the extension pulled the whole account: all
 * the notes and all the words, again, one row at a time in the JSON. An
 * account with twenty thousand notes made the panel wait for twenty
 * thousand rows before it showed anything, and the account cap allows
 * twenty thousand notes, so the slow case is the case the product promises
 * to support.
 *
 * The fix is the delta: the device remembers how far it has seen the
 * account and asks for what changed since then. Three rules make that
 * safe, and each of them is a test here.
 *
 * - A delta that says it left rows out is not the whole truth. The device
 *   pulls the whole list instead and does not move its cursor.
 * - A row the delta does not mention did not change on the service. It is
 *   not a deletion, and it stays on the device.
 * - The deletions travel with the delta. A row the service says was
 *   deleted somewhere else leaves the device.
 *
 * The tests drive the real code against a fake chrome.storage and a fake
 * fetch, the same way the extension loads it in the service worker.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Loads cloud-sync.js into a sandbox with a fake storage and a fake fetch.
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
      calls.push({
        url,
        options: options || {},
        body: options && options.body ? JSON.parse(options.body) : null,
      });
      return fetchImpl(url, options || {});
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (key === null) return { ...storage };
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
            for (const name of Array.isArray(key) ? key : [key]) {
              delete storage[name];
            }
          },
        },
      },
      runtime: { sendMessage: async () => ({}) },
      tabs: { onUpdated: { addListener() {} }, create: async () => ({ id: 1 }) },
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

const SESSION = { token: "jwt-token", login: "alice", githubId: 1001, savedAt: 1 };
const NOTES_KEY = "ytd_notes_1001";
const CURSOR_KEY = "ytd_sync_cursor_notes_1001";

/** A moment long before the cloud copy of a note was written. */
const OLD = Date.parse("2026-01-01T00:00:00Z");

/** A note as it comes back from the cloud. */
function cloudNote(clientId, note, updatedAt) {
  return {
    id: "uuid-" + clientId,
    clientId,
    note,
    videoId: "abc123xyz",
    videoTitle: "A video",
    channelName: "A channel",
    timestampSeconds: 42,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: updatedAt || "2026-01-01T00:00:00Z",
  };
}

/** A note as it is on the device. */
function localNote(clientId, note, cloudId, updatedAt) {
  return {
    id: clientId,
    text: note,
    rawText: note,
    videoId: "abc123xyz",
    videoTitle: "A video",
    channelName: "A channel",
    timestampSeconds: 42,
    createdAt: updatedAt,
    updatedAt: updatedAt,
    cloudId: cloudId === undefined ? "" : cloudId,
  };
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * A delta as the service sends it: what changed, what was deleted, and
 * whether anything was left out.
 */
function delta({ notes = [], vocabulary = [], deletedNotes = [], deletedVocabulary = [], truncated, serverTime } = {}) {
  const body = {
    notes,
    vocabulary,
    deleted: { notes: deletedNotes, vocabulary: deletedVocabulary },
    serverTime: serverTime || "2026-02-02T00:00:00.000Z",
  };
  if (truncated) {
    body.truncated = {
      notes: false,
      vocabulary: false,
      deletedNotes: false,
      deletedVocabulary: false,
      ...truncated,
    };
  }
  return body;
}

test("a device that knows how far it has seen the account asks for the delta", async () => {
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) return jsonResponse(delta());
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.fullSyncNotes();

  const asked = calls.filter((call) => call.url.includes("/api/sync?since="));
  assert.equal(asked.length, 1, "the device did not ask for the delta");
  assert.match(
    decodeURIComponent(asked[0].url),
    /since=2026-02-01T00:00:00\.000Z/,
    "the delta must be asked for since the moment the device last saw the account",
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/api/notes")).length,
    0,
    "the whole account was pulled even though the device knew what changed",
  );
});

test("the cursor moves only after the rows are on the device", async () => {
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [],
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) {
        return jsonResponse(
          delta({
            notes: [cloudNote("note_1", "a note from another device")],
            serverTime: "2026-02-03T00:00:00.000Z",
          }),
        );
      }
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.fullSyncNotes();

  assert.equal(
    storage[CURSOR_KEY],
    "2026-02-03T00:00:00.000Z",
    "the cursor did not move to the moment the device saw the account",
  );
  assert.equal(
    (storage[NOTES_KEY] || []).length,
    1,
    "the note from the delta did not arrive",
  );
});

test("a delta that says it left rows out is not trusted", async () => {
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) {
        // The service says it left rows out. The device cannot know which
        // ones, so the delta is not the truth and the whole list is pulled.
        return jsonResponse(
          delta({
            notes: [cloudNote("note_1", "one note of many")],
            truncated: { notes: true },
            serverTime: "2026-02-03T00:00:00.000Z",
          }),
        );
      }
      return jsonResponse({
        notes: [cloudNote("note_1", "one note of many")],
        serverTime: "2026-02-04T00:00:00.000Z",
        truncated: false,
      });
    },
  });

  await sandbox.fullSyncNotes();

  assert.equal(
    calls.filter((call) => call.url.endsWith("/api/notes")).length,
    1,
    "the whole list was not pulled after a truncated delta",
  );
  assert.equal(
    storage[CURSOR_KEY],
    "2026-02-04T00:00:00.000Z",
    "the cursor did not move to the moment the whole list was read",
  );
  assert.notEqual(
    storage[CURSOR_KEY],
    "2026-02-03T00:00:00.000Z",
    "the cursor moved past rows the device never saw",
  );
});

test("a delta as long as a whole page is not trusted either", async () => {
  // An older service does not say whether it left rows out. A delta that
  // is as long as a page may have been cut, so it is not the truth.
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [],
  };
  const many = [];
  for (let index = 0; index < 5000; index += 1) {
    many.push(cloudNote("note_" + index, "text " + index));
  }
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) return jsonResponse(delta({ notes: many }));
      return jsonResponse({ notes: [], truncated: false });
    },
  });

  await sandbox.fullSyncNotes();

  assert.equal(
    calls.filter((call) => call.url.endsWith("/api/notes")).length,
    1,
    "a delta that may have been cut was trusted",
  );
  assert.equal(
    storage[CURSOR_KEY],
    "2026-02-01T00:00:00.000Z",
    "the cursor moved past rows the device never saw",
  );
});

test("a list the service says it cut does not move the cursor", async () => {
  // The whole list is the account, unless the service says it left rows
  // out. A cursor that moves past those rows hides them for good.
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [],
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) {
        // This service has no delta route at all.
        return jsonResponse({ error: "Not found" }, 404);
      }
      return jsonResponse({
        notes: [cloudNote("note_1", "one note of many")],
        truncated: true,
        serverTime: "2026-02-04T00:00:00.000Z",
      });
    },
  });

  await sandbox.fullSyncNotes();

  assert.equal(
    storage[CURSOR_KEY],
    "2026-02-01T00:00:00.000Z",
    "the cursor moved past rows the device never saw",
  );
});

test("an edit made on this device is marked as waiting to be sent", async () => {
  // The edit reaches the service on its own. When that request fails, the
  // mark is what makes the next sync send it anyway.
  const storage = {
    ytd_github_session: SESSION,
    [NOTES_KEY]: [localNote("note_1", "before", "uuid-note_1", OLD)],
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "PATCH") throw new Error("the network is down");
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.handleUpdateNote("note_1", "after");

  assert.equal(storage[NOTES_KEY][0].text, "after");
  assert.equal(
    storage[NOTES_KEY][0].dirty,
    true,
    "the edit is not marked as waiting to be sent",
  );
});

test("an edit the service took is no longer waiting to be sent", async () => {
  const storage = {
    ytd_github_session: SESSION,
    [NOTES_KEY]: [localNote("note_1", "before", "uuid-note_1", OLD)],
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "PATCH") return jsonResponse({ note: { id: "uuid-note_1" } });
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.handleUpdateNote("note_1", "after");

  assert.equal(storage[NOTES_KEY][0].text, "after");
  assert.equal(
    storage[NOTES_KEY][0].dirty,
    false,
    "the row is still marked as waiting to be sent",
  );
});

test("a row the delta does not mention stays on the device", async () => {
  // The delta only says what changed. A row that is not in it did not
  // change on the service, so it is not a deletion.
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [localNote("note_1", "a note nobody touched", "uuid-note_1", OLD)],
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) return jsonResponse(delta());
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.fullSyncNotes();

  const stored = storage[NOTES_KEY] || [];
  assert.equal(stored.length, 1, "a row the delta did not mention was dropped");
  assert.equal(stored[0].id, "note_1");
});

test("a row the service says was deleted elsewhere leaves the device", async () => {
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [
      localNote("note_1", "deleted on the dashboard", "uuid-note_1", OLD),
      localNote("note_2", "still there", "uuid-note_2", OLD),
    ],
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) {
        return jsonResponse(delta({ deletedNotes: [{ clientId: "note_1" }] }));
      }
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.fullSyncNotes();

  const stored = storage[NOTES_KEY] || [];
  assert.deepEqual(
    stored.map((note) => note.id),
    ["note_2"],
    "the deleted note is still on the device",
  );
});

test("a note deleted on the dashboard leaves the device when the whole list is pulled", async () => {
  // The whole list is the same promise as the delta: a row the service no
  // longer holds was deleted somewhere else.
  const storage = {
    ytd_github_session: SESSION,
    [NOTES_KEY]: [localNote("note_1", "deleted on the dashboard", "uuid-note_1", OLD)],
  };
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (url.includes("/api/sync")) return jsonResponse(delta());
      return jsonResponse({ notes: [], truncated: false });
    },
  });

  await sandbox.fullSyncNotes();

  assert.deepEqual(
    (storage[NOTES_KEY] || []).map((note) => note.id),
    [],
    "the note deleted elsewhere is still on the device",
  );
});

test("an edit made on this device is sent even when the delta does not mention it", async () => {
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [
      {
        ...localNote("note_1", "edited here", "uuid-note_1", OLD),
        dirty: true,
      },
    ],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (url.includes("/api/sync")) return jsonResponse(delta());
      if (options.method === "POST") {
        return jsonResponse({ note: { id: "uuid-note_1", clientId: "note_1" } });
      }
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.fullSyncNotes();

  const posts = calls.filter((call) => call.options.method === "POST");
  assert.equal(posts.length, 1, "the edit was not sent");
  assert.equal(posts[0].body.clientId, "note_1");
  assert.equal(posts[0].body.note, "edited here");
  assert.equal(
    storage[NOTES_KEY][0].dirty,
    false,
    "the row is still marked as waiting to be sent",
  );
});

test("a row the service did not take is sent again on its own", async () => {
  // The service answers the batch without reporting the rows. A row it
  // does not mention is not on the service, so it is sent again: an answer
  // that quietly drops rows would lose them.
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [
      localNote("note_1", "first", "", OLD),
      localNote("note_2", "second", "", OLD),
    ],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (url.includes("/api/sync")) {
        if (options.method === "POST") {
          // The batch route answers, but it only reports one of the rows.
          return jsonResponse({
            pushed: { notes: [{ clientId: "note_1", id: "uuid-note_1" }] },
          });
        }
        return jsonResponse(delta());
      }
      if (options.method === "POST") {
        return jsonResponse({ note: { id: "uuid-note_2", clientId: "note_2" } });
      }
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.fullSyncNotes();

  const single = calls.filter(
    (call) => call.options.method === "POST" && call.url.endsWith("/api/notes"),
  );
  assert.equal(single.length, 1, "the row the service did not report was not sent again");
  assert.equal(single[0].body.clientId, "note_2");
});

test("a service without the batch route gets the rows one by one", async () => {
  const storage = {
    ytd_github_session: SESSION,
    [CURSOR_KEY]: "2026-02-01T00:00:00.000Z",
    [NOTES_KEY]: [
      localNote("note_1", "first", "", OLD),
      localNote("note_2", "second", "", OLD),
    ],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (url.includes("/api/sync") && options.method === "POST") {
        // The route is not deployed on this service.
        return jsonResponse({ error: "Not found" }, 404);
      }
      if (url.includes("/api/sync")) return jsonResponse(delta());
      if (options.method === "POST") {
        return jsonResponse({ note: { id: "uuid-" + JSON.parse(options.body).clientId } });
      }
      return jsonResponse({ notes: [] });
    },
  });

  await sandbox.fullSyncNotes();

  const single = calls.filter(
    (call) => call.options.method === "POST" && call.url.endsWith("/api/notes"),
  );
  assert.equal(single.length, 2, "the rows were not sent one by one");
  assert.deepEqual(
    single.map((call) => call.body.clientId).sort(),
    ["note_1", "note_2"],
  );
});
