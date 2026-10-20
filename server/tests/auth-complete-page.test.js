const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const worker = require("../src/index");
const { MemoryStore } = require("../src/db");

const dashboardDir = path.resolve(__dirname, "..", "dashboard");
const authJs = fs.readFileSync(path.join(dashboardDir, "auth-complete.js"), "utf8");

/**
 * Renders the real sign-in landing page.
 *
 * The page is not a file: the Worker builds it, so that the language it
 * greets the reader with can be decided on the server. The tests use the
 * Worker itself instead of a copy of the markup, so a change to the page
 * cannot leave the tests behind.
 *
 * A language can reach the server in two ways. An explicit one travels in
 * the query string, the way the extension asks for it. An implicit one is
 * only the browser's preference, and the server asks the browser for it.
 */
async function renderPage(lang, { implicit = false } = {}) {
  const env = {
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    JWT_SECRET: "test-" + "secret-0123456789abcdef-0123456789",
    DATABASE_URL: "",
    store: new MemoryStore(),
  };
  const url = "https://ytd.example/auth/complete";
  const request = implicit
    ? new Request(url, { headers: { "accept-language": lang } })
    : new Request(url + (lang ? "?lang=" + lang : ""));
  const response = await worker.fetch(request, env);
  return response.text();
}

async function settle(window, turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

/**
 * Boots the landing page in a real DOM.
 *
 * The page loads only same-origin files, so the script is the real one and
 * the document is the real markup. A reader who lands on the wrong
 * language must be able to switch without leaving the page.
 */
async function bootPage(options = {}) {
  const html = await renderPage(options.serverLang, { implicit: options.implicit });
  // The browser lands on the URL the server sent the reader to, so the
  // query is the same one the server was asked with.
  const query = options.implicit
    ? ""
    : options.serverLang
      ? "?lang=" + options.serverLang
      : "";
  const dom = new JSDOM(html, {
    url: options.url || "https://ytd.example/auth/complete" + query,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  if (options.language) {
    Object.defineProperty(window.navigator, "language", {
      value: options.language,
      configurable: true,
    });
  }
  if (options.storedLang) {
    window.localStorage.setItem("ytd_dashboard_lang", options.storedLang);
  }

  window.eval(authJs);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await settle(window);
  return { dom, window };
}

const text = (window) => window.document.body.textContent;

test("the sign-in page greets the reader in the language the server chose", async () => {
  const { window } = await bootPage({ serverLang: "zh-CN" });
  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.match(text(window), /已用 GitHub 登录/);
  assert.match(text(window), /你可以关掉这个标签页/);
  assert.doesNotMatch(text(window), /Signed in to GitHub/);
});

test("the sign-in page keeps the language the server rendered", async () => {
  // The server rendered the page in the browser's language. The script
  // must not send the reader back to a different one, even though the
  // browser's own language is a second opinion.
  const { window } = await bootPage({ serverLang: "zh-CN", implicit: true });
  assert.equal(window.navigator.language, "en-US");
  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.match(text(window), /已用 GitHub 登录/);
});

test("the sign-in page remembers the language the reader chose", async () => {
  // The reader's own choice beats the browser's preference.
  const { window } = await bootPage({
    serverLang: "en",
    implicit: true,
    storedLang: "zh-CN",
  });
  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.match(text(window), /已用 GitHub 登录/);
});

test("the language switcher changes the page in place", async () => {
  const { window } = await bootPage({ serverLang: "en" });
  assert.equal(window.document.documentElement.lang, "en");

  const chinese = window.document.querySelector(
    '#langSwitch button[data-lang="zh-CN"]',
  );
  chinese.click();
  await settle(window);

  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.match(text(window), /已用 GitHub 登录/);
  assert.equal(chinese.getAttribute("aria-pressed"), "true");
  // The choice is remembered, so the next sign-in starts in the same
  // language.
  assert.equal(window.localStorage.getItem("ytd_dashboard_lang"), "zh-CN");
  // The server renders the next sign-in page, so the choice travels there
  // in a cookie the server can read.
  assert.match(window.document.cookie, /ytd_dashboard_lang=zh-CN/);
});

test("the sign-in page says what happened to the data", async () => {
  const { window } = await bootPage({ serverLang: "en" });
  // A reader who just signed in should know where their notes went.
  assert.match(text(window), /saved to your own account/);
  assert.match(text(window), /Nothing was shared with anyone/);
});
