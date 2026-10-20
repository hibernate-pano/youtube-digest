/**
 * Store contract tests.
 *
 * MemoryStore and NeonStore are two implementations of one interface, and the
 * production data path is Neon. Running the *same* suite against both is what
 * keeps them honest: the historical divergence (NeonStore.submitReview writing
 * a review row for a vocabulary owned by somebody else, and upsertVocabulary
 * writing the vocabulary id into review_items.user_id) survived precisely
 * because every pre-existing test exercised the in-memory store only.
 *
 * The Neon runs use the fake tagged-template driver in helpers/fake-sql.js,
 * which records every statement. So these tests assert on query *shape* (an
 * ownership probe must run, a write must not run when it fails) in addition to
 * asserting on returned values.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { MemoryStore, NeonStore } = require("../src/db");
const { createFakeSql } = require("./helpers/fake-sql");

const ALICE = 1;
const BOB = 2;
const DUE_NOW = "2000-01-01T00:00:00.000Z"; // unambiguously in the past

/**
 * One fixture per store implementation, exposing the same operations so the
 * shared suite below can run unchanged against either dialect.
 *
 * For NeonStore the fake driver owns table contents, so seeding goes straight
 * into the fake; for MemoryStore seeding goes through the public API.
 */
function createFixture(name) {
  if (name === "MemoryStore") {
    const store = new MemoryStore();
    return {
      store,
      calls: null,
      addVocabulary(userId, fields) {
        return store.upsertVocabulary(
          userId,
          Object.assign({ status: "learning" }, fields),
        );
      },
      addReviewItem(userId, vocabularyId) {
        // upsertVocabulary already seeds a due review row, so creating the
        // vocabulary is enough to make it reviewable.
        return Promise.resolve();
      },
      addNote(userId, fields) {
        return store.createNote(userId, fields);
      },
      addUser(userId) {
        return store.upsertUser({ githubId: userId, login: "u" + userId, avatarUrl: "" });
      },
    };
  }

  const sql = createFakeSql();
  const store = new NeonStore("postgres://user:pass@localhost/test", sql);
  return {
    store,
    calls: sql.__fake,
    addVocabulary(userId, fields) {
      const row = sql.__fake.seedVocabulary(
        userId,
        Object.assign({}, fields, {
          sentence_translation: fields.sentenceTranslation,
          video_id: fields.videoId,
          video_title: fields.videoTitle,
          timestamp_seconds: fields.timestampSeconds,
        }),
      );
      sql.__fake.seedReviewItem(userId, row.id, { due_at: DUE_NOW });
      return Promise.resolve({ id: row.id, term: row.term, status: row.status });
    },
    addReviewItem(userId, vocabularyId) {
      sql.__fake.seedReviewItem(userId, vocabularyId, { due_at: DUE_NOW });
      return Promise.resolve();
    },
    addNote(userId, fields) {
      // The fake stores snake_case columns; the public store API speaks
      // camelCase, so translate here to keep both fixtures interchangeable.
      const row = sql.__fake.seedNote(
        userId,
        Object.assign({}, fields, {
          client_id: fields.clientId,
          note: fields.note,
          video_id: fields.videoId,
          video_title: fields.videoTitle,
          channel_name: fields.channelName,
          timestamp_seconds: fields.timestampSeconds,
        }),
      );
      return Promise.resolve({ id: row.id, clientId: row.client_id, starred: !!row.starred });
    },
    addUser(userId) {
      const row = sql.__fake.seedUser(userId);
      return Promise.resolve(row);
    },
  };
}

for (const name of ["MemoryStore", "NeonStore"]) {
  test(`[${name}] submitReview refuses a vocabulary owned by another account`, async () => {
    const f = createFixture(name);
    const vocab = await f.addVocabulary(ALICE, { term: "victim-word" });
    assert.equal(typeof vocab.id, "string");

    const result = await f.store.submitReview(BOB, vocab.id, 4);
    assert.equal(result, null, "must not schedule a review for somebody else's word");

    if (f.calls) {
      const probes = f.calls.find(/select id from vocabulary where id/);
      assert.equal(probes.length, 1, "an ownership probe must run before any write");
      assert.ok(
        /and user_id = __VAL__/.test(probes[0].sql),
        "the ownership probe must filter on user_id",
      );
      assert.ok(
        probes[0].values.includes(BOB),
        "the probe must be scoped to the calling user, not the vocabulary owner",
      );
      assert.equal(
        f.calls.findTable("review_items").length,
        0,
        "no review row may be written when ownership fails",
      );
    }
  });

  test(`[${name}] listDueReviews never returns another account's vocabulary`, async () => {
    const f = createFixture(name);
    await f.addVocabulary(ALICE, { term: "alice-word" });
    const bobVocab = await f.addVocabulary(BOB, { term: "bob-secret" });
    // The attacker's own user_id pointing at somebody else's vocabulary. This
    // is exactly the row the old NeonStore happily created.
    await f.addReviewItem(ALICE, bobVocab.id);

    const rows = await f.store.listDueReviews(ALICE);
    assert.deepEqual(
      rows.map((row) => row.vocabulary.term),
      ["alice-word"],
      "only vocabulary the caller owns may be returned",
    );
  });

  test(`[${name}] getAllUserData excludes reviews over foreign vocabulary`, async () => {
    const f = createFixture(name);
    const aliceVocab = await f.addVocabulary(ALICE, { term: "alice-word" });
    const bobVocab = await f.addVocabulary(BOB, { term: "bob-secret" });
    await f.addReviewItem(ALICE, bobVocab.id);

    const data = await f.store.getAllUserData(ALICE);
    const ids = (data.reviews || []).map((review) => review.vocabularyId);
    assert.ok(ids.length >= 1, "the caller's own review row is still exported");
    assert.ok(
      ids.includes(aliceVocab.id),
      "the caller's own vocabulary is present in the export",
    );
    assert.ok(
      !ids.includes(bobVocab.id),
      "an export must not leak another account's vocabulary id",
    );
  });

  test(`[${name}] submitReview and listDueReviews round-trip for the owner`, async () => {
    const f = createFixture(name);
    const vocab = await f.addVocabulary(ALICE, { term: "ephemeral" });

    const graded = await f.store.submitReview(ALICE, vocab.id, 4);
    assert.ok(graded, "the owner must be able to grade their own word");
    assert.equal(graded.reps, 1);
    assert.equal(graded.intervalDays, 2);
    assert.ok(new Date(graded.dueAt) > new Date(), "grading must push the due date out");

    // Grading moved the due date into the future, so it must leave the queue.
    const due = await f.store.listDueReviews(ALICE);
    assert.equal(due.length, 0, "a graded item must leave the due queue");
  });

  test(`[${name}] submitReview on a vocabulary that does not exist returns null`, async () => {
    const f = createFixture(name);
    assert.equal(await f.store.submitReview(ALICE, "no-such-vocabulary", 3), null);
  });

  test(`[${name}] a brand-new note is not a favourite until the client says so`, async () => {
    const f = createFixture(name);
    const created = await f.store.createNote(ALICE, {
      clientId: "note_new",
      videoId: "abc123xyz",
      videoTitle: "",
      channelName: "",
      timestampSeconds: 0,
      quote: "",
      note: "just a note",
    });

    assert.equal(
      created.starred,
      false,
      "a note that never mentioned the flag must not become a favourite",
    );
  });

  test(`[${name}] notes keep the stored starred flag when the client omits it`, async () => {
    const f = createFixture(name);
    const created = await f.addNote(ALICE, { clientId: "note_1", note: "text", starred: true });
    assert.equal(created.starred, true);

    const after = await f.store.createNote(ALICE, {
      clientId: "note_1",
      videoId: "abc123xyz",
      videoTitle: "",
      channelName: "",
      timestampSeconds: 0,
      quote: "",
      note: "edited text",
    });
    assert.equal(after.id, created.id, "the same clientId must upsert, not duplicate");
    assert.equal(after.starred, true, "an absent starred flag must not clear the favorite");
    assert.equal(after.note, "edited text");
  });

  test(`[${name}] starred survives a full note round-trip`, async () => {
    const f = createFixture(name);
    const created = await f.store.createNote(ALICE, {
      clientId: "note_star",
      videoId: "abc123xyz",
      videoTitle: "",
      channelName: "",
      timestampSeconds: 0,
      quote: "",
      note: "favorite idea",
      starred: true,
    });
    assert.equal(created.starred, true);

    const listed = await f.store.listNotes(ALICE);
    assert.equal(listed[0].starred, true, "starred must survive listNotes");
  });

  test(`[${name}] updateNote reports the stored starred flag`, async () => {
    const f = createFixture(name);
    const created = await f.addNote(ALICE, { clientId: "note_2", note: "text", starred: true });

    const updated = await f.store.updateNote(ALICE, created.id, {
      videoTitle: "",
      channelName: "",
      timestampSeconds: 0,
      quote: "",
      note: "text only update",
    });
    assert.ok(updated, "the owner must be able to update their note");
    assert.equal(updated.starred, true, "a PATCH response must not report starred=false");
    assert.equal(updated.note, "text only update");
  });

  test(`[${name}] setNoteStarred is refused for another account's note`, async () => {
    const f = createFixture(name);
    const aliceNote = await f.addNote(ALICE, { clientId: "note_3", note: "alice" });
    assert.equal(await f.store.setNoteStarred(BOB, aliceNote.id, true), null);
    assert.equal(await f.store.setNoteStarred(ALICE, aliceNote.id, true).then((r) => r.starred), true);
  });

  test(`[${name}] deleteUserData removes only the caller's review rows`, async () => {
    const f = createFixture(name);
    await f.addVocabulary(ALICE, { term: "a" });
    const bobVocab = await f.addVocabulary(BOB, { term: "b" });
    await f.addReviewItem(BOB, bobVocab.id);

    await f.store.deleteUserData(ALICE);

    const bobStillHasData = await f.store.listVocabulary(BOB);
    assert.equal(bobStillHasData.length, 1, "another account's vocabulary must survive a delete");
    const bobReviews = await f.store.listDueReviews(BOB);
    assert.equal(bobReviews.length, 1, "another account's review row must survive a delete");
  });

  test(`[${name}] updateNote never rewrites the client id`, async () => {
    const f = createFixture(name);
    const created = await f.addNote(ALICE, { clientId: "note_client_id", note: "original" });

    const updated = await f.store.updateNote(ALICE, created.id, {
      clientId: "hijacked_client_id",
      note: "edited",
    });
    assert.ok(updated, "the owner must be able to update their note");
    assert.equal(
      updated.clientId,
      "note_client_id",
      "clientId is the sync identity key and must be immutable on edit",
    );

    const listed = await f.store.listNotes(ALICE);
    assert.equal(listed[0].clientId, "note_client_id");
  });

  test(`[${name}] a sparse note update leaves unmentioned fields alone`, async () => {
    const f = createFixture(name);
    const created = await f.addNote(ALICE, {
      clientId: "note_sparse",
      note: "original",
      videoTitle: "A title",
      channelName: "A channel",
      timestampSeconds: 42,
      quote: "a quote",
    });

    const updated = await f.store.updateNote(ALICE, created.id, { note: "edited" });
    assert.ok(updated, "the owner must be able to update their note");
    assert.equal(updated.note, "edited");
    assert.equal(updated.videoTitle, "A title", "an omitted field must survive the update");
    assert.equal(updated.channelName, "A channel");
    assert.equal(updated.timestampSeconds, 42);
    assert.equal(updated.quote, "a quote");
  });

  test(`[${name}] a note update can move the note to another video`, async () => {
    const f = createFixture(name);
    const created = await f.addNote(ALICE, {
      clientId: "note_video",
      note: "text",
      videoId: "abc123xyz",
    });

    // The extension sends the whole note on every push, videoId included, so
    // the update path has to honour it. Otherwise the two stores disagree:
    // one moves the note, the other keeps the old video.
    const updated = await f.store.updateNote(ALICE, created.id, {
      note: "text",
      videoId: "zzz999yyy",
    });
    assert.ok(updated, "the owner must be able to update their note");
    assert.equal(updated.videoId, "zzz999yyy", "the video id must be updated too");

    const listed = await f.store.listNotes(ALICE);
    assert.equal(listed[0].videoId, "zzz999yyy");
  });

  test(`[${name}] listNotes and listVocabulary expose the same public shape`, async () => {
    const f = createFixture(name);
    await f.addNote(ALICE, { clientId: "note_shape", note: "text" });
    await f.addVocabulary(ALICE, { term: "shape" });

    const notes = await f.store.listNotes(ALICE);
    const vocabulary = await f.store.listVocabulary(ALICE);
    assert.equal(notes.length, 1);
    assert.equal(vocabulary.length, 1);

    // The two stores must publish exactly the same key set: an extra
    // `userId` leaks the internal account id, and a missing `starred`
    // silently breaks the favorites feature in the local dev store.
    assert.deepEqual(
      Object.keys(notes[0]).sort(),
      [
        "channelName",
        "clientId",
        "createdAt",
        "id",
        "note",
        "quote",
        "starred",
        "timestampSeconds",
        "updatedAt",
        "videoId",
        "videoTitle",
      ],
      "listNotes must return the public note shape",
    );
    assert.deepEqual(
      Object.keys(vocabulary[0]).sort(),
      [
        "createdAt",
        "id",
        "sentence",
        "sentenceTranslation",
        "status",
        "term",
        "timestampSeconds",
        "translation",
        "updatedAt",
        "videoId",
        "videoTitle",
      ],
      "listVocabulary must return the public vocabulary shape",
    );
    assert.ok(!("userId" in notes[0]), "the internal user id must not be published");
    assert.ok(!("userId" in vocabulary[0]), "the internal user id must not be published");
    assert.equal(notes[0].starred, false, "starred must always be present");
  });

  test(`[${name}] getSyncDelta rejects an unparseable since value`, async () => {
    const f = createFixture(name);
    await f.addNote(ALICE, { clientId: "note_delta", note: "text" });
    await assert.rejects(
      () => f.store.getSyncDelta(ALICE, "not-a-date"),
      /since/i,
      "an unparseable since value must be an error, not an empty delta",
    );
    const delta = await f.store.getSyncDelta(ALICE, "2000-01-01T00:00:00Z");
    assert.equal(delta.notes.length, 1);
  });

  test(`[${name}] deleting the account bumps the token version`, async () => {
    const f = createFixture(name);
    await f.addUser(ALICE);
    assert.equal(await f.store.getTokenVersion(ALICE), 0);
    await f.store.deleteUserData(ALICE);
    // The account row stays behind as a revocation tombstone, but its token
    // version has moved on: every token issued before the deletion must stop
    // authenticating.
    const version = await f.store.getTokenVersion(ALICE);
    assert.notEqual(
      version,
      0,
      "a deleted account must not keep an authenticating token version",
    );
    assert.ok(
      version === null || version === undefined || Number(version) > 0,
      "the token version must either be gone or bumped past the pre-deletion value",
    );
  });
}

test("[NeonStore] the sparse note update keeps the tri-state starred rule", async () => {
  const { store, calls } = createFixture("NeonStore");
  const created = await store.createNote(ALICE, {
    clientId: "note_tri_state",
    note: "text",
    starred: true,
  });

  await store.updateNote(ALICE, created.id, { note: "edited", starred: true });

  // The sparse update only writes `starred` when the client sent a boolean,
  // so the bound parameter is never null here and the fallback of the
  // coalesce cannot be observed through the store. The statement text is the
  // only place the rule lives, so it is pinned here: a fallback of `false`
  // would clear every favourite the moment a client ever sent a null.
  const update = calls.find(/update notes set/).pop();
  assert.ok(update, "the sparse update must run");
  assert.match(
    update.sql,
    /starred = coalesce\(__VAL__, starred\)/,
    "the sparse update must fall back to the stored flag, never to a literal",
  );
});

test("[NeonStore] listDueReviews SQL scopes the joined vocabulary to the caller", async () => {
  const { store, calls } = createFixture("NeonStore");
  await store.listDueReviews(ALICE);
  const query = calls.find(/join vocabulary/).pop();
  assert.ok(query, "the due-review query must run");
  assert.ok(/where ri\.user_id = __VAL__/.test(query.sql), "review rows stay scoped to the caller");
  assert.ok(
    /v\.user_id = __VAL__/.test(query.sql),
    "the joined vocabulary must be scoped to the caller as well",
  );
});

test("[NeonStore] getAllUserData SQL scopes the joined vocabulary to the caller", async () => {
  const { store, calls } = createFixture("NeonStore");
  await store.getAllUserData(ALICE);
  const query = calls.find(/join vocabulary/).pop();
  assert.ok(query, "the export query must run");
  assert.ok(/v\.user_id = __VAL__/.test(query.sql));
});

test("[NeonStore] upsertVocabulary writes the caller's id into review_items.user_id", async () => {
  const { store, calls } = createFixture("NeonStore");
  await store.upsertVocabulary(ALICE, {
    term: "serendipity",
    translation: "t",
    sentence: "s",
    sentenceTranslation: "st",
    videoId: "abc123xyz",
    videoTitle: "v",
    timestampSeconds: 0,
    status: "learning",
  });

  const insert = calls.find(/insert into review_items/).pop();
  assert.ok(insert, "a review row must be created for a new word");
  // Regression guard: both columns used to receive the vocabulary id, so the
  // review row was attributed to a non-existent user and never came back from
  // listDueReviews (ri.user_id never matched a real caller).
  const vocabularyId = [...calls.vocabulary.values()][0].id;
  assert.equal(insert.values[0], ALICE, "review_items.user_id must be the caller id");
  assert.equal(insert.values[1], vocabularyId, "review_items.vocabulary_id must be the vocabulary id");
  assert.notEqual(insert.values[0], insert.values[1]);

  const due = await store.listDueReviews(ALICE);
  assert.equal(due.length, 1, "a new word must be immediately reviewable by its owner");
});

test("both stores expose the same method surface", () => {
  const memory = new MemoryStore();
  const neon = createFixture("NeonStore").store;
  const memoryMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(memory)).sort();
  const neonMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(neon)).sort();
  assert.deepEqual(neonMethods, memoryMethods);
});
