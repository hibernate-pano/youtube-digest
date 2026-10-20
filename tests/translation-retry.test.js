const test = require("node:test");
const assert = require("node:assert/strict");
const { createPanel, workerRouter } = require("./helpers/panel-harness.js");

/* ============================================================
   A translation that failed once must not cost the user the
   work they paid for.

   Every translation is paid for with the user's own provider balance. Before
   this, a batch that failed - a rate limit, a network blip, a model that
   answered with half a JSON - stayed in the original language for good: the
   transcript row kept its error until the user noticed and pressed "Retry",
   and the interface segment went on a deny list that never let the panel ask
   again for the same video.

   These tests drive the real panel in a real DOM. They count the requests
   that went out and they look at what the user ends up seeing.
   ============================================================ */

const VIDEO_URL = "https://www.youtube.com/watch?v=videoA";

// The captions are long enough to be one segment each, so the panel asks
// for them in one batch of three.
const CAPTIONS = [
  {
    text: "The first sentence of the talk is about how a translation that failed once used to stay in the wrong language for good.",
    start: 0,
    duration: 3,
    language: "en",
  },
  {
    text: "The second sentence of the talk is about how the panel asks the provider again now when the failure is a temporary one.",
    start: 3,
    duration: 3,
    language: "en",
  },
  {
    text: "The third sentence of the talk is about how the user keeps the button that asks for a translation by hand.",
    start: 6,
    duration: 3,
    language: "en",
  },
];

const ANALYSIS = {
  summary: "The talk is about retries.",
  chapters: [
    {
      title: "Retries save paid work",
      summary: "One network blip used to cost a whole translation.",
      timestamp: "0:00",
      timestampSeconds: 0,
    },
  ],
  keyQuotes: [],
};

/**
 * The worker, with the translation answers the test scripts.
 */
function panelWith({ translate }) {
  const worker = workerRouter({
    fetchTranscript: {
      success: true,
      transcript: CAPTIONS,
      transcriptText: CAPTIONS.map((caption) => caption.text).join(" "),
      transcriptTextTimestamped: CAPTIONS.map(
        (caption) => `[${caption.start}] ${caption.text}`,
      ).join(" "),
      language: "en",
    },
    analyzeTranscript: { success: true, analysis: ANALYSIS },
  });
  return createPanel({
    sendMessageImpl: async (message) => {
      if (message.action === "translateContent") return translate(message);
      return worker(message);
    },
  });
}

/**
 * The worker answering with a translation of whatever it was asked for.
 */
function translatedAnswer(message) {
  return {
    success: true,
    translatedContent: {
      segments: (message.content?.segments || []).map((segment) => ({
        id: segment.id,
        text: `译文：${segment.text}`,
      })),
    },
  };
}

const translationRequests = (panel) =>
  panel.sentMessages.filter((message) => message.action === "translateContent");

/**
 * Moves the clock past the wait between two attempts and lets the panel
 * finish what it started.
 */
async function waitOutTheBackoff(panel, ms = 2000) {
  panel.clock.advance(ms);
  await panel.flush();
}

/* ============================================================
   The transcript
   ============================================================ */

test("a transcript batch that hit a rate limit is translated on the next try", async () => {
  let attempts = 0;
  const panel = panelWith({
    translate: (message) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          success: false,
          error: "Rate limited - try again in a moment",
          code: "RATE_LIMITED",
        };
      }
      return translatedAnswer(message);
    },
  });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await panel.helpers.handleDisplayLanguageModeChange("zh");
  await panel.flush();

  assert.equal(
    translationRequests(panel).length,
    1,
    "the first attempt went out and failed",
  );
  assert.equal(
    panel.all(".transcript-entry.translated").length,
    0,
    "the row is still waiting for its translation",
  );
  assert.equal(
    panel.all(".translation-retry-btn").length,
    0,
    "the user is not asked to fix something the panel can fix itself",
  );

  await waitOutTheBackoff(panel);

  assert.equal(
    translationRequests(panel).length,
    2,
    "the panel asked the provider again instead of giving up on the batch",
  );
  const rows = panel.all(".transcript-entry");
  assert.equal(rows.length, 3, "the transcript is on screen");
  assert.ok(
    rows.every((row) => row.classList.contains("translated")),
    "every row carries its translation",
  );
  assert.match(rows[0].textContent, /译文：/, "the translation is what the user reads");
  assert.equal(
    panel.all(".translation-retry-btn").length,
    0,
    "a batch that the panel fixed on its own leaves no error behind",
  );
});

test("a transcript batch with no API key is not asked again", async () => {
  const panel = panelWith({
    translate: () => ({ success: false, error: "NO_AI_KEY", code: "NO_AI_KEY" }),
  });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await panel.helpers.handleDisplayLanguageModeChange("zh");
  await panel.flush();

  assert.equal(translationRequests(panel).length, 1, "the batch was asked once");

  // The clock runs long past every backoff the panel would use.
  panel.clock.advance(60_000);
  await panel.flush();

  assert.equal(
    translationRequests(panel).length,
    1,
    "a missing key was asked again, spending the user's balance for the same answer",
  );
  assert.equal(
    panel.all(".translation-retry-btn").length,
    3,
    "the user still gets the button, because the settings are theirs to fix",
  );
});

test("a transcript batch that keeps failing is asked again three times, and only then given up on", async () => {
  const panel = panelWith({
    translate: () => ({
      success: false,
      error: "Rate limited - try again in a moment",
      code: "RATE_LIMITED",
    }),
  });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await panel.helpers.handleDisplayLanguageModeChange("zh");
  await panel.flush();

  assert.equal(translationRequests(panel).length, 1, "the first attempt went out");

  await waitOutTheBackoff(panel, 2000);
  assert.equal(translationRequests(panel).length, 2, "the second attempt went out");

  await waitOutTheBackoff(panel, 4000);
  assert.equal(translationRequests(panel).length, 3, "the third attempt went out");

  await waitOutTheBackoff(panel, 6000);
  assert.equal(
    translationRequests(panel).length,
    4,
    "the panel asked one time and then three more times, and no more",
  );

  panel.clock.advance(60_000);
  await panel.flush();
  assert.equal(
    translationRequests(panel).length,
    4,
    "the panel kept asking after it had used up its attempts",
  );

  assert.equal(
    panel.all(".translation-retry-btn").length,
    3,
    "the user is told what happened and can ask for it by hand",
  );
  assert.ok(
    panel
      .all(".transcript-entry")
      .every((row) => row.classList.contains("translation-failed")),
    "the rows are marked as failed",
  );
});

test("the retry button still works after the panel used up its attempts", async () => {
  let attempts = 0;
  const panel = panelWith({
    translate: (message) => {
      attempts += 1;
      if (attempts <= 4) {
        return {
          success: false,
          error: "Rate limited - try again in a moment",
          code: "RATE_LIMITED",
        };
      }
      return translatedAnswer(message);
    },
  });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await panel.helpers.handleDisplayLanguageModeChange("zh");
  await panel.flush();
  await waitOutTheBackoff(panel, 2000);
  await waitOutTheBackoff(panel, 4000);
  await waitOutTheBackoff(panel, 6000);
  await panel.flush();

  assert.equal(
    panel.all(".translation-retry-btn").length,
    3,
    "the user is offered the button to ask for the translation again",
  );

  // The user presses the button on the first row.
  await panel.click(panel.all(".translation-retry-btn")[0]);
  await panel.flush();

  assert.equal(
    translationRequests(panel).length,
    5,
    "the button asked the provider for the batch again",
  );
  assert.equal(
    translationRequests(panel).at(-1).content.segments.length,
    1,
    "the panel asked only for the row the user pressed the button on",
  );
  const firstRow = panel.all(".transcript-entry")[0];
  assert.ok(
    firstRow.classList.contains("translated"),
    "the row the user asked for carries its translation now",
  );
  assert.match(firstRow.textContent, /译文：/, "the translation is on screen");
  assert.equal(
    panel.all(".translation-retry-btn").length,
    2,
    "the rows the user did not ask for keep their error",
  );
});

test("leaving the video during the wait stops the panel from asking again", async () => {
  const panel = panelWith({
    translate: () => ({
      success: false,
      error: "Rate limited - try again in a moment",
      code: "RATE_LIMITED",
    }),
  });

  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await panel.helpers.handleDisplayLanguageModeChange("zh");
  await panel.flush();

  assert.equal(translationRequests(panel).length, 1, "the first attempt went out");

  // The user opens another video while the panel is waiting.
  await panel.helpers.startDigest("videoB", "https://www.youtube.com/watch?v=videoB");
  await panel.flush();

  panel.clock.advance(60_000);
  await panel.flush();

  assert.equal(
    translationRequests(panel).length,
    1,
    "the panel paid for a translation of a video the user already left",
  );
});

/* ============================================================
   The interface content
   ============================================================ */

async function openTheOverview(panel) {
  await panel.helpers.startDigest("videoA", VIDEO_URL);
  await panel.helpers.triggerAnalysis();
  await panel.helpers.switchTab("overview");
  await panel.helpers.handleDisplayLanguageModeChange("zh");
  await panel.flush();
}

test("an interface segment that hit a rate limit is translated on the next try", async () => {
  let attempts = 0;
  const panel = panelWith({
    translate: (message) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          success: false,
          error: "Rate limited - try again in a moment",
          code: "RATE_LIMITED",
        };
      }
      return translatedAnswer(message);
    },
  });

  await openTheOverview(panel);

  assert.equal(
    translationRequests(panel).length,
    1,
    "the first attempt went out and failed",
  );
  assert.equal(
    panel.helpers.getState().interfaceTranslationFailures.size,
    0,
    "the segment is not on the deny list while the panel is still trying",
  );

  await waitOutTheBackoff(panel);

  assert.equal(
    translationRequests(panel).length,
    2,
    "the panel asked the provider again instead of giving up on the segment",
  );
  assert.equal(
    panel.helpers.getState().interfaceTranslationFailures.size,
    0,
    "a segment the panel fixed on its own never goes on the deny list",
  );
  assert.match(
    panel.el("chapterList").textContent,
    /译文：/,
    "the translation is what the user reads",
  );
  assert.equal(
    panel.all('[data-interface-retry-surface="overview"]').length,
    0,
    "a segment that the panel fixed on its own leaves no error behind",
  );
});

test("an interface segment that keeps failing goes on the deny list only after the attempts are used up", async () => {
  const panel = panelWith({
    translate: () => ({
      success: false,
      error: "Rate limited - try again in a moment",
      code: "RATE_LIMITED",
    }),
  });

  await openTheOverview(panel);

  assert.equal(
    panel.helpers.getState().interfaceTranslationFailures.size,
    0,
    "the segment is not on the deny list while the panel is still trying",
  );
  assert.equal(
    panel.all('[data-interface-retry-surface="overview"]').length,
    0,
    "the user is not asked to fix something the panel can fix itself",
  );

  await waitOutTheBackoff(panel, 2000);
  await waitOutTheBackoff(panel, 4000);
  await waitOutTheBackoff(panel, 6000);

  assert.equal(
    translationRequests(panel).length,
    4,
    "the panel asked one time and then three more times, and no more",
  );
  assert.equal(
    panel.helpers.getState().interfaceTranslationFailures.size,
    3,
    "the segments are on the deny list now that every attempt is used up",
  );
  assert.equal(
    panel.all('[data-interface-retry-surface="overview"]').length,
    3,
    "the user is told what happened and can ask for it by hand",
  );
});

test("the interface retry button still works after the panel used up its attempts", async () => {
  let attempts = 0;
  const panel = panelWith({
    translate: (message) => {
      attempts += 1;
      if (attempts <= 4) {
        return {
          success: false,
          error: "Rate limited - try again in a moment",
          code: "RATE_LIMITED",
        };
      }
      return translatedAnswer(message);
    },
  });

  await openTheOverview(panel);
  await waitOutTheBackoff(panel, 2000);
  await waitOutTheBackoff(panel, 4000);
  await waitOutTheBackoff(panel, 6000);
  await panel.flush();

  assert.equal(
    panel.helpers.getState().interfaceTranslationFailures.size,
    3,
    "the segments are on the deny list",
  );

  // The user presses the button on the summary.
  await panel.click(panel.all('[data-interface-retry-surface="overview"]')[0]);
  await panel.flush();

  assert.equal(
    translationRequests(panel).length,
    5,
    "the button asked the provider for the segment again",
  );
  assert.match(
    panel.el("summaryText").textContent,
    /译文：/,
    "the translation the user asked for is on screen",
  );
});

test("an interface segment with no API key is not asked again", async () => {
  const panel = panelWith({
    translate: () => ({ success: false, error: "NO_AI_KEY", code: "NO_AI_KEY" }),
  });

  await openTheOverview(panel);

  assert.equal(translationRequests(panel).length, 1, "the segment was asked once");

  panel.clock.advance(60_000);
  await panel.flush();

  assert.equal(
    translationRequests(panel).length,
    1,
    "a missing key was asked again, spending the user's balance for the same answer",
  );
  assert.equal(
    panel.helpers.getState().interfaceTranslationFailures.size,
    3,
    "the segments are on the deny list, so the panel does not keep asking",
  );
  assert.equal(
    panel.all('[data-interface-retry-surface="overview"]').length,
    3,
    "the user still gets the button, because the settings are theirs to fix",
  );
});

test("leaving the video during the wait stops the panel from asking again", async () => {
  const panel = panelWith({
    translate: () => ({
      success: false,
      error: "Rate limited - try again in a moment",
      code: "RATE_LIMITED",
    }),
  });

  await openTheOverview(panel);

  assert.equal(translationRequests(panel).length, 1, "the first attempt went out");

  // The user opens another video while the panel is waiting.
  await panel.helpers.startDigest("videoB", "https://www.youtube.com/watch?v=videoB");
  await panel.flush();

  panel.clock.advance(60_000);
  await panel.flush();

  assert.equal(
    translationRequests(panel).length,
    1,
    "the panel paid for a translation of a video the user already left",
  );
  assert.equal(
    panel.helpers.getState().interfaceTranslationFailures.size,
    0,
    "a segment the user no longer wants is not remembered as failed",
  );
});

/* ============================================================
   Which failures are worth another try
   ============================================================ */

test("a failure that a new attempt cannot fix is not worth the user's balance", async () => {
  const panel = panelWith({ translate: () => ({ success: false }) });
  const { isRetryableTranslationError } = panel.sandbox.__YTD_TRANSCRIPT_TESTING__;

  // The failures the user has to fix in the settings.
  assert.equal(
    isRetryableTranslationError({ success: false, code: "NO_AI_KEY" }),
    false,
    "a missing key does not come back by itself",
  );
  assert.equal(
    isRetryableTranslationError({ success: false, code: "INVALID_AI_KEY" }),
    false,
    "a refused key does not come back by itself",
  );
  assert.equal(
    isRetryableTranslationError({
      success: false,
      error: "DeepSeek API key not configured",
    }),
    false,
    "the worker sends a sentence when it has no code, and it is still a key problem",
  );

  // The failures that are usually over by the time the next attempt goes out.
  assert.equal(
    isRetryableTranslationError({ success: false, code: "RATE_LIMITED" }),
    true,
    "a rate limit is worth one more try",
  );
  assert.equal(
    isRetryableTranslationError({
      success: false,
      error: "Rate limited - try again in a moment",
    }),
    true,
    "a rate limit is worth one more try, code or no code",
  );
  assert.equal(
    isRetryableTranslationError({
      success: false,
      error: "Translation request timed out after 130 seconds. Please Retry.",
    }),
    true,
    "a timeout is worth one more try",
  );
  assert.equal(
    isRetryableTranslationError({
      success: false,
      error: "Unexpected token } in JSON at position 79",
    }),
    true,
    "a model that answered with half a JSON is worth one more try",
  );
  assert.equal(
    isRetryableTranslationError({
      success: false,
      error: "Translation returned no valid Chinese segments",
    }),
    true,
    "a model that wrote nothing usable is worth one more try",
  );

  // A success is never a failure.
  assert.equal(
    isRetryableTranslationError({ success: true }),
    false,
    "a translation that arrived is not a failure",
  );
});
