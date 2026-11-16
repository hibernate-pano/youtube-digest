const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPanel,
  workerRouter,
  flush,
} = require("./helpers/panel-harness.js");

/**
 * A transcript of `count` sentences.
 *
 * The panel groups the captions into sentences, so a caption that is a
 * whole sentence of its own is a row of the transcript. A caption of three
 * words would be swallowed by the sentence before it.
 */
function transcriptOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    text: `This is caption number ${index} and it is long enough to be a sentence of its own.`,
    start: index * 3,
    duration: 3,
    language: "en",
  }));
}

/**
 * A notebook of `count` words.
 */
function vocabularyOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `word-${index}`,
    term: `term${index}`,
    translation: `meaning ${index}`,
    status: "learning",
    videoId: "videoA",
    videoTitle: "A video",
    timestampSeconds: index,
  }));
}

/**
 * A panel with a transcript of `count` rows on the screen.
 */
async function panelWithTranscript(count, worker = {}) {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      fetchTranscript: () => ({
        success: true,
        transcript: transcriptOf(count),
        transcriptText: "a transcript",
        transcriptTextTimestamped: "[0:00] a transcript",
        language: "en",
      }),
      ...worker,
    }),
  });
  // jsdom has no layout, so it has no scrollIntoView. The browser the
  // panel ships to has one; this stub only stands in for it.
  panel.window.Element.prototype.scrollIntoView = () => {};
  await panel.boot();
  await panel.helpers.startDigest(
    "videoA",
    "https://www.youtube.com/watch?v=videoA",
  );
  await flush();
  return panel;
}

/**
 * Types a word into the transcript search and lets the typing settle.
 */
async function search(panel, query) {
  const input = panel.el("transcriptSearchInput");
  input.value = query;
  input.dispatchEvent(new panel.window.Event("input", { bubbles: true }));
  panel.clock.advance(300);
  await flush();
}

// ============================================================
// D1 - the transcript is drawn a window at a time
// ============================================================

test("a transcript of three thousand rows does not build a page of three thousand rows", async () => {
  const panel = await panelWithTranscript(3000);

  const rows = panel.all("#transcriptList .transcript-entry");
  assert.ok(rows.length > 0, "the transcript is on the screen");
  assert.ok(
    rows.length < 300,
    `the list drew ${rows.length} rows of the three thousand it has`,
  );

  // The old list built one set of nodes for every row: three thousand rows
  // are nine thousand nodes. A list that is drawn a window at a time holds
  // a few dozen rows, so its page is a fraction of that.
  const nodes = panel.el("transcriptList").querySelectorAll("*").length;
  assert.ok(
    nodes < 1000,
    `the list built ${nodes} nodes for three thousand rows`,
  );

  // The rows are not lost: the panel still knows all of them.
  await search(panel, "caption");
  assert.match(
    panel.el("transcriptSearchCount").textContent,
    /3000 found/,
    "the panel does not know about the rows that are not on the screen",
  );
});

test("the transcript window follows the reader", async () => {
  const panel = await panelWithTranscript(3000);
  const first = panel.all("#transcriptList .transcript-entry")[0];
  assert.equal(first.dataset.seconds, "0", "the list does not start at the top");

  const area = panel.el("contentArea");
  area.scrollTop = 6000;
  area.dispatchEvent(new panel.window.Event("scroll"));
  await flush();

  const rows = panel.all("#transcriptList .transcript-entry");
  assert.ok(rows.length > 0, "the list is empty after the scroll");
  assert.notEqual(
    rows[0].dataset.seconds,
    "0",
    "the window did not follow the reader",
  );
  assert.ok(
    rows.length < 300,
    `the list drew ${rows.length} rows after the scroll`,
  );
});

test("the search reads the words that are on the screen again", async () => {
  const panel = await panelWithTranscript(3000, {
    translateContent: (message) => ({
      success: true,
      translatedContent: {
        segments: message.content.segments.map((segment) => ({
          id: segment.id,
          text: "译文",
        })),
      },
    }),
  });

  await search(panel, "caption");
  assert.match(
    panel.el("transcriptSearchCount").textContent,
    /3000 found/,
    "the word is not in the transcript",
  );

  // The reader reads the video in Chinese. The rows say something else
  // now, and the word is not in what they say.
  await panel.helpers.handleDisplayLanguageModeChange("zh");
  await flush();
  assert.doesNotMatch(
    panel.el("transcriptSearchCount").textContent,
    /3000 found/,
    "the search still counts the words of the language that went away",
  );

  // The reader goes back to the original language. The words are the
  // original words again, so the search has to find them again.
  await panel.helpers.handleDisplayLanguageModeChange("original");
  await flush();
  assert.match(
    panel.el("transcriptSearchCount").textContent,
    /3000 found/,
    "the search kept the answer of the language that went away",
  );
});

// ============================================================
// D4 - the word notebook is drawn a window at a time
// ============================================================

test("five hundred word cards do not build a page of five hundred cards", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      getVocabulary: () => ({ success: true, items: vocabularyOf(500) }),
    }),
  });
  panel.window.Element.prototype.scrollIntoView = () => {};
  await panel.boot();
  await panel.helpers.loadVocabulary();
  await flush();

  const cards = panel.all("#wordsList .word-item");
  assert.ok(cards.length > 0, "the notebook is on the screen");
  assert.ok(
    cards.length < 100,
    `the notebook drew ${cards.length} cards of the five hundred it has`,
  );

  // The old notebook built every card: five hundred cards are thousands of
  // nodes, and the panel that draws them is the panel the reader waits for.
  const nodes = panel.el("wordsList").querySelectorAll("*").length;
  assert.ok(
    nodes < 1000,
    `the notebook built ${nodes} nodes for five hundred cards`,
  );
});

// ============================================================
// D2 - the search waits for the typing, and says what it did
// ============================================================

test("the transcript is searched once the typing has settled", async () => {
  const panel = await panelWithTranscript(3000);
  panel.helpers.resetTranscriptWork();

  const input = panel.el("transcriptSearchInput");
  input.value = "caption";
  input.dispatchEvent(new panel.window.Event("input", { bubbles: true }));

  // The reader is still typing, so the transcript is not read yet.
  assert.equal(
    panel.helpers.getTranscriptWork().searchScans,
    0,
    "the transcript was searched while the reader was still typing",
  );

  panel.clock.advance(300);
  await flush();

  assert.equal(
    panel.helpers.getTranscriptWork().searchScans,
    1,
    "the transcript was searched more than once for one settled word",
  );
});

test("the same word is not looked for twice", async () => {
  const panel = await panelWithTranscript(3000);
  await search(panel, "caption");
  const afterSearch = panel.helpers.getTranscriptWork().searchScans;

  // The transcript is drawn again, and the words have not changed, so the
  // answer is the one that is already known.
  panel.helpers.renderTranscript();
  await flush();

  assert.equal(
    panel.helpers.getTranscriptWork().searchScans,
    afterSearch,
    "the transcript was searched again for the same word",
  );
});

test("the matches are capped, and the count says how many there are", async () => {
  const panel = await panelWithTranscript(3000);
  await search(panel, "caption");

  // Fifteen thousand marks are fifteen thousand pieces of the page. The
  // marks that are drawn are a few hundred at most.
  const marks = panel.all("#transcriptList mark.transcript-search-highlight");
  assert.ok(
    marks.length < 1000,
    `the panel drew ${marks.length} marks for one word`,
  );

  // The count is honest: it says how many were shown and how many there
  // are.
  const count = panel.el("transcriptSearchCount").textContent;
  assert.match(count, /500/, "the count does not say how many were shown");
  assert.match(count, /3000/, "the count does not say how many there are");
});

test("a search finds a word that is not on the screen", async () => {
  const panel = await panelWithTranscript(3000);
  await search(panel, "2999");

  assert.match(
    panel.el("transcriptSearchCount").textContent,
    /1 of 1/,
    "the word in the last row was not found",
  );

  const marks = panel.all("#transcriptList mark.transcript-search-highlight");
  assert.equal(marks.length, 1, "the word in the last row was not marked");
  assert.equal(marks[0].textContent, "2999");
  assert.equal(
    marks[0].closest(".transcript-entry").dataset.seconds,
    String(2999 * 3),
    "the reader was not brought to the word",
  );
});

// ============================================================
// D3 - the caret walks the rows it needs and not the whole list
// ============================================================

test("the caret reads the rows it walks and not the whole transcript", async () => {
  const panel = await panelWithTranscript(3000);
  const list = panel.el("transcriptList");
  list.focus();
  panel.helpers.resetTranscriptWork();

  const press = () =>
    list.dispatchEvent(
      new panel.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

  press();
  press();

  const work = panel.helpers.getTranscriptWork();
  assert.ok(
    work.rowListBuilds <= 1,
    `the list of rows was built ${work.rowListBuilds} times for two key presses`,
  );
  assert.ok(
    work.rowsListed <= 4,
    `the caret read ${work.rowsListed} rows of the three thousand it has`,
  );
  assert.equal(
    panel.window.getSelection().toString().length,
    2,
    "the selection did not grow",
  );
});

test("the caret walks past the first screenful while a selection grows", async () => {
  const panel = await panelWithTranscript(3000);
  const list = panel.el("transcriptList");
  list.focus();

  const press = () =>
    list.dispatchEvent(
      new panel.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

  // The reader holds the shift key and walks down the talk. A screenful
  // is ninety rows, so the caret has to leave it behind.
  for (let index = 0; index < 120; index += 1) press();

  const selection = panel.window.getSelection();
  const caretRow =
    selection.focusNode?.parentElement?.closest?.(".transcript-entry")
      ?.dataset.rowIndex;
  assert.ok(
    Number(caretRow) >= 100,
    `the caret stopped at row ${caretRow} of the hundred and twenty the reader walked`,
  );
  assert.ok(
    (selection.toString() || "").length > 100,
    "the selection the reader made is gone",
  );
});

// ============================================================
// The features the window must not break
// ============================================================

test("the playback highlight lands on the row that is being spoken", async () => {
  const panel = await panelWithTranscript(3000);
  panel.helpers.highlightActiveEntry(300 * 3);

  const active = panel.all("#transcriptList .transcript-entry.active-playback");
  assert.equal(active.length, 1, "the row that is spoken is not marked");
  assert.equal(
    active[0].dataset.seconds,
    String(300 * 3),
    "the wrong row is marked",
  );
});

test("the playback mark leaves the row that is no longer spoken", async () => {
  const panel = await panelWithTranscript(3000);

  // The reader looked for a word, so the panel stopped following the
  // playback and left the reader where they are.
  await search(panel, "caption");

  panel.helpers.highlightActiveEntry(0);
  assert.equal(
    panel.all(".transcript-entry.active-playback").length,
    1,
    "the row that is spoken is not marked",
  );

  // The video goes on, and the row that is spoken now is not on the
  // screen. The panel does not pull the reader there, because the reader
  // is not following the playback. The mark still has to follow the video.
  panel.helpers.highlightActiveEntry(300 * 3);
  assert.equal(
    panel.all(".transcript-entry.active-playback").length,
    0,
    "the row that is no longer spoken is still marked",
  );

  // The reader scrolls to the row that is being spoken, and the mark is
  // waiting for them there.
  const area = panel.el("contentArea");
  area.scrollTop = 300 * 68;
  area.dispatchEvent(new panel.window.Event("scroll"));
  await flush();

  const active = panel.all(".transcript-entry.active-playback");
  assert.equal(active.length, 1, "the row that is spoken is not marked");
  assert.equal(
    active[0].dataset.seconds,
    String(300 * 3),
    "the wrong row is marked",
  );
});

// ============================================================
// D5 - the cache is dropped by its size as well
// ============================================================

test("the cache is dropped by its size and not only by its age", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });

  // Twenty digests of a three hour talk are twenty-two megabytes of store.
  const entries = {};
  const now = Date.now();
  for (let index = 0; index < 20; index += 1) {
    entries[`video${index}`] = {
      key: `digest_video${index}`,
      timestamp: now - (20 - index) * 1000,
      bytes: 1_200_000,
    };
  }
  await panel.helpers.writeDigestCacheIndex(entries);

  await panel.helpers.evictOldCacheEntries(20);

  const index = await panel.helpers.readDigestCacheIndex();
  const bytes = Object.values(index).reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  assert.ok(
    bytes <= 10 * 1024 * 1024,
    `the cache still takes ${bytes} bytes after the cleanup`,
  );
  assert.ok(
    Object.keys(index).length < 20,
    "not one digest was dropped, and the cache is still too big",
  );
  assert.ok(index.video19, "the newest digest was dropped instead of the oldest");
  assert.ok(!index.video0, "the oldest digest was kept");
});

test("a digest that is written says how much room it takes", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  const digest = {
    analysis: null,
    transcript: transcriptOf(50),
    transcriptText: "a transcript",
    timestamp: Date.now(),
  };

  const written = await panel.helpers.writeDigestCache("videoA", digest);
  assert.equal(written, true, "the digest did not make it into the store");

  const index = await panel.helpers.readDigestCacheIndex();
  assert.ok(index.videoA, "the digest is not in the index");
  assert.ok(
    index.videoA.bytes > 0,
    "the index does not say how much room the digest takes",
  );
});

// ============================================================
// D6 - the count reads the index and not every digest
// ============================================================

test("the welcome count reads the index and not every cached digest", async () => {
  const panel = createPanel({ sendMessageImpl: workerRouter() });
  await panel.helpers.writeDigestCacheIndex({
    videoA: { key: "digest_videoA", timestamp: Date.now(), bytes: 10 },
    videoB: { key: "digest_videoB", timestamp: Date.now(), bytes: 10 },
  });

  // Every read of the store is watched. Reading everything to count two
  // numbers is what the panel used to do, and a digest of a three hour talk
  // is a megabyte or two.
  const reads = [];
  const originalGet = panel.storage.local.get;
  panel.storage.local.get = async (keys) => {
    reads.push(keys);
    return originalGet.call(panel.storage.local, keys);
  };

  await panel.helpers.updateWelcomeCounts();

  assert.equal(
    reads.filter((keys) => keys === null).length,
    0,
    "the whole store was read to count the cached digests",
  );
  assert.equal(
    panel.el("welcomeLibraryCount").textContent,
    "(2)",
    "the count of the cached digests is wrong",
  );
});

// ============================================================
// D7 - the sign-out asks before it takes the account's items away
// ============================================================

/**
 * How many times the panel has been told to sign out.
 */
function logoutCount(panel) {
  return panel.sentMessages.filter(
    (message) => message.action === "logoutGithub",
  ).length;
}

test("the sign-out asks about the items that only exist on this device", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      getGithubSession: () => ({
        success: true,
        session: { login: "reader", githubId: "1001", savedAt: Date.now() },
      }),
    }),
    local: {
      ytd_github_session: { token: "t", githubId: "1001", login: "reader" },
      // A note that never reached the account, and a word that did.
      ytd_notes_1001: [{ id: "n1", text: "a note", cloudId: null }],
      ytd_vocabulary_1001: [{ id: "w1", term: "a word", cloudId: "c1" }],
    },
  });
  await panel.boot();
  await flush();

  const before = logoutCount(panel);
  await panel.click(panel.el("syncAccount"));
  await flush();

  assert.equal(
    logoutCount(panel),
    before,
    "the panel signed out without asking",
  );

  const modal = panel.el("signOutUnsyncedModal");
  assert.ok(modal, "the panel did not ask about the note");
  assert.match(
    modal.textContent,
    /1 note/,
    "the question does not say what is only on this device",
  );

  await panel.click(panel.el("signOutUnsyncedConfirmBtn"));
  await flush();

  assert.ok(
    logoutCount(panel) > before,
    "the panel did not sign out after the reader agreed",
  );
});

test("the sign-out does not ask when everything reached the account", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      getGithubSession: () => ({
        success: true,
        session: { login: "reader", githubId: "1001", savedAt: Date.now() },
      }),
    }),
    local: {
      ytd_github_session: { token: "t", githubId: "1001", login: "reader" },
      ytd_notes_1001: [{ id: "n1", text: "a note", cloudId: "c1" }],
      ytd_vocabulary_1001: [{ id: "w1", term: "a word", cloudId: "c1" }],
    },
  });
  await panel.boot();
  await flush();

  const before = logoutCount(panel);
  await panel.click(panel.el("syncAccount"));
  await flush();

  assert.ok(logoutCount(panel) > before, "the panel did not sign out");
  assert.equal(
    panel.el("signOutUnsyncedModal"),
    null,
    "the panel asked a question it had no reason to ask",
  );
});
