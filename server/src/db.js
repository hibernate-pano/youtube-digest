/**
 * Data layer with two interchangeable stores:
 * - NeonStore: serverless Postgres via @neondatabase/serverless (production).
 * - MemoryStore: in-memory Maps (local dev without a database, tests).
 *
 * Every method takes the authenticated user id explicitly and scopes all
 * queries by it. Client-supplied user ids are never used as a filter.
 */

const DEFAULT_REVIEW_LIMIT = 50;

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(value).toISOString();
}

function rowToNote(row) {
  return {
    id: row.id,
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

class MemoryStore {
  constructor() {
    this.nextUserId = 1;
    this.users = new Map(); // github_id -> user
    this.notes = new Map(); // id -> row
    this.vocabulary = new Map(); // id -> row
    this.reviews = new Map(); // vocabulary_id -> row
    this.clock = () => new Date();
  }

  async upsertUser(githubUser) {
    let user = this.users.get(githubUser.githubId);
    if (!user) {
      user = {
        id: this.nextUserId++,
        githubId: githubUser.githubId,
        login: githubUser.login,
        avatarUrl: githubUser.avatarUrl || "",
      };
      this.users.set(githubUser.githubId, user);
    } else {
      user.login = githubUser.login;
      user.avatarUrl = githubUser.avatarUrl || user.avatarUrl;
    }
    return { id: user.id, githubId: user.githubId, login: user.login, avatarUrl: user.avatarUrl };
  }

  async listNotes(userId) {
    return [...this.notes.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async createNote(userId, note) {
    const now = this.clock().toISOString();
    const row = Object.assign({}, note, {
      id: crypto.randomUUID(),
      userId,
      createdAt: now,
      updatedAt: now,
    });
    this.notes.set(row.id, row);
    return rowToNote(row);
  }

  async updateNote(userId, noteId, patch) {
    const row = this.notes.get(noteId);
    if (!row || row.userId !== userId) return null;
    Object.assign(row, patch, { updatedAt: this.clock().toISOString() });
    return rowToNote(row);
  }

  async deleteNote(userId, noteId) {
    const row = this.notes.get(noteId);
    if (!row || row.userId !== userId) return false;
    this.notes.delete(noteId);
    return true;
  }

  async listVocabulary(userId) {
    return [...this.vocabulary.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
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
    this.reviews.set(row.id, {
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
    this.reviews.delete(vocabId);
    return true;
  }

  async listDueReviews(userId, limit = DEFAULT_REVIEW_LIMIT) {
    const now = this.clock();
    return [...this.reviews.values()]
      .filter((review) => {
        const vocab = this.vocabulary.get(review.vocabularyId);
        return vocab && vocab.userId === userId && new Date(review.dueAt) <= now;
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
    let review = this.reviews.get(vocabId);
    if (!review) {
      review = {
        vocabularyId: vocabId,
        intervalDays: 0,
        ease: 2.5,
        reps: 0,
        lapses: 0,
      };
      this.reviews.set(vocabId, review);
    }
    const updated = applyGrade(review, grade, this.clock());
    this.reviews.set(vocabId, updated);
    return {
      dueAt: updated.dueAt,
      intervalDays: updated.intervalDays,
      ease: updated.ease,
      reps: updated.reps,
      lapses: updated.lapses,
    };
  }

  async getSyncDelta(userId, sinceIso) {
    const since = sinceIso ? new Date(sinceIso) : new Date(0);
    const notes = [...this.notes.values()]
      .filter((row) => row.userId === userId && new Date(row.updatedAt) > since)
      .map(rowToNote);
    const vocabulary = [...this.vocabulary.values()]
      .filter((row) => row.userId === userId && new Date(row.updatedAt) > since)
      .map(rowToVocabulary);
    return { notes, vocabulary };
  }
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
    next.intervalDays = Math.max(1, Math.round(next.intervalDays * multiplier));
  }
  next.ease = Math.min(2.8, next.ease + (grade >= 4 ? 0.1 : 0));
  next.dueAt = new Date(now.getTime() + next.intervalDays * 86_400_000).toISOString();
  return next;
}

class NeonStore {
  constructor(connectionString) {
    const driver = require("@neondatabase/serverless");
    this.sql = driver.neon(connectionString);
  }

  async upsertUser(githubUser) {
    const rows = await this.sql`
      insert into users (github_id, github_login, avatar_url)
      values (${githubUser.githubId}, ${githubUser.login}, ${githubUser.avatarUrl || ""})
      on conflict (github_id) do update set
        github_login = excluded.github_login,
        avatar_url = excluded.avatar_url
      returning id, github_id as "githubId", github_login as "login", avatar_url as "avatarUrl"
    `;
    return rows[0];
  }

  async listNotes(userId) {
    const rows = await this.sql`
      select id, video_id as "videoId", video_title as "videoTitle", channel_name as "channelName",
        timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
      from notes where user_id = ${userId} order by updated_at desc
    `;
    return rows.map(rowToNote);
  }

  async createNote(userId, note) {
    const rows = await this.sql`
      insert into notes (user_id, video_id, video_title, channel_name, timestamp_seconds, quote, note)
      values (${userId}, ${note.videoId}, ${note.videoTitle}, ${note.channelName},
        ${note.timestampSeconds}, ${note.quote}, ${note.note})
      returning id, video_id as "videoId", video_title as "videoTitle", channel_name as "channelName",
        timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
    `;
    return rowToNote(rows[0]);
  }

  async updateNote(userId, noteId, patch) {
    const rows = await this.sql`
      update notes set
        video_title = ${patch.videoTitle}, channel_name = ${patch.channelName},
        timestamp_seconds = ${patch.timestampSeconds}, quote = ${patch.quote}, note = ${patch.note},
        updated_at = now()
      where id = ${noteId} and user_id = ${userId}
      returning id, video_id as "videoId", video_title as "videoTitle", channel_name as "channelName",
        timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
    `;
    return rows.length ? rowToNote(rows[0]) : null;
  }

  async deleteNote(userId, noteId) {
    const rows = await this.sql`
      delete from notes where id = ${noteId} and user_id = ${userId} returning id
    `;
    return rows.length > 0;
  }

  async listVocabulary(userId) {
    const rows = await this.sql`
      select id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
      from vocabulary where user_id = ${userId} order by updated_at desc
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
    await this.sql`
      insert into review_items (user_id, vocabulary_id) values (${rows[0].id}, ${rows[0].id})
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
      where ri.user_id = ${userId} and ri.due_at <= now()
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
    const since = sinceIso || new Date(0).toISOString();
    const notes = await this.sql`
      select id, video_id as "videoId", video_title as "videoTitle", channel_name as "channelName",
        timestamp_seconds as "timestampSeconds", quote, note,
        created_at as "createdAt", updated_at as "updatedAt"
      from notes where user_id = ${userId} and updated_at > ${since}
    `;
    const vocabulary = await this.sql`
      select id, term, translation, sentence, sentence_translation as "sentenceTranslation",
        video_id as "videoId", video_title as "videoTitle", timestamp_seconds as "timestampSeconds", status,
        created_at as "createdAt", updated_at as "updatedAt"
      from vocabulary where user_id = ${userId} and updated_at > ${since}
    `;
    return {
      notes: notes.map(rowToNote),
      vocabulary: vocabulary.map(rowToVocabulary),
    };
  }
}

function createStore(env) {
  if (env && env.DATABASE_URL) {
    return new NeonStore(env.DATABASE_URL);
  }
  console.warn("[youtube-digest-server] DATABASE_URL missing: using the in-memory dev store.");
  return new MemoryStore();
}

module.exports = { MemoryStore, NeonStore, createStore, applyGrade };
