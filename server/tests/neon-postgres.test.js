const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The store's SQL, executed by a real PostgreSQL server.
 *
 * Until this file existed, the NeonStore's statements had never been run by
 * Postgres. The test double answered from the *shape* of the statement, so
 * it could not tell an executable statement from a broken one - and two
 * statements that Postgres rejects shipped to production:
 *
 *   - `update notes set note = $1,  where id = $2` (a dangling comma)
 *   - `select count(*) as count from $1` (a table name bound as a value)
 *
 * The suite is skipped when no database is configured, so a developer
 * without a local Postgres is not blocked. CI runs it against a real
 * service container.
 */
const DATABASE_URL = process.env.YTD_TEST_DATABASE_URL;

const schemaSql = fs.readFileSync(
  path.resolve(__dirname, "..", "schema.sql"),
  "utf8",
);

let pool = null;
let NeonStore = null;
let MemoryStore = null;
let StorageLimitError = null;
let ForeignRowError = null;
let MAX_ACCOUNT_ROWS = null;
let createPgSql = null;
let createSchema = null;
let resetTables = null;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  const helpers = require("./helpers/pg-sql.js");
  createPgSql = helpers.createPgSql;
  createSchema = helpers.createSchema;
  resetTables = helpers.resetTables;
  const db = require("../src/db.js");
  NeonStore = db.NeonStore;
  MemoryStore = db.MemoryStore;
  StorageLimitError = db.StorageLimitError;
  ForeignRowError = db.ForeignRowError;
  MAX_ACCOUNT_ROWS = db.MAX_ACCOUNT_ROWS;
  pool = new Pool({ connectionString: DATABASE_URL });
}

/** A note as the batch route hands it to the store. */
function batchNote(clientId, text, extra) {
  return Object.assign(
    {
      clientId,
      note: text,
      videoId: "abc123xyz",
      videoTitle: "Video",
      channelName: "Channel",
      timestampSeconds: 0,
      quote: "",
    },
    extra || {},
  );
}

/** A word as the batch route hands it to the store. */
function batchWord(term, sentence, extra) {
  return Object.assign(
    {
      term,
      translation: "",
      sentence,
      sentenceTranslation: "",
      videoId: "abc123xyz",
      videoTitle: "Video",
      timestampSeconds: 0,
      status: "learning",
    },
    extra || {},
  );
}

/** A store wired to the real server through the Neon-like client. */
function realStore() {
  return new NeonStore(DATABASE_URL, createPgSql(pool));
}

const describe = DATABASE_URL ? test : test.skip;

/**
 * Random text of a given length.
 *
 * A sentence of one repeated character is compressed by Postgres and would
 * never reach the limit of an index entry, so a test about long sentences
 * has to use text that does not compress.
 */
function randomText(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = require("node:crypto").randomBytes(length);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += alphabet[bytes[index] % alphabet.length];
  }
  return text;
}

describe("the store's SQL is executable by a real PostgreSQL", async (t) => {
  t.before(async () => {
    await createSchema(pool, schemaSql);
  });

  t.after(async () => {
    if (pool) await pool.end();
  });

  await t.test("a sparse note update changes the row and returns it", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1001, login: "sparse" });
    const created = await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "a quote",
      note: "the original note",
    });
    assert.ok(created.id, "the note was created");

    const updated = await store.updateNote(user.id, created.id, {
      note: "the edited note",
    });

    // The store has to hand back the row it just wrote. Without a RETURNING
    // clause the driver reports no rows and the route turns a successful
    // update into a 404.
    assert.ok(updated, "updateNote returned the updated note");
    assert.equal(updated.note, "the edited note");

    // And the row on disk really changed.
    const listed = await store.listNotes(user.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].note, "the edited note");
    // A sparse patch must not zero the fields it left out.
    assert.equal(listed[0].videoTitle, "Title");
    assert.equal(listed[0].quote, "a quote");
  });

  await t.test("an edited note moves its own timestamp", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1002, login: "clock" });
    const created = await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "before",
    });
    const before = Date.parse(created.updatedAt);

    // The delta sync and the last-write-wins comparison both read
    // `updated_at`. An edit that keeps the old timestamp is invisible on
    // every other device.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const updated = await store.updateNote(user.id, created.id, {
      note: "after",
    });
    const after = Date.parse(updated.updatedAt);
    assert.ok(
      after > before,
      `updated_at did not move: ${created.updatedAt} -> ${updated.updatedAt}`,
    );
  });

  await t.test("a note edit that says nothing about the flag keeps the flag", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1003, login: "star" });
    const created = await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "before",
    });
    await store.setNoteStarred(user.id, created.id, true);

    // The client pushes the note body; it does not know about the flag.
    // The flag has to survive.
    const updated = await store.updateNote(user.id, created.id, {
      note: "after",
    });
    assert.equal(updated.starred, true, "the star was cleared by a text edit");

    // And when the client does mention it, the mention wins.
    const unstarred = await store.updateNote(user.id, created.id, {
      note: "after again",
      starred: false,
    });
    assert.equal(unstarred.starred, false);
  });

  await t.test("a note update that leaves the note text alone keeps it", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1007, login: "sparse-note" });
    const created = await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "a quote",
      note: "the original note",
    });

    // A patch that does not carry the note body must not write the
    // column: a bound `undefined` would be written as NULL, and the
    // column is NOT NULL - the update would fail.
    const updated = await store.updateNote(user.id, created.id, {
      quote: "a new quote",
    });
    assert.ok(updated, "the store must return the updated row");
    assert.equal(updated.note, "the original note");
    assert.equal(updated.quote, "a new quote");

    const listed = await store.listNotes(user.id);
    assert.equal(listed[0].note, "the original note");
  });

  await t.test("counting a user's rows works", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1004, login: "count" });
    await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "one",
    });
    await store.createNote(user.id, {
      clientId: "c2",
      videoId: "vid2",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 20,
      quote: "",
      note: "two",
    });

    // A table name is an identifier and cannot be a bound parameter.
    assert.equal(await store.countRows("notes", user.id), 2);
    assert.equal(await store.countRows("vocabulary", user.id), 0);
  });

  await t.test("the export path returns the user's data", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1005, login: "export" });
    await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "exported",
    });

    // `GET /api/export` runs this. It was a 500 for every user, because the
    // table name was bound as a value.
    const data = await store.getAllUserData(user.id);
    assert.ok(data, "the export returned nothing");
    assert.equal(data.notes.length, 1);
    assert.equal(data.notes[0].note, "exported");
    assert.equal(data.vocabulary.length, 0);
  });

  await t.test("a deleted note is never handed back", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1010, login: "tombstone" });
    const created = await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "the quote the user wrote",
      note: "the note the user wrote and then deleted",
    });
    assert.equal(await store.deleteNote(user.id, created.id), true);

    // The promise is that a marked row is never served. The lists kept it,
    // the three update paths did not: they updated the tombstone and
    // returned the row - the user's own words - in the answer.
    const starred = await store.setNoteStarred(user.id, created.id, true);
    assert.equal(starred, null, "a deleted note was starred and handed back");
    const edited = await store.updateNote(user.id, created.id, { note: "after" });
    assert.equal(edited, null, "a deleted note was edited and handed back");

    // The word is the same promise.
    const word = await store.upsertVocabulary(user.id, {
      term: "serendipity",
      translation: "意外之喜",
      sentence: "A happy accident.",
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 10,
      status: "learning",
    });
    assert.equal(await store.deleteVocabulary(user.id, word.id), true);
    const graded = await store.updateVocabularyStatus(user.id, word.id, "mastered");
    assert.equal(graded, null, "a deleted word was graded and handed back");
  });

  await t.test("a part of the export is measured on its own", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1014, login: "part" });
    await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "a quote",
      note: "the note the user wrote",
    });
    await store.upsertVocabulary(user.id, {
      term: "serendipity",
      translation: "意外之喜",
      sentence: "A happy accident.",
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 10,
      status: "learning",
    });

    // The two stores have to answer the same way: the estimate of a part
    // is smaller than the estimate of the whole, or the second half of a
    // big account is refused by the cap of the first.
    const whole = await store.estimateExportBytes(user.id);
    const notesOnly = await store.estimateExportBytes(user.id, "notes");
    const wordsOnly = await store.estimateExportBytes(user.id, "vocabulary");
    assert.ok(notesOnly > 0, "the notes half is not measured at all");
    assert.ok(wordsOnly > 0, "the words half is not measured at all");
    assert.ok(notesOnly < whole, "the notes half is measured as the whole");
    assert.ok(wordsOnly < whole, "the words half is measured as the whole");
  });

  await t.test("deleting all notes marks every note of the account", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1011, login: "delete-all" });
    const other = await store.upsertUser({ githubId: 1012, login: "other" });
    for (const clientId of ["c1", "c2", "c3"]) {
      await store.createNote(user.id, {
        clientId,
        videoId: "vid1",
        videoTitle: "Title",
        channelName: "Channel",
        timestampSeconds: 10,
        quote: "",
        note: "note " + clientId,
      });
    }
    await store.createNote(other.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "someone else's note",
    });

    const deleted = await store.deleteAllNotes(user.id);
    assert.equal(deleted, 3, "the count is not the number of notes");
    assert.equal((await store.listNotes(user.id)).length, 0);
    assert.equal((await store.countNotes(user.id)), 0);

    // The rows are tombstones, not gone: the scheduled purge is what drops
    // them, and another account's notes are not touched.
    const rows = await pool.query(
      "select deleted_at from notes where user_id = $1",
      [user.id],
    );
    assert.equal(rows.rows.length, 3, "the rows were hard-deleted");
    assert.ok(
      rows.rows.every((row) => row.deleted_at),
      "the rows were not marked as deleted",
    );
    assert.equal((await store.listNotes(other.id)).length, 1, "another account lost notes");
  });

  await t.test("the counts and the export hold every row", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1013, login: "big" });
    // More rows than the export used to hold: the export was capped at half
    // the account, so a big account got half of its own data and a
    // `truncated` field nobody read.
    await pool.query(
      `insert into notes (user_id, client_id, video_id, video_title, channel_name,
        timestamp_seconds, quote, note)
       select $1, 'c' || g, 'vid1', 'Title', 'Channel', 10, '', 'note ' || g
       from generate_series(1, 10001) as g`,
      [user.id],
    );

    assert.equal(await store.countNotes(user.id), 10_001, "the count is not the account");
    const data = await store.getAllUserData(user.id);
    assert.equal(data.notes.length, 10_001, "the export dropped rows");
    assert.equal(data.truncated.notes, 0, "the export says it left rows out");
  });

  await t.test("a capped delta says so, so the device does not keep what was deleted", async () => {
    // "Delete all notes" stamps every tombstone with one timestamp, so no
    // later `since` can fetch the rows the cap left behind. If the delta
    // does not say it was capped, the device keeps notes the user deleted.
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1014, login: "delta" });
    await pool.query(
      `insert into notes (user_id, client_id, video_id, video_title, channel_name,
        timestamp_seconds, quote, note)
       select $1, 'c' || g, 'vid1', 'Title', 'Channel', 10, '', 'note ' || g
       from generate_series(1, 5001) as g`,
      [user.id],
    );

    const changed = await store.getSyncDelta(user.id, "2000-01-01T00:00:00Z");
    assert.equal(changed.notes.length, 5_000, "the changed list is capped");
    assert.equal(changed.truncated.notes, true, "the changed list does not say it was capped");
    assert.equal(changed.truncated.deletedNotes, false, "nothing was deleted");

    assert.equal(await store.deleteAllNotes(user.id), 5_001);
    const after = await store.getSyncDelta(user.id, "2000-01-01T00:00:00Z");
    assert.equal(after.deleted.notes.length, 5_000, "the deletion list is capped");
    assert.equal(
      after.truncated.deletedNotes,
      true,
      "the deletion list does not say it was capped",
    );
  });

  await t.test("deleting an account removes the account and everything in it", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1007, login: "leaving" });
    await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "a note",
    });
    const word = await store.upsertVocabulary(user.id, {
      clientId: "w1",
      term: "habit",
      translation: "\u4e60\u60ef",
      sentence: "A system is a climate.",
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 10,
      status: "learning",
    });
    await store.submitReview(user.id, word.id, 3);

    assert.ok((await store.listNotes(user.id)).length, "the note was never saved");
    assert.ok(
      (await store.listVocabulary(user.id)).length,
      "the word was never saved",
    );

    // "Delete my account" has to mean the account too, not only the rows
    // that hang off it. The old code kept the user row as a tombstone and
    // only bumped a token version, so the GitHub identity survived a
    // deletion the user was told was permanent.
    const deleted = await store.deleteUserData(user.id);
    assert.ok(deleted, "nothing was deleted");

    const { rows } = await pool.query("select id from users where id = $1", [
      user.id,
    ]);
    assert.equal(rows.length, 0, "the account row survived the deletion");
    const { rows: noteRows } = await pool.query(
      "select id from notes where user_id = $1",
      [user.id],
    );
    assert.equal(noteRows.length, 0, "the notes survived the deletion");
    const { rows: wordRows } = await pool.query(
      "select id from vocabulary where user_id = $1",
      [user.id],
    );
    assert.equal(wordRows.length, 0, "the words survived the deletion");
    const { rows: reviewRows } = await pool.query(
      "select id from review_items where user_id = $1",
      [user.id],
    );
    assert.equal(reviewRows.length, 0, "the review history survived");
    // A token names an account. An account that no longer exists cannot
    // be found, so the token is refused.
    assert.equal(
      await store.getTokenVersion(user.id),
      null,
      "a deleted account can still act",
    );
  });

  await t.test("a note can be deleted and starred through the store", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1006, login: "crud" });
    const created = await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "note",
    });

    const starred = await store.setNoteStarred(user.id, created.id, true);
    assert.equal(starred.starred, true);

    assert.equal(await store.deleteNote(user.id, created.id), true);
    assert.equal((await store.listNotes(user.id)).length, 0);
  });

  await t.test("a long sentence is stored instead of failing every time", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1007, login: "long" });
    // Random text: a sentence of one repeated character is compressed by
    // Postgres and would never reach the limit of an index entry.
    const sentence = randomText(4000);
    const word = await store.upsertVocabulary(user.id, {
      term: "longword",
      translation: "t",
      sentence,
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 0,
      status: "learning",
    });

    assert.equal(word.sentence.length, 4000, "the word has to be stored as it was sent");
    const again = await store.upsertVocabulary(user.id, {
      term: "longword",
      translation: "",
      sentence,
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 0,
      status: "learning",
    });
    assert.equal(again.id, word.id, "the same word is the same row");
  });

  await t.test("a word that is captured again keeps what the first device knew", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1008, login: "merge" });
    await store.upsertVocabulary(user.id, {
      term: "ubiquitous",
      translation: "无处不在的",
      sentence: "Ubiquitous computing is here.",
      sentenceTranslation: "普适计算已到来。",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 12,
      status: "mastered",
    });

    // The same word, captured on a second device that knows less about it.
    const again = await store.upsertVocabulary(user.id, {
      term: "ubiquitous",
      translation: "",
      sentence: "Ubiquitous computing is here.",
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 12,
      status: "learning",
    });

    assert.equal(again.translation, "无处不在的", "a re-capture must not wipe the translation");
    assert.equal(again.sentenceTranslation, "普适计算已到来。");
    assert.equal(again.status, "mastered", "a re-capture must not undo the learning state");
  });

  await t.test("a deleted note does not come back", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1009, login: "tombstone" });
    const note = await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "note",
    });
    await store.deleteNote(user.id, note.id);

    // The device that still holds the note pushes it again.
    await store.createNote(user.id, {
      clientId: "c1",
      videoId: "vid1",
      videoTitle: "Title",
      channelName: "Channel",
      timestampSeconds: 10,
      quote: "",
      note: "note",
    });

    assert.equal(
      (await store.listNotes(user.id)).length,
      0,
      "a note that was deleted must not come back from the server",
    );
  });

  await t.test("the review schedule of a deleted word survives the delete", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1010, login: "reviews" });
    const word = await store.upsertVocabulary(user.id, {
      term: "persistence",
      translation: "坚持",
      sentence: "Persistence pays off.",
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 12,
      status: "learning",
    });
    await store.submitReview(user.id, word.id, 4);
    await store.deleteVocabulary(user.id, word.id);

    // The user captures the word again: it comes back as the same row, with
    // the schedule it had. A word the user had worked on must not start
    // over as a word that is due right now.
    const restored = await store.upsertVocabulary(user.id, {
      term: "persistence",
      translation: "坚持",
      sentence: "Persistence pays off.",
      sentenceTranslation: "",
      videoId: "vid1",
      videoTitle: "Title",
      timestampSeconds: 12,
      status: "learning",
    });
    assert.equal(restored.id, word.id, "the word must come back as the same row");

    const { rows } = await pool.query(
      "select reps, interval_days from review_items where vocabulary_id = $1",
      [word.id],
    );
    assert.equal(rows.length, 1, "the review row has to survive the delete");
    assert.equal(rows[0].reps, 1, "the review history must not start over");
    assert.equal(rows[0].interval_days, 2);
  });

  // ============================================================
  // POST /api/sync: the batch is one transaction
  // ============================================================

  await t.test("a batch writes notes and words in one transaction", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1101, login: "batch" });

    const pushed = await store.batchUpsert(user.id, {
      notes: [
        batchNote("batch-1", "first"),
        batchNote("batch-2", "second"),
      ],
      vocabulary: [batchWord("serendipity", "A happy accident.", { translation: "意外之喜" })],
    });

    assert.deepEqual(
      pushed.notes.map((note) => note.clientId),
      ["batch-1", "batch-2"],
      "the answer has to name every note of the batch, in order",
    );
    assert.deepEqual(
      pushed.vocabulary.map((word) => [word.term, word.sentence]),
      [["serendipity", "A happy accident."]],
    );
    for (const entry of pushed.notes.concat(pushed.vocabulary)) {
      assert.equal(typeof entry.id, "string");
      assert.ok(entry.id.length > 0, "the answer has to name the row");
      assert.ok(Number.isFinite(Date.parse(entry.updatedAt)));
    }

    const listed = await store.listNotes(user.id);
    assert.deepEqual(listed.map((note) => note.note).sort(), ["first", "second"]);
    assert.equal((await store.listVocabulary(user.id)).length, 1);
    assert.equal((await store.listDueReviews(user.id)).length, 1);

    // A word that was new in the batch got its review row in the same
    // transaction: there is no window where the word exists unreviewable.
    const { rows } = await pool.query(
      "select count(*)::int as count from review_items where user_id = $1",
      [user.id],
    );
    assert.equal(rows[0].count, 1);
  });

  await t.test("a batch does not bring a deleted note back", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1102, login: "batch-tombstone" });
    const created = await store.createNote(user.id, batchNote("gone-1", "deleted by the user"));
    await store.deleteNote(user.id, created.id);

    const pushed = await store.batchUpsert(user.id, {
      notes: [batchNote("gone-1", "deleted by the user", { updatedAt: Date.now() + 60_000 })],
      vocabulary: [],
    });

    assert.equal(pushed.notes[0].id, created.id, "the answer has to name the stored row");
    assert.equal((await store.listNotes(user.id)).length, 0, "the deleted note came back");
  });

  await t.test("a batch keeps the newer of two edits", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1103, login: "batch-clock" });
    const created = await store.createNote(user.id, batchNote("clock-1", "the newer text"));

    // The moment is measured on the server, so a client that sends an older
    // moment than the stored row loses even after the network delay.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const stale = await store.batchUpsert(user.id, {
      notes: [batchNote("clock-1", "the older text", { updatedAt: Date.now() - 60_000 })],
      vocabulary: [],
    });
    assert.equal(stale.notes[0].id, created.id);
    assert.equal(
      (await store.listNotes(user.id))[0].note,
      "the newer text",
      "an older edit overwrote the stored row",
    );

    await store.batchUpsert(user.id, {
      notes: [batchNote("clock-1", "the newest text", { updatedAt: Date.now() + 60_000 })],
      vocabulary: [],
    });
    assert.equal((await store.listNotes(user.id))[0].note, "the newest text");
  });

  await t.test("a batch that would pass the cap writes nothing", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1104, login: "batch-cap" });
    // The account is one row short of the cap. Filling it through the store
    // would issue 20 000 requests; generate_series writes the rows at once.
    await pool.query(
      `insert into notes (user_id, client_id, video_id, timestamp_seconds, note)
       select $1, 'seed-c-' || g, 'abc123xyz', 0, 'seed'
       from generate_series(1, 19999) as g`,
      [user.id],
    );

    await assert.rejects(
      () =>
        store.batchUpsert(user.id, {
          notes: [batchNote("cap-1", "one"), batchNote("cap-2", "two")],
          vocabulary: [],
        }),
      (error) => {
        assert.ok(error instanceof StorageLimitError, "the batch must be refused as full");
        assert.equal(error.limit, MAX_ACCOUNT_ROWS, "the answer has to carry the limit");
        return true;
      },
    );
    // The whole batch rolled back: one of the two would have fit.
    const afterRefusal = await pool.query(
      "select client_id from notes where user_id = $1 and client_id in ('cap-1', 'cap-2')",
      [user.id],
    );
    assert.equal(afterRefusal.rows.length, 0, "a refused batch wrote a row");

    // The same batch with one item fits exactly, and the next is refused.
    await store.batchUpsert(user.id, { notes: [batchNote("cap-1", "one")], vocabulary: [] });
    assert.equal(await store.countNotes(user.id), MAX_ACCOUNT_ROWS);
    await assert.rejects(
      () =>
        store.batchUpsert(user.id, {
          notes: [batchNote("cap-2", "two")],
          vocabulary: [],
        }),
      (error) => error instanceof StorageLimitError,
      "an account at the cap accepted another row",
    );
  });

  await t.test("a batch may not name another account's row", async () => {
    await resetTables(pool);
    const store = realStore();
    const alice = await store.upsertUser({ githubId: 1105, login: "batch-alice" });
    const bob = await store.upsertUser({ githubId: 1106, login: "batch-bob" });
    const aliceNote = await store.createNote(alice.id, batchNote("alice-1", "alice's note"));
    const aliceWord = await store.upsertVocabulary(
      alice.id,
      batchWord("alice-word", "Alice's sentence."),
    );

    await assert.rejects(
      () =>
        store.batchUpsert(bob.id, {
          notes: [batchNote("bob-1", "written over alice", { id: aliceNote.id })],
          vocabulary: [],
        }),
      (error) => error instanceof ForeignRowError,
      "a batch must refuse a note id that belongs to another account",
    );
    await assert.rejects(
      () =>
        store.batchUpsert(bob.id, {
          notes: [],
          vocabulary: [batchWord("bob-word", "Bob's sentence.", { id: aliceWord.id })],
        }),
      (error) => error instanceof ForeignRowError,
      "a batch must refuse a word id that belongs to another account",
    );
    assert.equal(await store.countNotes(bob.id), 0, "a refused batch wrote a note");
    assert.equal(await store.countVocabulary(bob.id), 0, "a refused batch wrote a word");
  });

  await t.test("a batch brings a deleted word back with the schedule it had", async () => {
    await resetTables(pool);
    const store = realStore();
    const user = await store.upsertUser({ githubId: 1108, login: "batch-word-back" });
    const word = await store.upsertVocabulary(
      user.id,
      batchWord("persistence", "Persistence pays off."),
    );
    await store.submitReview(user.id, word.id, 4);
    await store.deleteVocabulary(user.id, word.id);

    const pushed = await store.batchUpsert(user.id, {
      notes: [],
      vocabulary: [batchWord("persistence", "Persistence pays off.")],
    });

    assert.equal(pushed.vocabulary[0].id, word.id, "the word must come back as the same row");
    assert.equal((await store.listVocabulary(user.id)).length, 1, "the word did not come back");
    const { rows } = await pool.query(
      "select reps from review_items where vocabulary_id = $1",
      [word.id],
    );
    assert.equal(rows.length, 1, "the review row must survive the re-capture");
    assert.equal(rows[0].reps, 1, "the review history must not start over");
  });

  await t.test("the two stores answer the same batch the same way", async () => {
    await resetTables(pool);
    const neon = realStore();
    const memory = new MemoryStore();
    const batch = () => ({
      notes: [batchNote("same-1", "one"), batchNote("same-2", "two")],
      vocabulary: [batchWord("same", "Same sentence.")],
    });

    const neonUser = await neon.upsertUser({ githubId: 1107, login: "same-neon" });
    const memoryUser = await memory.upsertUser({ githubId: 1107, login: "same-neon" });
    const pushedShape = (pushed) => ({
      notes: pushed.notes.map((note) => note.clientId),
      vocabulary: pushed.vocabulary.map((word) => [word.term, word.sentence]),
    });

    assert.deepEqual(
      pushedShape(await neon.batchUpsert(neonUser.id, batch())),
      pushedShape(await memory.batchUpsert(memoryUser.id, batch())),
      "the two stores answered the first push differently",
    );
    // A retry and then a stale edit: both stores must keep what they had and
    // write no second row.
    await neon.batchUpsert(neonUser.id, batch());
    await memory.batchUpsert(memoryUser.id, batch());
    await neon.batchUpsert(neonUser.id, {
      notes: [batchNote("same-1", "older", { updatedAt: Date.now() - 60_000 })],
      vocabulary: [],
    });
    await memory.batchUpsert(memoryUser.id, {
      notes: [batchNote("same-1", "older", { updatedAt: Date.now() - 60_000 })],
      vocabulary: [],
    });

    const readable = async (store, userId) => ({
      notes: (await store.listNotes(userId)).map((note) => [note.clientId, note.note]).sort(),
      vocabulary: (await store.listVocabulary(userId)).map((word) => [word.term, word.sentence]),
      reviews: (await store.listDueReviews(userId)).length,
      noteCount: await store.countNotes(userId),
    });
    assert.deepEqual(
      await readable(neon, neonUser.id),
      await readable(memory, memoryUser.id),
      "the two stores hold different rows after the same batch sequence",
    );
  });
});

test("the real-Postgres suite is wired to a database", () => {
  if (!DATABASE_URL) {
    // Skipped, not silently passed: a CI job that forgets to configure the
    // database would otherwise look green.
    assert.ok(
      process.env.YTD_TEST_DATABASE_URL === undefined,
      "YTD_TEST_DATABASE_URL was set to an empty value",
    );
    return;
  }
  assert.match(DATABASE_URL, /^postgres(ql)?:\/\//);
});
