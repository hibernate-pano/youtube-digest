const test = require("node:test");
const assert = require("node:assert/strict");
const { createPanel, flush, read, workerRouter } = require("./helpers/panel-harness.js");

/* ============================================================
   The copy has to agree with the number.

   English does not let a writer say "1 entries". A panel that says it
   looks like a machine talking to itself, and the count is the one thing
   the user cannot argue with: the panel told them it removed three
   entries and then wrote "1 entries". The words are checked here
   because they are what the user reads, not because a string is nicer.
   ============================================================ */

async function libraryNotice(count) {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: { ytd_library_cleanup: { count, removedAt: Date.now() } },
  });
  await panel.helpers.loadLibrary();
  await flush();
  return panel.el("libraryCleanup");
}

test("the library says one entry in the singular", async () => {
  const notice = await libraryNotice(1);
  assert.equal(notice.hidden, false, "the cleanup is not on screen");
  assert.match(notice.textContent, /\b1 entry\b/, "one entry is not plural");
  assert.doesNotMatch(notice.textContent, /entries/, "one entry is not plural");
});

test("the library says many entries in the plural", async () => {
  const notice = await libraryNotice(3);
  assert.match(notice.textContent, /\b3 entries\b/, "three entries are plural");
});

test("the note store says one note in the singular", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: { ytd_notes_dropped: { total: 1, lastCount: 1, lastAt: Date.now() } },
  });
  await panel.helpers.loadNotesDroppedNotice();
  await flush();
  const notice = panel.el("notesDroppedNotice");
  assert.equal(notice.hidden, false, "the drop is not on screen");
  assert.match(notice.textContent, /\b1 older note\b/, "one note is not plural");
  assert.doesNotMatch(notice.textContent, /older notes\b/, "one note is not plural");
});

test("the note store says many notes in the plural", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter(),
    local: { ytd_notes_dropped: { total: 2, lastCount: 2, lastAt: Date.now() } },
  });
  await panel.helpers.loadNotesDroppedNotice();
  await flush();
  const notice = panel.el("notesDroppedNotice");
  assert.match(notice.textContent, /\b2 older notes\b/, "two notes are plural");
});

test("the copy table has no bracket in it", () => {
  // "note(s)" was the old way of saying this. It is not English, and it
  // tells the reader that nobody decided what the sentence says.
  const source = read("sidepanel.js");
  const table = source.match(/const PANEL_COPY = \{[\s\S]*?\n\};/);
  assert.ok(table, "the panel needs a copy table");
  const english = table[0].split('"zh-CN":')[0];
  assert.doesNotMatch(
    english,
    /\(s\)/,
    "the English copy still hedges its own number instead of agreeing with it",
  );
});

test("no sentence in the copy table is written twice", () => {
  // A key that appears twice is a key that was renamed once and the old
  // name was left behind. The reader sees the second one; the first one
  // is a sentence nobody chose, and a translator has to guess what it
  // was for.
  const source = read("sidepanel.js");
  const table = source.match(/const PANEL_COPY = \{[\s\S]*?\n\};/);
  assert.ok(table, "the panel needs a copy table");
  const blocks = [
    ["English", table[0].split('"zh-CN":')[0]],
    ["Chinese", table[0].split('"zh-CN":')[1]],
  ];
  for (const [language, block] of blocks) {
    const keys = [...block.matchAll(/^ {4}([A-Za-z0-9]+):/gm)].map((match) => match[1]);
    const twice = keys.filter((key, index) => keys.indexOf(key) !== index);
    assert.deepEqual(
      twice,
      [],
      `the ${language} copy table says ${twice.join(", ")} twice`,
    );
  }
});

/* ============================================================
   The note composer has to say where the note will land.

   It used to say "Play from 0:42" — a phrase borrowed from the button
   that plays a note — next to a Save button, with no way to press
   play. The reader was told about a control that was not there.
   ============================================================ */

test("the composer says where the note will land", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      relayToContent: {
        success: true,
        response: { currentTime: 92 },
      },
    }),
  });
  panel.helpers.setCurrentVideo("abc123xyz", "https://www.youtube.com/watch?v=abc123xyz");
  await panel.helpers.refreshNotesCurrentTime();
  await flush();

  const label = panel.el("notesCurrentTime");
  assert.match(label.textContent, /1:32/, "the label does not show the moment");
  assert.doesNotMatch(
    label.textContent,
    /Play from/i,
    "the composer promised a play button that is not there",
  );
  assert.equal(
    label.classList.contains("is-warning"),
    false,
    "a moment that was read is not a warning",
  );
});

test("the composer says so when it cannot read the moment", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      relayToContent: { success: false },
    }),
  });
  panel.helpers.setCurrentVideo("abc123xyz", "https://www.youtube.com/watch?v=abc123xyz");
  await panel.helpers.refreshNotesCurrentTime();
  await flush();

  const label = panel.el("notesCurrentTime");
  assert.match(label.textContent, /start of the video/i, "the fallback is not explained");
  assert.equal(
    label.classList.contains("is-warning"),
    true,
    "a note that lands in the wrong place is said in the tone of a warning",
  );
});
