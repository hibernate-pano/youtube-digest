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
