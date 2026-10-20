/**
 * A deleted note must not come back.
 *
 * `handleDeleteNote` removed the note from the device and then asked the
 * server to remove it there too. The failure of that request was logged
 * and dropped. The note was then gone from this device but still on the
 * server, and the next full sync saw a note the cloud had and the device
 * did not - so it pulled it back. The user deleted a note and it returned.
 *
 * A delete is therefore recorded as an *intent* before it is sent: the
 * intent survives a failed request and a restart, it is scoped to the
 * account the note belongs to, and a note the user re-created is not eaten
 * by the stale intent.
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
 *
 * The storage object is handed in, so a "restart" - which is what the
 * service worker does when it is suspended and woken up again - is a new
 * sandbox over the same storage.
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
      calls.push({ url, options: options || {} });
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
            delete storage[key];
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

/** A note as it is stored on the device. */
function localNote(clientId, note, cloudId, updatedAt) {
  return {
    id: clientId,
    text: note,
    rawText: note,
    videoId: "abc123xyz",
    videoTitle: "A video",
    channelName: "A channel",
    timestampSeconds: 42,
    cloudId,
    createdAt: updatedAt,
    updatedAt,
  };
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

/** The requests of one kind. */
function requestsOf(calls, method) {
  return calls.filter((call) => (call.options.method || "GET") === method);
}

test("a deleted note does not come back when the cloud delete failed", async () => {
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note", "uuid-note_1", OLD)],
  };
  let online = false;
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        if (!online) throw new Error("the network is down");
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      // The server still has the note: the delete never arrived.
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [cloudNote("note_1", "the note")] }),
      };
    },
  });

  const deleted = await sandbox.handleDeleteNote("note_1");
  assert.equal(deleted.success, true);
  // The note leaves this device at once, even though the server was not
  // reachable: the user asked for it to be gone.
  assert.equal(storage.ytd_notes_1001.length, 0, "the note must leave the device at once");

  online = true;
  await sandbox.fullSyncNotes();
  assert.equal(
    storage.ytd_notes_1001.length,
    0,
    "the deleted note came back from the cloud",
  );
});

test("the delete that failed is sent again on the next sync", async () => {
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note", "uuid-note_1", OLD)],
  };
  let online = false;
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        if (!online) throw new Error("the network is down");
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [cloudNote("note_1", "the note")] }),
      };
    },
  });

  await sandbox.handleDeleteNote("note_1");
  // The intent is kept: the request failed.
  assert.equal(storage.ytd_pending_deletes_1001.length, 1);
  assert.equal(storage.ytd_pending_deletes_1001[0].clientId, "note_1");

  online = true;
  await sandbox.fullSyncNotes();

  const deletes = requestsOf(calls, "DELETE");
  assert.equal(deletes.length, 2, "the pending delete was not sent again");
  assert.match(deletes[1].url, /\/api\/notes\/client\/note_1$/);
  // The server confirmed it: the intent has done its job.
  assert.deepEqual(plain(storage.ytd_pending_deletes_1001), []);
});

test("the pending delete survives a restart of the extension", async () => {
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note", "uuid-note_1", OLD)],
  };
  const first = loadCloudSync({
    storage,
    fetchImpl: async () => {
      throw new Error("the network is down");
    },
  });
  await first.sandbox.handleDeleteNote("note_1");
  assert.equal(storage.ytd_pending_deletes_1001.length, 1);

  // The service worker is suspended and woken up again: a new sandbox over
  // the same storage.
  const second = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ notes: [] }) };
    },
  });
  await second.sandbox.fullSyncNotes();

  const deletes = requestsOf(second.calls, "DELETE");
  assert.equal(deletes.length, 1, "the delete was lost when the worker restarted");
  assert.match(deletes[0].url, /\/api\/notes\/client\/note_1$/);
  assert.deepEqual(plain(storage.ytd_pending_deletes_1001), []);
});

test("a delete of one account is never applied to another account's note", async () => {
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "alice's note", "uuid-alice", OLD)],
  };
  const alice = loadCloudSync({
    storage,
    fetchImpl: async () => {
      throw new Error("the network is down");
    },
  });
  await alice.sandbox.handleDeleteNote("note_1");
  assert.equal(storage.ytd_pending_deletes_1001.length, 1);
  assert.equal(storage.ytd_pending_deletes_1002, undefined);

  // Bob signs in on the same device. His note happens to carry the same
  // id, and it must survive: the delete belongs to Alice.
  storage.ytd_github_session = { token: "jwt-bob", login: "bob", githubId: 1002, savedAt: 1 };
  storage.ytd_notes_1002 = [localNote("note_1", "bob's note", "uuid-bob", OLD)];
  const bob = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [cloudNote("note_1", "bob's note")] }),
      };
    },
  });
  await bob.sandbox.fullSyncNotes();

  assert.equal(
    requestsOf(bob.calls, "DELETE").length,
    0,
    "alice's delete was sent as bob's",
  );
  assert.deepEqual(
    plain(storage.ytd_notes_1002.map((note) => note.text)),
    ["bob's note"],
    "bob's note was deleted by alice's delete",
  );
});

test("a delete the server reports as already gone is not retried forever", async () => {
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note", "uuid-note_1", OLD)],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        // The server does not know this note: there is nothing to delete.
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "Note not found." }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ notes: [] }) };
    },
  });

  await sandbox.handleDeleteNote("note_1");
  // "Already gone" is done: the intent must not be kept for ever.
  assert.deepEqual(plain(storage.ytd_pending_deletes_1001), []);

  await sandbox.fullSyncNotes();
  assert.equal(
    requestsOf(calls, "DELETE").length,
    1,
    "a delete that is already done was sent again",
  );
});

test("a note the user re-created is not eaten by the stale pending delete", async () => {
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note", "uuid-note_1", OLD)],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        // The delete never reaches the server.
        throw new Error("the network is down");
      }
      if (options.method === "POST") {
        return { ok: true, status: 201, json: async () => ({ note: { id: "uuid-note_1" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [cloudNote("note_1", "the note")] }),
      };
    },
  });

  await sandbox.handleDeleteNote("note_1");
  assert.equal(storage.ytd_pending_deletes_1001.length, 1);

  // The user saves the note again. The push that follows is newer than the
  // delete that is still on its way, so the delete is dropped.
  await sandbox.saveNoteToStorage(
    localNote("note_1", "the note again", "", Date.now()),
  );
  assert.deepEqual(
    plain(storage.ytd_pending_deletes_1001),
    [],
    "the stale delete was not dropped when the note was written again",
  );

  await sandbox.fullSyncNotes();
  assert.equal(
    requestsOf(calls, "DELETE").length,
    1,
    "the stale delete was sent again after the note was written again",
  );
  assert.deepEqual(
    plain(storage.ytd_notes_1001.map((note) => note.text)),
    ["the note again"],
    "the note the user re-created was eaten by the stale delete",
  );
});

test("a note the user re-created survives a stale pending delete even when the cloud copy is newer", async () => {
  // The hard case: the note the user wrote again is OLDER than the copy on
  // the server, so the merge would normally prefer the cloud copy. The
  // delete that is still on its way says the note is gone, so the note the
  // user wrote again must win - the delete is older than the note.
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note", "uuid-note_1", OLD)],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        throw new Error("the network is down");
      }
      if (options.method === "POST") {
        return { ok: true, status: 201, json: async () => ({ note: { id: "uuid-note_1" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ notes: [cloudNote("note_1", "the note")] }),
      };
    },
  });

  await sandbox.handleDeleteNote("note_1");
  // The note is written again, but its own timestamp is older than the
  // cloud copy: the delete still has to lose.
  await sandbox.saveNoteToStorage(
    localNote("note_1", "the note again", "", OLD + 1000),
  );

  await sandbox.fullSyncNotes();

  assert.deepEqual(
    plain(storage.ytd_notes_1001.map((note) => note.text)),
    ["the note again"],
    "the note the user re-created was eaten by the stale delete",
  );
  assert.deepEqual(
    plain(storage.ytd_pending_deletes_1001),
    [],
    "the stale delete was not dropped",
  );
  // The note is on the server again, so the delete has nothing left to do.
  assert.equal(
    requestsOf(calls, "DELETE").length,
    1,
    "the stale delete was sent again after the note was written again",
  );
});

test("a note pushed by a sync cancels the pending delete instead of being deleted by it", async () => {
  // The note is written again while the network is down, so the push of
  // the save cannot confirm it. The next sync pushes it - and that push is
  // what cancels the delete, because the note is newer than the delete.
  const onServer = new Set(["note_1"]);
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note", "uuid-note_1", OLD)],
  };
  let online = false;
  const { sandbox } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      const method = options.method || "GET";
      if (method === "DELETE") {
        if (!online) throw new Error("the network is down");
        const id = decodeURIComponent(url.split("/client/")[1]);
        onServer.delete(id);
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      if (method === "POST") {
        if (!online) throw new Error("the network is down");
        onServer.add(JSON.parse(options.body).clientId);
        return { ok: true, status: 201, json: async () => ({ note: { id: "uuid-note_1" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          notes: [...onServer].map((id) => cloudNote(id, "the note")),
        }),
      };
    },
  });

  await sandbox.handleDeleteNote("note_1");
  await sandbox.saveNoteToStorage(
    localNote("note_1", "the note again", "", Date.now()),
  );
  // The push of the save failed with the network: the intent is still
  // there.
  assert.equal(storage.ytd_pending_deletes_1001.length, 1);

  online = true;
  await sandbox.fullSyncNotes();

  assert.deepEqual(
    plain(storage.ytd_pending_deletes_1001),
    [],
    "the pending delete was not cancelled by the push",
  );
  assert.deepEqual(
    [...onServer],
    ["note_1"],
    "the note the user re-created was deleted on the server by the stale delete",
  );
});

test("a delete that is older than the note is dropped before the merge", async () => {
  // The write happened after the delete was recorded, so the write is
  // newer. The delete must not be applied to the note - not by the merge
  // and not by the delete that is sent again.
  //
  // The note carries a cloud id, so the merge does not push it: this
  // isolates the ordering rule from the push that cancels a delete.
  const storage = {
    ytd_github_session: SESSION,
    ytd_notes_1001: [localNote("note_1", "the note again", "uuid-note_1", OLD + 1000)],
  };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          // The cloud copy is newer than the note on the device, so the
          // merge would take it - but the note must not disappear.
          notes: [cloudNote("note_1", "the note again", "2026-06-01T00:00:00Z")],
        }),
      };
    },
  });

  // The delete is recorded with a timestamp that is older than the note:
  // this is the state a device is in when the note was written again
  // while the delete was still on its way.
  storage.ytd_pending_deletes_1001 = [
    { clientId: "note_1", deletedAt: OLD - 1000 },
  ];

  await sandbox.fullSyncNotes();

  assert.deepEqual(
    plain(storage.ytd_pending_deletes_1001),
    [],
    "a delete that is older than the note was kept",
  );
  assert.equal(
    requestsOf(calls, "DELETE").length,
    0,
    "a delete that is older than the note was sent to the server",
  );
  assert.deepEqual(
    plain(storage.ytd_notes_1001.map((note) => note.text)),
    ["the note again"],
    "the note the user re-created was eaten by the stale delete",
  );
});
