const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const dashboardDir = path.resolve(__dirname, "..", "dashboard");
const privacyHtml = fs.readFileSync(path.join(dashboardDir, "privacy.html"), "utf8");
const privacyJs = fs.readFileSync(path.join(dashboardDir, "privacy.js"), "utf8");
const dashboardHtml = fs.readFileSync(path.join(dashboardDir, "index.html"), "utf8");

/**
 * Boots the real privacy page in a real DOM.
 *
 * The page used to carry its rules in an inline <style> block, which the
 * page's own Content-Security-Policy blocks. It was therefore served
 * unstyled from the day it was deployed, and nothing noticed, because
 * nothing tested it. These tests drive the real privacy.js in jsdom, and
 * they check that the page can actually satisfy its own policy.
 */
async function bootPrivacy(options = {}) {
  const dom = new JSDOM(privacyHtml, {
    url: options.url || "https://ytd.example/privacy.html",
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

  window.eval(privacyJs);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await settle(window);
  return { dom, window };
}

async function settle(window, turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

// jsdom does not implement innerText; textContent is what the copy sets.
const text = (window) => window.document.body.textContent;

test("the privacy page opens in the language the URL asks for", async () => {
  const { window } = await bootPrivacy({ url: "https://ytd.example/privacy.html?lang=zh-CN" });
  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.match(text(window), /同步服务保存什么/);
  assert.match(text(window), /你写下的笔记/);
});

test("the privacy page follows the language the dashboard remembered", async () => {
  // The dashboard stores the chosen language; the privacy page is a
  // different document and must not send the user back to English.
  const { window } = await bootPrivacy({ storedLang: "zh-CN" });
  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.match(text(window), /中间的网络/);
});

test("a reader whose browser is Chinese gets the Chinese page", async () => {
  const { window } = await bootPrivacy({ language: "zh-CN" });
  assert.equal(window.document.documentElement.lang, "zh-CN");
});

test("the privacy page is English when nothing says otherwise", async () => {
  const { window } = await bootPrivacy({ language: "en-US" });
  assert.equal(window.document.documentElement.lang, "en");
  assert.match(text(window), /What the sync service stores/);
});

test("the language switcher changes the page in place", async () => {
  const { window } = await bootPrivacy({ url: "https://ytd.example/privacy.html?lang=en" });
  assert.match(text(window), /What the sync service stores/);
  window.document
    .querySelector('#langSwitch button[data-lang="zh-CN"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle(window);
  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.match(text(window), /同步服务保存什么/);
  assert.doesNotMatch(text(window), /What we store/);
  // The choice is remembered for the next page.
  assert.equal(window.localStorage.getItem("ytd_dashboard_lang"), "zh-CN");
});

test("the privacy page says who handles the connection", async () => {
  // Cloudflare's edge sees every request. The page has to say so in both
  // languages, or the "no analytics, no tracking" claim is only half true.
  const english = await bootPrivacy({ language: "en" });
  assert.match(text(english.window), /Cloudflare/);
  const chinese = await bootPrivacy({ language: "zh-CN" });
  assert.match(text(chinese.window), /Cloudflare/);
  assert.match(text(chinese.window), /IP 地址/);
});

test("the privacy page does not repeat its label inside the sentence", async () => {
  const { window } = await bootPrivacy({ language: "zh-CN" });
  const items = [...window.document.querySelectorAll(".privacy-body li")].map(
    (item) => item.textContent,
  );
  const exportItem = items.find((item) => item.includes("导出"));
  assert.ok(exportItem, "the export control is listed");
  assert.equal(exportItem.match(/导出：/g).length, 1, "导出： appears once");
});

test("every marked string on the privacy page has a translation", async () => {
  const { window } = await bootPrivacy({ language: "en" });
  const keys = [...window.document.querySelectorAll("[data-i18n]")].map((element) =>
    element.getAttribute("data-i18n"),
  );
  assert.ok(keys.length > 10, "the page is marked up for translation");
  const copy = window.YTD_PRIVACY.copy;
  for (const key of keys) {
    assert.notEqual(copy(key), "", `no English copy for "${key}"`);
    copy.language = "zh-CN";
    assert.notEqual(copy(key), "", `no Chinese copy for "${key}"`);
    copy.language = "en";
  }
  // The copy function falls back to English when a language is missing a
  // key, so the check above cannot tell a translation from a fallback. The
  // Chinese reader would simply get the English sentence, which is the one
  // thing this page must not do.
  const tables = window.YTD_PRIVACY.tables;
  for (const key of keys) {
    assert.ok(
      typeof tables["zh-CN"][key] === "string" && tables["zh-CN"][key].length > 0,
      `the Chinese page falls back to English for "${key}"`,
    );
    assert.ok(
      typeof tables.en[key] === "string" && tables.en[key].length > 0,
      `the English page has no copy for "${key}"`,
    );
  }
});

test("the privacy page says where the extension sends its data", async () => {
  // The store's privacy policy URL has to answer for the whole extension,
  // not only for the sync service. A reader has to learn here that the
  // transcript can reach Supadata and the AI provider they picked, and
  // that the API keys stay on the device.
  const english = await bootPrivacy({ language: "en" });
  const englishText = text(english.window);
  assert.match(englishText, /Supadata/);
  assert.match(englishText, /AI provider/);
  assert.match(englishText, /session id/);
  assert.match(englishText, /stays in your Chrome profile/);

  const chinese = await bootPrivacy({ language: "zh-CN" });
  const chineseText = text(chinese.window);
  assert.match(chineseText, /Supadata/);
  assert.match(chineseText, /AI 服务商/);
  assert.match(chineseText, /会话 ID/);
  assert.match(chineseText, /留在你的 Chrome 用户配置里/);
});

test("neither dashboard page can violate its own Content-Security-Policy", async () => {
  // The pages ship a strict policy: no inline styles, no inline scripts, no
  // inline event handlers. An inline <style> is silently dropped by the
  // browser, so the page renders unstyled and the only sign is a console
  // error nobody reads. This is the guard that catches it.
  for (const [name, source] of [
    ["privacy.html", privacyHtml],
    ["index.html", dashboardHtml],
  ]) {
    assert.doesNotMatch(source, /<style[\s>]/i, `${name} has an inline <style>`);
    assert.doesNotMatch(
      source,
      /\son[a-z]+\s*=/i,
      `${name} has an inline event handler`,
    );
    assert.doesNotMatch(
      source,
      /<script(?![^>]*\bsrc=)[^>]*>/i,
      `${name} has an inline <script>`,
    );
  }
});

test("the privacy page's rules live in a same-origin stylesheet", async () => {
  const links = [...privacyHtml.matchAll(/<link[^>]+href="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(
    links.includes("/privacy.css"),
    "the privacy page links its own stylesheet",
  );
  assert.ok(
    fs.existsSync(path.join(dashboardDir, "privacy.css")),
    "the stylesheet is shipped with the page",
  );
});
