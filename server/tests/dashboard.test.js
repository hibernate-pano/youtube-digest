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

  const data = options.data || {
    notes: NOTES,
    vocabulary: VOCABULARY,
    reviews: REVIEWS,
  };
  const calls = [];
  window.fetch = async (path, init) => {
    calls.push({ path, init });
    if (options.expired && path.includes("/api/me")) {
      // The token in localStorage is no longer accepted.
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: "Session expired." }),
      };
    }
    const body = path.includes("/api/me")
      ? { user: { login: "jasper-test", id: 1 } }
      : path.includes("/api/notes")
        ? { notes: data.notes, serverTime: "2026-10-20T00:00:00.000Z" }
        : path.includes("/api/vocabulary")
          ? { vocabulary: data.vocabulary, serverTime: "2026-10-20T00:00:00.000Z" }
          : path.includes("/api/reviews/due")
            ? { reviews: data.reviews }
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

  if (options.language) {
    Object.defineProperty(window.navigator, "language", {
      value: options.language,
      configurable: true,
    });
  }
  if (options.signedIn !== false) {
    window.localStorage.setItem("ytd_dashboard_token", "test.token");
  }
  if (options.storedLang) {
    window.localStorage.setItem("ytd_dashboard_lang", options.storedLang);
  }
  if (options.hash) {
    window.history.replaceState(null, "", options.hash);
  }
  if (options.pendingNonce) {
    // The nonce the page kept when the reader pressed "Sign in".
    window.sessionStorage.setItem("ytd_dashboard_login_nonce", options.pendingNonce);
  }

  window.eval(appJs);
  // A test can change the page before it starts, e.g. to take a copy key
  // away and prove that English takes over.
  if (options.beforeStart) options.beforeStart(window);
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
const tabLabels = (window) =>
  [...window.document.querySelectorAll(".tab")].map((tab) =>
    tab.textContent.trim(),
  );
const langButton = (window, language) =>
  window.document.querySelector(`#langSwitch .lang-btn[data-lang="${language}"]`);

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

// ============================================================
// LANGUAGE
// ============================================================
// A Chinese user who signs in to sync their notes lands on a web page. It
// has to speak their language, the way the side panel and the options page
// already do.

test("a Chinese browser gets a Chinese dashboard", async () => {
  const { window } = await bootDashboard({
    language: "zh-CN",
    data: { notes: [], vocabulary: [], reviews: [] },
  });
  assert.deepEqual(tabLabels(window), ["笔记", "收藏", "词汇", "复习"]);
  // The empty state is the copy a user reads first, so it is Chinese too.
  assert.equal($(window, "notesEmpty").hidden, false);
  assert.equal(
    $(window, "notesEmpty").textContent,
    "还没有笔记。看视频时在扩展里保存一条吧。",
  );
  // A screen reader has to know which language to pronounce.
  assert.equal(window.document.documentElement.lang, "zh-CN");
});

test("the loaded data is drawn in Chinese", async () => {
  const { window } = await bootDashboard({ language: "zh-CN" });
  const card = $(window, "notesList").querySelector(".card");
  assert.deepEqual(
    [...card.querySelectorAll(".del-btn")].map((button) => button.textContent),
    ["复制", "删除"],
  );
  // The star button says what it does, in the page's language.
  const star = card.querySelector(".star-btn");
  assert.equal(star.title, "取消收藏");
  assert.equal(star.getAttribute("aria-label"), "取消收藏");
  assert.match(card.querySelector(".card-meta").textContent, /保存于/);
  assert.equal($(window, "notesCount").textContent, "2 条笔记");
  assert.equal($(window, "vocabularyCount").textContent, "1 个词");
  assert.deepEqual(
    [...$(window, "vocabularyList").querySelectorAll("option")].map(
      (option) => option.textContent,
    ),
    ["学习中", "复习中", "已掌握"],
  );
  // The review card counts in Chinese too.
  $(window, "tab-review").click();
  await settle(window);
  assert.equal($(window, "reviewCount").textContent, "1 个待复习");
  assert.equal($(window, "dashReviewProgress").textContent, "第 1 / 1 张");
  assert.equal($(window, "dashReviewHint").textContent, "显示答案");
});

test("a link can ask for a language the browser does not use", async () => {
  const { window } = await bootDashboard({
    url: "https://ytd.example/?lang=zh-CN",
    language: "en",
    // Even a stored English choice loses to the link.
    storedLang: "en",
  });
  assert.deepEqual(tabLabels(window), ["笔记", "收藏", "词汇", "复习"]);
  assert.equal(window.document.documentElement.lang, "zh-CN");
  // The link's language is remembered for the next visit.
  assert.equal(window.localStorage.getItem("ytd_dashboard_lang"), "zh-CN");
});

test("a link can ask for English on a Chinese browser", async () => {
  const { window } = await bootDashboard({
    url: "https://ytd.example/?lang=en",
    language: "zh-CN",
  });
  assert.deepEqual(tabLabels(window), ["Notes", "Favorites", "Vocabulary", "Review"]);
  assert.equal(window.document.documentElement.lang, "en");
});

test("the language switcher redraws the page in place", async () => {
  const { window, calls } = await bootDashboard({ language: "en" });
  const list = $(window, "notesList");
  assert.equal($(window, "tab-notes").textContent.trim(), "Notes");
  const callsBefore = calls.length;

  langButton(window, "zh-CN").click();
  await settle(window);

  // The same page, redrawn: a reload would have replaced the document.
  assert.equal($(window, "notesList"), list);
  // The data was already here, so the switch did not ask the server again.
  assert.equal(calls.length, callsBefore);
  // The signed-in state survived the switch.
  assert.equal($(window, "userChip").hidden, false);
  assert.equal($(window, "signedOut").hidden, true);
  assert.equal($(window, "tabsNav").hidden, false);

  assert.equal($(window, "tab-notes").textContent.trim(), "笔记");
  assert.equal(window.document.documentElement.lang, "zh-CN");
  // The notes that were already on screen are drawn in the new language.
  const card = $(window, "notesList").querySelector(".card");
  assert.deepEqual(
    [...card.querySelectorAll(".del-btn")].map((button) => button.textContent),
    ["复制", "删除"],
  );
  assert.equal($(window, "notesCount").textContent, "2 条笔记");
  // The switcher says which language is on.
  assert.deepEqual(
    [...window.document.querySelectorAll("#langSwitch .lang-btn")].map((button) =>
      button.getAttribute("aria-pressed"),
    ),
    ["false", "true"],
  );
  assert.equal(window.localStorage.getItem("ytd_dashboard_lang"), "zh-CN");
});

test("a copy key that is missing falls back to English", async () => {
  const { window } = await bootDashboard({
    language: "zh-CN",
    beforeStart: (w) => {
      delete w.YTD_DASHBOARD.DASHBOARD_COPY["zh-CN"].tabNotes;
      // The markup says something else, so only the English table can put
      // the right word on screen.
      w.document
        .querySelector('#tab-notes [data-i18n="tabNotes"]')
        .textContent = "STALE MARKUP";
    },
  });
  // English takes over. The tab must never go blank.
  assert.equal($(window, "tab-notes").textContent.trim(), "Notes");
  assert.notEqual($(window, "tab-notes").textContent.trim(), "");
});

test("the language choice survives a reload", async () => {
  const { window } = await bootDashboard({ language: "en" });
  langButton(window, "zh-CN").click();
  await settle(window);
  const stored = window.localStorage.getItem("ytd_dashboard_lang");
  assert.equal(stored, "zh-CN");

  // A reload: a fresh document that keeps what the browser keeps. The
  // stored choice beats the browser's own preference.
  const reloaded = await bootDashboard({ storedLang: stored, language: "en" });
  assert.equal(reloaded.window.document.documentElement.lang, "zh-CN");
  assert.deepEqual(tabLabels(reloaded.window), ["笔记", "收藏", "词汇", "复习"]);
});

test("every string the dashboard shows exists in both languages", async () => {
  const { window } = await bootDashboard();
  const table = window.YTD_DASHBOARD.DASHBOARD_COPY;
  assert.deepEqual(
    Object.keys(table["zh-CN"]).sort(),
    Object.keys(table.en).sort(),
  );
  const keys = [
    ...html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(table.en[key], `Missing English copy for ${key}`);
    assert.ok(table["zh-CN"][key], `Missing Chinese copy for ${key}`);
  }
});

test("every page shows the product's mark in the browser tab", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dashboardDir = path.resolve(__dirname, "..", "dashboard");
  const icon = path.join(dashboardDir, "favicon.png");
  assert.ok(fs.existsSync(icon), "the favicon is missing");
  // It is the extension's own mark, so the tab looks like the product.
  const extensionIcon = path.resolve(
    __dirname,
    "..",
    "..",
    "icons",
    "icon48.png",
  );
  assert.deepEqual(fs.readFileSync(icon), fs.readFileSync(extensionIcon));

  for (const page of ["index.html", "privacy.html"]) {
    const markup = fs.readFileSync(path.join(dashboardDir, page), "utf8");
    assert.match(markup, /<link rel="icon" href="\/favicon\.png" \/>/);
  }
});

test("an expired session says so calmly and offers no retry that cannot work", async () => {
  const { window } = await bootDashboard({ expired: true });
  // The reader is signed out and the sign-in button is right there.
  assert.equal($(window, "signedOut").hidden, false);
  const status = $(window, "statusLine");
  assert.match(status.textContent, /Session expired/);
  // A retry cannot bring an expired session back, so there is none.
  assert.equal(status.querySelector("button"), null);
  // And it is not dressed up as a failure either.
  assert.equal(status.classList.contains("error"), false);
});

test("the sign-in link carries a nonce this page can recognize", async () => {
  const { window } = await bootDashboard({ signedIn: false });
  const link = window.document.querySelector('a[href^="/api/auth/login"]');
  assert.ok(link, "the signed-out page offers a sign-in link");
  let href = "";
  link.addEventListener("click", (event) => {
    // The page's own listener runs first, so the link already carries the
    // nonce by the time this one looks.
    href = link.getAttribute("href");
    event.preventDefault();
  });
  link.click();

  const nonce = window.sessionStorage.getItem("ytd_dashboard_login_nonce");
  assert.ok(nonce, "pressing sign-in leaves a nonce behind");
  assert.ok(nonce.length >= 16, "the nonce is long enough to be a nonce");
  assert.ok(
    href.includes("nonce=" + encodeURIComponent(nonce)),
    "the link carries the very nonce the page kept",
  );
  assert.ok(href.includes("redirect=/"), "the link still comes back here");
});

test("a token without this page's nonce is refused", async () => {
  const { window } = await bootDashboard({
    signedIn: false,
    hash: "https://ytd.example/#access_token=somebody-elses-token",
  });
  // The token is not ours, so it is not kept. Otherwise a link in a chat
  // message could sign the reader into another account.
  assert.equal(window.localStorage.getItem("ytd_dashboard_token"), null);
  assert.equal($(window, "signedOut").hidden, false);
  assert.match(
    $(window, "statusLine").textContent,
    /did not come from this page/,
  );
});

test("a token with this page's nonce is accepted and the nonce is spent", async () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  const { window } = await bootDashboard({
    signedIn: false,
    pendingNonce: nonce,
    hash:
      "https://ytd.example/#access_token=my-own-token&nonce=" + nonce,
  });
  assert.equal(window.localStorage.getItem("ytd_dashboard_token"), "my-own-token");
  // The nonce cannot be used twice.
  assert.equal(window.sessionStorage.getItem("ytd_dashboard_login_nonce"), null);
});

test("a refused sign-in keeps its message, and its lack of a retry, when the language changes", async () => {
  const { window } = await bootDashboard({
    signedIn: false,
    hash: "https://ytd.example/#access_token=forged-token",
  });
  const status = $(window, "statusLine");
  assert.match(status.textContent, /did not come from this page/);
  // A retry cannot make a refused sign-in accepted, so there is none.
  assert.equal(status.querySelector("button"), null);

  // The reader changes the language. The message has to be said again in
  // the new language - and it must not grow a retry button on the way.
  langButton(window, "zh-CN").click();
  await settle(window);
  assert.match(status.textContent, /不是从本页面发起的/);
  assert.equal(status.querySelector("button"), null);
});
