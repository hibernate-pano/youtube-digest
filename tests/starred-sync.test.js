/**
 * `starred` fidelity across the extension <-> cloud boundary.
 *
 * The favorite flag lives in Postgres (notes.starred) and is written by the
 * web dashboard, but for a long time cloud-sync.js never carried it in either
 * direction. Nothing errored: a full sync simply overwrote the local copy with
 * a cloud copy that had no `starred`, so a favorite set in the dashboard was
 * silently dropped, and a local favorite was never pushed up.
 *
 * The second half of this file covers the same merge from the other side:
 * the timestamps the merge compares come from two different clocks (the
 * server's for the cloud rows, the device's for the local ones), and a
 * device with a wrong clock used to win or lose every single conflict.
 *
 * These tests load cloud-sync.js the same way background.js does (via
 * importScripts, so the functions are globals) and drive the two pure
 * conversion helpers plus the merge that uses them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/** Load cloud-sync.js into a sandbox that records fetch calls and storage. */
function loadCloudSync({ fetchImpl, storage = {}, now, warnings } = {}) {
  const calls = [];
  // A device clock can be simulated: every timestamp the sync layer writes
  // or compares comes from Date.now().
  const Clock = now
    ? class extends Date {
        static now() {
          return now;
        }
      }
    : Date;
  const sandbox = {
    console: warnings
      ? { ...console, warn: (...args) => warnings.push(args.join(" ")) }
      : console,
    URL,
    Date: Clock,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options, body: options && options.body ? JSON.parse(options.body) : null });
      return fetchImpl(url, options);
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (Array.isArray(key)) {
              const out = {};
              for (const k of key) if (key in storage) out[k] = storage[k];
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
    // The real settings module is loaded, with only the network host
    // swapped for the test double. A hand-written stub silently went stale
    // the moment settings.js grew a function, which broke the sync tests
    // instead of the code that was actually wrong.
    "YTD_SETTINGS": {
      ...require("../settings.js"),
      GITHUB_SESSION_KEY: "ytd_github_session",
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  return { sandbox, calls, storage };
}

const SESSION = {
  token: "test-token",
  login: "alice",
  githubId: 1001,
  savedAt: 1,
};

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/** The server's clock, as an ISO timestamp. */
const serverTime = (ms) => new Date(ms).toISOString();

test("a starred note pulled from the cloud keeps its favorite locally", () => {
  const { sandbox } = loadCloudSync();
  const local = sandbox.cloudToLocalNote({
    id: "server-1",
    clientId: "note_1",
    videoId: "abc123xyz",
    videoTitle: "Video",
    channelName: "Channel",
    timestampSeconds: 90,
    note: "text",
    starred: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  });
  assert.equal(local.starred, true, "the favorite must survive the download");
  assert.equal(local.id, "note_1");
});

test("an unstarred cloud note is not mistaken for a favorite", () => {
  const { sandbox } = loadCloudSync();
  const local = sandbox.cloudToLocalNote({
    clientId: "note_1",
    note: "text",
    starred: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  });
  assert.equal(local.starred, false);
});

test("a cloud note with no starred field at all resolves to false", () => {
  const { sandbox } = loadCloudSync();
  const local = sandbox.cloudToLocalNote({
    clientId: "note_1",
    note: "text",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  });
  assert.equal(local.starred, false, "missing means unstarred, never undefined leaking through");
});

test("a local favorite is uploaded with the note payload", () => {
  const { sandbox } = loadCloudSync();
  const payload = sandbox.localNoteToCloudPayload({
    id: "note_1",
    text: "text",
    videoId: "abc123xyz",
    videoTitle: "Video",
    channelName: "Channel",
    timestampSeconds: 5,
    starred: true,
  });
  assert.equal(payload.starred, true, "starred must be pushed up, not only downloaded");
});

test("a local note without a starred field omits it entirely", () => {
  const { sandbox } = loadCloudSync();
  const payload = sandbox.localNoteToCloudPayload({ id: "note_1", text: "text" });
  assert.ok(
    !("starred" in payload),
    "sending a defaulted false would clear favorites set in the dashboard",
  );
});

test("a full sync preserves a favorite the user set in the dashboard", async () => {
  const cloudNote = {
    id: "server-1",
    clientId: "note_1",
    videoId: "abc123xyz",
    videoTitle: "Video",
    channelName: "Channel",
    timestampSeconds: 10,
    note: "text",
    starred: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-05T00:00:00Z",
  };
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/notes")) return jsonResponse({ notes: [cloudNote] });
      return jsonResponse({ note: { id: "server-1" } });
    },
  });

  // The local copy is stale and has no star; the cloud copy is newer and starred.
  storage.ytd_notes_1001 = [
    { id: "note_1", text: "text", updatedAt: 0, createdAt: 0, cloudId: "server-1" },
  ];

  const result = await sandbox.fullSyncNotes();

  assert.equal(result.success, true, JSON.stringify(result));
  const merged = storage.ytd_notes_1001;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].starred, true, "the dashboard favorite must survive the sync");
  assert.equal(
    calls.filter((call) => call.options && call.options.method === "POST").length,
    0,
    "a cloud-won merge must not be pushed back",
  );
});

test("a full sync uploads a local favorite to the cloud", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options && options.method === "POST") {
        return jsonResponse({ note: { id: "server-new", clientId: "note_2" } });
      }
      return jsonResponse({ notes: [] });
    },
  });

  storage.ytd_notes_1001 = [
    {
      id: "note_2",
      text: "local favorite",
      videoId: "abc123xyz",
      updatedAt: 10,
      createdAt: 10,
      starred: true,
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const post = calls.find((call) => call.options && call.options.method === "POST");
  assert.ok(post, "a local-only note must be pushed");
  assert.equal(post.body.starred, true, "the uploaded payload must carry the favorite");
});

test("a text-only edit does not clear the favorite", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options && options.method === "PATCH") {
        return jsonResponse({ note: { id: "server-1", starred: true } });
      }
      return jsonResponse({ notes: [] });
    },
  });

  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "old",
      cloudId: "server-1",
      starred: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const result = await sandbox.handleUpdateNote("note_1", "new text");
  assert.equal(result.success, true, JSON.stringify(result));

  const patch = calls.find((call) => call.options && call.options.method === "PATCH");
  assert.ok(patch, "an edit to a synced note must PATCH the cloud");
  // The edit never touched the favorite, so the flag is left out of the
  // payload entirely: the server keeps the stored value, which is the
  // stronger guarantee - sending the local copy could only ever clear it.
  assert.ok(
    !("starred" in patch.body),
    "a text edit must not carry the favorite flag at all",
  );
  assert.equal(patch.body.note, "new text");
});

test("an explicit star change on this device is pushed to the cloud", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options && options.method === "PATCH") {
        return jsonResponse({ note: { id: "server-1", starred: true } });
      }
      return jsonResponse({ notes: [] });
    },
  });

  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "a note",
      cloudId: "server-1",
      starred: false,
      starredSynced: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const result = await sandbox.handleSetNoteStarred("note_1", true);
  assert.equal(result.success, true, JSON.stringify(result));

  const patch = calls.find((call) => call.options && call.options.method === "PATCH");
  assert.ok(patch, "a star click must reach the cloud");
  assert.equal(patch.url, "https://sync.test/api/notes/server-1/star");
  assert.equal(patch.body.starred, true, "the new star must be sent");
  // The star endpoint only carries the flag, so a star click can never
  // rewrite the note text.
  assert.equal(patch.body.note, undefined);

  const stored = storage.ytd_notes_1001[0];
  assert.equal(stored.starred, true);
  assert.equal(stored.starredDirty, false, "a confirmed star is no longer pending");
  assert.equal(stored.starredSynced, true, "the confirmed star is the new baseline");
});

test("a sync that did not touch the favorite never sends the flag", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options && options.method === "POST") {
        return jsonResponse({ note: { id: "server-1" } });
      }
      return jsonResponse({
        notes: [
          {
            id: "server-1",
            clientId: "note_1",
            note: "old text",
            videoId: "abc123xyz",
            starred: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
    },
  });

  // A note the server already knows, with the flag it last confirmed.
  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "edited here",
      cloudId: "server-1",
      starred: false,
      starredSynced: false,
      createdAt: 1,
      updatedAt: Date.parse("2026-02-01T00:00:00Z"),
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const post = calls.find((call) => call.options && call.options.method === "POST");
  assert.ok(post, "the local edit must be pushed");
  assert.ok(
    !("starred" in post.body),
    "the favorite flag may only travel when the user changed it here",
  );
});

test("the dashboard's star survives a sync that pushes a local edit", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options && options.method === "POST") {
        return jsonResponse({ note: { id: "server-1" } });
      }
      return jsonResponse({
        notes: [
          {
            id: "server-1",
            clientId: "note_1",
            note: "old text",
            videoId: "abc123xyz",
            starred: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
          },
        ],
      });
    },
  });

  // The local copy is newer (it was edited here) but its favorite flag is
  // the stale one: the star was set in the dashboard afterwards.
  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "new text",
      cloudId: "server-1",
      starred: false,
      starredSynced: false,
      createdAt: 1,
      updatedAt: Date.parse("2026-01-03T00:00:00Z"),
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const post = calls.find((call) => call.options && call.options.method === "POST");
  assert.ok(post, "the newer local edit must be pushed");
  assert.ok(
    !("starred" in post.body),
    "the stale local flag must never overwrite the star set in the dashboard",
  );
  const merged = storage.ytd_notes_1001[0];
  assert.equal(merged.starred, true, "the merged copy shows the star from the cloud");
});

test("a star the user changed here wins over the cloud copy", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async (url, options) => {
      if (options && options.method === "POST") {
        return jsonResponse({ note: { id: "server-1" } });
      }
      return jsonResponse({
        notes: [
          {
            id: "server-1",
            clientId: "note_1",
            note: "text",
            videoId: "abc123xyz",
            starred: false,
            createdAt: "2026-01-01T00:00:00Z",
            // The cloud copy is the newer one, so the row itself is the
            // cloud's - but the star was changed here and never sent.
            updatedAt: "2026-06-01T00:00:00Z",
          },
        ],
      });
    },
  });

  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "text",
      cloudId: "server-1",
      starred: true,
      starredSynced: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const post = calls.find((call) => call.options && call.options.method === "POST");
  assert.ok(post, "the pending star change must be pushed");
  assert.equal(post.body.starred, true, "the star the user set here must be sent");
  const merged = storage.ytd_notes_1001[0];
  assert.equal(merged.starred, true);
  assert.equal(merged.starredSynced, true, "a confirmed star becomes the baseline");
});

test("the note push path used when saving also carries the favorite", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    fetchImpl: async () => jsonResponse({ note: { id: "server-1" } }),
  });
  storage.ytd_notes_1001 = [];
  await sandbox.saveNoteToStorage({
    id: "note_3",
    text: "hello",
    videoId: "abc123xyz",
    timestampSeconds: 3,
    starred: true,
  });
  const post = calls.find((call) => call.options && call.options.method === "POST");
  assert.ok(post);
  assert.equal(post.body.starred, true);
});

// ============================================================
// CLOCK SKEW
// ============================================================

/**
 * The server's clock is the only trustworthy one: the cloud rows are
 * stamped by the server, the local rows by the device. These tests run the
 * merge with a device clock that is deliberately wrong.
 */
const SERVER_NOW = Date.parse("2026-05-01T12:00:00Z");
const HOUR = 3600000;
const DAY = 24 * HOUR;

function cloudNote(overrides) {
  return Object.assign(
    {
      id: "server-1",
      clientId: "note_1",
      videoId: "abc123xyz",
      videoTitle: "Video",
      channelName: "Channel",
      timestampSeconds: 10,
      note: "edited in the dashboard",
      starred: false,
      createdAt: serverTime(SERVER_NOW - 10 * DAY),
      updatedAt: serverTime(SERVER_NOW),
    },
    overrides,
  );
}

test("a device clock that runs fast does not roll back the dashboard's change", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    // The device clock is two hours ahead of the server's.
    now: SERVER_NOW + 2 * HOUR,
    fetchImpl: async (url, options) => {
      if (options && options.method === "POST") {
        return jsonResponse({ note: { id: "server-1" } });
      }
      return jsonResponse({ notes: [cloudNote()], serverTime: serverTime(SERVER_NOW) });
    },
  });

  // The note was edited in the extension an hour before the server's now,
  // so the device wrote a timestamp that is one hour in the future.
  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "edited in the extension",
      cloudId: "server-1",
      starred: false,
      starredSynced: false,
      createdAt: SERVER_NOW - 5 * DAY,
      updatedAt: SERVER_NOW + HOUR,
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const merged = storage.ytd_notes_1001[0];
  assert.equal(
    merged.text,
    "edited in the dashboard",
    "the newer change must not be rolled back by a fast device clock",
  );
  assert.equal(
    calls.filter((call) => call.options && call.options.method === "POST").length,
    0,
    "a cloud-won merge must not be pushed back",
  );
});

test("a device clock that runs slow does not lose the note written in the extension", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    // The device clock is two hours behind the server's.
    now: SERVER_NOW - 2 * HOUR,
    fetchImpl: async (url, options) => {
      if (options && options.method === "POST") {
        return jsonResponse({ note: { id: "server-1" } });
      }
      return jsonResponse({
        notes: [cloudNote({ updatedAt: serverTime(SERVER_NOW - 2 * HOUR) })],
        serverTime: serverTime(SERVER_NOW),
      });
    },
  });

  // The note was edited in the extension an hour before the server's now,
  // so the device wrote a timestamp three hours in the past.
  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "edited in the extension",
      cloudId: "server-1",
      starred: false,
      starredSynced: false,
      createdAt: SERVER_NOW - 5 * DAY,
      updatedAt: SERVER_NOW - 3 * HOUR,
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const post = calls.find((call) => call.options && call.options.method === "POST");
  assert.ok(post, "the newer local edit must be pushed");
  assert.equal(post.body.note, "edited in the extension");
  const merged = storage.ytd_notes_1001[0];
  assert.equal(merged.text, "edited in the extension");
});

test("a server that does not report its time keeps the previous comparison", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox } = loadCloudSync({
    storage,
    now: SERVER_NOW,
    fetchImpl: async () => jsonResponse({ notes: [cloudNote()] }),
  });

  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "edited in the extension",
      cloudId: "server-1",
      starred: false,
      starredSynced: false,
      createdAt: SERVER_NOW - 5 * DAY,
      updatedAt: SERVER_NOW - HOUR,
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const merged = storage.ytd_notes_1001[0];
  assert.equal(
    merged.text,
    "edited in the dashboard",
    "without a server clock the raw timestamps still decide",
  );
  assert.equal(
    storage.ytd_clock_offset,
    undefined,
    "no offset can be measured without a server timestamp",
  );
});

test("an implausible clock offset keeps both copies instead of overwriting", async () => {
  const warnings = [];
  const storage = { ytd_github_session: SESSION };
  const { sandbox, calls } = loadCloudSync({
    storage,
    warnings,
    // The device clock is three days off: the local timestamps cannot be
    // placed on the server's timeline at all.
    now: SERVER_NOW + 3 * DAY,
    fetchImpl: async (url, options) => {
      if (options && options.method === "POST") {
        return jsonResponse({ note: { id: "server-1" } });
      }
      return jsonResponse({ notes: [cloudNote()], serverTime: serverTime(SERVER_NOW) });
    },
  });

  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "edited in the extension",
      cloudId: "server-1",
      starred: false,
      starredSynced: false,
      createdAt: SERVER_NOW - 5 * DAY,
      updatedAt: SERVER_NOW - 3 * DAY,
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const merged = storage.ytd_notes_1001[0];
  assert.equal(
    merged.text,
    "edited in the extension",
    "the local copy must not be overwritten when the clock cannot be trusted",
  );
  assert.equal(
    calls.filter((call) => call.options && call.options.method === "POST").length,
    0,
    "the cloud copy must not be overwritten either",
  );
  assert.ok(
    warnings.some((message) => /clock/i.test(message)),
    "an implausible offset must be reported",
  );
});

test("the measured offset is remembered so the next sync does not have to measure it again", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox } = loadCloudSync({
    storage,
    now: SERVER_NOW + 2 * HOUR,
    fetchImpl: async () =>
      jsonResponse({ notes: [], serverTime: serverTime(SERVER_NOW) }),
  });

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, true, JSON.stringify(result));

  const sample = storage.ytd_clock_offset;
  assert.ok(sample, "the offset must be persisted");
  assert.equal(sample.offset, -2 * HOUR, "the offset is the server clock minus the device clock");
  assert.equal(sample.trusted, true);
});

test("a failed sync leaves the local notes untouched", async () => {
  const storage = { ytd_github_session: SESSION };
  const { sandbox } = loadCloudSync({
    storage,
    now: SERVER_NOW,
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });

  storage.ytd_notes_1001 = [
    {
      id: "note_1",
      text: "written while offline",
      cloudId: "server-1",
      starred: true,
      starredSynced: true,
      createdAt: SERVER_NOW - DAY,
      updatedAt: SERVER_NOW - HOUR,
    },
  ];

  const result = await sandbox.fullSyncNotes();
  assert.equal(result.success, false, "the sync must report the failure");
  const notes = storage.ytd_notes_1001;
  assert.equal(notes.length, 1, "no note may be dropped by a failed sync");
  assert.equal(notes[0].text, "written while offline");
  assert.equal(notes[0].starred, true);
});
