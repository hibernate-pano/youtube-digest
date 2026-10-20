/**
 * The SQL the store sends has to be executable by Postgres.
 *
 * The fake driver in helpers/fake-sql.js answers from the *shape* of a
 * statement, so a statement Postgres would reject still "works" there: a
 * dangling comma in front of `where`, an UPDATE without `returning`, and a
 * table name bound as a parameter are all invisible to it. That is how a
 * broken production data path could sit behind a green test suite.
 *
 * These tests therefore look at the statement text itself and drive the
 * store with a driver that behaves the way Postgres does for the two rules
 * that matter here:
 *
 *   - an UPDATE without `returning` produces no rows,
 *   - a table name in a FROM clause is an identifier and cannot be a bound
 *     parameter (`from $1` is a syntax error).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { NeonStore, MemoryStore } = require("../src/db");

const ALICE = 1;
const BOB = 2;

/**
 * Compiles a tagged-template call the way the Neon driver does: the string
 * parts are joined and every value becomes a numbered placeholder.
 */
function compileSql(strings, values) {
  let text = strings[0];
  for (let index = 0; index < values.length; index += 1) {
    text += "$" + (index + 1) + strings[index + 1];
  }
  return text;
}

/**
 * Splits on the commas that are not inside parentheses.
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * A driver that records every statement and answers the way Postgres does.
 *
 * `respond` may return the rows for a statement; anything it does not
 * answer comes back empty.
 */
function createDriver(respond) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = compileSql(strings, values);
    calls.push({ text, values });
    const from = /\bfrom\s+(\S+)/i.exec(text);
    if (from && /^\$\d+$/.test(from[1])) {
      // Postgres: `from $1` - a table name cannot be a bound parameter.
      throw new Error(`syntax error at or near "${from[1]}"`);
    }
    if (/^\s*update\b/i.test(text) && !/\breturning\b/i.test(text)) {
      // Postgres: an UPDATE without RETURNING reports no rows.
      return [];
    }
    if (respond) {
      const answer = respond(text, values);
      if (answer) return answer;
    }
    return [];
  };
  sql.calls = calls;
  return sql;
}

const NOTE_ROW = {
  id: "note-1",
  clientId: "note_1",
  starred: false,
  videoId: "video-1",
  videoTitle: "A title",
  channelName: "A channel",
  timestampSeconds: 12,
  quote: "a quote",
  note: "edited",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

test("a note update is a statement Postgres can run", async () => {
  const driver = createDriver(() => [NOTE_ROW]);
  const store = new NeonStore("postgres://example", driver);

  await store.updateNote(ALICE, "note-1", { note: "edited" });

  assert.equal(driver.calls.length, 1);
  const { text, values } = driver.calls[0];

  // One WHERE clause, and the SET list ends before it.
  assert.equal((text.match(/\bwhere\b/gi) || []).length, 1, text);
  assert.doesNotMatch(text, /,\s*where/i, "a dangling comma before where: " + text);

  // Every SET item is a complete assignment: no empty item, no trailing
  // separator, no half-written column.
  const setClause = text.slice(text.indexOf("set ") + 4, text.search(/\bwhere\b/i));
  const items = splitTopLevel(setClause).map((item) => item.trim());
  for (const item of items) {
    assert.ok(item.length > 0, "empty SET item in: " + text);
    assert.match(item, /^[a-z_]+\s*=\s*\S/, "malformed SET item " + JSON.stringify(item));
  }
  assert.ok(items.length >= 1, text);

  // The placeholders are numbered in order and cover every value.
  const placeholders = (text.match(/\$\d+/g) || []).map((one) => Number(one.slice(1)));
  assert.deepEqual(placeholders, values.map((_, index) => index + 1), text);

  // The row the update touched is identified by both ids.
  const where = text.slice(text.search(/\bwhere\b/i));
  assert.match(where, /id = \$\d+ and user_id = \$\d+/, text);
  const bound = values.map((value, index) => ({ value, index }));
  const noteIdAt = Number(/id = \$(\d+)/.exec(where)[1]);
  const userIdAt = Number(/user_id = \$(\d+)/.exec(where)[1]);
  assert.equal(bound[noteIdAt - 1].value, "note-1");
  assert.equal(bound[userIdAt - 1].value, ALICE);
});

test("a note update reports the row it changed", async () => {
  // The driver answers an UPDATE without RETURNING with no rows, the way
  // Postgres does. A store that does not read the row back would report
  // "not found" for a note it had just updated.
  const driver = createDriver((text) =>
    /^update notes set/i.test(text) ? [NOTE_ROW] : null,
  );
  const store = new NeonStore("postgres://example", driver);

  const row = await store.updateNote(ALICE, "note-1", { note: "edited" });

  assert.ok(row, "the store must return the updated row");
  assert.equal(row.note, "edited");
  assert.match(driver.calls[0].text, /\breturning\b/i);
});

test("a note update moves the row's own timestamp", async () => {
  const driver = createDriver(() => [NOTE_ROW]);
  const store = new NeonStore("postgres://example", driver);

  await store.updateNote(ALICE, "note-1", { note: "edited" });

  // The delta sync and the last-write-wins comparison both read
  // `updated_at`. An edit that keeps the old timestamp is invisible to
  // the other devices.
  assert.match(driver.calls[0].text, /updated_at = now\(\)/);
});

test("a note update writes only the fields the client sent", async () => {
  const driver = createDriver(() => [NOTE_ROW]);
  const store = new NeonStore("postgres://example", driver);

  await store.updateNote(ALICE, "note-1", { note: "edited", videoId: "video-1" });

  const setClause = driver.calls[0].text.slice(
    driver.calls[0].text.indexOf("set ") + 4,
    driver.calls[0].text.search(/\bwhere\b/i),
  );
  const columns = splitTopLevel(setClause)
    .map((item) => /^\s*([a-z_]+)\s*=/.exec(item.trim()))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.deepEqual(columns, ["note", "video_id", "updated_at"]);
});

test("a note update without a note body does not write the note column", async () => {
  // A patch that leaves the note text alone must not write the column at
  // all: a bound `undefined` would be written as NULL, and the column is
  // NOT NULL. The two stores have to agree on this, and only the SQL can
  // show it.
  const driver = createDriver(() => [NOTE_ROW]);
  const store = new NeonStore("postgresql://example", driver);

  await store.updateNote(ALICE, "note-1", { quote: "a new quote" });

  const setClause = driver.calls[0].text.slice(
    driver.calls[0].text.indexOf("set ") + 4,
    driver.calls[0].text.search(/\bwhere\b/i),
  );
  const columns = splitTopLevel(setClause)
    .map((item) => /^\s*([a-z_]+)\s*=/.exec(item.trim()))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.deepEqual(columns, ["quote", "updated_at"]);
});

test("a note update that does not mention starred leaves the stored favorite alone", async () => {
  const driver = createDriver(() => [NOTE_ROW]);
  const store = new NeonStore("postgres://example", driver);

  await store.updateNote(ALICE, "note-1", { note: "edited" });

  const setClause = driver.calls[0].text.slice(
    driver.calls[0].text.indexOf("set ") + 4,
    driver.calls[0].text.search(/\bwhere\b/i),
  );
  assert.doesNotMatch(
    setClause,
    /\bstarred\b/,
    "an unmentioned favorite must not be written: " + driver.calls[0].text,
  );
});

test("a note update that mentions starred writes it", async () => {
  const driver = createDriver(() => [NOTE_ROW]);
  const store = new NeonStore("postgres://example", driver);

  await store.updateNote(ALICE, "note-1", { note: "edited", starred: false });

  const setClause = driver.calls[0].text.slice(
    driver.calls[0].text.indexOf("set ") + 4,
    driver.calls[0].text.search(/\bwhere\b/i),
  );
  assert.match(setClause, /\bstarred\s*=/);
});

test("counting a user's rows names the table instead of binding it", async () => {
  const driver = createDriver(() => [{ count: "3" }]);
  const store = new NeonStore("postgres://example", driver);

  const count = await store.countRows("notes", ALICE);

  assert.equal(count, 3);
  const { text, values } = driver.calls[0];
  assert.match(text, /from notes\b/, text);
  assert.doesNotMatch(text, /from \$\d+/, text);
  // The user id stays a bound parameter.
  assert.deepEqual(values, [ALICE]);
});

test("the export counts the notes and the vocabulary separately", async () => {
  const driver = createDriver((text) => {
    if (/count\(\*\)/i.test(text) && /from notes/i.test(text)) return [{ count: "3" }];
    if (/count\(\*\)/i.test(text) && /from vocabulary/i.test(text)) return [{ count: "5" }];
    if (/from users/i.test(text)) {
      return [{ id: ALICE, githubId: 7, login: "alice", avatarUrl: "" }];
    }
    return [];
  });
  const store = new NeonStore("postgres://example", driver);

  const data = await store.getAllUserData(ALICE);

  const counts = driver.calls.filter((call) => /count\(\*\)/i.test(call.text));
  assert.equal(counts.length, 2);
  assert.match(counts[0].text, /from notes\b/, counts[0].text);
  assert.match(counts[1].text, /from vocabulary\b/, counts[1].text);
  // The counts are the ones the export reports as truncated.
  assert.equal(data.truncated.notes, 3);
  assert.equal(data.truncated.vocabulary, 5);
});

test("both stores refuse to count a table that does not exist", async () => {
  const memory = new MemoryStore();
  const neon = new NeonStore("postgres://example", createDriver(() => [{ count: "0" }]));

  await assert.rejects(() => memory.countRows("secrets", ALICE));
  await assert.rejects(() => neon.countRows("secrets", ALICE));
});
