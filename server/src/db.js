/**
 * Data layer with two interchangeable stores:
 * - NeonStore: serverless Postgres via @neondatabase/serverless (production).
 * - MemoryStore: in-memory Maps (local dev without a database, tests).
 *
 * Every method takes the authenticated user id explicitly and scopes all
 * queries by it. Client-supplied user ids are never used as a filter.
 */

const DEFAULT_REVIEW_LIMIT = 50;

/** Hard cap on the rows a list endpoint returns. */
const MAX_LIST_ROWS = 5_000;

/** Hard cap on the rows an export blob contains. */
const MAX_EXPORT_ROWS = 10_000;

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
 * Hard cap on the size of an export, in bytes.
 *
 * The export is a single JSON blob that the browser downloads, so a blob of
 * a few hundred megabytes does not arrive: the download simply dies. The
 * cap is checked before the blob is built, so the Worker never holds one.
 */
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

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
  constructor(message) {
    super(message);
    this.name = "StorageLimitError";
    this.code = "storage_limit_reached";
  }
}

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
    if (!row || row.userId !== userId) return null;
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
    if (!row || row.userId !== userId) return null;
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

  async updateVocabularyStatus(userId, vocabId, status) {
    const row = this.vocabulary.get(vocabId);
    if (!row || row.userId !== userId) return null;
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
    const notes = [...this.notes.values()]
      .filter((row) => mine(row) && !row.deletedAt && new Date(row.updatedAt) > since)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, MAX_LIST_ROWS)
      .map(rowToNote);
    const vocabulary = [...this.vocabulary.values()]
      .filter((row) => mine(row) && !row.deletedAt && new Date(row.updatedAt) > since)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, MAX_LIST_ROWS)
      .map(rowToVocabulary);
    // The deletions travel with the delta. A delta that only carries the
    // rows that still exist cannot say that a note is gone, so the device
    // that still holds it would keep it and push it back.
    const deletedNotes = [...this.notes.values()]
      .filter((row) => mine(row) && row.deletedAt && new Date(row.deletedAt) > since)
      .slice(0, MAX_LIST_ROWS)
      .map((row) => ({ clientId: row.clientId }));
    const deletedVocabulary = [...this.vocabulary.values()]
      .filter((row) => mine(row) && row.deletedAt && new Date(row.deletedAt) > since)
      .slice(0, MAX_LIST_ROWS)
      .map((row) => ({ term: row.term, sentence: row.sentence }));
    return {
      notes,
      vocabulary,
      deleted: { notes: deletedNotes, vocabulary: deletedVocabulary },
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
  async estimateExportBytes(userId) {
    let bytes = 0;
    for (const row of this.notes.values()) {
      if (row.userId !== userId || row.deletedAt) continue;
      bytes += noteBytes(row);
    }
    for (const row of this.vocabulary.values()) {
      if (row.userId !== userId || row.deletedAt) continue;
      bytes += vocabularyBytes(row);
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
      where id = ${noteId} and user_id = ${userId}
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
        { before: "", after: "", value: userId },
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
      where id = ${vocabId} and user_id = ${userId}
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
    const notes = await this.sql`
      select id, client_id as "clientId", starred, video_id as "videoId", video_title as "videoTitle",
        channel_name as "channelName", timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
      from notes where user_id = ${userId} and updated_at > ${sinceIsoText} and deleted_at is null
      order by updated_at desc limit ${MAX_LIST_ROWS}
    `;
    const vocabulary = await this.sql`
      select id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
      from vocabulary where user_id = ${userId} and updated_at > ${sinceIsoText} and deleted_at is null
      order by updated_at desc limit ${MAX_LIST_ROWS}
    `;
    // The deletions travel with the delta. A delta that only carries the
    // rows that still exist cannot say that a note is gone, so the device
    // that still holds it would keep it and push it back.
    const deletedNotes = await this.sql`
      select client_id as "clientId" from notes
      where user_id = ${userId} and deleted_at is not null and deleted_at > ${sinceIsoText}
      order by deleted_at desc limit ${MAX_LIST_ROWS}
    `;
    const deletedVocabulary = await this.sql`
      select term, sentence from vocabulary
      where user_id = ${userId} and deleted_at is not null and deleted_at > ${sinceIsoText}
      order by deleted_at desc limit ${MAX_LIST_ROWS}
    `;
    return {
      notes: notes.map(rowToNote),
      vocabulary: vocabulary.map(rowToVocabulary),
      deleted: {
        notes: deletedNotes.map((row) => ({ clientId: row.clientId })),
        vocabulary: deletedVocabulary.map((row) => ({ term: row.term, sentence: row.sentence })),
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
  async estimateExportBytes(userId) {
    const notes = await this.sql`
      select coalesce(sum(
        octet_length(note) + octet_length(quote) + octet_length(video_title) + octet_length(channel_name)
      ), 0) as bytes
      from notes where user_id = ${userId} and deleted_at is null
    `;
    const vocabulary = await this.sql`
      select coalesce(sum(
        octet_length(term) + octet_length(translation) + octet_length(sentence)
        + octet_length(sentence_translation) + octet_length(video_title)
      ), 0) as bytes
      from vocabulary where user_id = ${userId} and deleted_at is null
    `;
    return (notes.length ? Number(notes[0].bytes) || 0 : 0) +
      (vocabulary.length ? Number(vocabulary[0].bytes) || 0 : 0);
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
  StorageLimitError,
  MAX_LIST_ROWS,
  MAX_EXPORT_ROWS,
  MAX_EXPORT_BYTES,
  MAX_ACCOUNT_ROWS,
  TOMBSTONE_RETENTION_DAYS,
  MAX_INTERVAL_DAYS,
};
