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
  return {
    note,
    clientId,
    videoId: cleanVideoId(input && input.videoId),
    videoTitle: cleanString(input && input.videoTitle, MAX_VIDEO_TITLE_LENGTH),
    channelName: cleanString(input && input.channelName, MAX_CHANNEL_LENGTH),
    timestampSeconds: cleanTimestampSeconds(input && input.timestampSeconds) ?? 0,
    quote: cleanString(input && input.quote, MAX_QUOTE_LENGTH),
  };
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

function parseReviewGrade(value) {
  const grade = Number(value);
  return Number.isInteger(grade) && REVIEW_GRADES.has(grade) ? grade : null;
}

module.exports = {
  cleanString,
  cleanVideoId,
  parseNote,
  parseVocabulary,
  parseReviewGrade,
  VOCABULARY_STATUSES,
};
