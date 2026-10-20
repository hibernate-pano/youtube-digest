const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPanel,
  flush,
  read,
  workerRouter,
} = require("./helpers/panel-harness.js");

/* ============================================================
   The panel, running for real.

   These tests cover the way the panel talks to the user: the visible
   notice, the sentences a failure is shown with, the language of every
   label, and the order the Words tab puts its sections in. They drive the
   real sidepanel.js inside a real DOM with the real sidepanel.html, so an
   assertion is about what the user ends up seeing.
   ============================================================ */

/* ============================================================
   A: a failure has to be visible
   ============================================================ */

test("a failure is shown on screen, not only to a screen reader", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.announceAlert("Could not save. Try again.");

  const notice = panel.el("panelToast");
  assert.equal(notice.hidden, false, "the failure is invisible to everyone");
  assert.equal(
    panel.el("panelToastText").textContent,
    "Could not save. Try again.",
    "the visible notice does not carry the message",
  );
  assert.equal(
    panel.el("panelAlert").textContent,
    "Could not save. Try again.",
    "the screen reader lost the message",
  );
});

test("a passing message goes away on its own", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.announceStatus("Note saved.");
  assert.equal(panel.el("panelToast").hidden, false);

  panel.clock.advance(4000);
  assert.equal(
    panel.el("panelToast").hidden,
    true,
    "the message is still on screen long after it was stale",
  );
});

test("an error waits for the user and can be dismissed", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await panel.boot();

  panel.helpers.announceAlert("Could not save. Try again.");

  panel.clock.advance(60_000);
  assert.equal(
    panel.el("panelToast").hidden,
    false,
    "the error disappeared on its own, so the user may never read it",
  );

  await panel.click(panel.el("panelToastClose"));
  assert.equal(panel.el("panelToast").hidden, true, "the error cannot be dismissed");
});

test("a passing message does not wipe an error the user has not read", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.announceAlert("Could not save. Try again.");
  panel.helpers.announceStatus("Note saved.");

  assert.equal(
    panel.el("panelToastText").textContent,
    "Could not save. Try again.",
    "a passing message replaced an error",
  );
});

test("a state the panel already shows is not repeated on screen", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  // The error screen takes over the panel and says what went wrong.
  panel.helpers.showError("Error", "Something went wrong.");

  assert.equal(
    panel.el("panelToast").hidden,
    true,
    "the failure is on screen twice",
  );
  assert.match(
    panel.el("panelAlert").textContent,
    /Something went wrong/,
    "the screen reader lost the failure",
  );
});

test("the notice cannot swallow a click meant for the panel", () => {
  const css = read("sidepanel.css");

  // A notice that takes pointer events would sit on top of the content and
  // eat the clicks the user meant for the content.
  const bar = css.match(/\.panel-toast\s*\{[^}]*\}/);
  assert.ok(bar, "the notice has no rule of its own");
  assert.match(bar[0], /position:\s*fixed;/, "the notice is not out of the flow");
  assert.match(
    bar[0],
    /pointer-events:\s*none;/,
    "the notice eats the clicks meant for the content",
  );
});

// ============================================================
// B: a failure code is not a sentence
// ============================================================

test("our own failure code becomes a sentence the user can read", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure({ error: "NO_AI_KEY" });

  const item = panel.el("chapterList").children[0];
  const message = item.children[0].textContent;
  assert.doesNotMatch(message, /NO_AI_KEY/, "the code reached the user");
  assert.ok(message.trim().length > 10, "the failure has no explanation");
});

test("the provider's own message is still shown", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure({
    error: "NO_AI_KEY",
    message: "DeepSeek V4 Flash API key not configured.",
  });

  const item = panel.el("chapterList").children[0];
  assert.match(
    item.children[0].textContent,
    /API key not configured/,
    "the provider's own words were hidden",
  );
});

test("every failure code has a sentence in both languages", async () => {
  const english = createPanel({ sendMessageImpl: workerRouter() });
  const chinese = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await chinese.helpers.loadPanelLanguage();

  const codes = [
    "NO_AI_KEY",
    "INVALID_AI_KEY",
    "NO_SUPADATA_KEY",
    "INVALID_SUPADATA_KEY",
    "NO_TRANSCRIPT",
    "EMPTY_TRANSCRIPT",
    "OUT_OF_CREDITS",
    "RATE_LIMITED",
    "EMPTY_SENTENCE",
    "AI_IDLE_TIMEOUT",
    "AI_HARD_TIMEOUT",
    "SYNC_SESSION_EXPIRED",
  ];

  for (const code of codes) {
    const englishText = english.helpers.panelFailureMessage({ error: code });
    assert.notEqual(englishText, code, `${code} is shown as a code`);
    assert.ok(englishText.trim().length > 10, `${code} has no English sentence`);

    const chineseText = chinese.helpers.panelFailureMessage({ error: code });
    assert.notEqual(chineseText, code, `${code} is shown as a code in Chinese`);
    assert.ok(chineseText.trim().length > 4, `${code} has no Chinese sentence`);
    assert.notEqual(
      chineseText,
      englishText,
      `${code} says the same thing in both languages`,
    );
  }
});

// ============================================================
// C: a failure has to look like a failure
// ============================================================

test("a failed summary is painted as a failure", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure({ error: "NO_AI_KEY" });

  const chapter = panel.el("chapterList").children[0];
  assert.equal(
    chapter.style.color,
    "var(--danger)",
    "the failure is painted in the accent colour, so it looks like content",
  );
  const quote = panel.el("quotesList").children[0];
  assert.equal(quote.style.color, "var(--danger)");
});

// ============================================================
// D: no hardcoded English left behind
// ============================================================

/**
 * Removes the ${...} expressions from a template literal.
 *
 * What is left is the markup itself, so the words between two tags can be
 * read without stumbling over a JavaScript expression.
 */
function stripTemplateExpressions(template) {
  let result = "";
  let index = 0;
  while (index < template.length) {
    if (template.startsWith("${", index)) {
      let depth = 1;
      index += 2;
      while (index < template.length && depth > 0) {
        const character = template[index];
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        index += 1;
      }
      result += " ";
      continue;
    }
    result += template[index];
    index += 1;
  }
  return result;
}

test("the panel has no hardcoded English left in its user-visible strings", () => {
  const source = read("sidepanel.js");
  // The copy table is the one place where English is written on purpose.
  const code = source.replace(/const PANEL_COPY = \{[\s\S]*?\n\};/, "");

  const offenders = [];

  for (const match of code.matchAll(/\.textContent\s*=\s*"([^"]*)"/g)) {
    if (/[A-Za-z]{2,}/.test(match[1])) {
      offenders.push(`textContent = "${match[1]}"`);
    }
  }

  for (const match of code.matchAll(/\.innerHTML\s*=\s*`([\s\S]*?)`/g)) {
    const markup = stripTemplateExpressions(match[1]);
    for (const text of markup.matchAll(/>([^<>]*[A-Za-z]{2,}[^<>]*)</g)) {
      offenders.push(`innerHTML writes "${text[1].trim()}"`);
    }
  }

  // Every label and title has to come from the copy table. There is no
  // exception any more: the note delete button used to carry an English
  // default because the release gate checked for that exact string, and
  // the string was pinned rather than translated.
  for (const match of code.matchAll(/\b(?:aria-label|title)="([^"${]*)"/g)) {
    if (!/[A-Za-z]{2,}/.test(match[1])) continue;
    offenders.push(match[0]);
  }

  assert.deepEqual(
    offenders,
    [],
    `these words never follow the interface language: ${offenders.join(", ")}`,
  );
});

test("the copy button answers in the panel's language", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await panel.helpers.loadPanelLanguage();

  panel.helpers.startDigest("videoA", "https://www.youtube.com/watch?v=videoA");
  await flush();

  const button = panel.el("copyTranscriptBtn");
  const original = button.textContent;
  await panel.click(button);

  assert.equal(
    button.textContent,
    "已复制",
    "the copy button still speaks English on a Chinese panel",
  );
  assert.notEqual(button.textContent, original);
});

// ============================================================
// E: the library speaks the user's language
// ============================================================

test("a video read a moment ago says so", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const now = Date.now();
  assert.equal(panel.helpers.formatRelativeTime(now - 20_000), "just now");
  assert.equal(panel.helpers.formatRelativeTime(now - 3 * 60_000), "3 min ago");
  assert.equal(panel.helpers.formatRelativeTime(now - 5 * 3_600_000), "5 h ago");
  assert.equal(panel.helpers.formatRelativeTime(now - 3 * 86_400_000), "3 d ago");
  assert.equal(panel.helpers.formatRelativeTime(now - 90 * 86_400_000), "3 mo ago");
});

test("the library says how long ago in the panel's language", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await panel.helpers.loadPanelLanguage();

  const now = Date.now();
  assert.equal(panel.helpers.formatRelativeTime(now - 20_000), "刚刚");
  assert.equal(panel.helpers.formatRelativeTime(now - 3 * 86_400_000), "3 天前");
});

test("the library card shows when the video was read", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_videoB: {
        videoTitle: "A saved video",
        channelName: "A channel",
        timestamp: Date.now() - 30_000,
        analysis: { summary: "A summary" },
      },
    },
  });

  await panel.helpers.loadLibrary();

  const card = panel.el("libraryList").children[0];
  assert.match(card.textContent, /just now/, "the card has no time on it");
});

test("an empty library and a search with no results say different things", async () => {
  const empty = createPanel({ sendMessageImpl: workerRouter() });
  await empty.helpers.loadLibrary();
  const emptyText = empty.el("libraryList").textContent.trim();
  assert.ok(emptyText.length > 0, "the empty library says nothing");

  const searching = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_videoB: {
        videoTitle: "A saved video",
        channelName: "A channel",
        timestamp: Date.now() - 1000,
      },
    },
  });
  await searching.helpers.loadLibrary();

  const input = searching.el("librarySearchInput");
  input.value = "nothing matches this";
  input.dispatchEvent(new searching.window.Event("input", { bubbles: true }));
  await flush();

  const noResultsText = searching.el("libraryList").textContent.trim();
  assert.ok(noResultsText.length > 0, "the empty search says nothing");
  assert.notEqual(
    noResultsText,
    emptyText,
    "a search that found nothing says the same thing as an empty library",
  );
});

// ============================================================
// F: review comes before the word list
// ============================================================

test("review comes before the word list", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const sections = [...panel.el("panel-words").children].filter((element) =>
    element.classList.contains("section"),
  );
  const reviewIndex = sections.findIndex((element) =>
    element.querySelector("#reviewArea"),
  );
  const wordsIndex = sections.findIndex((element) =>
    element.querySelector("#wordsList"),
  );

  assert.ok(reviewIndex >= 0, "the review section is gone");
  assert.ok(wordsIndex >= 0, "the vocabulary section is gone");
  assert.ok(
    reviewIndex < wordsIndex,
    "the review is still below the whole word list",
  );
});

test("the first control of the Words tab is the review", () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const controls = panel.all("#panel-words button");
  assert.ok(controls.length > 0, "the Words tab has no controls");
  assert.equal(
    controls[0].id,
    "reviewCard",
    "a keyboard user still has to walk past the word list to reach the review",
  );
});

// ============================================================
// G: a lost note and a lost cache are both said out loud
// ============================================================

/**
 * The failure Chrome raises when the device storage is full.
 */
function quotaError() {
  const error = new Error(
    "QUOTA_BYTES quota exceeded: the storage is full.",
  );
  error.name = "QuotaExceededError";
  return error;
}

test("a note that did not save says why, in the user's language", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      saveNote: {
        success: false,
        error: "The device storage is full: the note could not be saved.",
        code: "STORAGE_QUOTA_EXCEEDED",
      },
    }),
  });
  await panel.boot();
  panel.helpers.setCurrentVideo("video-1", "https://youtu.be/video-1");

  panel.el("quickNoteInput").value = "a sentence worth keeping";
  await panel.helpers.saveQuickNote();
  await flush();

  const message = panel.el("panelToastText").textContent;
  assert.doesNotMatch(message, /STORAGE_QUOTA_EXCEEDED/, "the code reached the user");
  assert.match(message, /storage is full/i, "the reason is not explained");
});

test("a note that did not save for any other reason still says something", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      saveNote: { success: false, error: "Something broke" },
    }),
  });
  await panel.boot();
  panel.helpers.setCurrentVideo("video-1", "https://youtu.be/video-1");

  panel.el("quickNoteInput").value = "a sentence worth keeping";
  await panel.helpers.saveQuickNote();
  await flush();

  const message = panel.el("panelToastText").textContent;
  assert.ok(message.trim().length > 5, "the failure says nothing at all");
});

test("a note that did save is not announced as a failure", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      saveNote: { success: true, note: { id: "note-1" } },
      getNotes: { success: true, notes: [] },
    }),
  });
  await panel.boot();

  panel.helpers.setCurrentVideo("video-1", "https://youtu.be/video-1");
  const input = panel.el("quickNoteInput");
  input.value = "a sentence worth keeping";
  await panel.helpers.saveQuickNote();
  await flush();

  assert.equal(
    panel.el("panelToastText").textContent,
    "Note saved.",
    "a saved note was announced as a failure",
  );
});

test("a cached video makes room for itself when the storage is full", async () => {
  let panel = null;
  panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: {
      digest_old: { videoTitle: "Old", timestamp: Date.now() - 1000 },
      digest_newer: { videoTitle: "Newer", timestamp: Date.now() - 500 },
    },
    // The store is full as long as both old digests are still in it. A
    // write only goes through once the panel has made room.
    onLocalSet: () => {
      const digests = Object.keys(panel.storage.local.values).filter((key) =>
        key.startsWith("digest_"),
      );
      return digests.length >= 2 ? quotaError() : null;
    },
  });

  const stored = await panel.helpers.writeDigestCache("videoX", {
    videoTitle: "A video",
    timestamp: Date.now(),
  });

  assert.equal(stored, true, "the digest was not saved even though room was freed");
  assert.ok(panel.storage.local.values.digest_videoX, "the digest is not in the store");
  assert.equal(
    Object.keys(panel.storage.local.values).filter((key) =>
      key.startsWith("digest_"),
    ).length,
    1,
    "the room that was freed was not freed",
  );
});

test("a cache that cannot be saved at all is announced", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    onLocalSet: () => quotaError(),
  });

  const stored = await panel.helpers.writeDigestCache("videoX", {
    videoTitle: "A video",
    timestamp: Date.now(),
  });

  assert.equal(stored, false, "the cache pretends to be saved");
});

test("a timeout is not told as a missing subtitle", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.showTranscriptError({ error: "TRANSCRIPT_REQUEST_TIMEOUT" });

  const title = panel.el("errorTitle").textContent;
  const message = panel.el("errorMessage").textContent;
  assert.doesNotMatch(message, /TRANSCRIPT_REQUEST_TIMEOUT/, "the code reached the user");
  assert.doesNotMatch(
    title,
    /no transcript found/i,
    "a timeout is titled as a missing subtitle",
  );
  assert.match(message, /did not answer/i, "the timeout is not explained");
});

test("the new failure codes have a sentence in both languages", async () => {
  const english = createPanel({ sendMessageImpl: workerRouter() });
  const chinese = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await chinese.helpers.loadPanelLanguage();

  const codes = [
    "SYNC_REQUEST_TIMEOUT",
    "TRANSCRIPT_REQUEST_TIMEOUT",
    "STORAGE_QUOTA_EXCEEDED",
  ];

  // Every code has to say something about its own subject. A generic
  // "something went wrong" would pass a length check and tell the user
  // nothing at all.
  const subjects = {
    SYNC_REQUEST_TIMEOUT: /sync service/i,
    TRANSCRIPT_REQUEST_TIMEOUT: /transcript service/i,
    STORAGE_QUOTA_EXCEEDED: /storage/i,
  };

  for (const code of codes) {
    const englishText = english.helpers.panelFailureMessage({ error: code });
    assert.notEqual(englishText, code, `${code} is shown as a code`);
    assert.ok(englishText.trim().length > 10, `${code} has no English sentence`);
    assert.match(
      englishText,
      subjects[code],
      `${code} does not say what went wrong`,
    );

    const chineseText = chinese.helpers.panelFailureMessage({ error: code });
    assert.notEqual(chineseText, code, `${code} is shown as a code in Chinese`);
    assert.ok(chineseText.trim().length > 4, `${code} has no Chinese sentence`);
    assert.notEqual(
      chineseText,
      englishText,
      `${code} says the same thing in both languages`,
    );
  }
});

test("a quote that did not save says why", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      saveNote: {
        success: false,
        error: "The device storage is full: the note could not be saved.",
        code: "STORAGE_QUOTA_EXCEEDED",
      },
    }),
  });
  await panel.boot();
  panel.helpers.setCurrentVideo("video-1", "https://youtu.be/video-1");

  const button = panel.document.createElement("button");
  panel.document.body.appendChild(button);
  await panel.helpers.saveQuoteAsNote(
    { timestampSeconds: 12, quote: "a quote worth keeping" },
    button,
  );
  await flush();

  const message = panel.el("panelToastText").textContent;
  assert.match(message, /storage is full/i, "the reason is not explained");
});

test("a video with no captions and no fallback key says both things", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.showTranscriptError({ error: "NO_SUPADATA_KEY" });

  const message = panel.el("errorMessage").textContent;
  assert.match(message, /no subtitles/i, "the video's real problem is hidden");
  assert.match(message, /Supadata/i, "the fallback key is not named");
  assert.doesNotMatch(
    message,
    /NO_SUPADATA_KEY/,
    "the code reached the user",
  );
});

test("a failure is never shown in the worker's language", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await panel.helpers.loadPanelLanguage();

  // The worker knows what went wrong. The panel knows how to say it in the
  // language the user reads. Only one of the two may write the sentence:
  // a sentence from the worker reaches a Chinese screen in English.
  panel.helpers.showTranscriptError({
    error: "NO_TRANSCRIPT",
    message: "No subtitles found for this video.",
  });

  const message = panel.el("errorMessage").textContent;
  assert.doesNotMatch(
    message,
    /[A-Za-z]{3,}/,
    "the worker's English reached a Chinese screen",
  );
  assert.match(message, /字幕/, "the Chinese sentence is missing");
});

test("the panel keeps the worker's sentence out of every failure", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  const codes = [
    "NO_SUPADATA_KEY",
    "INVALID_SUPADATA_KEY",
    "OUT_OF_CREDITS",
    "RATE_LIMITED",
    "NO_TRANSCRIPT",
    "EMPTY_TRANSCRIPT",
    "TRANSCRIPT_REQUEST_TIMEOUT",
    "TRANSCRIPT_FAILED",
  ];

  for (const code of codes) {
    panel.helpers.showTranscriptError({
      error: code,
      message: "A sentence the worker wrote in its own language.",
    });
    const message = panel.el("errorMessage").textContent;
    assert.doesNotMatch(
      message,
      /worker wrote/i,
      `${code} shows the sentence the worker sent`,
    );
    assert.ok(
      message.trim().length > 10,
      `${code} has no sentence of its own`,
    );
  }

  // A code the panel has no sentence for is a failure the product does not
  // understand yet. The worker's own words are still not the ones the user
  // reads: they are in the worker's language.
  panel.helpers.showTranscriptError({
    error: "A_CODE_WE_DO_NOT_KNOW",
    message: "A sentence the worker wrote in its own language.",
  });
  assert.doesNotMatch(
    panel.el("errorMessage").textContent,
    /worker wrote/i,
    "an unknown failure shows the sentence the worker sent",
  );
});

test("an exhausted balance still says where to add credits", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.showTranscriptError({ error: "OUT_OF_CREDITS" });

  const message = panel.el("errorMessage").textContent;
  assert.match(message, /credits/i, "the balance is not mentioned");
  assert.match(
    message,
    /dash\.supadata\.ai/,
    "the place to add credits is not named",
  );
});

test("the panel works without a Supadata key and says so once", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      checkConfig: { hasSupadataKey: false, hasAiKey: true },
    }),
  });
  await panel.boot();

  // The panel is alive: it did not fall into the "missing keys" dead end.
  assert.equal(
    panel.el("errorState").style.display,
    "none",
    "a missing fallback key stops the whole panel",
  );

  // And the user knows the fallback is gone.
  const notice = panel.el("panelToastText").textContent;
  assert.match(notice, /Supadata/i, "the missing fallback is not mentioned");

  // The notice is shown before a single subtitle has been read, so it must
  // not claim the video has none. That claim belongs to the dead end, where
  // the page really had nothing to give.
  assert.doesNotMatch(
    notice,
    /no subtitles|no captions/i,
    "the boot notice claims the video has no subtitles before reading any",
  );

  // It is a note, not a failure: a red bar that waits for a dismissal reads
  // like the product is broken.
  assert.equal(
    panel.el("panelToast").dataset.kind,
    "status",
    "the missing fallback is shown as a failure",
  );
});

test("the panel stops when both keys are missing", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      checkConfig: { hasSupadataKey: false, hasAiKey: false },
    }),
  });
  await panel.boot();

  assert.equal(
    panel.el("errorState").style.display,
    "block",
    "the panel runs without any key at all",
  );
  const message = panel.el("errorMessage").textContent;
  assert.match(message, /AI provider key/i, "the missing AI key is not named");
});

test("the video the panel just read is cached for next time", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.startDigest("videoA", "https://www.youtube.com/watch?v=videoA");
  await flush();

  const cached = panel.storage.local.values.digest_videoA;
  assert.ok(cached, "the video was not cached, so the next visit costs a credit");
  assert.ok(
    Array.isArray(cached.transcript) && cached.transcript.length > 0,
    "the cache has no transcript in it",
  );
  assert.ok(cached.timestamp, "the cache does not say when it was written");
});

// ============================================================
// F: the retry the user is offered has to be a real one
// ============================================================

test("a video without captions still offers a way out", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No subtitles found for this video.",
      },
    }),
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  assert.equal(panel.el("errorTitle").textContent, "No transcript found");
  assert.match(
    panel.el("errorMessage").textContent,
    /subtitles/i,
    "the user is shown a code instead of a sentence",
  );
  assert.equal(
    panel.el("errorBtn").textContent,
    "Try Again",
    "a caption-less video leaves the user with no way out",
  );
});

test("the retry button asks the worker to look the video up again", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No subtitles found for this video.",
      },
    }),
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  const lookups = panel.sentMessages.filter(
    (message) => message.action === "fetchTranscript",
  );
  assert.equal(lookups.length, 1);
  assert.notEqual(
    lookups[0].force,
    true,
    "the first look at the video is already a forced one",
  );

  // The user presses the button that says "Retry".
  await panel.click(panel.el("errorBtn"));
  await flush();

  const afterRetry = panel.sentMessages.filter(
    (message) => message.action === "fetchTranscript",
  );
  assert.equal(afterRetry.length, 2, "the retry never reached the worker");
  assert.equal(
    afterRetry[1].force,
    true,
    "the retry was answered from what the worker remembers, so it did nothing",
  );
});

test("an empty transcript can be tried again as well", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      },
    }),
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  assert.equal(panel.el("errorBtn").textContent, "Try Again");

  await panel.click(panel.el("errorBtn"));
  await flush();

  const afterRetry = panel.sentMessages.filter(
    (message) => message.action === "fetchTranscript",
  );
  assert.equal(afterRetry.length, 2, "the retry never reached the worker");
  assert.equal(
    afterRetry[1].force,
    true,
    "the retry was answered from what the worker remembers, so it did nothing",
  );
});
