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
