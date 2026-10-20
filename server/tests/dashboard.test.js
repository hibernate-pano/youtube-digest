const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const dashboardDir = path.resolve(__dirname, "..", "dashboard");
const html = fs.readFileSync(path.join(dashboardDir, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(dashboardDir, "app.js"), "utf8");

const NOTES = [
  {
    id: "n1",
    clientId: "c1",
    starred: true,
    videoId: "dQw4w9WgXcQ",
    videoTitle: "How to build a habit that actually sticks",
    channelName: "Learning Lab",
    timestampSeconds: 135,
    quote: "",
    note: "The system beats the motivation.",
    createdAt: "2026-10-18T09:12:00Z",
    updatedAt: "2026-10-18T09:12:00Z",
  },
  {
    id: "n2",
    clientId: "c2",
    starred: false,
    videoId: "aBc123XyZ00",
    videoTitle: "",
    channelName: "",
    timestampSeconds: 0,
    quote: "",
    note: "A note with no title and no channel.",
    createdAt: "2026-10-19T10:00:00Z",
    updatedAt: "2026-10-19T10:00:00Z",
  },
];

const VOCABULARY = [
  {
    id: "v1",
    term: "habit",
    translation: "习惯",
    sentence: "A system is a climate.",
    sentenceTranslation: "系统是气候。",
    videoId: "dQw4w9WgXcQ",
    videoTitle: "How to build a habit that actually sticks",
    timestampSeconds: 135,
    status: "learning",
    createdAt: "2026-10-19T10:05:00Z",
    updatedAt: "2026-10-19T10:05:00Z",
  },
];

const REVIEWS = [
  {
    id: "r1",
    vocabularyId: "v1",
    dueAt: "2026-10-19T00:00:00Z",
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    vocabulary: VOCABULARY[0],
  },
];

/**
 * Boots the real dashboard in a real DOM.
 *
 * The dashboard used to have no tests at all, which is how it shipped a bug
 * where all four tab panels were rendered at once under a tab bar that
 * claimed one of them was selected. These tests drive the real app.js in
 * jsdom, so they fail when the behaviour breaks rather than when the source
 * text changes shape.
 */
async function bootDashboard(options = {}) {
  const dom = new JSDOM(html, {
    url: options.url || "https://ytd.example/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const calls = [];
  window.fetch = async (path, init) => {
    calls.push({ path, init });
    const body = path.includes("/api/me")
      ? { user: { login: "jasper-test", id: 1 } }
      : path.includes("/api/notes")
        ? { notes: NOTES, serverTime: "2026-10-20T00:00:00.000Z" }
        : path.includes("/api/vocabulary")
          ? { vocabulary: VOCABULARY, serverTime: "2026-10-20T00:00:00.000Z" }
          : path.includes("/api/reviews/due")
            ? { reviews: REVIEWS }
            : {};
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
  window.confirm = () => true;
  window.navigator.clipboard = { writeText: async () => {} };
  window.URL.createObjectURL = () => "blob:stub";
  window.URL.revokeObjectURL = () => {};

  if (options.signedIn !== false) {
    window.localStorage.setItem("ytd_dashboard_token", "test.token");
  }
  if (options.hash) {
    window.history.replaceState(null, "", options.hash);
  }

  window.eval(appJs);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await settle(window);
  return { dom, window, calls };
}

/** Lets the dashboard's promise chains finish. */
async function settle(window, turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

const $ = (window, id) => window.document.getElementById(id);
const visiblePanels = (window) =>
  ["notesPanel", "favoritesPanel", "vocabularyPanel", "reviewPanel"].filter(
    (id) => !$(window, id).hidden,
  );

test("signing in shows one tab panel, not all four", async () => {
  const { window } = await bootDashboard();
  // The tab bar says "Notes" is selected. Only the Notes panel may be on
  // screen; stacking the other three under a selected "Notes" tab made the
  // tab bar a lie.
  assert.deepEqual(visiblePanels(window), ["notesPanel"]);
  assert.equal($(window, "tabsNav").hidden, false);
  assert.equal($(window, "signedOut").hidden, true);
});

test("the tab bar carries the ARIA tabs pattern", async () => {
  const { window } = await bootDashboard();
  const tabs = [...window.document.querySelectorAll(".tab")];
  assert.equal($(window, "tabsNav").getAttribute("role"), "tablist");
  assert.ok($(window, "tabsNav").getAttribute("aria-label"));
  for (const tab of tabs) {
    assert.equal(tab.getAttribute("role"), "tab");
    assert.equal(tab.getAttribute("aria-controls"), tab.dataset.tab + "Panel");
  }
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute("aria-selected")),
    ["true", "false", "false", "false"],
  );
  // Only the selected tab stays in the tab order.
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute("tabindex")),
    ["0", "-1", "-1", "-1"],
  );
  for (const id of ["notesPanel", "favoritesPanel", "vocabularyPanel", "reviewPanel"]) {
    assert.equal($(window, id).getAttribute("role"), "tabpanel");
  }
});

test("clicking a tab swaps the visible panel and the selection", async () => {
  const { window } = await bootDashboard();
  $(window, "tab-review").click();
  await settle(window);
  assert.deepEqual(visiblePanels(window), ["reviewPanel"]);
  assert.deepEqual(
    [...window.document.querySelectorAll(".tab")].map((tab) =>
      tab.getAttribute("aria-selected"),
    ),
    ["false", "false", "false", "true"],
  );
  assert.deepEqual(
    [...window.document.querySelectorAll(".tab")].map((tab) =>
      tab.getAttribute("tabindex"),
    ),
    ["-1", "-1", "-1", "0"],
  );
});

test("arrow keys move the tab stop without switching the panel", async () => {
  const { window } = await bootDashboard();
  const tabs = [...window.document.querySelectorAll(".tab")];
  tabs[0].focus();
  tabs[0].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  assert.equal(window.document.activeElement, tabs[1]);
  // Focus moved, but the panel did not: the user activates a tab explicitly.
  assert.deepEqual(visiblePanels(window), ["notesPanel"]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].getAttribute("tabindex"), "0");
});

test("the review answer can be revealed with the keyboard", async () => {
  const { window } = await bootDashboard();
  $(window, "tab-review").click();
  await settle(window);

  const card = $(window, "reviewCard");
  // It has to be a real control: the answer is behind it, so a div with a
  // click handler locked keyboard and screen reader users out of the review.
  assert.equal(card.tagName, "BUTTON");
  assert.equal(card.getAttribute("aria-expanded"), "false");
  assert.equal($(window, "dashReviewTranslation").hidden, true);

  card.focus();
  card.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  card.click();

  assert.equal(card.getAttribute("aria-expanded"), "true");
  assert.equal($(window, "dashReviewTranslation").hidden, false);
  assert.equal($(window, "dashReviewTranslation").textContent, "习惯");
  // The hint that says what the card does disappears once it has been done.
  assert.equal($(window, "dashReviewHint").hidden, true);
});

test("the review card says what it does before it is clicked", async () => {
  const { window } = await bootDashboard();
  $(window, "tab-review").click();
  await settle(window);
  assert.equal($(window, "dashReviewHint").hidden, false);
  assert.match($(window, "dashReviewHint").textContent, /\S/);
});

test("a saved word shows a readable status, not the raw database value", async () => {
  const { window } = await bootDashboard();
  const options = [...$(window, "vocabularyList").querySelectorAll("option")];
  assert.deepEqual(
    options.map((option) => option.textContent),
    ["Learning", "Reviewing", "Mastered"],
  );
  // The value the server stores is still the enum.
  assert.deepEqual(
    options.map((option) => option.value),
    ["learning", "reviewing", "mastered"],
  );
});

test("a note shows the channel, not the raw video id", async () => {
  const { window } = await bootDashboard();
  const cards = [...$(window, "notesList").querySelectorAll(".card")];
  assert.equal(cards.length, 2);
  const meta = cards[0].querySelector(".card-meta").textContent;
  assert.match(meta, /Learning Lab/);
  assert.doesNotMatch(meta, /dQw4w9WgXcQ/);
  // A note with no channel and no title still renders, with just the date.
  const bare = cards[1].querySelector(".card-meta").textContent;
  assert.doesNotMatch(bare, /aBc123XyZ00/);
});

test("signing out returns the page to the signed-out state", async () => {
  const { window } = await bootDashboard();
  $(window, "logoutBtn").click();
  await settle(window);
  assert.equal($(window, "signedOut").hidden, false);
  assert.equal($(window, "tabsNav").hidden, true);
  assert.equal(window.localStorage.getItem("ytd_dashboard_token"), null);
});
