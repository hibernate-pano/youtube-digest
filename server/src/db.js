/**
 * Data layer with two interchangeable stores:
 * - NeonStore: serverless Postgres via @neondatabase/serverless (production).
 * - MemoryStore: in-memory Maps (local dev without a database, tests).
 *
 * Every method takes the authenticated user id explicitly and scopes all
 * queries by it. Client-supplied user ids are never used as a filter.
 */

const DEFAULT_REVIEW_LIMIT = 50;

const { isUuid } = require("./validate");

/**
 * True when the failure is the guard that refuses a batch the account has
 * no room for.
 *
 * The guard divides by zero on purpose: it is the only division in the
 * store, so the SQLSTATE that comes back says exactly one thing - the batch
 * did not fit.
 *
 * @param {unknown} error the failure.
 * @returns {boolean} whether it is the guard.
 */
function isDivisionByZero(error) {
  return Boolean(error) && error.code === "22012";
}

/** Hard cap on the rows a list endpoint returns. */
const MAX_LIST_ROWS = 5_000;

/**
 * Hard cap on the rows one account may own.
 *
 * The rows are the user's own notes and words, so the cap is far above what
 * a real account needs, but it is a bound: without it a single account can
 * write until the Worker runs out of memory, and an out-of-memory Worker
 * takes every other account down with it.
 */
const MAX_ACCOUNT_ROWS = 20_000;

/**
 * Hard cap on the rows an export blob contains.
 *
 * The export is the user's own data, and the promise is that it holds ALL
 * of it. The cap used to be half the account cap, so an account that held
 * 20000 rows got the first 10000 of them and a `truncated` field nobody
 * read: the download looked complete and was not. The export therefore
 * holds as many rows as the account may own, and the only limit left is the
 * size of the blob, which fails loudly with a reason instead of quietly
 * dropping rows.
 */
const MAX_EXPORT_ROWS = MAX_ACCOUNT_ROWS;

/**
 * Hard cap on the size of an export, in bytes.
 *
 * The export is a single JSON blob that the browser downloads, so a blob of
 * a few hundred megabytes does not arrive: the download simply dies. The
 * cap is checked before the blob is built, so the Worker never holds one.
 *
 * The number is not free: it has to be able to hold what the account cap
 * allows. An account may own 20000 rows, and a full account of ordinary
 * rows is about 12.7MB (measured: 20000 realistic notes, each ~570 bytes
 * of JSON, plus the review rows that belong to the words). The old cap was
 * 8MB, so the biggest account the service allows was the one account it
 * refused to export - and the promise "download all your data" broke at
 * exactly the accounts that had the most of it.
 *
 * 32MB holds such an account with room to spare, and still leaves the
 * Worker enough headroom to build the blob. The absolute worst case - a
 * note may be 20000 characters long, so an account may hold far more than
 * that - cannot fit in any single blob; such an account is served in two
 * parts (`?type=notes` and `?type=vocabulary`), and if a part still does
 * not fit, the answer says so instead of quietly dropping rows.
 */
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/**
 * What a row costs in the export besides its text.
 *
 * The export is JSON, so every row carries its id, its keys, its quotes
 * and its timestamps. The size was measured on the text alone, which made
 * the estimate about a third too small: the byte cap was compared with a
 * number that did not describe the blob, so it protected the Worker less
 * than it claimed to. These are the measured overheads of one row - the
 * smallest possible note still costs 264 bytes of scaffolding - with room
 * to spare.
 */
const NOTE_ROW_OVERHEAD_BYTES = 320;
const WORD_ROW_OVERHEAD_BYTES = 320;
const REVIEW_ROW_OVERHEAD_BYTES = 160;

/** How long a deletion is remembered, in days. */
const TOMBSTONE_RETENTION_DAYS = 30;

/** The longest review interval, in days. */
const MAX_INTERVAL_DAYS = 365;

/**
 * Thrown when the Worker has no usable database configuration.
 *
 * The message names the database and nothing else. A connection string must
 * never reach a log, a response or a test: it is the password to the user's
 * notes.
 */
class DatabaseNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseNotConfiguredError";
    this.code = "database_not_configured";
  }
}

/**
 * Thrown when an account has used up its storage.
 *
 * The account is not malformed and the request is not wrong: the account
 * simply holds as many rows as it is allowed to. The route turns this into
 * a 409 with a message the user can act on.
 */
class StorageLimitError extends Error {
  constructor(message, limit) {
    super(message);
    this.name = "StorageLimitError";
    this.code = "storage_limit_reached";
    // The number the limit is, so a UI can say it in the user's own
    // language instead of parsing an English sentence.
    if (Number.isFinite(limit)) this.limit = limit;
  }
}

/**
 * Thrown when a batch carries an id that belongs to another account.
 *
 * The token decides the account: a row id in the request body may never
 * select a row somebody else owns. The route turns this into a 400 that
 * names the item, so the client can drop the id and try again.
 */
class ForeignRowError extends Error {
  /**
   * @param {"notes"|"vocabulary"} kind which half of the batch the item is in.
   * @param {number} index the position of the item in that half.
   * @param {string} id the row id the item carried.
   */
  constructor(kind, index, id) {
    super(`The ${kind === "notes" ? "note" : "word"} at position ${index} carries an id that belongs to another account.`);
    this.name = "ForeignRowError";
    this.code = "foreign_row_id";
    this.kind = kind;
    this.index = index;
    this.id = id;
  }
}

/**
 * The maximum number of items one batch may carry.
 *
 * A device that holds a hundred notes and five hundred words used to push
 * them one request at a time, and the write limiter allows 120 writes a
 * minute: the first sync of a new device spent five minutes being refused.
 * The batch carries many items in one request, and this is the bound on how
 * many. The client chunks its pushes: a request with more items than this
 * is refused with a message the client can act on.
 */
const MAX_BATCH_ITEMS = 200;

/**
 * The largest body one batch may have, in bytes.
 *
 * The single-note cap (128 KB) is sized for one note and its quote. A batch
 * of 200 items is bigger, so the batch route reads its body with its own
 * bound: big enough for any batch of ordinary notes, small enough that a
 * Worker never buffers more than that.
 */
const MAX_BATCH_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Checks a connection string before it reaches the driver.
 *
 * The driver answers an unusable string with an error that QUOTES the
 * string, so the check has to happen here, where the message can be
 * written without it.
 *
 * @param {unknown} value the configured connection string.
 * @returns {string} the trimmed connection string.
 */
function assertUsableDatabaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DatabaseNotConfiguredError(
      "The database is not configured (DATABASE_URL is missing).",
    );
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new DatabaseNotConfiguredError(
      "The database connection string is not a valid URL.",
    );
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new DatabaseNotConfiguredError(
      "The database connection string is not a Postgres URL.",
    );
  }
  return value.trim();
}

/** True for the env values that mean "yes". */
function isEnabled(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(value).toISOString();
}

function rowToNote(row) {
  return {
    id: row.id,
    clientId: row.clientId || "",
    starred: !!row.starred,
    videoId: row.videoId,
    videoTitle: row.videoTitle || "",
    channelName: row.channelName || "",
    timestampSeconds: row.timestampSeconds || 0,
    quote: row.quote || "",
    note: row.note,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function rowToVocabulary(row) {
  return {
    id: row.id,
    term: row.term,
    translation: row.translation || "",
    sentence: row.sentence || "",
    sentenceTranslation: row.sentenceTranslation || "",
    videoId: row.videoId || "",
    videoTitle: row.videoTitle || "",
    timestampSeconds: row.timestampSeconds || 0,
    status: row.status || "learning",
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/**
 * The only tables a user's row count may be taken from.
 *
 * A table name is a schema identifier, not a value: it cannot be a bound
 * parameter, so it has to come from a fixed list instead of from a caller.
 */
const COUNTABLE_TABLES = new Set(["notes", "vocabulary"]);

/**
 * The columns a note update reads back.
 *
 * `createNote` and `setNoteStarred` spell the same list out inside their
 * tagged templates, because a tagged template cannot inline a constant
 * without turning it into a bound parameter.
 */
const NOTE_RETURNING_COLUMNS =
  'returning id, client_id as "clientId", starred, video_id as "videoId",' +
  ' video_title as "videoTitle", channel_name as "channelName",' +
  ' timestamp_seconds as "timestampSeconds", quote, note,' +
  ' created_at as "createdAt", updated_at as "updatedAt"';

/**
 * Builds a parameterized UPDATE statement from a fixed column whitelist.
 *
 * The column names come from the code, never from the request, so the
 * statement text can never be influenced by the client. The result is a
 * tagged-template argument list, which both the Neon driver and the test
 * fake accept.
 *
 * The builder owns the commas between the SET items. A caller describes
 * each item on its own - `{ before, value, after }` for a bound value,
 * `{ raw }` for a constant fragment such as `updated_at = now()` - and
 * never has to remember a trailing separator. Leaving the separator to the
 * caller is how a statement ends up with a dangling comma in front of
 * `where`, which Postgres rejects.
 */
function buildUpdateStatement(prefix, assignments, whereClauses, returning) {
  const strings = [];
  const values = [];
  let lead = prefix;
  assignments.forEach((assignment, index) => {
    if (index > 0) lead += ", ";
    if (assignment.raw) {
      // A constant fragment carries no placeholder of its own: it rides
      // along in the text that precedes the next parameter.
      lead += assignment.raw;
      return;
    }
    strings.push(lead + assignment.before);
    values.push(assignment.value);
    lead = assignment.after || "";
  });
  for (const clause of whereClauses) {
    strings.push(lead + clause.before);
    values.push(clause.value);
    lead = clause.after || "";
  }
  // The RETURNING clause follows the WHERE clause, separated by one space.
  if (returning) lead += " " + returning;
  strings.push(lead);
  return { strings, values };
}

/**
 * Marks a value that has to be bound instead of written into the statement.
 *
 * A batch has as many keys as it has items, and every one of them is text
 * the client sent. Text is written into the statement as a fragment only
 * when the code says so; a value the client sent is always bound.
 *
 * @param {unknown} value the value to bind.
 * @returns {object} the marked value.
 */
function bound(value) {
  return { bound: value };
}

/**
 * Builds a statement from text fragments and bound values.
 *
 * A tagged template can only bind a fixed number of parameters, but a
 * batch has as many keys as it has items. The builder takes the parts in
 * order - a plain string is text, a marked value is bound - and returns the
 * `strings` array and the `values` array every driver here understands: the
 * Neon driver, the `pg` adapter of the tests and the fake all read the same
 * shape.
 *
 * @param {Array<string|object>} parts the text and the bound values.
 * @returns {{strings: string[], values: unknown[]}} the statement.
 */
function buildBoundStatement(parts) {
  const strings = [];
  const values = [];
  let pending = "";
  for (const part of parts) {
    if (part && typeof part === "object" && "bound" in part) {
      strings.push(pending);
      pending = "";
      values.push(part.bound);
      continue;
    }
    pending += String(part);
  }
  strings.push(pending);
  return { strings, values };
}

/**
 * The identity of a word: its text and the sentence it was seen in.
 *
 * The same pair the single route matches on, so a word pushed in a batch is
 * the same row a word pushed on its own would be.
 *
 * @param {string} term the word.
 * @param {string} sentence the sentence it was seen in.
 * @returns {string} the key.
 */
function vocabularyKey(term, sentence) {
  return JSON.stringify([term, sentence]);
}

/**
 * The fields of a note that the store writes.
 *
 * The identity of a note and the moment the client changed it are not
 * fields of the row: the client id is the sync key and the timestamp is the
 * client's own, not the server's.
 *
 * @param {object} note the parsed note.
 * @returns {object} the fields to write.
 */
function noteFields(note) {
  const fields = {
    note: note.note,
    clientId: note.clientId,
    videoId: note.videoId,
    videoTitle: note.videoTitle,
    channelName: note.channelName,
    timestampSeconds: note.timestampSeconds,
    quote: note.quote,
  };
  // `starred` is tri-state: a client that did not mention the flag leaves
  // the stored one alone.
  if (typeof note.starred === "boolean") fields.starred = note.starred;
  return fields;
}

/**
 * The fields of a word that the store writes.
 *
 * @param {object} word the parsed word.
 * @returns {object} the fields to write.
 */
function vocabularyFields(word) {
  return {
    term: word.term,
    translation: word.translation,
    sentence: word.sentence,
    sentenceTranslation: word.sentenceTranslation,
    videoId: word.videoId,
    videoTitle: word.videoTitle,
    timestampSeconds: word.timestampSeconds,
    status: word.status,
  };
}

/**
 * Decides what a batch does with every one of its items.
 *
 * The rules are the ones the single routes use, and they live in one place
 * so that the two stores answer a batch the same way:
 * - a note is matched by its client id, a word by its text,
 * - a note that was deleted stays deleted: the device that still holds it
 *   cannot bring it back,
 * - a word that was deleted comes back with the review schedule it had,
 *   the way POST /api/vocabulary brings it back,
 * - the later edit wins: an item that carries a moment older than the
 *   stored row is dropped, and the stored row is reported back.
 *
 * @param {Map<string, object>} stored the rows the account already has,
 *   keyed by the identity of the item.
 * @param {object[]} items the items of one half of the batch.
 * @param {string} keyOf the function that reads the identity of an item.
 * @param {boolean} keepTombstones true when a deleted row may not be
 *   written again.
 * @returns {Array<{action: string, reason: string|null}>} one decision per
 *   item, in the order of the items.
 */
function planBatch(stored, items, keyOf, keepTombstones) {
  return items.map((item) => {
    const row = stored.get(keyOf(item));
    if (!row) return { action: "insert", reason: null };
    if (keepTombstones && row.deletedAt) {
      return { action: "skip", reason: "deleted" };
    }
    if (item.updatedAt !== null && item.updatedAt !== undefined) {
      const storedAt = Date.parse(row.updatedAt);
      if (Number.isFinite(storedAt) && item.updatedAt <= storedAt) {
        // The stored row is the newer one, so it wins and the push is
        // dropped. The client is told which row the server holds.
        return { action: "skip", reason: "stale" };
      }
    }
    return { action: "update", reason: null };
  });
}

/**
 * How many live rows a batch adds, counting two items with the same identity
 * as one row.
 *
 * A batch may repeat an item - two chunks of the same push can overlap - and
 * both writes land on the same row: the note is matched by its client id and
 * the word by its text. Counting the repeats as new rows would refuse a
 * batch the account has room for, so the cap is checked against distinct
 * identities.
 *
 * A row that is written is not always a new row: a deleted word that is
 * captured again comes back, and it takes a slot in the account like an
 * insert does. A tombstone is not a live row, so bringing one back has to be
 * counted here as well, or the cap could be passed without the batch ever
 * inserting anything.
 *
 * @param {object[]} items the items of one half of the batch.
 * @param {Array<{action: string, reason: string|null}>} plan the decisions.
 * @param {(item: object) => string} keyOf the identity of an item.
 * @param {Map<string, object>} stored the rows the account already has.
 * @returns {number} the number of live rows the batch adds.
 */
function countAddedRows(items, plan, keyOf, stored) {
  const seen = new Set();
  let count = 0;
  plan.forEach((step, index) => {
    if (step.action === "skip") return;
    const key = keyOf(items[index]);
    if (seen.has(key)) return;
    seen.add(key);
    const row = stored.get(key);
    if (step.action === "insert" || (row && row.deletedAt)) count += 1;
  });
  return count;
}

/** Review rows are keyed by owner as well as vocabulary, like the database. */
function reviewKey(userId, vocabularyId) {
  return userId + ":" + vocabularyId;
}

/**
 * The learning state of a word, in the order it can move.
 *
 * A word that is captured again may only move forward. The second device
 * usually knows LESS about a word than the first one, so a re-capture that
 * reset the state would throw away work the user had already done.
 */
const STATUS_ORDER = { learning: 0, reviewing: 1, mastered: 2 };

function moreAdvancedStatus(stored, incoming) {
  const storedRank = STATUS_ORDER[stored] === undefined ? 0 : STATUS_ORDER[stored];
  const incomingRank = STATUS_ORDER[incoming] === undefined ? 0 : STATUS_ORDER[incoming];
  return incomingRank > storedRank ? incoming : stored;
}

/**
 * Merges a re-captured word into the stored one.
 *
 * A word is identified by its text, so the same word captured on a second
 * device is the SAME row - and the second device usually knows less about
 * it. A blind overwrite therefore threw away the translation, the
 * explanation and the learning state of a word the user had already worked
 * on.
 *
 * The rule:
 * - the video context is updated: it says where the word was seen last,
 * - a translation or an explanation is only written when the new capture
 *   carries one. An empty text means "this device does not know it", not
 *   "the text is empty",
 * - the learning state only moves forward.
 */
function mergeVocabularyFields(stored, incoming) {
  return {
    translation: incoming.translation || stored.translation,
    sentenceTranslation: incoming.sentenceTranslation || stored.sentenceTranslation,
    videoId: incoming.videoId || stored.videoId,
    videoTitle: incoming.videoTitle || stored.videoTitle,
    timestampSeconds: incoming.timestampSeconds,
    status: moreAdvancedStatus(stored.status, incoming.status),
  };
}

/** The bytes a note adds to an export blob. */
function noteBytes(row) {
  return (
    byteLength(row.note) +
    byteLength(row.quote) +
    byteLength(row.videoTitle) +
    byteLength(row.channelName)
  );
}

/** The bytes a word adds to an export blob. */
function vocabularyBytes(row) {
  return (
    byteLength(row.term) +
    byteLength(row.translation) +
    byteLength(row.sentence) +
    byteLength(row.sentenceTranslation) +
    byteLength(row.videoTitle)
  );
}

function byteLength(value) {
  if (typeof value !== "string") return 0;
  // `Buffer` does not exist in a Worker, so the length comes from the
  // platform's own text encoder.
  return new TextEncoder().encode(value).length;
}

/**
 * Caps one list of the delta and says whether it was capped.
 *
 * A delta that quietly stops at the cap is a lie the device believes: after
 * "delete all notes" every tombstone shares one timestamp, so there is no
 * later `since` that would fetch the rows the cap left behind. The device
 * would keep notes the user deleted, forever.
 *
 * The caller asks for one row past the cap, so the answer costs no second
 * query: if the extra row is there, the list was capped.
 */
function takeDelta(rows, mapRow = (row) => row) {
  const truncated = rows.length > MAX_LIST_ROWS;
  const kept = truncated ? rows.slice(0, MAX_LIST_ROWS) : rows;
  return { rows: kept.map(mapRow), truncated };
}

/**
 * Postgres hands out account ids from a global sequence, so two accounts
 * never share one. The in-memory store mirrors that with a process-wide
 * counter: two store instances in the same process must never hand out the
 * same account id, or a per-account rate limit would treat two different
 * accounts as one.
 */
let nextMemoryUserId = 1;

class MemoryStore {
  constructor() {
    this.users = new Map(); // github_id -> user
    this.notes = new Map(); // id -> row
    this.vocabulary = new Map(); // id -> row
    this.reviews = new Map(); // `${userId}:${vocabularyId}` -> row
    this.clock = () => new Date();
  }

  async upsertUser(githubUser) {
    let user = this.users.get(githubUser.githubId);
    if (!user) {
      user = {
        id: nextMemoryUserId++,
        githubId: githubUser.githubId,
        login: githubUser.login,
        avatarUrl: githubUser.avatarUrl || "",
        tokenVersion: 0,
      };
      this.users.set(githubUser.githubId, user);
    } else {
      user.login = githubUser.login;
      user.avatarUrl = githubUser.avatarUrl || user.avatarUrl;
    }
    return {
      id: user.id,
      githubId: user.githubId,
      login: user.login,
      avatarUrl: user.avatarUrl,
      tokenVersion: user.tokenVersion || 0,
    };
  }

  /**
   * The token version stored for an account. `null` means the account does
   * not exist, so no token can authenticate as it any more.
   */
  async getTokenVersion(userId) {
    const user = [...this.users.values()].find(
      (row) => String(row.id) === String(userId),
    );
    if (!user) return null;
    return user.tokenVersion || 0;
  }

  async listNotes(userId, limit = MAX_LIST_ROWS) {
    return [...this.notes.values()]
      .filter((row) => row.userId === userId && !row.deletedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map(rowToNote);
  }

  /**
   * How many notes the account holds.
   *
   * The same truth as the Neon store: the page is capped, the account is
   * not, and a UI that shows the page size tells a false number.
   */
  async countNotes(userId) {
    let count = 0;
    for (const row of this.notes.values()) {
      if (row.userId === userId && !row.deletedAt) count += 1;
    }
    return count;
  }

  /**
   * Marks every note of the account as deleted, the way a single delete
   * does, and answers how many rows were marked.
   */
  async deleteAllNotes(userId) {
    const now = this.clock().toISOString();
    let deleted = 0;
    for (const row of this.notes.values()) {
      if (row.userId !== userId || row.deletedAt) continue;
      row.deletedAt = now;
      row.updatedAt = now;
      deleted += 1;
    }
    return deleted;
  }

  async createNote(userId, note) {
    const now = this.clock().toISOString();
    await this.assertNoteRoom(userId, note.clientId);
    const existing = [...this.notes.values()].find(
      (row) => row.userId === userId && row.clientId === note.clientId,
    );
    if (existing) {
      // A note that was deleted stays deleted. The delete is remembered, so
      // a device that still holds the note cannot bring it back by pushing
      // it again.
      if (existing.deletedAt) return rowToNote(existing);
      Object.assign(existing, note, { updatedAt: now });
      return rowToNote(existing);
    }
    const row = Object.assign({}, note, {
      id: crypto.randomUUID(),
      userId,
      createdAt: now,
      updatedAt: now,
    });
    this.notes.set(row.id, row);
    return rowToNote(row);
  }

  async setNoteStarred(userId, noteId, starred) {
    const row = this.notes.get(noteId);
    // A note that was deleted stays deleted, and its text is never handed
    // back. The row is a tombstone, not a row: serving it would put the
    // user's own words back in front of them after they deleted them.
    if (!row || row.userId !== userId || row.deletedAt) return null;
    row.starred = !!starred;
    row.updatedAt = this.clock().toISOString();
    return rowToNote(row);
  }

  async deleteNoteByClientId(userId, clientId) {
    const row = [...this.notes.values()].find(
      (candidate) =>
        candidate.userId === userId && candidate.clientId === clientId,
    );
    if (!row || row.deletedAt) return false;
    row.deletedAt = this.clock().toISOString();
    return true;
  }

  async updateNote(userId, noteId, patch) {
    const row = this.notes.get(noteId);
    // A deleted note is not edited and not returned. The answer is the same
    // as for a note that never existed: it is not there.
    if (!row || row.userId !== userId || row.deletedAt) return null;
    // Mirror the Neon tri-state rule: an absent `starred` leaves the stored
    // flag alone, so the two stores agree on what a note update does.
    const next = Object.assign({}, patch);
    if (typeof patch.starred !== "boolean") delete next.starred;
    // A field the patch did not carry must not be written: `Object.assign`
    // copies an explicit `undefined` too, which would blank the stored
    // value instead of leaving it alone.
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    // clientId is the sync identity key (`unique (user_id, client_id)`), so
    // it is immutable on edit: renaming it would make the next full sync
    // treat the note as deleted elsewhere and drop it.
    delete next.clientId;
    Object.assign(row, next, { updatedAt: this.clock().toISOString() });
    return rowToNote(row);
  }

  async deleteNote(userId, noteId) {
    const row = this.notes.get(noteId);
    if (!row || row.userId !== userId || row.deletedAt) return false;
    // The row stays as a tombstone. A hard delete would let the device that
    // still holds the note push it back, and the note would come back from
    // the server.
    row.deletedAt = this.clock().toISOString();
    return true;
  }

  async listVocabulary(userId, limit = MAX_LIST_ROWS) {
    return [...this.vocabulary.values()]
      .filter((row) => row.userId === userId && !row.deletedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map(rowToVocabulary);
  }

  /**
   * How many words the account holds.
   *
   * The same truth as the Neon store: the page is capped, the account is
   * not, and a UI that shows the page size tells a false number.
   */
  async countVocabulary(userId) {
    let count = 0;
    for (const row of this.vocabulary.values()) {
      if (row.userId === userId && !row.deletedAt) count += 1;
    }
    return count;
  }

  async upsertVocabulary(userId, vocab) {
    await this.assertVocabularyRoom(userId, vocab.term, vocab.sentence);
    const existing = [...this.vocabulary.values()].find(
      (row) => row.userId === userId && row.term === vocab.term && row.sentence === vocab.sentence,
    );
    const now = this.clock().toISOString();
    if (existing) {
      // A word that was deleted comes back when it is captured again, and it
      // comes back with the review schedule it had: the row was only marked
      // as deleted, so the schedule that belongs to it was never touched.
      const merged = mergeVocabularyFields(existing, vocab);
      Object.assign(existing, merged, { updatedAt: now, deletedAt: null });
      return rowToVocabulary(existing);
    }
    const row = Object.assign({}, vocab, {
      id: crypto.randomUUID(),
      userId,
      createdAt: now,
      updatedAt: now,
    });
    this.vocabulary.set(row.id, row);
    // A brand-new word is due for its first review immediately. Existing
    // entries keep their review schedule untouched.
    this.reviews.set(reviewKey(userId, row.id), {
      userId,
      vocabularyId: row.id,
      intervalDays: 0,
      ease: 2.5,
      reps: 0,
      lapses: 0,
      dueAt: now,
    });
    return rowToVocabulary(row);
  }

  /**
   * Writes a batch of notes and words in one go.
   *
   * The batch is all or nothing: every item of the batch is written, or
   * none of them is. The account cap is checked against the whole batch
   * before the first row is written, so a batch that does not fit leaves the
   * account exactly as it was.
   *
   * @param {string|number} userId the account that owns the rows.
   * @param {{notes?: object[], vocabulary?: object[]}} batch the items.
   * @returns {Promise<{notes: object[], vocabulary: object[]}>} what the
   *   server holds for every item of the batch.
   */
  async batchUpsert(userId, batch) {
    const notes = (batch && batch.notes) || [];
    const vocabulary = (batch && batch.vocabulary) || [];

    // The token decides the account: an id in the body may not name a row
    // somebody else owns.
    this.assertNoForeignIds(userId, notes, vocabulary);

    // The rows the account already has, so the plan can be made.
    const storedNotes = new Map();
    for (const row of this.notes.values()) {
      if (row.userId === userId) storedNotes.set(row.clientId, row);
    }
    const storedWords = new Map();
    for (const row of this.vocabulary.values()) {
      if (row.userId === userId) {
        storedWords.set(vocabularyKey(row.term, row.sentence), row);
      }
    }

    const notePlan = planBatch(
      storedNotes,
      notes,
      (note) => note.clientId,
      true,
    );
    const wordPlan = planBatch(
      storedWords,
      vocabulary,
      (word) => vocabularyKey(word.term, word.sentence),
      false,
    );

    // The cap, checked against the whole batch. A batch that would push the
    // account past the limit writes nothing at all. Two items with the same
    // identity are one row, so they are one new row here too.
    const added =
      countAddedRows(notes, notePlan, (note) => note.clientId, storedNotes) +
      countAddedRows(
        vocabulary,
        wordPlan,
        (word) => vocabularyKey(word.term, word.sentence),
        storedWords,
      );
    const used = this.countLiveRows(userId);
    if (used + added > MAX_ACCOUNT_ROWS) {
      throw new StorageLimitError(
        `This account already holds ${used} notes and words, which is the limit of ${MAX_ACCOUNT_ROWS}.`,
        MAX_ACCOUNT_ROWS,
      );
    }

    // The writes. Nothing is awaited from here on: the batch is applied in
    // one go, so no other request can see half of it.
    const now = this.clock().toISOString();
    const pushedNotes = [];
    notes.forEach((note, index) => {
      const step = notePlan[index];
      // A batch may carry the same note twice. The second item lands on the
      // row the first one wrote, exactly as the database's upsert does.
      const stored = storedNotes.get(note.clientId);
      if (step.action === "skip") {
        pushedNotes.push({
          clientId: note.clientId,
          id: stored.id,
          updatedAt: stored.updatedAt,
        });
        return;
      }
      if (step.action === "update" || stored) {
        Object.assign(stored, noteFields(note), { updatedAt: now });
        pushedNotes.push({
          clientId: stored.clientId,
          id: stored.id,
          updatedAt: stored.updatedAt,
        });
        return;
      }
      const row = Object.assign({}, noteFields(note), {
        id: crypto.randomUUID(),
        userId,
        createdAt: now,
        updatedAt: now,
      });
      this.notes.set(row.id, row);
      // A later item of this batch with the same identity finds the row.
      storedNotes.set(row.clientId, row);
      pushedNotes.push({ clientId: row.clientId, id: row.id, updatedAt: row.updatedAt });
    });

    const pushedWords = [];
    vocabulary.forEach((word, index) => {
      const step = wordPlan[index];
      const key = vocabularyKey(word.term, word.sentence);
      // The row the account already had, or the row an earlier item of this
      // same batch wrote: both are the row this item lands on.
      const stored = storedWords.get(key);
      if (step.action === "skip") {
        pushedWords.push({
          term: word.term,
          sentence: word.sentence,
          id: stored.id,
          updatedAt: stored.updatedAt,
        });
        return;
      }
      if (step.action === "update" || stored) {
        // The same merge the single route does: a device that knows less
        // about a word does not wipe what the first device knew.
        const merged = mergeVocabularyFields(stored, vocabularyFields(word));
        Object.assign(stored, merged, { updatedAt: now, deletedAt: null });
        pushedWords.push({
          term: stored.term,
          sentence: stored.sentence,
          id: stored.id,
          updatedAt: stored.updatedAt,
        });
        return;
      }
      const row = Object.assign({}, vocabularyFields(word), {
        id: crypto.randomUUID(),
        userId,
        createdAt: now,
        updatedAt: now,
      });
      this.vocabulary.set(row.id, row);
      // A later item of this batch with the same text finds the row.
      storedWords.set(key, row);
      // A brand-new word is due for its first review immediately.
      this.reviews.set(reviewKey(userId, row.id), {
        userId,
        vocabularyId: row.id,
        intervalDays: 0,
        ease: 2.5,
        reps: 0,
        lapses: 0,
        dueAt: now,
      });
      pushedWords.push({
        term: row.term,
        sentence: row.sentence,
        id: row.id,
        updatedAt: row.updatedAt,
      });
    });

    return { notes: pushedNotes, vocabulary: pushedWords };
  }

  /**
   * Throws when an item of a batch carries the id of another account's row.
   *
   * The batch matches a note by its client id and a word by its text, so an
   * id in the body is never used to pick a row. It is still refused when it
   * names somebody else's row: a client that sends such an id has a bug, and
   * the answer says so instead of quietly doing something else.
   *
   * @param {string|number} userId the account that is pushing.
   * @param {object[]} notes the notes of the batch.
   * @param {object[]} vocabulary the words of the batch.
   */
  assertNoForeignIds(userId, notes, vocabulary) {
    const foreignNotes = new Set();
    for (const [id, row] of this.notes) {
      if (row.userId !== userId) foreignNotes.add(id);
    }
    const foreignWords = new Set();
    for (const [id, row] of this.vocabulary) {
      if (row.userId !== userId) foreignWords.add(id);
    }
    notes.forEach((note, index) => {
      if (note.id && foreignNotes.has(note.id)) {
        throw new ForeignRowError("notes", index, note.id);
      }
    });
    vocabulary.forEach((word, index) => {
      if (word.id && foreignWords.has(word.id)) {
        throw new ForeignRowError("vocabulary", index, word.id);
      }
    });
  }

  /**
   * How many live rows the account holds, in both content tables.
   *
   * @param {string|number} userId the account.
   * @returns {number} the number of rows.
   */
  countLiveRows(userId) {
    let count = 0;
    for (const row of this.notes.values()) {
      if (row.userId === userId && !row.deletedAt) count += 1;
    }
    for (const row of this.vocabulary.values()) {
      if (row.userId === userId && !row.deletedAt) count += 1;
    }
    return count;
  }

  async updateVocabularyStatus(userId, vocabId, status) {
    const row = this.vocabulary.get(vocabId);
    // A deleted word is not graded and not returned: the answer carries the
    // word and the sentence it was seen in.
    if (!row || row.userId !== userId || row.deletedAt) return null;
    row.status = status;
    row.updatedAt = this.clock().toISOString();
    return rowToVocabulary(row);
  }

  async deleteVocabulary(userId, vocabId) {
    const row = this.vocabulary.get(vocabId);
    if (!row || row.userId !== userId || row.deletedAt) return false;
    // The row stays as a tombstone and keeps its review schedule. A word
    // that is captured again comes back with the progress the user made,
    // instead of starting over as a word that is due right now.
    row.deletedAt = this.clock().toISOString();
    return true;
  }

  async listDueReviews(userId, limit = DEFAULT_REVIEW_LIMIT) {
    const now = this.clock();
    return [...this.reviews.values()]
      .filter((review) => {
        const vocab = this.vocabulary.get(review.vocabularyId);
        return (
          review.userId === userId &&
          vocab &&
          vocab.userId === userId &&
          !vocab.deletedAt &&
          new Date(review.dueAt) <= now
        );
      })
      .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
      .slice(0, limit)
      .map((review) => ({
        review: {
          dueAt: review.dueAt,
          intervalDays: review.intervalDays,
          ease: review.ease,
          reps: review.reps,
        },
        vocabulary: rowToVocabulary(this.vocabulary.get(review.vocabularyId)),
      }));
  }

  async submitReview(userId, vocabId, grade) {
    const vocab = this.vocabulary.get(vocabId);
    if (!vocab || vocab.userId !== userId) return null;
    const key = reviewKey(userId, vocabId);
    let review = this.reviews.get(key);
    if (!review) {
      review = {
        userId,
        vocabularyId: vocabId,
        intervalDays: 0,
        ease: 2.5,
        reps: 0,
        lapses: 0,
      };
      this.reviews.set(key, review);
    }
    const updated = applyGrade(review, grade, this.clock());
    updated.userId = userId;
    updated.vocabularyId = vocabId;
    this.reviews.set(key, updated);
    return {
      dueAt: updated.dueAt,
      intervalDays: updated.intervalDays,
      ease: updated.ease,
      reps: updated.reps,
      lapses: updated.lapses,
    };
  }

  async getSyncDelta(userId, sinceIso) {
    const since = parseSince(sinceIso);
    const mine = (row) => row.userId === userId;
    const notes = takeDelta(
      [...this.notes.values()]
        .filter((row) => mine(row) && !row.deletedAt && new Date(row.updatedAt) > since)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      rowToNote,
    );
    const vocabulary = takeDelta(
      [...this.vocabulary.values()]
        .filter((row) => mine(row) && !row.deletedAt && new Date(row.updatedAt) > since)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      rowToVocabulary,
    );
    // The deletions travel with the delta. A delta that only carries the
    // rows that still exist cannot say that a note is gone, so the device
    // that still holds it would keep it and push it back.
    const deletedNotes = takeDelta(
      [...this.notes.values()].filter(
        (row) => mine(row) && row.deletedAt && new Date(row.deletedAt) > since,
      ),
      (row) => ({ clientId: row.clientId }),
    );
    const deletedVocabulary = takeDelta(
      [...this.vocabulary.values()].filter(
        (row) => mine(row) && row.deletedAt && new Date(row.deletedAt) > since,
      ),
      (row) => ({ term: row.term, sentence: row.sentence }),
    );
    return {
      notes: notes.rows,
      vocabulary: vocabulary.rows,
      deleted: { notes: deletedNotes.rows, vocabulary: deletedVocabulary.rows },
      // A capped list says so, so the device can reconcile instead of
      // believing it has seen every deletion.
      truncated: {
        notes: notes.truncated,
        vocabulary: vocabulary.truncated,
        deletedNotes: deletedNotes.truncated,
        deletedVocabulary: deletedVocabulary.truncated,
      },
    };
  }

  /**
   * Counts a user's rows in one of the two content tables.
   *
   * Deleted rows are not counted: they are tombstones, and a tombstone is
   * not a note the user has.
   */
  async countRows(table, userId) {
    if (!COUNTABLE_TABLES.has(table)) {
      throw new Error(`countRows: unsupported table ${table}`);
    }
    const rows = table === "vocabulary" ? this.vocabulary : this.notes;
    return [...rows.values()].filter(
      (row) => row.userId === userId && !row.deletedAt,
    ).length;
  }

  /**
   * Throws when the account has no room for another note.
   *
   * An update to a note that already exists is not a new note, so it is
   * always allowed: an account that is exactly at the cap must still be
   * able to edit what it has.
   */
  async assertNoteRoom(userId, clientId) {
    const existing = [...this.notes.values()].some(
      (row) => row.userId === userId && row.clientId === clientId,
    );
    if (!existing) await this.assertAccountRoom(userId);
  }

  /** The vocabulary counterpart of assertNoteRoom. */
  async assertVocabularyRoom(userId, term, sentence) {
    const existing = [...this.vocabulary.values()].some(
      (row) => row.userId === userId && row.term === term && row.sentence === sentence,
    );
    if (!existing) await this.assertAccountRoom(userId);
  }

  /**
   * Throws when the account has no room left.
   *
   * The rows are the account's own, so the cap is far above what a real
   * account needs, but it is a bound: without it one account can write
   * until the Worker runs out of memory, and an out-of-memory Worker takes
   * every other account down with it.
   */
  async assertAccountRoom(userId) {
    const used =
      (await this.countRows("notes", userId)) +
      (await this.countRows("vocabulary", userId));
    if (used >= MAX_ACCOUNT_ROWS) {
      throw new StorageLimitError(
        `This account already holds ${used} notes and words, which is the limit of ${MAX_ACCOUNT_ROWS}.`,
        MAX_ACCOUNT_ROWS,
      );
    }
  }

  /**
   * Removes the tombstones that are older than the retention period.
   *
   * A tombstone is only needed while a device could still be holding the row
   * it deleted. Keeping every tombstone forever would grow the database
   * without bound, so the old ones are dropped.
   */
  async purgeTombstones(olderThanIso) {
    const cutoff = new Date(olderThanIso).getTime();
    let removed = 0;
    for (const [key, row] of [...this.notes.entries()]) {
      if (row.deletedAt && new Date(row.deletedAt).getTime() <= cutoff) {
        this.notes.delete(key);
        removed += 1;
      }
    }
    for (const [key, row] of [...this.vocabulary.entries()]) {
      if (row.deletedAt && new Date(row.deletedAt).getTime() <= cutoff) {
        this.vocabulary.delete(key);
        this.reviews.delete(reviewKey(row.userId, key));
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * The size of the export blob, in bytes, without building it.
   *
   * The export is a single JSON blob the browser downloads, so it has to be
   * measured BEFORE it is built: a blob of a few hundred megabytes does not
   * arrive, the download simply dies.
   */
  async estimateExportBytes(userId, part) {
    // One rule, one shape, in both stores: ask which halves the part wants,
    // then answer for exactly those halves. The words bring their reviews
    // with them, because the route keeps the reviews in the words half.
    const wantsNotes = part !== "vocabulary";
    const wantsWords = part !== "notes";
    let bytes = 0;
    if (wantsNotes) {
      for (const row of this.notes.values()) {
        if (row.userId !== userId || row.deletedAt) continue;
        bytes += noteBytes(row) + NOTE_ROW_OVERHEAD_BYTES;
      }
    }
    if (wantsWords) {
      for (const row of this.vocabulary.values()) {
        if (row.userId !== userId || row.deletedAt) continue;
        bytes += vocabularyBytes(row) + WORD_ROW_OVERHEAD_BYTES;
      }
      // The review of a word travels with it in the export.
      for (const review of this.reviews.values()) {
        if (review.userId !== userId) continue;
        const vocabulary = this.vocabulary.get(review.vocabularyId);
        if (!vocabulary || vocabulary.deletedAt) continue;
        bytes += REVIEW_ROW_OVERHEAD_BYTES;
      }
    }
    return bytes;
  }

  async getAllUserData(userId) {
    const user = [...this.users.values()].find(
      (row) => String(row.id) === String(userId),
    );
    const allNotes = [...this.notes.values()].filter(
      (row) => row.userId === userId && !row.deletedAt,
    );
    const allVocabulary = [...this.vocabulary.values()].filter(
      (row) => row.userId === userId && !row.deletedAt,
    );
    const reviews = [...this.reviews.values()]
      .filter((review) => {
        if (review.userId !== userId) return false;
        // The review of a word that is not in the export is not in the
        // export either: the Neon store joins the two tables and cannot
        // return a review without its word.
        const vocabulary = this.vocabulary.get(review.vocabularyId);
        return !!vocabulary && !vocabulary.deletedAt;
      })
      .map((review) => ({
        vocabularyId: review.vocabularyId,
        dueAt: review.dueAt,
        intervalDays: review.intervalDays,
        ease: review.ease,
        reps: review.reps,
        lapses: review.lapses,
      }));
    const notes = allNotes
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, MAX_EXPORT_ROWS)
      .map(rowToNote);
    const vocabulary = allVocabulary
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, MAX_EXPORT_ROWS)
      .map(rowToVocabulary);
    return {
      user: user
        ? { id: user.id, githubId: user.githubId, login: user.login, avatarUrl: user.avatarUrl }
        : null,
      notes,
      vocabulary,
      reviews,
      // Report what was left out, so a truncated export is never silent.
      truncated: {
        notes: Math.max(0, allNotes.length - notes.length),
        vocabulary: Math.max(0, allVocabulary.length - vocabulary.length),
      },
    };
  }

  async deleteUserData(userId) {
    const before = [...this.notes.values()].filter((row) => row.userId === userId).length;
    for (const [key, row] of [...this.notes.entries()]) {
      if (row.userId === userId) this.notes.delete(key);
    }
    for (const [key, row] of [...this.vocabulary.entries()]) {
      if (row.userId === userId) {
        this.vocabulary.delete(key);
        this.reviews.delete(reviewKey(userId, key));
      }
    }
    // The account row goes too: "delete my account and all my data" has to
    // mean the GitHub identity as well, not only the notes. Deleting it
    // revokes every token the account issued, because the token names an
    // account that no longer exists.
    for (const [key, user] of [...this.users.entries()]) {
      if (String(user.id) === String(userId)) this.users.delete(key);
    }
    return before;
  }
}

/**
 * Parses a `since` timestamp. An unparseable value is an error, not an
 * empty result: `new Date("nonsense")` yields an Invalid Date, which
 * compares false against every row and would silently drop the whole
 * delta.
 */
function parseSince(sinceIso) {
  if (sinceIso === undefined || sinceIso === null || sinceIso === "") {
    return new Date(0);
  }
  const parsed = Date.parse(sinceIso);
  if (Number.isNaN(parsed)) {
    const error = new Error("since must be an ISO 8601 timestamp.");
    error.status = 400;
    error.code = "INVALID_SINCE";
    throw error;
  }
  return new Date(parsed);
}

/**
 * SM-2-flavored scheduling. Grades are 0-5 (again/hard/good/easy).
 */
function applyGrade(review, grade, now) {
  const next = Object.assign({}, review);
  if (grade < 2) {
    next.lapses += 1;
    next.ease = Math.max(1.3, next.ease - 0.2);
    next.intervalDays = 0;
    next.dueAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    return next;
  }
  next.reps += 1;
  if (next.reps === 1) {
    next.intervalDays = grade >= 4 ? 2 : 1;
  } else if (next.reps === 2) {
    next.intervalDays = grade >= 4 ? 4 : 3;
  } else {
    const multiplier = grade >= 4 ? next.ease * 1.1 : next.ease;
    // Capped: an uncapped interval eventually overflows timestamptz, which
    // would make every later review submission fail for that account.
    next.intervalDays = Math.min(
      MAX_INTERVAL_DAYS,
      Math.max(1, Math.round(next.intervalDays * multiplier)),
    );
  }
  next.ease = Math.min(2.8, next.ease + (grade >= 4 ? 0.1 : 0));
  next.dueAt = new Date(now.getTime() + next.intervalDays * 86_400_000).toISOString();
  return next;
}

/**
 * The statement that writes one note of a batch.
 *
 * The same upsert the single route uses: a note is matched by its client
 * id, and a note that was deleted is not written again.
 *
 * @param {string|number} userId the account that owns the row.
 * @param {object} note the parsed note.
 * @returns {object} the statement.
 */
function noteUpsertStatement(sql, userId, note) {
  const starred = typeof note.starred === "boolean" ? note.starred : null;
  return sql`
    insert into notes (user_id, client_id, video_id, video_title, channel_name, timestamp_seconds, quote, note, starred)
    values (${userId}, ${note.clientId}, ${note.videoId}, ${note.videoTitle}, ${note.channelName},
      ${note.timestampSeconds}, ${note.quote}, ${note.note}, coalesce(${starred}, false))
    on conflict (user_id, client_id) do update set
      video_id = excluded.video_id, video_title = excluded.video_title,
      channel_name = excluded.channel_name, timestamp_seconds = excluded.timestamp_seconds,
      quote = excluded.quote, note = excluded.note, updated_at = now(),
      starred = coalesce(${starred}, notes.starred)
    where notes.deleted_at is null
    returning id, client_id as "clientId", updated_at as "updatedAt"
  `;
}

/**
 * The statement that writes one word of a batch.
 *
 * The same upsert the single route uses: a word is matched by its text,
 * a device that knows less about a word does not wipe what the first
 * device knew, and a word that was deleted comes back with the review
 * schedule it had.
 *
 * @param {string|number} userId the account that owns the row.
 * @param {object} word the parsed word.
 * @returns {object} the statement.
 */
function wordUpsertStatement(sql, userId, word) {
  return sql`
    insert into vocabulary (user_id, term, translation, sentence, sentence_translation,
      video_id, video_title, timestamp_seconds, status)
    values (${userId}, ${word.term}, ${word.translation}, ${word.sentence}, ${word.sentenceTranslation},
      ${word.videoId}, ${word.videoTitle}, ${word.timestampSeconds}, ${word.status})
    on conflict (user_id, sync_key) do update set
      translation = case when excluded.translation <> '' then excluded.translation else vocabulary.translation end,
      sentence_translation = case when excluded.sentence_translation <> '' then excluded.sentence_translation else vocabulary.sentence_translation end,
      video_id = case when excluded.video_id <> '' then excluded.video_id else vocabulary.video_id end,
      video_title = case when excluded.video_title <> '' then excluded.video_title else vocabulary.video_title end,
      timestamp_seconds = excluded.timestamp_seconds,
      status = case
        when vocabulary.status = 'mastered' or excluded.status = 'mastered' then 'mastered'
        when vocabulary.status = 'reviewing' or excluded.status = 'reviewing' then 'reviewing'
        else 'learning' end,
      deleted_at = null,
      updated_at = now()
    returning id, term, sentence, updated_at as "updatedAt"
  `;
}

/**
 * The statement that gives every word of the batch its review row.
 *
 * A word that is new is due for its first review immediately. The review
 * row is written in the same transaction as the words, so a batch never
 * leaves a word behind that the user cannot review.
 *
 * @param {string|number} userId the account that owns the rows.
 * @param {object[]} vocabulary the words of the batch.
 * @param {number[]} slots the positions of the words that were written.
 * @returns {object} the statement.
 */
function reviewItemsStatement(sql, userId, vocabulary, slots) {
  const parts = [
    "insert into review_items (user_id, vocabulary_id) select ",
    bound(userId),
    ", v.id from vocabulary v where v.user_id = ",
    bound(userId),
    " and (v.term, v.sentence) in ((",
  ];
  slots.forEach((slot, index) => {
    // The casts are required: Postgres cannot infer the type of a bound
    // value inside a row constructor, and refuses the statement outright.
    if (index > 0) parts.push("), (");
    parts.push(bound(vocabulary[slot].term));
    parts.push("::text, ");
    parts.push(bound(vocabulary[slot].sentence));
    parts.push("::text");
  });
  parts.push(")) on conflict (user_id, vocabulary_id) do nothing");
  const statement = buildBoundStatement(parts);
  return sql(statement.strings, ...statement.values);
}

/**
 * The statement that refuses a batch the account has no room for.
 *
 * The count runs inside the transaction and after the writes, so it sees
 * the rows the batch just wrote. A batch that would push the account past
 * the limit divides by zero, which aborts the transaction: nothing of the
 * batch is written.
 *
 * @param {string|number} userId the account.
 * @returns {object} the statement.
 */
function accountRoomGuardStatement(sql, userId) {
  return sql`
    select 1 / case when
      (select count(*) from notes where user_id = ${userId} and deleted_at is null)
      + (select count(*) from vocabulary where user_id = ${userId} and deleted_at is null)
      <= ${MAX_ACCOUNT_ROWS}
    then 1 else 0 end as guard
  `;
}

/**
 * The rows of the account that the notes of the batch are matched with.
 *
 * @param {string|number} userId the account.
 * @param {object[]} notes the notes of the batch.
 * @returns {Promise<Map<string, object>>} the rows, keyed by client id.
 */
async function lookupNotes(sql, userId, notes) {
  const rows = new Map();
  const clientIds = [];
  for (const note of notes) {
    if (note.clientId && !clientIds.includes(note.clientId)) {
      clientIds.push(note.clientId);
    }
  }
  if (!clientIds.length) return rows;
  const parts = [
    'select id, client_id as "clientId", updated_at as "updatedAt", deleted_at as "deletedAt" from notes where user_id = ',
    bound(userId),
    " and client_id in (",
  ];
  clientIds.forEach((clientId, index) => {
    if (index > 0) parts.push(", ");
    parts.push(bound(clientId));
  });
  parts.push(")");
  const statement = buildBoundStatement(parts);
  const found = await sql(statement.strings, ...statement.values);
  for (const row of found) {
    rows.set(row.clientId, {
      id: row.id,
      clientId: row.clientId,
      updatedAt: toIso(row.updatedAt),
      deletedAt: row.deletedAt ? toIso(row.deletedAt) : null,
    });
  }
  return rows;
}

/**
 * The rows of the account that the words of the batch are matched with.
 *
 * A word is matched by its text and the sentence it was seen in. The
 * sentence is checked here, so the words that only share a term with the
 * batch are not part of the answer.
 *
 * @param {string|number} userId the account.
 * @param {object[]} vocabulary the words of the batch.
 * @returns {Promise<Map<string, object>>} the rows, keyed by term and
 *   sentence.
 */
async function lookupVocabulary(sql, userId, vocabulary) {
  const rows = new Map();
  const terms = [];
  for (const word of vocabulary) {
    if (word.term && !terms.includes(word.term)) terms.push(word.term);
  }
  if (!terms.length) return rows;
  const parts = [
    'select id, term, sentence, updated_at as "updatedAt", deleted_at as "deletedAt" from vocabulary where user_id = ',
    bound(userId),
    " and term in (",
  ];
  terms.forEach((term, index) => {
    if (index > 0) parts.push(", ");
    parts.push(bound(term));
  });
  parts.push(")");
  const statement = buildBoundStatement(parts);
  const found = await sql(statement.strings, ...statement.values);
  for (const row of found) {
    if (!vocabulary.some((word) => word.sentence === row.sentence)) continue;
    rows.set(vocabularyKey(row.term, row.sentence), {
      id: row.id,
      term: row.term,
      sentence: row.sentence,
      updatedAt: toIso(row.updatedAt),
      deletedAt: row.deletedAt ? toIso(row.deletedAt) : null,
    });
  }
  return rows;
}

/**
 * Who owns the given rows.
 *
 * @param {"notes"|"vocabulary"} table the table the ids are in.
 * @param {string[]} ids the row ids.
 * @returns {Promise<Map<string, string>>} the owner of every id that
 *   exists.
 */
async function lookupRowOwners(sql, table, ids) {
  const owners = new Map();
  if (!COUNTABLE_TABLES.has(table)) {
    throw new Error(`lookupRowOwners: unsupported table ${table}`);
  }
  const parts = [
    'select id, user_id as "userId" from ',
    table,
    " where id in (",
  ];
  ids.forEach((id, index) => {
    if (index > 0) parts.push(", ");
    parts.push(bound(id));
  });
  parts.push(")");
  const statement = buildBoundStatement(parts);
  const rows = await sql(statement.strings, ...statement.values);
  for (const row of rows) owners.set(row.id, String(row.userId));
  return owners;
}

class NeonStore {
  /**
   * @param {string} connectionString Neon connection string.
   * @param {(strings: TemplateStringsArray, ...values: unknown[]) => Promise<object[]>} [sql]
   *   Pre-built tagged-template driver. Production always lets the constructor
   *   call `neon(connectionString)`; the parameter exists so tests can inject a
   *   fake and assert on the queries the store issues. It is never derived
   *   from user input.
   */
  constructor(connectionString, sql) {
    this.sql =
      sql ||
      require("@neondatabase/serverless").neon(connectionString);
  }

  async upsertUser(githubUser) {
    const rows = await this.sql`
      insert into users (github_id, github_login, avatar_url)
      values (${githubUser.githubId}, ${githubUser.login}, ${githubUser.avatarUrl || ""})
      on conflict (github_id) do update set
        github_login = excluded.github_login,
        avatar_url = excluded.avatar_url
      returning id, github_id as "githubId", github_login as "login", avatar_url as "avatarUrl",
        token_version as "tokenVersion"
    `;
    return rows[0];
  }

  /**
   * The token version stored for an account. `null` means the account does
   * not exist, so no token can authenticate as it any more.
   */
  async getTokenVersion(userId) {
    const rows = await this.sql`
      select token_version as "tokenVersion" from users where id = ${userId}
    `;
    if (!rows.length) return null;
    return Number(rows[0].tokenVersion) || 0;
  }

  async listNotes(userId, limit = MAX_LIST_ROWS) {
    const rows = await this.sql`
      select id, client_id as "clientId", starred, video_id as "videoId", video_title as "videoTitle",
        channel_name as "channelName", timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
      from notes where user_id = ${userId} and deleted_at is null
      order by updated_at desc limit ${limit}
    `;
    return rows.map(rowToNote);
  }

  /**
   * How many notes the account holds.
   *
   * The list is capped, so the page is not the account: a dashboard that
   * shows the number of rows it received tells the user a false number
   * about their own data. The count covers every live row, not the page.
   */
  async countNotes(userId) {
    const rows = await this.sql`
      select count(*) as count from notes
      where user_id = ${userId} and deleted_at is null
    `;
    return rows.length ? Number(rows[0].count) || 0 : 0;
  }

  /**
   * Marks every note of the account as deleted.
   *
   * The same tombstone a single delete leaves behind: the rows stay until
   * the scheduled purge drops them, so a device that still holds a note
   * cannot bring it back. The count is the number of rows that were
   * marked, which is the number the user had.
   */
  async deleteAllNotes(userId) {
    const rows = await this.sql`
      update notes set deleted_at = now(), updated_at = now()
      where user_id = ${userId} and deleted_at is null
      returning id
    `;
    return rows.length;
  }

  async createNote(userId, note) {
    // Tri-state `starred`: null means the client did not mention it. The
    // insert falls back to the column default, and the conflict branch keeps
    // whatever is already stored, so pushing note text from the extension can
    // never clear a favorite the user set in the dashboard.
    const starred = typeof note.starred === "boolean" ? note.starred : null;
    await this.assertNoteRoom(userId, note.clientId);
    const rows = await this.sql`
      insert into notes (user_id, client_id, video_id, video_title, channel_name, timestamp_seconds, quote, note, starred)
      values (${userId}, ${note.clientId}, ${note.videoId}, ${note.videoTitle}, ${note.channelName},
        ${note.timestampSeconds}, ${note.quote}, ${note.note}, coalesce(${starred}, false))
      on conflict (user_id, client_id) do update set
        video_id = excluded.video_id, video_title = excluded.video_title,
        channel_name = excluded.channel_name, timestamp_seconds = excluded.timestamp_seconds,
        quote = excluded.quote, note = excluded.note, updated_at = now(),
        starred = coalesce(${starred}, notes.starred)
      where notes.deleted_at is null
      returning id, client_id as "clientId", starred, video_id as "videoId", video_title as "videoTitle",
        channel_name as "channelName", timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
    `;
    if (rows.length) return rowToNote(rows[0]);
    // The note was deleted. The delete wins, so the row stays deleted and
    // the push changes nothing: a device that still holds the note cannot
    // bring it back from the server. The row is read back so the caller
    // learns which note this client id belongs to.
    const deleted = await this.sql`
      select id, client_id as "clientId", starred, video_id as "videoId", video_title as "videoTitle",
        channel_name as "channelName", timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
      from notes where user_id = ${userId} and client_id = ${note.clientId}
    `;
    return deleted.length ? rowToNote(deleted[0]) : null;
  }

  async deleteNoteByClientId(userId, clientId) {
    const rows = await this.sql`
      update notes set deleted_at = now(), updated_at = now()
      where user_id = ${userId} and client_id = ${clientId} and deleted_at is null
      returning id
    `;
    return rows.length > 0;
  }

  async setNoteStarred(userId, noteId, starred) {
    const rows = await this.sql`
      update notes set starred = ${!!starred}, updated_at = now()
      where id = ${noteId} and user_id = ${userId} and deleted_at is null
      returning id, client_id as "clientId", starred, video_id as "videoId",
        video_title as "videoTitle", channel_name as "channelName",
        timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
    `;
    return rows.length ? rowToNote(rows[0]) : null;
  }

  async updateNote(userId, noteId, patch) {
    // Only the fields the client actually sent are written, so a partial
    // update never zeroes the fields it left out. The column list is a
    // hardcoded whitelist: no column name ever comes from the request.
    // `starred` keeps the tri-state rule: the column is only written when
    // the client actually sent a boolean, so an absent flag leaves the
    // stored one alone. The note body follows the same rule: a patch that
    // does not carry it leaves the stored text alone.
    const assignments = [];
    if (patch.note !== undefined) {
      assignments.push({ before: "note = ", after: "", value: patch.note });
    }
    if (patch.videoId !== undefined) {
      assignments.push({ before: "video_id = ", after: "", value: patch.videoId });
    }
    if (patch.videoTitle !== undefined) {
      assignments.push({ before: "video_title = ", after: "", value: patch.videoTitle });
    }
    if (patch.channelName !== undefined) {
      assignments.push({ before: "channel_name = ", after: "", value: patch.channelName });
    }
    if (patch.timestampSeconds !== undefined) {
      assignments.push({ before: "timestamp_seconds = ", after: "", value: patch.timestampSeconds });
    }
    if (patch.quote !== undefined) {
      assignments.push({ before: "quote = ", after: "", value: patch.quote });
    }
    if (typeof patch.starred === "boolean") {
      assignments.push({
        before: "starred = coalesce(",
        after: ", starred)",
        value: patch.starred,
      });
    }
    // The edit has to move the row's own timestamp. The delta sync and the
    // last-write-wins comparison both read `updated_at`; a note that was
    // edited but kept its old timestamp is invisible to the other devices.
    assignments.push({ raw: "updated_at = now()" });
    const statement = buildUpdateStatement(
      "update notes set ",
      assignments,
      [
        { before: " where id = ", after: " and user_id = ", value: noteId },
        // A deleted note is not edited, and its text is not returned. The
        // tombstone is a row that is not there.
        { before: "", after: " and deleted_at is null", value: userId },
      ],
      // Without `returning` the driver reports no rows, and the route would
      // answer "Note not found." for the note it had just updated.
      NOTE_RETURNING_COLUMNS,
    );
    const rows = await this.sql(statement.strings, ...statement.values);
    return rows.length ? rowToNote(rows[0]) : null;
  }

  async deleteNote(userId, noteId) {
    const rows = await this.sql`
      update notes set deleted_at = now(), updated_at = now()
      where id = ${noteId} and user_id = ${userId} and deleted_at is null
      returning id
    `;
    return rows.length > 0;
  }

  /**
   * Writes a batch of notes and words in one transaction.
   *
   * The batch is all or nothing. Every statement of the batch runs in one
   * transaction, so a batch that cannot be written whole - because the
   * account has no room left, or because a statement fails - leaves the
   * account exactly as it was. The account cap is therefore checked against
   * the whole batch, not row by row.
   *
   * @param {string|number} userId the account that owns the rows.
   * @param {{notes?: object[], vocabulary?: object[]}} batch the items.
   * @returns {Promise<{notes: object[], vocabulary: object[]}>} what the
   *   server holds for every item of the batch.
   */
  async batchUpsert(userId, batch) {
    const notes = (batch && batch.notes) || [];
    const vocabulary = (batch && batch.vocabulary) || [];

    // The token decides the account: an id in the body may not name a row
    // somebody else owns. Nothing is written when one does.
    await this.assertNoForeignIds(userId, notes, vocabulary);

    // The rows the account already has, so the plan can be made.
    const storedNotes = await lookupNotes(this.sql, userId, notes);
    const storedWords = await lookupVocabulary(this.sql, userId, vocabulary);

    const notePlan = planBatch(
      storedNotes,
      notes,
      (note) => note.clientId,
      true,
    );
    const wordPlan = planBatch(
      storedWords,
      vocabulary,
      (word) => vocabularyKey(word.term, word.sentence),
      false,
    );

    // The cap, checked against the whole batch before anything is written.
    // Two items with the same identity are one row, so they are one new row
    // here too.
    const added =
      countAddedRows(notes, notePlan, (note) => note.clientId, storedNotes) +
      countAddedRows(
        vocabulary,
        wordPlan,
        (word) => vocabularyKey(word.term, word.sentence),
        storedWords,
      );
    const used = await this.countLiveRows(userId);
    if (used + added > MAX_ACCOUNT_ROWS) {
      throw new StorageLimitError(
        `This account already holds ${used} notes and words, and this batch would add ${added} more, which is past the limit of ${MAX_ACCOUNT_ROWS}.`,
        MAX_ACCOUNT_ROWS,
      );
    }

    // The writes. Every statement of the batch is one statement of one
    // transaction, so the batch lands whole or not at all.
    const statements = [];
    const noteSlots = [];
    const wordSlots = [];
    notes.forEach((note, index) => {
      if (notePlan[index].action === "skip") return;
      statements.push(noteUpsertStatement(this.sql, userId, note));
      noteSlots.push(index);
    });
    vocabulary.forEach((word, index) => {
      if (wordPlan[index].action === "skip") return;
      statements.push(wordUpsertStatement(this.sql, userId, word));
      wordSlots.push(index);
    });
    if (wordSlots.length) {
      statements.push(reviewItemsStatement(this.sql, userId, vocabulary, wordSlots));
    }
    // The guard runs after the writes and inside the same transaction: it
    // counts the rows the account holds now and refuses the whole batch when
    // that is more than the limit allows.
    statements.push(accountRoomGuardStatement(this.sql, userId));

    let results;
    try {
      results = await this.sql.transaction(statements);
    } catch (error) {
      if (isDivisionByZero(error)) {
        throw new StorageLimitError(
          `This account cannot hold more than ${MAX_ACCOUNT_ROWS} notes and words, which is the limit of ${MAX_ACCOUNT_ROWS}.`,
          MAX_ACCOUNT_ROWS,
        );
      }
      throw error;
    }

    // The answer: what the server holds for every item of the batch, in the
    // order of the request.
    const writtenNotes = new Map();
    noteSlots.forEach((itemIndex, slot) => {
      const rows = results[slot] || [];
      if (rows.length) writtenNotes.set(notes[itemIndex].clientId, rows[0]);
    });
    const writtenWords = new Map();
    wordSlots.forEach((itemIndex, slot) => {
      const rows = results[noteSlots.length + slot] || [];
      if (rows.length) {
        const word = vocabulary[itemIndex];
        writtenWords.set(vocabularyKey(word.term, word.sentence), rows[0]);
      }
    });
    const pushedNotes = notes.map((note) => {
      const written = writtenNotes.get(note.clientId);
      if (written) {
        return {
          clientId: note.clientId,
          id: written.id,
          updatedAt: toIso(written.updatedAt),
        };
      }
      // The item was not written: the stored row wins, or the row was
      // deleted between the plan and the write. Either way the stored row is
      // what the client has to know about.
      const stored = storedNotes.get(note.clientId);
      return {
        clientId: note.clientId,
        id: stored.id,
        updatedAt: toIso(stored.updatedAt),
      };
    });

    const pushedWords = vocabulary.map((word) => {
      const key = vocabularyKey(word.term, word.sentence);
      const written = writtenWords.get(key);
      if (written) {
        return {
          term: word.term,
          sentence: word.sentence,
          id: written.id,
          updatedAt: toIso(written.updatedAt),
        };
      }
      const stored = storedWords.get(key);
      return {
        term: word.term,
        sentence: word.sentence,
        id: stored.id,
        updatedAt: toIso(stored.updatedAt),
      };
    });

    return { notes: pushedNotes, vocabulary: pushedWords };
  }







  /**
   * Throws when an item of a batch carries the id of another account's row.
   *
   * The batch matches a note by its client id and a word by its text, so an
   * id in the body is never used to pick a row. It is still refused when it
   * names somebody else's row: the token decides the account, and a client
   * that sends such an id has a bug the answer points at.
   *
   * @param {string|number} userId the account that is pushing.
   * @param {object[]} notes the notes of the batch.
   * @param {object[]} vocabulary the words of the batch.
   */
  async assertNoForeignIds(userId, notes, vocabulary) {
    const noteIds = notes.map((note) => note.id).filter(isUuid);
    if (noteIds.length) {
      const owners = await lookupRowOwners(this.sql, "notes", noteIds);
      notes.forEach((note, index) => {
        if (!note.id || !owners.has(note.id)) return;
        if (String(owners.get(note.id)) !== String(userId)) {
          throw new ForeignRowError("notes", index, note.id);
        }
      });
    }
    const wordIds = vocabulary.map((word) => word.id).filter(isUuid);
    if (wordIds.length) {
      const owners = await lookupRowOwners(this.sql, "vocabulary", wordIds);
      vocabulary.forEach((word, index) => {
        if (!word.id || !owners.has(word.id)) return;
        if (String(owners.get(word.id)) !== String(userId)) {
          throw new ForeignRowError("vocabulary", index, word.id);
        }
      });
    }
  }


  /**
   * How many live rows the account holds, in both content tables.
   *
   * @param {string|number} userId the account.
   * @returns {Promise<number>} the number of rows.
   */
  async countLiveRows(userId) {
    const rows = await this.sql`
      select
        (select count(*) from notes where user_id = ${userId} and deleted_at is null) as notes,
        (select count(*) from vocabulary where user_id = ${userId} and deleted_at is null) as vocabulary
    `;
    const notes = rows.length ? Number(rows[0].notes) || 0 : 0;
    const vocabulary = rows.length ? Number(rows[0].vocabulary) || 0 : 0;
    return notes + vocabulary;
  }

  async listVocabulary(userId, limit = MAX_LIST_ROWS) {
    const rows = await this.sql`
      select id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
      from vocabulary where user_id = ${userId} and deleted_at is null
      order by updated_at desc limit ${limit}
    `;
    return rows.map(rowToVocabulary);
  }

  /**
   * How many words the account holds.
   *
   * The same truth as countNotes: the page is capped, the account is not.
   */
  async countVocabulary(userId) {
    const rows = await this.sql`
      select count(*) as count from vocabulary
      where user_id = ${userId} and deleted_at is null
    `;
    return rows.length ? Number(rows[0].count) || 0 : 0;
  }

  async upsertVocabulary(userId, vocab) {
    await this.assertVocabularyRoom(userId, vocab.term, vocab.sentence);
    const rows = await this.sql`
      insert into vocabulary (user_id, term, translation, sentence, sentence_translation,
        video_id, video_title, timestamp_seconds, status)
      values (${userId}, ${vocab.term}, ${vocab.translation}, ${vocab.sentence},
        ${vocab.sentenceTranslation}, ${vocab.videoId}, ${vocab.videoTitle},
        ${vocab.timestampSeconds}, ${vocab.status})
      on conflict (user_id, sync_key) do update set
        translation = case when excluded.translation <> '' then excluded.translation else vocabulary.translation end,
        sentence_translation = case when excluded.sentence_translation <> '' then excluded.sentence_translation else vocabulary.sentence_translation end,
        video_id = case when excluded.video_id <> '' then excluded.video_id else vocabulary.video_id end,
        video_title = case when excluded.video_title <> '' then excluded.video_title else vocabulary.video_title end,
        timestamp_seconds = excluded.timestamp_seconds,
        status = case
          when vocabulary.status = 'mastered' or excluded.status = 'mastered' then 'mastered'
          when vocabulary.status = 'reviewing' or excluded.status = 'reviewing' then 'reviewing'
          else 'learning' end,
        deleted_at = null,
        updated_at = now()
      returning id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
    `;
    // A brand-new word is due for its first review immediately. Existing
    // entries keep their review schedule untouched.
    // Both columns are populated: user_id must be the caller's id (a bigint
    // that also drives every due-review query) and vocabulary_id the word's.
    await this.sql`
      insert into review_items (user_id, vocabulary_id) values (${userId}, ${rows[0].id})
      on conflict (user_id, vocabulary_id) do nothing
    `;
    return rowToVocabulary(rows[0]);
  }

  async updateVocabularyStatus(userId, vocabId, status) {
    const rows = await this.sql`
      update vocabulary set status = ${status}, updated_at = now()
      where id = ${vocabId} and user_id = ${userId} and deleted_at is null
      returning id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
    `;
    return rows.length ? rowToVocabulary(rows[0]) : null;
  }

  async deleteVocabulary(userId, vocabId) {
    // The row is marked as deleted and keeps its review schedule: a word
    // that is captured again comes back with the progress the user made,
    // instead of starting over as a word that is due right now.
    const rows = await this.sql`
      update vocabulary set deleted_at = now(), updated_at = now()
      where id = ${vocabId} and user_id = ${userId} and deleted_at is null
      returning id
    `;
    return rows.length > 0;
  }

  async listDueReviews(userId, limit = DEFAULT_REVIEW_LIMIT) {
    const rows = await this.sql`
      select ri.due_at as "dueAt", ri.interval_days as "intervalDays", ri.ease, ri.reps,
        v.id as "vocabId", v.term, v.translation, v.sentence, v.sentence_translation as "sentenceTranslation",
        v.video_id as "videoId", v.video_title as "videoTitle", v.timestamp_seconds as "timestampSeconds", v.status,
        v.created_at as "createdAt", v.updated_at as "updatedAt"
      from review_items ri
      join vocabulary v on v.id = ri.vocabulary_id
      where ri.user_id = ${userId} and v.user_id = ${userId} and v.deleted_at is null
        and ri.due_at <= now()
      order by ri.due_at asc limit ${limit}
    `;
    return rows.map((row) => ({
      review: { dueAt: row.dueAt, intervalDays: row.intervalDays, ease: row.ease, reps: row.reps },
      vocabulary: rowToVocabulary({
        id: row.vocabId, term: row.term, translation: row.translation, sentence: row.sentence,
        sentenceTranslation: row.sentenceTranslation, videoId: row.videoId, videoTitle: row.videoTitle,
        timestampSeconds: row.timestampSeconds, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
      }),
    }));
  }

  async submitReview(userId, vocabId, grade) {
    // Ownership gate. review_items has its own user_id, so a matching row is
    // no proof that the caller owns the vocabulary: the same vocabulary_id can
    // legally appear under a different user_id. Without this check any
    // signed-in account could schedule reviews against another account's
    // words and then read them back through listDueReviews.
    const owned = await this.sql`
      select id from vocabulary where id = ${vocabId} and user_id = ${userId}
    `;
    if (!owned.length) return null;

    const existing = await this.sql`
      select interval_days as "intervalDays", ease, reps, lapses
      from review_items where vocabulary_id = ${vocabId} and user_id = ${userId}
    `;
    const base = existing[0] || { intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 };
    const scheduled = applyGrade(base, grade, new Date());
    const rows = await this.sql`
      insert into review_items (user_id, vocabulary_id, due_at, interval_days, ease, reps, lapses)
      values (${userId}, ${vocabId}, ${scheduled.dueAt}, ${scheduled.intervalDays},
        ${scheduled.ease}, ${scheduled.reps}, ${scheduled.lapses})
      on conflict (user_id, vocabulary_id) do update set
        due_at = excluded.due_at, interval_days = excluded.interval_days, ease = excluded.ease,
        reps = excluded.reps, lapses = excluded.lapses, updated_at = now()
      returning due_at as "dueAt", interval_days as "intervalDays", ease, reps, lapses
    `;
    return rows[0];
  }

  async getSyncDelta(userId, sinceIso) {
    const since = parseSince(sinceIso);
    const sinceIsoText = since.toISOString();
    // The rows are limited: a delta without a limit is a request for
    // everything the account ever wrote, which is what takes the Worker
    // down when one account holds a lot.
    const notes = takeDelta(
      await this.sql`
      select id, client_id as "clientId", starred, video_id as "videoId", video_title as "videoTitle",
        channel_name as "channelName", timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
      from notes where user_id = ${userId} and updated_at > ${sinceIsoText} and deleted_at is null
      order by updated_at desc limit ${MAX_LIST_ROWS + 1}
    `,
      rowToNote,
    );
    const vocabulary = takeDelta(
      await this.sql`
      select id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
      from vocabulary where user_id = ${userId} and updated_at > ${sinceIsoText} and deleted_at is null
      order by updated_at desc limit ${MAX_LIST_ROWS + 1}
    `,
      rowToVocabulary,
    );
    // The deletions travel with the delta. A delta that only carries the
    // rows that still exist cannot say that a note is gone, so the device
    // that still holds it would keep it and push it back.
    const deletedNotes = takeDelta(
      await this.sql`
      select client_id as "clientId" from notes
      where user_id = ${userId} and deleted_at is not null and deleted_at > ${sinceIsoText}
      order by deleted_at desc limit ${MAX_LIST_ROWS + 1}
    `,
      (row) => ({ clientId: row.clientId }),
    );
    const deletedVocabulary = takeDelta(
      await this.sql`
      select term, sentence from vocabulary
      where user_id = ${userId} and deleted_at is not null and deleted_at > ${sinceIsoText}
      order by deleted_at desc limit ${MAX_LIST_ROWS + 1}
    `,
      (row) => ({ term: row.term, sentence: row.sentence }),
    );
    return {
      notes: notes.rows,
      vocabulary: vocabulary.rows,
      deleted: {
        notes: deletedNotes.rows,
        vocabulary: deletedVocabulary.rows,
      },
      truncated: {
        notes: notes.truncated,
        vocabulary: vocabulary.truncated,
        deletedNotes: deletedNotes.truncated,
        deletedVocabulary: deletedVocabulary.truncated,
      },
    };
  }

  async getAllUserData(userId) {
    const users = await this.sql`
      select id, github_id as "githubId", github_login as "login", avatar_url as "avatarUrl"
      from users where id = ${userId}
    `;
    const notes = await this.listNotes(userId, MAX_EXPORT_ROWS);
    const vocabulary = await this.listVocabulary(userId, MAX_EXPORT_ROWS);
    const reviews = await this.sql`
      select ri.vocabulary_id as "vocabularyId", ri.due_at as "dueAt",
        ri.interval_days as "intervalDays", ri.ease, ri.reps, ri.lapses
      from review_items ri
      join vocabulary v on v.id = ri.vocabulary_id
      where ri.user_id = ${userId} and v.user_id = ${userId} and v.deleted_at is null
    `;
    const noteCount = await this.countRows("notes", userId);
    const vocabularyCount = await this.countRows("vocabulary", userId);
    return {
      user: users[0]
        ? {
            id: users[0].id,
            githubId: users[0].githubId,
            login: users[0].login,
            avatarUrl: users[0].avatarUrl,
          }
        : null,
      notes,
      vocabulary,
      reviews,
      // Report what was left out, so a truncated export is never silent.
      truncated: {
        notes: Math.max(0, noteCount - notes.length),
        vocabulary: Math.max(0, vocabularyCount - vocabulary.length),
      },
    };
  }

  /**
   * Counts a user's rows in one of the two content tables.
   *
   * The table name is a schema identifier, not a value: a tagged template
   * turns every interpolation into a bound parameter, and `from $1` is not
   * valid SQL. The name is therefore taken from a fixed whitelist and
   * written into the statement text, while the user id stays a bound
   * parameter.
   */
  async countRows(table, userId) {
    if (!COUNTABLE_TABLES.has(table)) {
      throw new Error(`countRows: unsupported table ${table}`);
    }
    const rows = await this.sql(
      [`select count(*) as count from ${table} where user_id = `, " and deleted_at is null"],
      userId,
    );
    return rows.length ? Number(rows[0].count) || 0 : 0;
  }

  /**
   * Throws when the account has no room for another note.
   *
   * An update to a note that already exists is not a new note, so it is
   * always allowed: an account that is exactly at the cap must still be
   * able to edit what it has.
   */
  async assertNoteRoom(userId, clientId) {
    const rows = await this.sql`
      select 1 from notes where user_id = ${userId} and client_id = ${clientId}
    `;
    if (!rows.length) await this.assertAccountRoom(userId);
  }

  /** The vocabulary counterpart of assertNoteRoom. */
  async assertVocabularyRoom(userId, term, sentence) {
    const rows = await this.sql`
      select 1 from vocabulary
      where user_id = ${userId} and term = ${term} and sentence = ${sentence}
    `;
    if (!rows.length) await this.assertAccountRoom(userId);
  }

  /**
   * Throws when the account has no room left.
   *
   * The rows are the account's own, so the cap is far above what a real
   * account needs, but it is a bound: without it one account can write
   * until the Worker runs out of memory, and an out-of-memory Worker takes
   * every other account down with it.
   */
  async assertAccountRoom(userId) {
    const rows = await this.sql`
      select
        (select count(*) from notes where user_id = ${userId} and deleted_at is null) as notes,
        (select count(*) from vocabulary where user_id = ${userId} and deleted_at is null) as vocabulary
    `;
    const used =
      (rows.length ? Number(rows[0].notes) || 0 : 0) +
      (rows.length ? Number(rows[0].vocabulary) || 0 : 0);
    if (used >= MAX_ACCOUNT_ROWS) {
      throw new StorageLimitError(
        `This account already holds ${used} notes and words, which is the limit of ${MAX_ACCOUNT_ROWS}.`,
        MAX_ACCOUNT_ROWS,
      );
    }
  }

  /**
   * Removes the tombstones that are older than the retention period.
   *
   * A tombstone is only needed while a device could still be holding the row
   * it deleted. Keeping every tombstone forever would grow the database
   * without bound, so the old ones are dropped.
   */
  async purgeTombstones(olderThanIso) {
    const cutoff = new Date(olderThanIso).toISOString();
    const notes = await this.sql`
      delete from notes
      where deleted_at is not null and deleted_at < ${cutoff}
      returning id
    `;
    const vocabulary = await this.sql`
      delete from vocabulary
      where deleted_at is not null and deleted_at < ${cutoff}
      returning id
    `;
    return notes.length + vocabulary.length;
  }

  /**
   * The size of the export blob, in bytes, without building it.
   *
   * The export is a single JSON blob the browser downloads, so it has to be
   * measured BEFORE it is built: a blob of a few hundred megabytes does not
   * arrive, the download simply dies.
   */
  async estimateExportBytes(userId, part) {
    // The export can be asked for one part at a time. An account too big
    // for one file is then fetched in two, which is the difference between
    // "too big" and "impossible". The estimate has to answer for that part
    // alone, or the second half is refused by the cap of the first.
    //
    // The words bring their reviews with them: the route drops the reviews
    // from the notes half and keeps them in the words half, so the estimate
    // counts them there and not there.
    const wantsNotes = part !== "vocabulary";
    const wantsWords = part !== "notes";
    let bytes = 0;
    if (wantsNotes) {
      const notes = await this.sql`
        select coalesce(sum(
          octet_length(note) + octet_length(quote) + octet_length(video_title) + octet_length(channel_name)
          + ${NOTE_ROW_OVERHEAD_BYTES}
        ), 0) as bytes
        from notes where user_id = ${userId} and deleted_at is null
      `;
      bytes += notes.length ? Number(notes[0].bytes) || 0 : 0;
    }
    if (wantsWords) {
      const vocabulary = await this.sql`
        select coalesce(sum(
          octet_length(term) + octet_length(translation) + octet_length(sentence)
          + octet_length(sentence_translation) + octet_length(video_title)
          + ${WORD_ROW_OVERHEAD_BYTES}
        ), 0) as bytes
        from vocabulary where user_id = ${userId} and deleted_at is null
      `;
      bytes += vocabulary.length ? Number(vocabulary[0].bytes) || 0 : 0;
      const reviews = await this.sql`
        select count(*) as count
        from review_items ri
        join vocabulary v on v.id = ri.vocabulary_id
        where ri.user_id = ${userId} and v.user_id = ${userId} and v.deleted_at is null
      `;
      bytes +=
        (reviews.length ? (Number(reviews[0].count) || 0) : 0) * REVIEW_ROW_OVERHEAD_BYTES;
    }
    return bytes;
  }

  async deleteUserData(userId) {
    const result = await this.sql`
      with deleted as (
        delete from notes where user_id = ${userId} returning id
      )
      select count(*) as count from deleted
    `;
    await this.sql`
      delete from review_items where user_id = ${userId}
    `;
    await this.sql`
      delete from vocabulary where user_id = ${userId}
    `;
    // The account row goes too: "delete my account and all my data" has
    // to mean the GitHub identity as well, not only the notes. The rows
    // above are already gone, and deleting the account revokes every token
    // it issued: the account can no longer be found, so the token that
    // names it is refused.
    await this.sql`
      delete from users where id = ${userId}
    `;
    return Number(result[0].count) || 0;
  }
}

function createStore(env) {
  if (env && env.DATABASE_URL) {
    return new NeonStore(assertUsableDatabaseUrl(env.DATABASE_URL));
  }
  // The in-memory store is a deliberate choice, never a fallback. A Worker
  // without a database would otherwise serve a store that lives in one
  // instance: every account would look empty, every note would vanish at the
  // next deploy, and no error would mention the database. Local development
  // asks for the in-memory store by name.
  if (env && isEnabled(env.ALLOW_MEMORY_STORE)) {
    console.warn(
      "[youtube-digest-server] ALLOW_MEMORY_STORE is set: using the in-memory dev store.",
    );
    return new MemoryStore();
  }
  throw new DatabaseNotConfiguredError(
    "The database is not configured (DATABASE_URL is missing).",
  );
}

module.exports = {
  MemoryStore,
  NeonStore,
  createStore,
  applyGrade,
  parseSince,
  DatabaseNotConfiguredError,
  ForeignRowError,
  StorageLimitError,
  MAX_LIST_ROWS,
  MAX_EXPORT_ROWS,
  MAX_EXPORT_BYTES,
  MAX_ACCOUNT_ROWS,
  MAX_BATCH_ITEMS,
  MAX_BATCH_BODY_BYTES,
  TOMBSTONE_RETENTION_DAYS,
  MAX_INTERVAL_DAYS,
};
