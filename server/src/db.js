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

/** The longest review interval, in days. */
const MAX_INTERVAL_DAYS = 365;

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
 * Builds a parameterized UPDATE statement from a fixed column whitelist.
 *
 * The column names come from the code, never from the request, so the
 * statement text can never be influenced by the client. The result is a
 * tagged-template argument list, which both the Neon driver and the test
 * fake accept.
 */
function buildUpdateStatement(prefix, assignments, whereClauses) {
  const strings = [];
  const values = [];
  let lead = prefix;
  for (const assignment of assignments) {
    strings.push(lead + assignment.before);
    values.push(assignment.value);
    lead = assignment.after;
  }
  for (const clause of whereClauses) {
    strings.push(lead + clause.before);
    values.push(clause.value);
    lead = clause.after;
  }
  strings.push(lead);
  return { strings, values };
}

/** Review rows are keyed by owner as well as vocabulary, like the database. */
function reviewKey(userId, vocabularyId) {
  return userId + ":" + vocabularyId;
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
      .filter((row) => row.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map(rowToNote);
  }

  async createNote(userId, note) {
    const now = this.clock().toISOString();
    const existing = [...this.notes.values()].find(
      (row) => row.userId === userId && row.clientId === note.clientId,
    );
    if (existing) {
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
    if (!row) return false;
    this.notes.delete(row.id);
    return true;
  }

  async updateNote(userId, noteId, patch) {
    const row = this.notes.get(noteId);
    if (!row || row.userId !== userId) return null;
    // Mirror the Neon tri-state rule: an absent `starred` leaves the stored
    // flag alone, so the two stores agree on what a note update does.
    const next = Object.assign({}, patch);
    if (typeof patch.starred !== "boolean") delete next.starred;
    // clientId is the sync identity key (`unique (user_id, client_id)`), so
    // it is immutable on edit: renaming it would make the next full sync
    // treat the note as deleted elsewhere and drop it.
    delete next.clientId;
    Object.assign(row, next, { updatedAt: this.clock().toISOString() });
    return rowToNote(row);
  }

  async deleteNote(userId, noteId) {
    const row = this.notes.get(noteId);
    if (!row || row.userId !== userId) return false;
    this.notes.delete(noteId);
    return true;
  }

  async listVocabulary(userId, limit = MAX_LIST_ROWS) {
    return [...this.vocabulary.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map(rowToVocabulary);
  }

  async upsertVocabulary(userId, vocab) {
    const existing = [...this.vocabulary.values()].find(
      (row) => row.userId === userId && row.term === vocab.term && row.sentence === vocab.sentence,
    );
    const now = this.clock().toISOString();
    if (existing) {
      Object.assign(existing, vocab, { updatedAt: now });
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
    if (!row || row.userId !== userId) return false;
    this.vocabulary.delete(vocabId);
    this.reviews.delete(reviewKey(userId, vocabId));
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
    const notes = [...this.notes.values()]
      .filter((row) => row.userId === userId && new Date(row.updatedAt) > since)
      .map(rowToNote);
    const vocabulary = [...this.vocabulary.values()]
      .filter((row) => row.userId === userId && new Date(row.updatedAt) > since)
      .map(rowToVocabulary);
    return { notes, vocabulary };
  }

  /** Counts a user's rows in one of the two content tables. */
  async countRows(table, userId) {
    const rows = table === "vocabulary" ? this.vocabulary : this.notes;
    return [...rows.values()].filter((row) => row.userId === userId).length;
  }

  async getAllUserData(userId) {
    const user = [...this.users.values()].find(
      (row) => String(row.id) === String(userId),
    );
    const allNotes = [...this.notes.values()].filter((row) => row.userId === userId);
    const allVocabulary = [...this.vocabulary.values()].filter(
      (row) => row.userId === userId,
    );
    const reviews = [...this.reviews.values()]
      .filter((review) => review.userId === userId)
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
    // The account row is kept as a revocation tombstone: bumping the token
    // version invalidates every token issued before the deletion, so the
    // deleted account can never act again.
    for (const user of this.users.values()) {
      if (String(user.id) === String(userId)) {
        user.tokenVersion = (user.tokenVersion || 0) + 1;
      }
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
      from notes where user_id = ${userId} order by updated_at desc limit ${limit}
    `;
    return rows.map(rowToNote);
  }

  async createNote(userId, note) {
    // Tri-state `starred`: null means the client did not mention it. The
    // insert falls back to the column default, and the conflict branch keeps
    // whatever is already stored, so pushing note text from the extension can
    // never clear a favorite the user set in the dashboard.
    const starred = typeof note.starred === "boolean" ? note.starred : null;
    const rows = await this.sql`
      insert into notes (user_id, client_id, video_id, video_title, channel_name, timestamp_seconds, quote, note, starred)
      values (${userId}, ${note.clientId}, ${note.videoId}, ${note.videoTitle}, ${note.channelName},
        ${note.timestampSeconds}, ${note.quote}, ${note.note}, coalesce(${starred}, false))
      on conflict (user_id, client_id) do update set
        video_id = excluded.video_id, video_title = excluded.video_title,
        channel_name = excluded.channel_name, timestamp_seconds = excluded.timestamp_seconds,
        quote = excluded.quote, note = excluded.note, updated_at = now(),
        starred = coalesce(${starred}, notes.starred)
      returning id, client_id as "clientId", starred, video_id as "videoId", video_title as "videoTitle",
        channel_name as "channelName", timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
    `;
    return rowToNote(rows[0]);
  }

  async deleteNoteByClientId(userId, clientId) {
    const rows = await this.sql`
      delete from notes where user_id = ${userId} and client_id = ${clientId} returning id
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
    // `starred` keeps the tri-state rule: coalesce($, starred) leaves the
    // stored flag alone when the client did not mention it.
    const assignments = [{ before: "note = ", after: ", ", value: patch.note }];
    if (patch.videoId !== undefined) {
      assignments.push({ before: "video_id = ", after: ", ", value: patch.videoId });
    }
    if (patch.videoTitle !== undefined) {
      assignments.push({ before: "video_title = ", after: ", ", value: patch.videoTitle });
    }
    if (patch.channelName !== undefined) {
      assignments.push({ before: "channel_name = ", after: ", ", value: patch.channelName });
    }
    if (patch.timestampSeconds !== undefined) {
      assignments.push({ before: "timestamp_seconds = ", after: ", ", value: patch.timestampSeconds });
    }
    if (patch.quote !== undefined) {
      assignments.push({ before: "quote = ", after: ", ", value: patch.quote });
    }
    if (typeof patch.starred === "boolean") {
      assignments.push({
        before: "starred = coalesce(",
        after: ", starred)",
        value: patch.starred,
      });
    }
    const statement = buildUpdateStatement(
      "update notes set ",
      assignments,
      [
        { before: " where id = ", after: " and user_id = ", value: noteId },
        { before: "", after: "", value: userId },
      ],
    );
    const rows = await this.sql(statement.strings, ...statement.values);
    return rows.length ? rowToNote(rows[0]) : null;
  }

  async deleteNote(userId, noteId) {
    const rows = await this.sql`
      delete from notes where id = ${noteId} and user_id = ${userId} returning id
    `;
    return rows.length > 0;
  }

  async listVocabulary(userId, limit = MAX_LIST_ROWS) {
    const rows = await this.sql`
      select id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
      from vocabulary where user_id = ${userId} order by updated_at desc limit ${limit}
    `;
    return rows.map(rowToVocabulary);
  }

  async upsertVocabulary(userId, vocab) {
    const rows = await this.sql`
      insert into vocabulary (user_id, term, translation, sentence, sentence_translation,
        video_id, video_title, timestamp_seconds, status)
      values (${userId}, ${vocab.term}, ${vocab.translation}, ${vocab.sentence},
        ${vocab.sentenceTranslation}, ${vocab.videoId}, ${vocab.videoTitle},
        ${vocab.timestampSeconds}, ${vocab.status})
      on conflict (user_id, term, sentence) do update set
        translation = excluded.translation, sentence_translation = excluded.sentence_translation,
        video_id = excluded.video_id, video_title = excluded.video_title,
        timestamp_seconds = excluded.timestamp_seconds, status = excluded.status, updated_at = now()
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
    const rows = await this.sql`
      delete from vocabulary where id = ${vocabId} and user_id = ${userId} returning id
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
      where ri.user_id = ${userId} and v.user_id = ${userId} and ri.due_at <= now()
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
    const notes = await this.sql`
      select id, client_id as "clientId", starred, video_id as "videoId", video_title as "videoTitle",
        channel_name as "channelName", timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
      from notes where user_id = ${userId} and updated_at > ${sinceIsoText}
    `;
    const vocabulary = await this.sql`
      select id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
      from vocabulary where user_id = ${userId} and updated_at > ${sinceIsoText}
    `;
    return {
      notes: notes.map(rowToNote),
      vocabulary: vocabulary.map(rowToVocabulary),
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
      where ri.user_id = ${userId} and v.user_id = ${userId}
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

  /** Counts a user's rows in one of the two content tables. */
  async countRows(table, userId) {
    const rows = await this.sql`
      select count(*) as count from ${table} where user_id = ${userId}
    `;
    return rows.length ? Number(rows[0].count) || 0 : 0;
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
    // The account row is kept as a revocation tombstone: bumping the token
    // version invalidates every token issued before the deletion, so the
    // deleted account can never act again.
    await this.sql`
      update users set token_version = token_version + 1 where id = ${userId}
    `;
    return Number(result[0].count) || 0;
  }
}

function createStore(env) {
  if (env && env.DATABASE_URL) {
    return new NeonStore(env.DATABASE_URL);
  }
  console.warn("[youtube-digest-server] DATABASE_URL missing: using the in-memory dev store.");
  return new MemoryStore();
}

module.exports = {
  MemoryStore,
  NeonStore,
  createStore,
  applyGrade,
  parseSince,
  MAX_LIST_ROWS,
  MAX_EXPORT_ROWS,
  MAX_INTERVAL_DAYS,
};
