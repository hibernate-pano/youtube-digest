/**
 * Unit tests for the request parsers.
 *
 * Every API input is untrusted, and the parsers are the only place where a
 * request is turned into a row. The `starred` flag is the sharpest edge: it
 * is tri-state (true / false / "not mentioned"), and the difference between
 * "the client did not mention it" and "the client sent false" decides
 * whether a favourite survives a note sync.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNote,
  parseNotePatch,
  parseVocabulary,
  parseReviewGrade,
} = require("../src/validate");

// ============================================================
// parseNote
// ============================================================

test("parseNote requires a non-empty note", () => {
  assert.equal(parseNote({ note: "" }), null);
  assert.equal(parseNote({ note: "   " }), null);
  assert.equal(parseNote({}), null);
  assert.equal(parseNote(null), null);
  assert.equal(parseNote(undefined), null);
});

test("parseNote keeps the note text and trims it", () => {
  const parsed = parseNote({ note: "  a useful idea  " });
  assert.equal(parsed.note, "a useful idea");
});

test("parseNote caps the note length", () => {
  const parsed = parseNote({ note: "x".repeat(30_000) });
  assert.equal(parsed.note.length, 20_000);
});

test("parseNote drops a video id that is not a YouTube id", () => {
  assert.equal(parseNote({ note: "n", videoId: "abc123xyz" }).videoId, "abc123xyz");
  assert.equal(parseNote({ note: "n", videoId: "not a video id" }).videoId, "");
  assert.equal(parseNote({ note: "n", videoId: "../../etc/passwd" }).videoId, "");
});

test("parseNote treats the starred flag as tri-state", () => {
  // The three outcomes have to stay distinguishable: absent means "do not
  // touch the stored flag", which is what keeps a favourite alive when the
  // extension pushes note text.
  assert.equal(
    Object.hasOwn(parseNote({ note: "n" }), "starred"),
    false,
    "an absent flag must stay absent",
  );
  assert.equal(parseNote({ note: "n", starred: true }).starred, true);
  assert.equal(parseNote({ note: "n", starred: false }).starred, false);
});

test("parseNote treats a null starred flag as absent, not as false", () => {
  // `null` is not a boolean, so the parser drops it and the store keeps the
  // stored flag. Treating it as false would silently clear every favourite
  // the moment a client sent a null.
  const parsed = parseNote({ note: "n", starred: null });
  assert.equal(
    Object.hasOwn(parsed, "starred"),
    false,
    "a null flag must not become an explicit false",
  );
});

test("parseNote ignores a starred flag that is not a boolean", () => {
  for (const value of ["true", 1, 0, {}, []]) {
    const parsed = parseNote({ note: "n", starred: value });
    assert.equal(
      Object.hasOwn(parsed, "starred"),
      false,
      `a ${JSON.stringify(value)} flag must not be honoured`,
    );
  }
});

test("parseNote defaults the missing fields to empty values", () => {
  const parsed = parseNote({ note: "n" });
  assert.equal(parsed.clientId, "");
  assert.equal(parsed.videoId, "");
  assert.equal(parsed.videoTitle, "");
  assert.equal(parsed.channelName, "");
  assert.equal(parsed.quote, "");
  assert.equal(parsed.timestampSeconds, 0);
});

test("parseNote rejects a negative timestamp and floors the rest", () => {
  assert.equal(parseNote({ note: "n", timestampSeconds: -5 }).timestampSeconds, 0);
  assert.equal(parseNote({ note: "n", timestampSeconds: 12.9 }).timestampSeconds, 12);
});

// ============================================================
// parseNotePatch
// ============================================================

test("parseNotePatch requires a note and a plain object", () => {
  assert.equal(parseNotePatch({ note: "" }), null);
  assert.equal(parseNotePatch(null), null);
  assert.equal(parseNotePatch("note"), null);
  assert.equal(parseNotePatch([{ note: "n" }]), null);
});

test("parseNotePatch returns only the fields the client sent", () => {
  const patch = parseNotePatch({ note: "edited" });
  assert.deepEqual(Object.keys(patch).sort(), ["note"]);
});

test("parseNotePatch keeps the fields the client did send", () => {
  const patch = parseNotePatch({
    note: "edited",
    videoId: "abc123xyz",
    videoTitle: "A title",
    channelName: "A channel",
    timestampSeconds: 42,
    quote: "a quote",
  });
  assert.equal(patch.videoId, "abc123xyz");
  assert.equal(patch.videoTitle, "A title");
  assert.equal(patch.channelName, "A channel");
  assert.equal(patch.timestampSeconds, 42);
  assert.equal(patch.quote, "a quote");
});

test("parseNotePatch never rewrites the client id", () => {
  // `clientId` is the sync identity key. A patch that carried it would make
  // the next full sync treat the note as deleted elsewhere.
  const patch = parseNotePatch({ note: "edited", clientId: "hijacked" });
  assert.equal(
    Object.hasOwn(patch, "clientId"),
    false,
    "the client id must stay immutable on edit",
  );
});

test("parseNotePatch treats the starred flag as tri-state", () => {
  assert.equal(
    Object.hasOwn(parseNotePatch({ note: "n" }), "starred"),
    false,
    "an absent flag must stay absent",
  );
  assert.equal(parseNotePatch({ note: "n", starred: true }).starred, true);
  assert.equal(parseNotePatch({ note: "n", starred: false }).starred, false);
  assert.equal(
    Object.hasOwn(parseNotePatch({ note: "n", starred: null }), "starred"),
    false,
    "a null flag must not become an explicit false",
  );
});

// ============================================================
// parseVocabulary
// ============================================================

test("parseVocabulary requires a term", () => {
  assert.equal(parseVocabulary({ term: "" }), null);
  assert.equal(parseVocabulary({ term: "   " }), null);
  assert.equal(parseVocabulary({}), null);
});

test("parseVocabulary falls back to a known status", () => {
  assert.equal(parseVocabulary({ term: "t" }).status, "learning");
  assert.equal(parseVocabulary({ term: "t", status: "reviewing" }).status, "reviewing");
  assert.equal(parseVocabulary({ term: "t", status: "mastered" }).status, "mastered");
  assert.equal(
    parseVocabulary({ term: "t", status: "nonsense" }).status,
    "learning",
    "an unknown status must fall back, not be stored",
  );
});

test("parseVocabulary caps the term and the sentence", () => {
  const parsed = parseVocabulary({
    term: "t".repeat(500),
    sentence: "s".repeat(9_000),
  });
  assert.equal(parsed.term.length, 200);
  assert.equal(parsed.sentence.length, 4_000);
});

// ============================================================
// parseReviewGrade
// ============================================================

test("parseReviewGrade accepts the whole 0-5 range", () => {
  for (let grade = 0; grade <= 5; grade += 1) {
    assert.equal(parseReviewGrade(grade), grade);
  }
});

test("parseReviewGrade refuses a grade outside the range", () => {
  assert.equal(parseReviewGrade(-1), null);
  assert.equal(parseReviewGrade(6), null);
  assert.equal(parseReviewGrade(2.5), null);
});

test("parseReviewGrade refuses the empty-ish values", () => {
  // `Number(null)`, `Number("")` and `Number(false)` are all 0, and 0 is a
  // legal grade. Coercing first would turn a missing grade into a real
  // "Again", which resets the word's schedule.
  for (const value of [null, undefined, "", "   ", false, true, NaN, {}]) {
    assert.equal(
      parseReviewGrade(value),
      null,
      `${JSON.stringify(value)} must not be read as a grade`,
    );
  }
});

test("parseReviewGrade reads a numeric string but not a loose one", () => {
  assert.equal(parseReviewGrade("3"), 3);
  assert.equal(parseReviewGrade(" 4 "), 4);
  assert.equal(parseReviewGrade("3.5"), null);
  assert.equal(parseReviewGrade("three"), null);
  assert.equal(parseReviewGrade("0x3"), null);
});
