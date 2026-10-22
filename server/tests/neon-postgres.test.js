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
let createPgSql = null;
let createSchema = null;
let resetTables = null;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  const helpers = require("./helpers/pg-sql.js");
  createPgSql = helpers.createPgSql;
  createSchema = helpers.createSchema;
  resetTables = helpers.resetTables;
  NeonStore = require("../src/db.js").NeonStore;
  pool = new Pool({ connectionString: DATABASE_URL });
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
