/**
 * `starred` fidelity across the extension <-> cloud boundary.
 *
 * The favorite flag lives in Postgres (notes.starred) and is written by the
 * web dashboard, but for a long time cloud-sync.js never carried it in either
 * direction. Nothing errored: a full sync simply overwrote the local copy with
 * a cloud copy that had no `starred`, so a favorite set in the dashboard was
 * silently dropped, and a local favorite was never pushed up.
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
function loadCloudSync({ fetchImpl, storage = {} } = {}) {
  const calls = [];
  const sandbox = {
    console,
    URL,
    Date,
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
    // Quoted: an unquoted `YTD_SETTINGS:` at statement position would parse as
    // a label rather than a property name.
    "YTD_SETTINGS": {
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
  assert.equal(patch.body.starred, true, "the star must be preserved on an edit");
  assert.equal(patch.body.note, "new text");
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
