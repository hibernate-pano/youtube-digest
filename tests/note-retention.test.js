const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * The local note store has a cap: the newest 100 notes are kept and the
 * older ones are dropped.
 *
 * The cap is reasonable. Dropping the notes without saying so is not: the
 * user wrote something, it was in the panel, and then it was gone with no
 * message. If the notes were never synced, they are gone for good.
 *
 * These tests load cloud-sync.js the way background.js does and check what
 * the store does at the boundary.
 */

function loadCloudSync({ storage = {} } = {}) {
  const sandbox = {
    console,
    URL,
    Date,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error("no network in this test");
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
    "YTD_SETTINGS": {
      ...require("../settings.js"),
      GITHUB_SESSION_KEY: "ytd_github_session",
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  return { sandbox, storage };
}

function note(index, createdAt) {
  return {
    id: `note_${index}`,
    clientId: `note_${index}`,
    videoId: "videoA",
    videoTitle: "Video",
    channelName: "Channel",
    timestampSeconds: index,
    quote: "",
    note: `note ${index}`,
    starred: false,
    createdAt,
    updatedAt: createdAt,
  };
}

test("the note store tells the user when it drops an old note", async () => {
  const { sandbox, storage } = loadCloudSync({ storage: {} });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    // Fill the store past the cap, then save one more note.
    const existing = [];
    for (let index = 0; index < 100; index += 1) {
      existing.push(note(index, 1000 + index));
    }
    storage.ytd_notes = existing;

    await sandbox.saveNoteToStorage(note(999, 999999));

    const stored = storage.ytd_notes;
    assert.equal(stored.length, 100, "the store kept more than its cap");
    assert.equal(
      stored[0].note,
      "note 999",
      "the new note is not at the front",
    );
    assert.ok(
      stored.some((item) => item.note === "note 0"),
      "the oldest note was not the one dropped",
    );
    // The user cannot see the console, so a warning there is not a signal.
    // The loss has to be written down where the panel can find it and say
    // it out loud.
    const record = storage.ytd_notes_dropped;
    assert.ok(
      record,
      "the store dropped a note and left no record the user could ever see",
    );
    assert.equal(
      Number(record.lastCount),
      1,
      `the record does not say how many notes were dropped: ${JSON.stringify(record)}`,
    );
    assert.ok(
      warnings.some((line) => /note/i.test(line) && /dropped|discard|removed|100/i.test(line)),
      `the console did not say what happened either: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("the panel knows the note store's cap", () => {
  // The panel shows "n / 100" next to the notes. If the cap changes, that
  // number has to change with it, so it must not be a second copy of the
  // number that lives in the store. Both sides have to read the one
  // number that settings.js holds.
  const panel = read("sidepanel.js");
  const cloudSync = read("cloud-sync.js");
  const settings = read("settings.js");

  assert.match(
    settings,
    /MAX_LOCAL_NOTES\s*=\s*\d+/,
    "settings.js does not hold the note cap",
  );
  assert.match(
    panel,
    /YTD_SETTINGS\.MAX_LOCAL_NOTES/,
    "the panel keeps its own copy of the note limit instead of reading the shared one",
  );
  assert.match(
    cloudSync,
    /YTD_SETTINGS\.MAX_LOCAL_NOTES/,
    "the store keeps its own copy of the note limit instead of reading the shared one",
  );
});
