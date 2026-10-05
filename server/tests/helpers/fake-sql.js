/**
 * A minimal in-memory stand-in for the Neon tagged-template driver.
 *
 * `NeonStore` receives `sql` as a tagged-template function, so the fake has to
 * reproduce that calling convention: it is called with the template strings
 * array plus the interpolated values and must return a promise of rows. Every
 * statement is recorded so tests can assert on the *shape* of the queries that
 * were issued, which is the only way to catch a missing ownership check on a
 * real database without connecting to one.
 *
 * It understands just enough SQL to back the store methods under test:
 * vocabulary ownership lookups, review item reads/writes and the due-review
 * join. It is deliberately not a SQL engine.
 */

const PLACEHOLDER = "__VAL__";

function compile(strings, values) {
  let sql = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    sql += PLACEHOLDER + strings[i + 1];
  }
  return sql;
}

/**
 * The table a statement targets. INSERTs name their table after `into` and
 * carry no `from` clause, so both shapes have to be recognized for the
 * query-shape assertions to see them.
 */
function targetTable(sql) {
  const withoutCte = sql.replace(/with\s+\w+\s+as\s*\([\s\S]*?\)\s*select/i, "select");
  const insert = /\binsert\s+into\s+([a-z_]+)/i.exec(withoutCte);
  if (insert) return insert[1].toLowerCase();
  const from = /\bfrom\s+([a-z_]+)/i.exec(withoutCte);
  return from ? from[1].toLowerCase() : "";
}

const sameId = (a, b) => String(a) === String(b);
const truthy = (v) => v === true || v === "t" || v === 1 || v === "1";

/**
 * Zip the trailing positional values onto column names, skipping any value the
 * statement did not interpolate (a tagged template only passes the
 * placeholders it actually contains, so a shorter list means the remaining
 * columns take their schema defaults).
 */
function pickDefined(values, startIndex, names) {
  const out = {};
  for (let i = 0; i < names.length; i += 1) {
    const value = values[startIndex + i];
    if (value !== undefined) out[names[i]] = value;
  }
  return out;
}

class FakeSql {
  constructor() {
    this.users = new Map(); // userId -> row
    this.vocabulary = new Map(); // id -> row
    this.reviewItems = new Map(); // `${userId}:${vocabId}` -> row
    this.notes = new Map(); // id -> row

    this.nextUserId = 1;
    this.nextVocabId = 1;
    this.nextRowId = 1;

    /** Every statement issued, in order, for shape assertions. */
    this.calls = [];
  }

  record(sql, values) {
    this.calls.push({
      sql,
      values,
      table: targetTable(sql),
      lowered: sql.toLowerCase(),
    });
  }

  /** All recorded statements whose text matches `pattern`. */
  find(pattern) {
    return this.calls.filter((call) => pattern.test(call.lowered));
  }

  /** Recorded statements against a given table. */
  findTable(table) {
    return this.calls.filter((call) => call.table === table);
  }

  reset() {
    this.calls = [];
  }

  seedUser(githubId) {
    const row = { id: this.nextUserId++, github_id: githubId, github_login: "u" + githubId };
    this.users.set(row.id, row);
    return row;
  }

  seedVocabulary(userId, overrides = {}) {
    const now = new Date().toISOString();
    const row = Object.assign(
      {
        id: "v" + this.nextVocabId++,
        user_id: userId,
        term: "term",
        translation: "",
        sentence: "",
        sentence_translation: "",
        video_id: "",
        video_title: "",
        timestamp_seconds: 0,
        status: "learning",
        created_at: now,
        updated_at: now,
      },
      overrides,
    );
    this.vocabulary.set(row.id, row);
    return row;
  }

  seedNote(userId, overrides = {}) {
    const now = new Date().toISOString();
    const row = Object.assign(
      {
        id: "n" + this.nextRowId++,
        user_id: userId,
        client_id: "c" + this.nextRowId,
        video_id: "abc123xyz",
        video_title: "",
        channel_name: "",
        timestamp_seconds: 0,
        quote: "",
        note: "",
        starred: false,
        created_at: now,
        updated_at: now,
      },
      overrides,
    );
    this.notes.set(row.id, row);
    return row;
  }

  seedReviewItem(userId, vocabularyId, overrides = {}) {
    const key = userId + ":" + vocabularyId;
    const row = Object.assign(
      {
        id: "r" + this.nextRowId++,
        user_id: userId,
        vocabulary_id: vocabularyId,
        due_at: new Date().toISOString(),
        interval_days: 0,
        ease: 2.5,
        reps: 0,
        lapses: 0,
        updated_at: new Date().toISOString(),
      },
      overrides,
    );
    this.reviewItems.set(key, row);
    return row;
  }

  async run(strings, ...values) {
    const sql = compile(strings, values);
    this.record(sql, values);
    const { lowered } = this.calls[this.calls.length - 1];

    // Dispatch on the statement kind rather than the target table: INSERTs
    // carry no `from <table>` clause at all.
    if (/count\(\*\)\s+as\s+count/.test(lowered)) {
      // deleteUserData's `with deleted as (...) select count(*)`.
      return [{ count: this.deleteNotesFor(values[0]) }];
    }
    if (lowered.includes("insert into users")) return this.handleUsers(lowered, values);
    if (lowered.includes("insert into notes")) return this.handleNotes(lowered, values);
    if (lowered.includes("update notes set starred")) return this.handleNotes(lowered, values);
    if (lowered.includes("update notes set")) return this.handleNotes(lowered, values);
    if (lowered.includes("delete from notes")) return this.handleNotes(lowered, values);
    if (lowered.includes("from notes")) return this.handleNotes(lowered, values);
    if (lowered.includes("insert into vocabulary")) return this.handleVocabulary(lowered, values);
    if (lowered.includes("update vocabulary")) return this.handleVocabulary(lowered, values);
    if (lowered.includes("delete from vocabulary")) return this.handleVocabulary(lowered, values);
    if (lowered.includes("from vocabulary")) return this.handleVocabulary(lowered, values);
    if (lowered.includes("insert into review_items")) return this.handleReviewItems(lowered, values);
    if (lowered.includes("delete from review_items")) return this.handleReviewItems(lowered, values);
    if (lowered.includes("review_items")) return this.handleReviewItems(lowered, values);
    if (lowered.includes("users")) return this.handleUsers(lowered, values);
    throw new Error("FakeSql: unsupported statement -> " + sql.replace(/\s+/g, " ").trim());
  }

  /** Delete a user's notes and report how many were removed. */
  deleteNotesFor(userId) {
    let count = 0;
    for (const [id, row] of [...this.notes.entries()]) {
      if (sameId(row.user_id, userId)) {
        this.notes.delete(id);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Find the first interpolated value that sits immediately after `keyword`
   * (e.g. the user id in `where id = $1 and user_id = $2`). Returns undefined
   * when the keyword is absent, so callers can assert on the query shape
   * instead of relying on positional indexes.
   */
  valueAfter(sql, keyword) {
    const index = sql.toLowerCase().indexOf(keyword.toLowerCase());
    if (index === -1) return undefined;
    const after = sql.slice(index + keyword.length);
    const match = new RegExp("^\\s*" + PLACEHOLDER).exec(after);
    if (!match) return undefined;
    const valueIndex = sql.slice(0, index + keyword.length + match[0].length).split(PLACEHOLDER).length - 2;
    return this.calls[this.calls.length - 1].values[valueIndex];
  }

  handleUsers(lowered, values) {
    if (lowered.includes("insert into users")) {
      const githubId = values[0];
      for (const row of this.users.values()) {
        if (sameId(row.github_id, githubId)) return [projectUser(row)];
      }
      const row = {
        id: this.nextUserId++,
        github_id: githubId,
        github_login: values[1],
        avatar_url: values[2],
      };
      this.users.set(row.id, row);
      return [projectUser(row)];
    }
    if (lowered.includes("delete from users")) {
      this.users.delete(Number(values[0]));
      return [];
    }
    if (lowered.includes("from users")) {
      const row = this.users.get(Number(values[0]));
      return row ? [projectUser(row)] : [];
    }
    return [];
  }

  handleVocabulary(lowered, values) {
    if (lowered.includes("insert into vocabulary")) {
      const row = {
        id: "v" + this.nextVocabId++,
        user_id: values[0],
        term: values[1],
        translation: values[2],
        sentence: values[3],
        sentence_translation: values[4],
        video_id: values[5],
        video_title: values[6],
        timestamp_seconds: values[7],
        status: values[8],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.vocabulary.set(row.id, row);
      return [projectVocabulary(row)];
    }
    if (lowered.includes("delete from vocabulary")) {
      const row = this.vocabulary.get(values[0]);
      if (!row || !sameId(row.user_id, values[1])) return [];
      this.vocabulary.delete(row.id);
      return [{ id: row.id }];
    }
    if (lowered.includes("update vocabulary")) {
      const row = this.vocabulary.get(values[0]);
      if (!row || !sameId(row.user_id, values[1])) return [];
      row.status = values[2];
      row.updated_at = new Date().toISOString();
      return [projectVocabulary(row)];
    }
    // The ownership probe issued by submitReview selects only `id` and filters
    // on id + user_id, so it is the one row-returning select with no `where
    // ... and user_id` on a second column.
    if (/^select\s+id\s+from\s+vocabulary/.test(lowered.trim())) {
      const row = this.vocabulary.get(values[0]);
      if (!row || !sameId(row.user_id, values[1])) return [];
      return [{ id: row.id }];
    }
    if (lowered.includes("from vocabulary")) {
      const userId = values[0];
      return [...this.vocabulary.values()]
        .filter((row) => sameId(row.user_id, userId))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .map(projectVocabulary);
    }
    return [];
  }

  handleReviewItems(lowered, values) {
    const joinsVocabulary = /join\s+vocabulary/.test(lowered);

    if (lowered.includes("insert into review_items")) {
      const [userId, vocabularyId] = values;
      const key = userId + ":" + vocabularyId;
      // Columns the statement omits fall back to the schema defaults
      // (due_at now(), interval_days 0, ease 2.5, reps 0, lapses 0), exactly
      // as Postgres would apply them.
      const merged = Object.assign(
        {
          due_at: new Date().toISOString(),
          interval_days: 0,
          ease: 2.5,
          reps: 0,
          lapses: 0,
        },
        pickDefined(values, 2, ["due_at", "interval_days", "ease", "reps", "lapses"]),
      );
      const existing = this.reviewItems.get(key);
      if (existing) {
        // `on conflict (user_id, vocabulary_id) do update` in submitReview.
        Object.assign(existing, merged, { updated_at: new Date().toISOString() });
        return [projectReview(existing)];
      }
      const row = Object.assign(
        { id: "r" + this.nextRowId++, user_id: userId, vocabulary_id: vocabularyId },
        merged,
        { updated_at: new Date().toISOString() },
      );
      this.reviewItems.set(key, row);
      return [projectReview(row)];
    }

    if (lowered.includes("delete from review_items")) {
      for (const [key, row] of [...this.reviewItems.entries()]) {
        if (sameId(row.user_id, values[0])) this.reviewItems.delete(key);
      }
      return [];
    }

    if (joinsVocabulary) {
      const scopesVocabularyOwner = /v\.user_id\s*=/.test(lowered);
      const userId = values[0];
      let rows = [...this.reviewItems.values()].filter((row) => sameId(row.user_id, userId));
      if (scopesVocabularyOwner) {
        // Mirrors `and v.user_id = $1`: rows whose vocabulary belongs to a
        // different account are filtered out by the database.
        rows = rows.filter((row) => {
          const vocab = this.vocabulary.get(row.vocabulary_id);
          return vocab && sameId(vocab.user_id, userId);
        });
      }
      if (lowered.includes("select ri.due_at")) {
        // listDueReviews: the join projects the vocabulary columns inline.
        const limit = values[values.length - 1];
        const now = new Date();
        return rows
          .filter((row) => new Date(row.due_at) <= now)
          .sort((a, b) => (a.due_at < b.due_at ? -1 : 1))
          .slice(0, limit)
          .map((row) => {
            const vocab = this.vocabulary.get(row.vocabulary_id) || {};
            return Object.assign(projectReview(row), projectVocabulary(vocab), {
              vocabId: vocab.id,
            });
          });
      }
      // getAllUserData: review columns only.
      return rows.map(projectReview);
    }

    // The existing-row lookup in submitReview: filters on vocabulary_id plus
    // the caller's user_id.
    const vocabId = values[0];
    const userId = values[1];
    return [...this.reviewItems.values()].filter(
      (row) => sameId(row.vocabulary_id, vocabId) && sameId(row.user_id, userId),
    ).map(projectReview);
  }

  handleNotes(lowered, values) {
    if (lowered.includes("insert into notes")) {
      const [userId, clientId, videoId, videoTitle, channelName, seconds, quote, note, starred] =
        values;
      const existing = [...this.notes.values()].find(
        (row) => sameId(row.user_id, userId) && row.client_id === clientId,
      );
      if (existing) {
        existing.video_id = videoId;
        existing.video_title = videoTitle;
        existing.channel_name = channelName;
        existing.timestamp_seconds = seconds;
        existing.quote = quote;
        existing.note = note;
        // `coalesce($starred, notes.starred)`: a null param keeps the stored
        // flag, mirroring Postgres.
        if (starred !== null) existing.starred = truthy(starred);
        existing.updated_at = new Date().toISOString();
        return [noteRow(existing)];
      }
      const row = {
        id: "n" + this.nextRowId++,
        user_id: userId,
        client_id: clientId,
        video_id: videoId,
        video_title: videoTitle,
        channel_name: channelName,
        timestamp_seconds: seconds,
        quote: quote,
        note: note,
        starred: starred === null ? false : truthy(starred),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.notes.set(row.id, row);
      return [noteRow(row)];
    }

    if (lowered.includes("delete from notes")) {
      const row = this.notes.get(values[0]);
      if (!row || !sameId(row.user_id, values[1])) return [];
      this.notes.delete(row.id);
      return [{ id: row.id }];
    }

    if (lowered.includes("update notes set starred")) {
      const [starred, noteId, userId] = values;
      const row = this.notes.get(noteId);
      if (!row || !sameId(row.user_id, userId)) return [];
      row.starred = truthy(starred);
      row.updated_at = new Date().toISOString();
      return [noteRow(row)];
    }

    if (lowered.includes("update notes set")) {
      const [title, channel, seconds, quote, note, starred, noteId, userId] = values;
      const row = this.notes.get(noteId);
      if (!row || !sameId(row.user_id, userId)) return [];
      row.video_title = title;
      row.channel_name = channel;
      row.timestamp_seconds = seconds;
      row.quote = quote;
      row.note = note;
      if (starred !== null) row.starred = truthy(starred);
      row.updated_at = new Date().toISOString();
      return [noteRow(row)];
    }

    if (lowered.includes("from notes")) {
      const userId = values[0];
      return [...this.notes.values()]
        .filter((row) => sameId(row.user_id, userId))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .map(noteRow);
    }
    return [];
  }
}

function projectUser(row) {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.github_login,
    avatarUrl: row.avatar_url || "",
  };
}

function projectVocabulary(row) {
  if (!row) return null;
  return {
    id: row.id,
    term: row.term,
    translation: row.translation,
    sentence: row.sentence,
    sentenceTranslation: row.sentence_translation,
    videoId: row.video_id,
    videoTitle: row.video_title,
    timestampSeconds: row.timestamp_seconds,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectReview(row) {
  return {
    vocabularyId: row.vocabulary_id,
    dueAt: row.due_at,
    intervalDays: row.interval_days,
    ease: row.ease,
    reps: row.reps,
    lapses: row.lapses,
  };
}

function noteRow(row) {
  return Object.assign({}, row, {
    clientId: row.client_id,
    videoId: row.video_id,
    videoTitle: row.video_title,
    channelName: row.channel_name,
    timestampSeconds: row.timestamp_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Build a tagged-template `sql` function backed by a FakeSql, matching the
 * `neon(connectionString)` call signature NeonStore expects.
 */
function createFakeSql() {
  const fake = new FakeSql();
  const sql = (strings, ...values) => fake.run(strings, ...values);
  sql.__fake = fake;
  return sql;
}

module.exports = { createFakeSql, FakeSql };
