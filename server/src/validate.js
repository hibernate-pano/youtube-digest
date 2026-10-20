/**
 * Input validation helpers. All API inputs are untrusted: lengths are capped
 * and types are checked before anything reaches the database.
 */

const MAX_NOTE_LENGTH = 20_000;
const MAX_QUOTE_LENGTH = 3_000;
const MAX_VIDEO_TITLE_LENGTH = 300;
const MAX_CHANNEL_LENGTH = 200;
const MAX_TERM_LENGTH = 200;
const MAX_TRANSLATION_LENGTH = 500;
const MAX_SENTENCE_LENGTH = 4_000;

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function cleanVideoId(value) {
  const cleaned = cleanString(value, 32);
  return /^[A-Za-z0-9_-]{6,20}$/.test(cleaned) ? cleaned : "";
}

function cleanTimestampSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.floor(number), 86_400 * 30);
}

function parseNote(input) {
  const note = cleanString(input && input.note, MAX_NOTE_LENGTH);
  if (!note) return null;
  const clientId = cleanString(input && input.clientId, 128);
  const parsed = {
    note,
    clientId,
    videoId: cleanVideoId(input && input.videoId),
    videoTitle: cleanString(input && input.videoTitle, MAX_VIDEO_TITLE_LENGTH),
    channelName: cleanString(input && input.channelName, MAX_CHANNEL_LENGTH),
    timestampSeconds: cleanTimestampSeconds(input && input.timestampSeconds) ?? 0,
    quote: cleanString(input && input.quote, MAX_QUOTE_LENGTH),
  };
  // `starred` is optional and tri-state: absent means "do not touch the
  // stored flag", so a client pushing note text can never clear a favorite
  // that was set from the dashboard. Only an explicit boolean is honored.
  if (typeof (input && input.starred) === "boolean") {
    parsed.starred = input.starred;
  }
  return parsed;
}

/**
 * True when the client did not send a value for a field.
 *
 * `null` is the wire form of "not set": a client that patches a note and
 * sends null for a field means "leave the stored value alone", not "write
 * a value". Reading null as a value wiped data - `Number(null)` is 0, so a
 * null timestamp became 0, and a null video id became an empty string that
 * cut the note off from its video.
 */
function isNotSent(value) {
  return value === null || value === undefined;
}

/**
 * Sparse parser for PATCH. Unlike parseNote it returns ONLY the fields the
 * client actually sent, so a partial update never zeroes the fields it left
 * out (video title, channel, timestamp, quote). `clientId` is deliberately
 * absent: it is the sync identity key and must stay immutable on edit.
 *
 * A field sent as null counts as not sent (see isNotSent), so the stored
 * value survives the patch. A patch that changes nothing is not a patch and
 * is refused.
 */
function parseNotePatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const patch = {};
  if (!isNotSent(input.note)) {
    const note = cleanString(input.note, MAX_NOTE_LENGTH);
    if (!note) return null;
    patch.note = note;
  }
  if (!isNotSent(input.videoId)) patch.videoId = cleanVideoId(input.videoId);
  if (!isNotSent(input.videoTitle)) {
    patch.videoTitle = cleanString(input.videoTitle, MAX_VIDEO_TITLE_LENGTH);
  }
  if (!isNotSent(input.channelName)) {
    patch.channelName = cleanString(input.channelName, MAX_CHANNEL_LENGTH);
  }
  if (!isNotSent(input.timestampSeconds)) {
    patch.timestampSeconds = cleanTimestampSeconds(input.timestampSeconds) ?? 0;
  }
  if (!isNotSent(input.quote)) patch.quote = cleanString(input.quote, MAX_QUOTE_LENGTH);
  // Tri-state: only an explicit boolean touches the stored flag.
  if (typeof input.starred === "boolean") patch.starred = input.starred;
  // Nothing to write: the request would only bump the timestamp.
  if (Object.keys(patch).length === 0) return null;
  return patch;
}

const VOCABULARY_STATUSES = new Set(["learning", "reviewing", "mastered"]);

function parseVocabulary(input) {
  const term = cleanString(input && input.term, MAX_TERM_LENGTH);
  if (!term) return null;
  const sentence = cleanString(input && input.sentence, MAX_SENTENCE_LENGTH);
  return {
    term,
    translation: cleanString(input && input.translation, MAX_TRANSLATION_LENGTH),
    sentence,
    sentenceTranslation: cleanString(input && input.sentenceTranslation, MAX_TRANSLATION_LENGTH),
    videoId: cleanVideoId(input && input.videoId),
    videoTitle: cleanString(input && input.videoTitle, MAX_VIDEO_TITLE_LENGTH),
    timestampSeconds: cleanTimestampSeconds(input && input.timestampSeconds) ?? 0,
    status: VOCABULARY_STATUSES.has(input && input.status) ? input.status : "learning",
  };
}

const REVIEW_GRADES = new Set([0, 1, 2, 3, 4, 5]);

/**
 * Parses a review grade (0-5).
 *
 * `Number(null)`, `Number("")` and `Number(false)` are all 0, and 0 is a
 * legal grade ("Again"). Coercing first would therefore turn a missing or
 * blank grade into a real "Again", which resets the word's schedule. So the
 * empty-ish values are rejected before any coercion happens.
 */
function parseReviewGrade(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && REVIEW_GRADES.has(parsed) ? parsed : null;
  }
  if (typeof value !== "number") return null;
  return Number.isInteger(value) && REVIEW_GRADES.has(value) ? value : null;
}

module.exports = {
  cleanString,
  cleanVideoId,
  parseNote,
  parseNotePatch,
  parseVocabulary,
  parseReviewGrade,
  VOCABULARY_STATUSES,
};
