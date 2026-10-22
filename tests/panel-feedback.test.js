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

/**
 * Waits for the panel to run its own boot.
 *
 * jsdom fires DOMContentLoaded by itself once the markup is parsed, so a
 * panel under test starts up without help. Calling boot() on top of that
 * dispatches a second one and the panel's listener runs twice, which wires
 * every button twice: a button that opens a dialog would open it twice.
 * That is the harness's doing, not the panel's, so a test that presses
 * buttons waits here instead.
 */
async function waitForBoot(panel) {
  for (let round = 0; round < 50; round += 1) {
    // The first thing the boot asks the worker for. Seeing it means the
    // listener has run and the controls are wired.
    const started = panel.sentMessages.some(
      (message) => message.action === "checkConfig",
    );
    if (started) return;
    await flush();
  }
  throw new Error("the panel never finished booting");
}

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

test("the failure names the provider whose key is missing", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  panel.helpers.renderAnalysisFailure({
    error: "NO_AI_KEY",
    provider: "DeepSeek",
  });

  const item = panel.el("chapterList").children[0];
  assert.match(
    item.children[0].textContent,
    /DeepSeek/,
    "the user is not told whose key is missing",
  );
  assert.doesNotMatch(
    item.children[0].textContent,
    /NO_AI_KEY/,
    "the code reached the user",
  );
});

test("the panel names the provider even when the failure does not", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      checkConfig: {
        hasSupadataKey: true,
        hasAiKey: true,
        provider: "MiniMax M3",
      },
    }),
  });
  await panel.boot();

  panel.helpers.renderAnalysisFailure({ error: "NO_AI_KEY" });

  const item = panel.el("chapterList").children[0];
  assert.match(
    item.children[0].textContent,
    /MiniMax/,
    "the panel does not know whose key is missing",
  );
});

test("the provider's own words still reach the user", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  // The provider's own verdict is the only place the specifics live. The
  // panel cannot translate it, so it shows it as it is.
  panel.helpers.renderAnalysisFailure({
    error: "This API key has expired",
  });

  const item = panel.el("chapterList").children[0];
  assert.match(
    item.children[0].textContent,
    /expired/i,
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

test("every code the worker can return has a sentence of its own", async () => {
  // The list above is a list somebody wrote by hand, so it only ever
  // covers the codes that existed the day it was written. This one is read
  // out of the worker's own source: a code added tomorrow is in the list
  // the moment it is written, and the panel has to answer it.
  const sources = ["background.js", "cloud-sync.js", "settings.js"].map(read);
  const codes = new Set();
  const patterns = [
    /\.code\s*=\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /error:\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /code:\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /\.code\s*\|\|\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /const ([A-Z][A-Z0-9_]{2,}) = "\1";/g,
  ];
  for (const source of sources) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) codes.add(match[1]);
    }
  }
  assert.ok(codes.size > 15, "the scan found almost no codes, so it proves nothing");

  const table = read("sidepanel.js").match(
    /const PANEL_ERROR_CODE_COPY = \{[\s\S]*?\n\};/,
  );
  assert.ok(table, "the panel needs a table of failure sentences");
  const mapped = new Set(
    [...table[0].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*"(\w+)"/gm)].map(
      (match) => match[1],
    ),
  );

  // A code with no entry falls back to the generic sentence, which is the
  // bug this guards: the user is told "something went wrong" while the
  // panel knew exactly what went wrong and did not say.
  const unmapped = [...codes].filter((code) => !mapped.has(code)).sort();
  assert.deepEqual(
    unmapped,
    [],
    `the panel has no sentence for: ${unmapped.join(", ")}`,
  );

  const english = createPanel({ sendMessageImpl: workerRouter() });
  const chinese = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await chinese.helpers.loadPanelLanguage();
  const generic = english.helpers.panelCopy("errorMessage");

  for (const code of codes) {
    const englishText = english.helpers.panelFailureMessage({ code });
    const chineseText = chinese.helpers.panelFailureMessage({ code });
    assert.notEqual(englishText, generic, `${code} falls back to the generic sentence`);
    assert.notEqual(chineseText, chinese.helpers.panelCopy("errorMessage"), `${code} falls back to the generic sentence in Chinese`);
    assert.notEqual(chineseText, englishText, `${code} says the same thing in both languages`);
  }
});

test("the transcript search count is said in the panel's language", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  // jsdom has no layout, so it has no scrollIntoView. The browser the panel
  // ships to has one; this stub only stands in for it.
  panel.window.Element.prototype.scrollIntoView = () => {};
  await panel.helpers.loadPanelLanguage();
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  const input = panel.el("transcriptSearchInput");
  input.value = "caption";
  input.dispatchEvent(new panel.window.Event("input", { bubbles: true }));
  // The search waits for the typing to settle, so the clock is moved
  // forward before the count is read.
  panel.clock.advance(300);
  await flush();

  const count = panel.el("transcriptSearchCount").textContent;
  // "1 of 2" is the browser's Find bar, not Chinese. A Chinese panel that
  // counts in English is the machine talking to itself.
  assert.doesNotMatch(count, /\bof\b/, "the English count reached the Chinese panel");
  assert.match(count, /共/, "the count is not said in Chinese");
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

test("a failed analysis is never shown in the worker's language", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter(), language: "zh-CN" });
  await panel.helpers.loadPanelLanguage();

  panel.helpers.renderAnalysisFailure({
    error: "NO_AI_KEY",
    provider: "DeepSeek",
    message: "DeepSeek V4 Flash API key not configured.",
  });

  const item = panel.el("chapterList").children[0];
  const message = item.children[0].textContent;
  assert.doesNotMatch(
    message,
    /not configured/i,
    "the worker's English reached a Chinese screen",
  );
  assert.match(message, /密钥/, "the Chinese sentence is missing");
  assert.match(message, /DeepSeek/, "the provider is not named");
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
    "PAGE_NOT_READY",
    "VIDEO_NOT_STARTED",
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

test("a failure the panel has no sentence for is not the worker's sentence", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  // This is the sentence every other failure screen uses, not only the
  // transcript one: the words a failed analysis, a failed extraction or a
  // failed review are shown with are the panel's, in the reader's
  // language. A code the panel has no sentence for is replaced by the
  // generic one, and the sentence the worker sent is not shown either.
  const message = panel.helpers.panelFailureMessage({
    error: "A_CODE_WE_DO_NOT_KNOW",
    message: "A sentence the worker wrote in its own language.",
  });
  assert.doesNotMatch(
    message,
    /worker wrote/i,
    "the sentence the worker sent is shown",
  );
  assert.ok(
    message.trim().length > 10,
    "there is no sentence of the panel's own",
  );

  // A failure with no code at all is the provider's own words, and they
  // are the only thing that can explain it: there is nothing to translate
  // them from.
  const provider = panel.helpers.panelFailureMessage({
    message: "The provider said something the panel cannot translate.",
  });
  assert.match(
    provider,
    /cannot translate/,
    "the provider's own words are lost",
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

test("the panel opens without any key and says which features need one", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      checkConfig: { hasSupadataKey: false, hasAiKey: false },
    }),
  });
  await panel.boot();

  // The subtitles are read out of the page and the notes and the
  // vocabulary stay on this device, so no key may stop the panel from
  // opening. Locking the free half behind the paid half was a fossil of
  // the time when the transcript key was required.
  assert.equal(
    panel.el("errorState").style.display,
    "none",
    "the panel refuses to open without a key",
  );

  const notice = panel.el("aiKeyNotice");
  assert.equal(notice.hidden, false, "the panel does not say what needs a key");
  const text = panel.el("aiKeyNoticeText").textContent;
  assert.match(text, /summary/i, "the notice does not name what is waiting");
  assert.match(
    text,
    /notes/i,
    "the notice does not say what works without a key",
  );
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

test("a page that was not ready does not blame the video", async () => {
  // The page had not swapped its player yet, so the subtitles could not be
  // read. The video may well have subtitles, and the screen must not say it
  // has none: the user would go looking for a problem that is not there.
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: { success: false, error: "PAGE_NOT_READY" },
    }),
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  const message = panel.el("errorMessage").textContent;
  assert.doesNotMatch(
    message,
    /no subtitles/i,
    "the video was blamed for a page that was not ready",
  );
  // The title carries the claim too: "No transcript found" is a sentence
  // about the video, and the video is not what failed here.
  assert.doesNotMatch(
    panel.el("errorTitle").textContent,
    /no transcript/i,
    "the title blamed the video for a page that was not ready",
  );
  assert.match(
    panel.el("errorTitle").textContent,
    /page/i,
    "the screen does not say what actually happened",
  );
  assert.equal(
    panel.el("errorBtn").textContent,
    "Try Again",
    "the one action that helps is not on the screen",
  );

  await panel.click(panel.el("errorBtn"));
  await flush();

  const requests = panel.sentMessages.filter(
    (message) => message.action === "fetchTranscript",
  );
  assert.equal(requests.length, 2, "the retry never reached the worker");
  assert.equal(
    requests[1].force,
    true,
    "the retry was answered from what the worker remembers, so it did nothing",
  );
});

test("the page that was not ready is said in the language the user picked", async () => {
  const chinese = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: { success: false, error: "PAGE_NOT_READY" },
    }),
    language: "zh-CN",
  });
  await chinese.boot();
  await chinese.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  assert.match(chinese.el("errorMessage").textContent, /字幕/);
  assert.match(chinese.el("errorTitle").textContent, /页面/);
  assert.doesNotMatch(
    chinese.el("errorMessage").textContent,
    /[A-Za-z]{6,}/,
    "an English sentence slipped into the Chinese screen",
  );
});

test("a video that has not started is told what to do, not blamed", async () => {
  // The video was never played, so YouTube never asked the page for the
  // captions and there was nothing to read. The video is not the problem,
  // and the screen must not claim that it has no subtitles: the user would
  // go looking for a problem that is not there.
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: { success: false, error: "VIDEO_NOT_STARTED" },
    }),
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  const title = panel.el("errorTitle").textContent;
  const message = panel.el("errorMessage").textContent;
  assert.doesNotMatch(
    message,
    /no subtitles/i,
    "the video was blamed for a video that has not started",
  );
  assert.doesNotMatch(
    title,
    /no transcript/i,
    "the title blamed the video for a video that has not started",
  );
  assert.match(
    message,
    /playing/i,
    "the screen does not say what will make it work",
  );
  assert.equal(
    panel.el("errorBtn").textContent,
    "Try Again",
    "the one action that helps is not on the screen",
  );

  await panel.click(panel.el("errorBtn"));
  await flush();

  const requests = panel.sentMessages.filter(
    (message) => message.action === "fetchTranscript",
  );
  assert.equal(requests.length, 2, "the retry never reached the worker");
  assert.equal(
    requests[1].force,
    true,
    "the retry was answered from what the worker remembers, so it did nothing",
  );
});

test("the video that has not started is said in the language the user picked", async () => {
  const chinese = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: { success: false, error: "VIDEO_NOT_STARTED" },
    }),
    language: "zh-CN",
  });
  await chinese.boot();
  await chinese.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  const title = chinese.el("errorTitle").textContent;
  const message = chinese.el("errorMessage").textContent;
  assert.match(message, /播放/, "the Chinese sentence does not say what to do");
  assert.match(title, /播放/, "the Chinese title does not say what to do");
  assert.doesNotMatch(
    message,
    /没有字幕|无字幕/,
    "the Chinese screen blamed the video for a video that has not started",
  );
  assert.doesNotMatch(
    message,
    /[A-Za-z]{6,}/,
    "an English sentence slipped into the Chinese screen",
  );
});

test("a failure the panel does not know still leaves a way out", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: {
        success: false,
        error: "A_CODE_WE_DO_NOT_KNOW",
        message: "Something the worker said.",
      },
    }),
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );

  // A code with no sentence of its own still gets a screen with a button
  // that does something.
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

// ============================================================
// H: the keyboard, the dialog and the words on the screen
// ============================================================

test("a keyboard selection puts the toolbar in reach", async () => {
  // The transcript is static text: the browser puts no caret in it, so
  // Shift with the arrow keys selected nothing and the three actions on
  // the selection were out of reach for a user without a mouse. The panel
  // keeps its own caret and builds the selection from it.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  // jsdom has no layout, so a range has no rectangle. The browser the panel
  // ships to has one; this stub only stands in for it.
  panel.window.Range.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  const list = panel.el("transcriptList");
  list.focus();
  list.dispatchEvent(
    new panel.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );

  const selection = panel.window.getSelection();
  assert.equal(selection.rangeCount, 1, "Shift+Right selected nothing");
  assert.equal(selection.toString(), "A", "the wrong text was selected");
  assert.ok(
    list.contains(selection.getRangeAt(0).startContainer),
    "the selection is not inside the transcript",
  );

  panel.window.document.dispatchEvent(
    new panel.window.KeyboardEvent("keyup", {
      key: "ArrowRight",
      shiftKey: true,
      bubbles: true,
    }),
  );
  await flush();

  assert.equal(
    panel.el("explainTooltip").style.display,
    "flex",
    "the actions are out of reach after a keyboard selection",
  );
});

test("the selection grows while Shift is held", async () => {
  // The focus is in the toolbar after a keyboard selection, so the arrow
  // keys have to grow the selection there as well. A selection that can
  // never be longer than one character is not a selection.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  panel.window.Range.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
  });
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  const list = panel.el("transcriptList");
  list.focus();
  for (const key of ["ArrowRight", "ArrowRight", "ArrowRight"]) {
    list.dispatchEvent(
      new panel.window.KeyboardEvent("keydown", {
        key,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    panel.window.document.dispatchEvent(
      new panel.window.KeyboardEvent("keyup", {
        key,
        shiftKey: true,
        bubbles: true,
      }),
    );
  }
  await flush();

  const toolbar = panel.el("explainTooltip");
  assert.equal(toolbar.style.display, "flex", "the toolbar is not on screen");
  assert.equal(
    panel.window.document.activeElement?.className,
    "explain-btn",
    "the keyboard is not in the toolbar",
  );

  toolbar.dispatchEvent(
    new panel.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );

  assert.equal(
    panel.window.getSelection().toString(),
    "A ca",
    "the selection did not grow while the focus was in the toolbar",
  );
});

test("Shift+Tab at the first action stays inside the dialog", async () => {
  // The focus starts on the dialog itself, which is inside the dialog but
  // is not one of the actions. The old trap only checked whether the focus
  // was inside, so the first Shift+Tab walked out into the inert panel and
  // the keyboard was left on the body with nowhere to go.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await panel.boot();
  await panel.helpers.showExplanation("some selected words");

  const dialog = panel.document.querySelector(".explain-modal");
  assert.ok(dialog, "the dialog is not on screen");
  dialog.focus();

  const event = new panel.window.KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  panel.document.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true, "the browser was allowed to leave the dialog");
  const active = panel.document.activeElement;
  assert.ok(dialog.contains(active), "the focus left the dialog");
  assert.notEqual(active, panel.document.body, "the focus landed on the body");
  const actions = [...dialog.querySelectorAll("button")];
  assert.equal(active, actions[actions.length - 1], "the focus did not wrap to the last action");
});

test("deleting a word says the word was deleted", async () => {
  const router = workerRouter({
    getVocabulary: {
      success: true,
      items: [{ id: "vocab_1", term: "spaced repetition", translation: "间隔重复" }],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });
  // The welcome screen is announced when the panel opens, and it would
  // overwrite whatever the delete said. Boot first, then delete.
  await panel.boot();
  await panel.helpers.loadVocabulary();

  await panel.click(panel.el("wordsList").querySelector(".word-delete"));
  await flush();

  assert.equal(
    panel.el("panelStatus").textContent,
    "Word deleted.",
    "the delete was announced as a different action",
  );
  assert.doesNotMatch(
    panel.el("panelStatus").textContent,
    /copied/i,
    "deleting a word announces a copy",
  );
});

test("the same message is announced again the second time", async () => {
  // A live region only speaks when its text changes. Writing the same
  // sentence twice left the region untouched the second time, so a user
  // who pressed copy twice heard the first answer and then nothing.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await panel.boot();

  panel.helpers.announceStatus("Note saved.", { notice: false });
  assert.equal(panel.el("panelStatus").textContent, "Note saved.");

  panel.helpers.announceStatus("Note saved.", { notice: false });
  // The region is emptied first so the second write is a change the
  // browser can announce, and the sentence comes back in the next task.
  assert.equal(panel.el("panelStatus").textContent, "", "the repeat was written as the same text");

  panel.clock.advance(200);
  assert.equal(
    panel.el("panelStatus").textContent,
    "Note saved.",
    "the second announcement never arrived",
  );
});

test("a failed note delete stays on screen and says why", async () => {
  const router = workerRouter({
    getNotes: {
      success: true,
      notes: [
        {
          id: "note-1",
          videoId: "video-1",
          videoTitle: "A video",
          text: "a note worth keeping",
          timestampSeconds: 12,
          timestampedUrl: "https://youtu.be/video-1?t=12",
        },
      ],
    },
    deleteNote: { success: false, error: "The store is read only." },
  });
  const panel = createPanel({ sendMessageImpl: router });
  await panel.boot();
  await panel.helpers.loadNotes(null);
  await flush();

  const row = panel.el("notesList").querySelector(".note-item");
  assert.ok(row, "the note is not on screen");

  await panel.click(row.querySelector(".note-delete"));
  await flush();

  assert.ok(
    panel.el("notesList").querySelector(".note-item"),
    "the row disappeared while the note is still on the disk",
  );
  assert.match(
    panel.el("panelToastText").textContent,
    /read only/i,
    "the failure is not on screen",
  );
});

test("the explain dialog states the price before it spends it", async () => {
  // The word dialog three lines away says what it costs. The explain
  // dialog charged the same way and said nothing.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await panel.boot();
  await panel.helpers.showExplanation("some selected words");

  const dialog = panel.document.querySelector(".explain-modal");
  assert.match(
    dialog.textContent,
    /provider/i,
    "the dialog charges without saying where the money goes",
  );
  assert.match(dialog.textContent, /\$|cent/i, "the dialog states no price");
});

test("switching to Chinese asks before it pays", async () => {
  // Translating a video is not one call: the transcript goes out in small
  // batches. Switching the language used to start all of them with no
  // price and no question.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  // This test presses a button, so every listener has to exist exactly once.
  // The harness boot() dispatches a second DOMContentLoaded on top of the one
  // jsdom fires on its own, which wires the buttons twice and opens the
  // question twice. Waiting for the panel's own boot keeps one of each.
  await waitForBoot(panel);
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  const before = panel.sentMessages.filter(
    (message) => message.action === "translateContent",
  ).length;

  // The path a user takes: they press the language button.
  await panel.click(panel.el("contentLanguageChinese"));

  const modal = panel.el("translationCostModal");
  assert.ok(modal, "the switch started paying without asking");
  assert.match(modal.textContent, /\$/, "the question does not say what it costs");
  assert.match(modal.textContent, /call/i, "the question does not say how many calls it takes");

  const paid = panel.sentMessages.filter(
    (message) => message.action === "translateContent",
  ).length;
  assert.equal(paid, before, "a batch went out before the user answered");

  // Saying no leaves the panel where it was.
  await panel.click(panel.el("translationCostCancelBtn"));
  await flush();
  assert.equal(panel.el("translationCostModal"), null, "the question stayed on screen");
  assert.equal(
    panel.helpers.getState().currentTranscriptMode,
    "original",
    "the language changed even though the user said no",
  );

  // Saying yes switches, and the switch does not ask a second time.
  await panel.click(panel.el("contentLanguageChinese"));
  assert.ok(panel.el("translationCostModal"), "the second switch asked again");
  await panel.click(panel.el("translationCostConfirmBtn"));
  await flush();
  assert.equal(panel.el("translationCostModal"), null);
  assert.equal(
    panel.helpers.getState().currentTranscriptMode,
    "zh",
    "the language did not change after the user agreed to pay",
  );
  const after = panel.sentMessages.filter(
    (message) => message.action === "translateContent",
  ).length;
  assert.ok(after > before, "the agreed translation never went out");
});

test("the review sign-in hint signs in", async () => {
  // The hint is the sentence that says the review needs a sign-in. A dead
  // grey sentence tells the user what is missing and not what to do about
  // it, and the button that does the thing is somewhere else.
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      getDueReviews: { success: false, error: "NO_SESSION" },
    }),
  });
  await panel.boot();
  await panel.helpers.loadDueReviews();

  const hint = panel.el("reviewSignedOut");
  assert.equal(hint.hidden, false, "the sign-in hint is missing");
  await panel.click(hint);

  assert.ok(
    panel.sentMessages.some((message) => message.action === "startGithubLogin"),
    "the hint does not start the sign-in it asks for",
  );
});

test("the library never says it is empty and that it was cleaned at once", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: { ytd_library_cleanup: { count: 2, at: Date.now() } },
  });
  await panel.helpers.loadLibrary();
  await flush();

  const screen = panel.el("panel-library").textContent;
  const saysEmpty = /nothing here yet/i.test(screen);
  const saysCleaned = /removed/i.test(screen);
  assert.equal(
    saysEmpty && saysCleaned,
    true,
    "the two sentences are not both on screen, so this test proves nothing",
  );
  assert.doesNotMatch(
    panel.el("libraryList").textContent,
    /nothing here yet/i,
    "the library says it is empty next to a record of what was removed",
  );
});

test("an old cleanup record is forgotten", async () => {
  // The record outlived the thing it described: a year later the library
  // still opened with "2 entries older than 30 days were removed" as if it
  // had just happened.
  const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: { ytd_library_cleanup: { count: 2, at: old } },
  });
  await panel.helpers.loadLibrary();
  await flush();

  assert.equal(panel.el("libraryCleanup").hidden, true, "a year-old cleanup is still on screen");
  assert.equal(
    panel.storage.local.values.ytd_library_cleanup,
    undefined,
    "the year-old record is still in the store",
  );
});

test("the summary gate quotes the price the README measured", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      checkConfig: { hasSupadataKey: true, hasAiKey: true },
    }),
  });
  await panel.helpers.bootPanel();
  panel.helpers.renderSummaryGate();

  const gate = panel.el("summaryGate").textContent;
  // "One AI call, your own provider balance" is not a price. The README
  // measured $0.002 to $0.015 for a 20-minute talk.
  assert.match(gate, /\$0\.002/, "the gate quotes no price");
  assert.match(gate, /\$0\.015/, "the gate quotes a price range that is not the measured one");
  assert.match(gate, /provider/i, "the gate does not say where the money goes");
  assert.match(gate, /length of the video/i, "the gate does not say what changes the price");
});

test("the note copy does not promise a polishing the panel does not do", async () => {
  // The panel saves a note exactly as it was written. Only the Note
  // button on the video page sends the line to the AI.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  const intro = panel.helpers.panelCopy("notesIntro");
  assert.doesNotMatch(
    intro,
    /polish/i,
    "the panel promises to polish notes it saves verbatim",
  );
  assert.match(intro, /exactly as you wrote it/i, "the panel does not say the note is kept as written");
  assert.match(
    intro,
    /video page/i,
    "the panel does not say where the AI-tidied note comes from",
  );
});

test("grading the last card leaves the keyboard in the review area", async () => {
  // The focus was on a grade button, and the button is hidden once the
  // queue is empty. A hidden button cannot hold the focus: the browser
  // drops it on the body and the next Tab starts at the top of the panel
  // again.
  const router = workerRouter({
    getDueReviews: {
      success: true,
      reviews: [
        {
          review: { dueAt: Date.now() - 1000, intervalDays: 1, ease: 2.5, reps: 1 },
          vocabulary: { id: "cloud-uuid-1", term: "spaced repetition", translation: "间隔重复" },
        },
      ],
    },
  });
  const panel = createPanel({ sendMessageImpl: router });
  await panel.boot();
  // The review lives on the Words tab, which is only reachable once the
  // panel is showing a video. jsdom will not focus an element whose
  // ancestor is display:none, so the tab has to be on screen first.
  panel.helpers.showState("results");
  panel.helpers.switchTab("words");
  await panel.helpers.loadDueReviews();
  await panel.helpers.revealReviewAnswer();

  const grade = panel.el("reviewActions").querySelector(".grade-btn");
  grade.focus();
  await panel.helpers.submitReviewGrade(3);
  await flush();

  const active = panel.document.activeElement;
  assert.notEqual(active, panel.document.body, "the focus was dropped on the body");
  assert.notEqual(active, grade, "the focus is still on a hidden button");
  assert.equal(
    active?.id,
    "reviewEmpty",
    "the keyboard was not left where the review ended",
  );
});

// ============================================================
// I: the relay, the list semantics and the price order
// ============================================================

/**
 * Answers a relay the way the content script does.
 *
 * The worker only uses a tab id the panel names; without one it looks for a
 * YouTube tab in front, which is a different video whenever the user is
 * reading another tab beside the panel.
 */
function relayRecorder() {
  const relays = [];
  const sendMessageImpl = (message) => {
    if (message.action === "relayToContent") {
      relays.push(message);
      return Promise.resolve({ success: true, response: {} });
    }
    return Promise.resolve({ success: true });
  };
  return { relays, sendMessageImpl };
}

test("the panel names its own tab when it relays to the page", async () => {
  // A relay without a tab id may only reach the tab in front. The panel can
  // be open next to a tab the user is not looking at, and then the answer
  // comes from another video.
  const { relays, sendMessageImpl } = relayRecorder();
  const panel = createPanel({ sendMessageImpl });
  await waitForBoot(panel);

  panel.window.chrome.tabs.query = async () => [
    { id: 42, url: "https://www.youtube.com/watch?v=videoA" },
  ];
  await panel.helpers.checkCurrentTab();
  await flush();

  const videoInfo = relays.find(
    (message) => message.payload?.action === "getVideoInfo",
  );
  assert.ok(videoInfo, "the metadata never asked the page");
  assert.equal(
    videoInfo.tabId,
    42,
    "the metadata relay does not say which tab it is about",
  );
});

test("the playback clock names its own tab too", async () => {
  const { relays, sendMessageImpl } = relayRecorder();
  const panel = createPanel({ sendMessageImpl });
  await waitForBoot(panel);

  panel.window.chrome.tabs.query = async () => [
    { id: 7, url: "https://www.youtube.com/watch?v=videoA" },
  ];
  await panel.helpers.checkCurrentTab();
  relays.length = 0;

  // The direct message to the stored tab is refused, so the panel falls
  // back to the relay - which is where the tab id used to be dropped.
  panel.window.chrome.tabs.sendMessage = async () => {
    throw new Error("no receiving end");
  };
  await panel.helpers.refreshNotesCurrentTime();
  await flush();

  const clock = relays.find(
    (message) => message.payload?.action === "getCurrentTime",
  );
  assert.ok(clock, "the clock never asked the page");
  assert.equal(clock.tabId, 7, "the clock relay does not say which tab it is about");
});

test("nothing in the panel waits for a transcript progress message", async () => {
  // The worker used to narrate the transcript fetch. There is no sender any
  // more, so a listener for it is a branch that can never run.
  const source = read("sidepanel.js");
  assert.doesNotMatch(
    source,
    /transcriptProgress/,
    "the panel still listens for a message nobody sends",
  );
});

test("the video id is read from a Shorts and an embed page", () => {
  // The panel is the broader of the two halves: the page only puts a button
  // on a watch page, but a user can still reach the panel from a Shorts or
  // an embedded player.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  assert.equal(
    panel.helpers.extractVideoId("https://www.youtube.com/shorts/abc123XYZ"),
    "abc123XYZ",
  );
  assert.equal(
    panel.helpers.extractVideoId("https://www.youtube.com/embed/abc123XYZ"),
    "abc123XYZ",
  );
});

test("a refused language leaves the tick on the language on screen", async () => {
  // The row is a native radio group. aria-pressed is not read on a radio,
  // and the browser had already moved the tick to the button the user
  // pressed, so saying no to the price left the refused language ticked.
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await waitForBoot(panel);
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  await panel.click(panel.el("contentLanguageChinese"));
  await panel.click(panel.el("translationCostCancelBtn"));
  await flush();

  assert.equal(panel.el("contentLanguageOriginal").checked, true, "the original is not ticked");
  assert.equal(panel.el("contentLanguageChinese").checked, false, "the refused language is still ticked");
  assert.equal(
    panel.el("contentLanguageChinese").getAttribute("aria-pressed"),
    null,
    "a radio is still carrying aria-pressed",
  );
});

test("every row of a list is a list item", async () => {
  // The containers are <ul>. A div inside a <ul> is not a list item, and
  // Chrome reports the list without saying how many things are in it.
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      getVocabulary: {
        success: true,
        items: [{ id: "v1", term: "spaced repetition", translation: "间隔重复" }],
      },
    }),
    // A library entry is whatever the cache holds under a digest_ key.
    local: {
      digest_videoB: {
        videoTitle: "A video read before",
        channelName: "A channel",
        timestamp: Date.now() - 60_000,
        analysis: { summary: "read already" },
      },
    },
  });
  await waitForBoot(panel);
  await panel.helpers.loadVocabulary();

  // Each list is checked right after it is rendered: a later render on the
  // same screen replaces the rows, and a row that is gone cannot be checked.
  const rows = [];
  const collect = (selector, className) => {
    for (const row of panel.document.querySelectorAll(selector)) {
      if (row.classList.contains(className)) rows.push(row);
    }
  };

  collect("#wordsList > *", "word-item");

  panel.helpers.renderNotes(
    [
      {
        id: "n1",
        text: "a note",
        timestampSeconds: 30,
        timestampedUrl: "https://www.youtube.com/watch?v=videoA&t=30s",
        videoId: "videoA",
        videoTitle: "A talk",
      },
    ],
    null,
  );
  collect("#notesList > *", "note-item");

  panel.helpers.renderAnalysisResults({
    chapters: [],
    keyQuotes: [{ quote: "a line worth keeping", timestampSeconds: 12 }],
  });
  collect("#quotesList > *", "quote-item");

  await panel.helpers.loadLibrary();
  collect("#libraryList > *", "library-item");

  assert.equal(rows.length, 4, `not every list rendered a row: ${rows.length}`);
  for (const row of rows) {
    assert.equal(
      row.tagName,
      "LI",
      `${row.className} is a ${row.tagName}, not a list item`,
    );
  }
});

test("no list in the panel ever holds something that is not a list item", async () => {
  // The rows, the empty state, the loading state and the failure state are
  // four different renderers for the same <ul>, and every one of them has
  // to put a <li> in it. This walks the whole panel after each state, so a
  // renderer that goes back to a div or a p is caught wherever it is.
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      getVocabulary: { success: true, items: [] },
    }),
  });
  await waitForBoot(panel);

  const foreign = () =>
    [...panel.document.querySelectorAll("ul > *")]
      .filter((child) => child.tagName !== "LI")
      .map((child) => `${child.tagName}.${child.className}`);

  // The empty states: no words, no notes, no quotes, no library entries.
  panel.helpers.renderNotes([], null);
  panel.helpers.renderAnalysisResults({ chapters: [], keyQuotes: [] });
  panel.helpers.renderVocabulary();
  await panel.helpers.loadLibrary();
  assert.deepEqual(foreign(), [], "an empty state is not a list item");

  // The loading and failure states of the overview.
  panel.helpers.showState("results");
  panel.helpers.renderAnalysisFailure({ error: "NO_AI_KEY" });
  assert.deepEqual(foreign(), [], "a failure state is not a list item");

  // And with rows in them.
  panel.helpers.renderNotes(
    [{ id: "n1", text: "a note", timestampSeconds: 30, timestampedUrl: "u" }],
    null,
  );
  panel.helpers.renderAnalysisResults({
    chapters: [{ title: "c", summary: "s", timestampSeconds: 5 }],
    keyQuotes: [{ quote: "q", timestampSeconds: 12 }],
  });
  assert.deepEqual(foreign(), [], "a row is not a list item");
});

test("the transcript row and its timestamp are a list item with no inline paint", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await waitForBoot(panel);
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  const row = panel.el("transcriptList").querySelector(".transcript-entry");
  assert.ok(row, "the transcript did not render");
  assert.equal(row.tagName, "LI", "a transcript row is not a list item");

  const stamp = row.querySelector(".transcript-time");
  // An inline background wins over the stylesheet, so the chip the panel
  // paints every other timestamp with never reached this one.
  assert.doesNotMatch(
    stamp.getAttribute("style") || "",
    /background|text-align/,
    "the timestamp still paints itself inline",
  );
});

test("the summary price is read before the button, not after it", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await waitForBoot(panel);
  await panel.helpers.renderSummaryGate();

  const gate = panel.el("summaryGate");
  const cost = gate.querySelector(".summary-gate-cost");
  const button = panel.el("summaryGenerateBtn");
  assert.ok(cost, "the gate states no price");
  assert.equal(
    cost.nextElementSibling,
    button,
    "the price is not directly in front of the button it is about",
  );
});

test("the word card keeps the time in its own element", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      getVocabulary: {
        success: true,
        items: [
          {
            id: "v1",
            term: "spaced repetition",
            translation: "间隔重复",
            videoId: "videoA",
            videoTitle: "A talk",
            timestampSeconds: 90,
          },
        ],
      },
    }),
  });
  await waitForBoot(panel);
  await panel.helpers.loadVocabulary();

  const stamp = panel.el("wordsList").querySelector(".word-timestamp");
  assert.ok(stamp, "the time is still glued to the video title");
  assert.equal(stamp.textContent, "1:30", "the chip does not say the moment");
});

test("the price the user agrees to covers the summary and the notes too", async () => {
  // The question named the transcript's batches and left out the other two
  // screens. A user who agreed to "14 calls" was charged more than twenty
  // when they opened their own summary, and nothing asked them again.
  const calls = [];
  const router = workerRouter({
    analyzeTranscript: async () => {
      calls.push("analyze");
      return {
        success: true,
        analysis: {
          summary: "A summary the reader will want in Chinese.",
          chapters: [
            { title: "A chapter", summary: "A chapter summary", timestampSeconds: 1 },
          ],
          keyQuotes: [{ quote: "A quote", timestampSeconds: 2 }],
        },
      };
    },
    translateContent: async () => {
      calls.push("translate");
      return { success: true, translatedContent: { segments: [] } };
    },
  });
  const panel = createPanel({ sendMessageImpl: router });
  await waitForBoot(panel);
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();
  // The user asked for a summary, so there is a summary to translate. The
  // digest does not build one on its own: the summary is paid for, so it
  // waits for the button.
  await panel.helpers.triggerAnalysis();
  await flush();

  // The user picks Chinese and reads the number the panel is asking for.
  await panel.click(panel.el("contentLanguageChinese"));
  const modal = panel.el("translationCostModal");
  assert.ok(modal, "the switch started paying without asking");
  const stated = Number(
    (modal.textContent.match(/at least\s+(\d+)\s+times?/i) || [])[1],
  );
  assert.ok(stated > 0, `the question states no number of calls: ${modal.textContent}`);

  // The summary and the notes are translated by the same switch, so the
  // number has to be big enough to pay for them as well.
  await panel.click(panel.el("translationCostConfirmBtn"));
  await flush();
  await panel.helpers.switchTab("overview");
  await flush();
  await panel.helpers.switchTab("notes");
  await flush();

  const spent = calls.filter((call) => call === "translate").length;
  assert.ok(
    spent <= stated,
    `the panel asked for ${stated} calls and made ${spent}: the price it ` +
      `named did not cover the screens it then translated`,
  );
});

/**
 * The number of provider calls the price question names.
 */
function statedCalls(modal) {
  return Number((modal.textContent.match(/at least\s+(\d+)\s+times?/i) || [])[1]);
}

test("a summary that lands after the price was agreed to asks again", async () => {
  // The price the user agreed to was the price of what was on screen at
  // that moment: the transcript and the notes. The summary landed after
  // the question, and reading it took more calls than the number the
  // panel had stated - without a second question.
  const requests = [];
  const router = workerRouter({
    getNotes: {
      success: true,
      notes: [
        { id: "n1", text: "a note", timestampSeconds: 30, timestampedUrl: "u" },
      ],
    },
    analyzeTranscript: async () => ({
      success: true,
      analysis: {
        summary: "A summary the reader will want in Chinese.",
        chapters: [
          { title: "A chapter", summary: "A chapter summary", timestampSeconds: 1 },
          { title: "Another chapter", summary: "Another summary", timestampSeconds: 2 },
        ],
        keyQuotes: [
          { quote: "A quote", timestampSeconds: 3 },
          { quote: "Another quote", timestampSeconds: 4 },
        ],
      },
    }),
    translateContent: async (message) => {
      requests.push(message);
      return { success: true, translatedContent: { segments: [] } };
    },
  });
  const panel = createPanel({ sendMessageImpl: router });
  await waitForBoot(panel);
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  // The user picks Chinese and reads the number the panel is asking for.
  await panel.click(panel.el("contentLanguageChinese"));
  const first = panel.el("translationCostModal");
  assert.ok(first, "the switch started paying without asking");
  const agreed = statedCalls(first);
  assert.ok(
    agreed > 0,
    `the question states no number of calls: ${first.textContent}`,
  );
  await panel.click(panel.el("translationCostConfirmBtn"));
  await flush();
  assert.ok(
    requests.length <= agreed,
    `the panel spent ${requests.length} calls for a price of ${agreed}`,
  );

  // The summary lands AFTER the user agreed to the price.
  await panel.helpers.triggerAnalysis();
  await flush();

  // The user reads their own summary.
  await panel.helpers.switchTab("overview");
  await flush();

  const second = panel.el("translationCostModal");
  assert.ok(
    second,
    "the panel spent more than the user agreed to without asking again",
  );
  const extra = statedCalls(second);
  assert.ok(
    extra > 0,
    `the second question states no number of calls: ${second.textContent}`,
  );

  // Nothing was spent while the question was on screen.
  const spentBefore = requests.length;
  assert.ok(
    spentBefore <= agreed,
    `the panel spent ${spentBefore} calls for a price of ${agreed}`,
  );

  // The user says no to the extra calls.
  await panel.click(panel.el("translationCostCancelBtn"));
  await flush();
  assert.equal(
    requests.length,
    spentBefore,
    "the summary was paid for even though the user refused",
  );

  // The notes were in the first price, so they still translate - and they
  // do not push the panel past the number the user agreed to.
  await panel.helpers.switchTab("notes");
  await flush();
  assert.ok(
    requests.length <= agreed,
    `the panel spent ${requests.length} calls for a price of ${agreed}`,
  );
});

test("a word extraction without a provider key says the key is missing", async () => {
  // The worker answers "NO_AI_KEY" when there is no key. The panel turned
  // that into "no words could be read from this sentence", so a user
  // without a key went looking for a broken sentence while the sentence
  // was fine and the key was missing.
  const router = workerRouter({
    extractVocabulary: {
      success: false,
      error: "NO_AI_KEY",
      provider: "OpenAI",
    },
  });
  const panel = createPanel({ sendMessageImpl: router });
  await waitForBoot(panel);
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();

  // The browser measures a range to place the toolbar. jsdom does not.
  panel.window.Range.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
  });

  // The user selects a sentence in the transcript.
  const sentence = panel
    .el("transcriptList")
    .querySelector(".transcript-text")
    .firstChild;
  const range = panel.window.document.createRange();
  range.setStart(sentence, 0);
  range.setEnd(sentence, 5);
  const selection = panel.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  panel.window.document.dispatchEvent(
    new panel.window.MouseEvent("mouseup", { bubbles: true }),
  );
  await flush();

  const toolbar = panel.el("explainTooltip");
  assert.equal(
    toolbar.style.display,
    "flex",
    "the actions on the selection are not on screen",
  );

  // The user asks for the words of that sentence.
  await panel.click(toolbar.querySelector(".selection-word-btn"));
  await flush();

  const modal = panel.el("aiKeyNeededModal");
  assert.ok(modal, "the panel did not say that the key is missing");
  assert.doesNotMatch(
    modal.textContent,
    /no words could be read/i,
    "the panel blames the sentence instead of the key",
  );
  assert.match(
    modal.textContent,
    /key/i,
    "the panel does not say that a key is what is missing",
  );

  // The panel offers the way out, the same way the summary does.
  const settingsButton = modal.querySelector("#aiKeyNeededSettingsBtn");
  assert.ok(settingsButton, "the panel does not offer the way to add the key");
  assert.match(
    settingsButton.textContent,
    /settings/i,
    "the button does not say that it opens the settings",
  );

  await panel.click(settingsButton);
  await flush();
  assert.ok(
    panel.sentMessages.some((message) => message.action === "openOptions"),
    "the button does not open the settings",
  );
});
