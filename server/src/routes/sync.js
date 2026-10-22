/**
 * The batch route: one request carries many notes and many words.
 *
 * A device that holds a hundred notes and five hundred words used to push
 * them one request at a time. The write limiter allows 120 writes a minute,
 * so the first sync of a new device spent five minutes being refused. The
 * batch carries the same rows in one request, and the limiter counts the
 * request, not the rows.
 *
 * The rules of a batch are the rules of the single routes:
 * - a note is matched by its client id, a word by its text,
 * - the later edit wins, and a note that was deleted stays deleted,
 * - the account cap is checked against the whole batch: a batch that does
 *   not fit writes nothing at all,
 * - one bad item is a bad request: nothing of the batch is written.
 */

const { json, HttpError, serverTime, readJsonObject } = require("../middleware");
const { parseNote, parseVocabulary } = require("../validate");
const { MAX_BATCH_ITEMS, MAX_BATCH_BODY_BYTES, ForeignRowError } = require("../db");

/**
 * Reads the moment a row was changed.
 *
 * The client may send the moment the row was changed on the device, and the
 * server keeps the newer of the two. The moment is read the way the client
 * keeps it: a number of milliseconds since the epoch or an ISO timestamp.
 *
 * A moment the server cannot read is a bad item, not a silent "the push
 * wins": a client that sends a broken timestamp would otherwise never learn
 * that its rows are being dropped.
 *
 * @param {unknown} value the value from the request body.
 * @returns {number|null|undefined} the moment in milliseconds, `null` when
 *   the value cannot be read, `undefined` when the client sent none.
 */
function parseUpdatedAt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * The row id an item carries, if any.
 *
 * The id is never used to pick a row: a note is matched by its client id
 * and a word by its text. It is only checked, so a batch that carries the
 * id of another account's row is refused instead of quietly doing
 * something else.
 *
 * @param {unknown} value the value from the request body.
 * @returns {string} the id, or an empty string.
 */
function parseRowId(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads the notes of a batch.
 *
 * Every item is read before anything is written, so a batch with one bad
 * item writes nothing at all.
 *
 * @param {unknown[]} items the notes of the request.
 * @returns {object[]} the notes, ready for the store.
 */
function readNotes(items) {
  return items.map((item, index) => {
    const note = parseNote(item);
    if (!note) {
      throw new HttpError(400, `notes[${index}]: a non-empty note is required.`);
    }
    if (!note.clientId) {
      throw new HttpError(
        400,
        `notes[${index}]: clientId is required for idempotent sync.`,
      );
    }
    const updatedAt = parseUpdatedAt(item && item.updatedAt);
    if (updatedAt === null) {
      throw new HttpError(
        400,
        `notes[${index}]: updatedAt must be an ISO 8601 timestamp or a number of milliseconds.`,
      );
    }
    note.updatedAt = updatedAt;
    note.id = parseRowId(item && item.id);
    return note;
  });
}

/**
 * Reads the words of a batch.
 *
 * @param {unknown[]} items the words of the request.
 * @returns {object[]} the words, ready for the store.
 */
function readVocabulary(items) {
  return items.map((item, index) => {
    const word = parseVocabulary(item);
    if (!word) {
      throw new HttpError(400, `vocabulary[${index}]: a non-empty term is required.`);
    }
    const updatedAt = parseUpdatedAt(item && item.updatedAt);
    if (updatedAt === null) {
      throw new HttpError(
        400,
        `vocabulary[${index}]: updatedAt must be an ISO 8601 timestamp or a number of milliseconds.`,
      );
    }
    word.updatedAt = updatedAt;
    word.id = parseRowId(item && item.id);
    return word;
  });
}

/**
 * Pushes a batch of notes and words.
 *
 * @param {object} ctx the request context.
 * @returns {Promise<Response>} the answer: what the server holds for every
 *   item of the batch.
 */
async function pushBatch(ctx) {
  const body = await readJsonObject(ctx.request, MAX_BATCH_BODY_BYTES);
  const rawNotes = body.notes === undefined ? [] : body.notes;
  const rawVocabulary = body.vocabulary === undefined ? [] : body.vocabulary;
  if (!Array.isArray(rawNotes)) {
    throw new HttpError(400, "notes must be an array.");
  }
  if (!Array.isArray(rawVocabulary)) {
    throw new HttpError(400, "vocabulary must be an array.");
  }

  // The client chunks its pushes. A batch that is too big is refused with a
  // message that says what to do about it.
  const total = rawNotes.length + rawVocabulary.length;
  if (total > MAX_BATCH_ITEMS) {
    throw new HttpError(
      400,
      `This batch holds ${total} items. Send at most ${MAX_BATCH_ITEMS} items at a time.`,
    );
  }

  // Every item is read before the first row is written: one bad item is a
  // bad request, never a half-written batch.
  const notes = readNotes(rawNotes);
  const vocabulary = readVocabulary(rawVocabulary);

  let pushed;
  try {
    pushed = await ctx.store.batchUpsert(ctx.user.id, { notes, vocabulary });
  } catch (error) {
    if (error instanceof ForeignRowError) {
      // The token decides the account: an id from the body may never name
      // another account's row.
      throw new HttpError(
        400,
        `${error.kind}[${error.index}]: this id belongs to another account.`,
      );
    }
    throw error;
  }

  return json({ pushed, serverTime: serverTime() });
}

module.exports = { pushBatch, MAX_BATCH_ITEMS, MAX_BATCH_BODY_BYTES };
