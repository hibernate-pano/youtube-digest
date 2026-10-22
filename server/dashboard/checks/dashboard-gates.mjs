/**
 * The dashboard's browser gates.
 *
 * The dashboard's own behaviour is checked where it is painted: a real
 * browser, a stub of the sync service, and a measurement of what the page
 * actually does. The audits that found the defects these gates guard (a
 * count that was not the account's, a re-render that dropped the keyboard,
 * a page that scrolled sideways on a phone, a page that could be framed)
 * all measured in a browser, so a gate that only reads the source could
 * not have seen any of them.
 *
 * Run it with:
 *
 *   node server/dashboard/checks/dashboard-gates.mjs
 *
 * The installed Chrome is used when it is there; Playwright's downloaded
 * build is the fallback. The gate exits non-zero when anything fails.
 *
 * The `_headers` rule is checked by reading the file: the headers it
 * declares are served by Cloudflare's asset server, which has to be
 * running to answer, and a gate that needs a deploy to answer is not a
 * gate. To see the live headers:
 *
 *   cd server && npx wrangler dev --port 8791 --local
 *   curl -sI http://127.0.0.1:8791/ | grep -i frame
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(HERE, "..");
const PLAYWRIGHT = path.resolve(HERE, "..", "..", "..", "node_modules", "playwright", "index.mjs");

const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log("ok   " + name);
  } else {
    failures.push(name + (detail ? " — " + detail : ""));
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

// ============================================================
// THE STUB SERVICE
// ============================================================
// The shape the server team is shipping: a page of rows, the number the
// account really holds, and whether the page is the whole account.

const NOTES = [
  {
    id: "n1",
    starred: true,
    videoId: "vid1",
    videoTitle: "A note from a video",
    channelName: "Channel",
    timestampSeconds: 61,
    note: "The first note.",
    createdAt: "2026-10-18T09:12:00.000Z",
  },
  {
    id: "n2",
    starred: false,
    videoId: "vid2",
    videoTitle: "Another video",
    channelName: "Channel",
    timestampSeconds: 62,
    note: "The second note.",
    createdAt: "2026-10-19T09:12:00.000Z",
  },
];

const VOCABULARY = [
  {
    id: "v1",
    term: "habit",
    translation: "习惯",
    sentence: "A system is a climate.",
    sentenceTranslation: "系统是气候。",
    videoId: "vid1",
    videoTitle: "A note from a video",
    timestampSeconds: 61,
    status: "learning",
    createdAt: "2026-10-19T09:12:00.000Z",
  },
];

const REVIEWS = [
  {
    id: "r1",
    vocabularyId: "v1",
    dueAt: "2026-10-19T00:00:00.000Z",
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    vocabulary: VOCABULARY[0],
  },
  {
    id: "r2",
    vocabularyId: "v2",
    dueAt: "2026-10-19T00:00:00.000Z",
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    vocabulary: { ...VOCABULARY[0], id: "v2", term: "climate" },
  },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

const state = {
  mode: "ok",
  legacy: false,
  noteTotal: 6,
  noteTruncated: true,
  reviewPosts: [],
  reviewDelayMs: 250,
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname;
  const json = (body, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (pathname.startsWith("/api/")) {
    if (state.mode === "expired") {
      json({ error: "Invalid or expired session. Sign in again." }, 401);
      return;
    }
    if (state.mode === "boom") {
      json({ error: "boom" }, 500);
      return;
    }
    if (pathname === "/api/me") {
      json({ user: { id: 1, login: "gate-test" } });
      return;
    }
    if (pathname === "/api/notes") {
      const body = { notes: NOTES, serverTime: "2026-10-20T00:00:00.000Z" };
      if (!state.legacy) {
        body.total = state.noteTotal;
        body.truncated = state.noteTruncated;
      }
      json(body);
      return;
    }
    if (pathname === "/api/vocabulary") {
      const body = { vocabulary: VOCABULARY };
      if (!state.legacy) {
        body.total = 3;
        body.truncated = true;
      }
      json(body);
      return;
    }
    if (pathname === "/api/reviews/due") {
      json({ reviews: REVIEWS });
      return;
    }
    if (pathname.startsWith("/api/reviews/") && request.method === "POST") {
      state.reviewPosts.push(pathname);
      setTimeout(() => json({ review: { id: "r" } }), state.reviewDelayMs);
      return;
    }
    if (request.method === "PATCH" && pathname.startsWith("/api/vocabulary/")) {
      const body = JSON.parse(await readBody(request));
      json({ vocabulary: { ...VOCABULARY[0], ...body } });
      return;
    }
    json({ ok: true });
    return;
  }

  const file = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(DASHBOARD, file);
  if (!full.startsWith(DASHBOARD) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  response.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "text/plain" });
  response.end(fs.readFileSync(full));
});

function readBody(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => resolve(data));
  });
}

// ============================================================
// THE GATES
// ============================================================

async function main() {
  const { chromium } = await import(PLAYWRIGHT);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port + "/";

  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome" });
  } catch (_error) {
    browser = await chromium.launch();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const open = async (options = {}) => {
    const page = await context.newPage();
    await page.addInitScript(
      ([token, language]) => {
        if (token) window.localStorage.setItem("ytd_dashboard_token", token);
        else window.localStorage.removeItem("ytd_dashboard_token");
        if (language) window.localStorage.setItem("ytd_dashboard_lang", language);
        else window.localStorage.removeItem("ytd_dashboard_lang");
      },
      // The page's language is pinned: the reader's browser locale is not
      // part of what a gate about English copy is testing.
      [options.token === undefined ? "gate.token" : options.token, options.language || "en"],
    );
    await page.goto(base, { waitUntil: "networkidle" });
    return page;
  };

  // --- the count is the account's, not the page's ----------------------
  {
    const page = await open();
    const count = (await page.textContent("#notesCount")).trim();
    check(
      "the note count is the account's number, not the page's length",
      count.includes("6") && !count.startsWith("2"),
      "showed: " + count,
    );
    const noticeElement = await page.$("#notesTruncation");
    const notice = noticeElement ? (await noticeElement.textContent()).trim() : "";
    const noticeVisible = noticeElement ? await noticeElement.isVisible() : false;
    check(
      "a truncated list says it is partial, and how much",
      noticeVisible && /2/.test(notice) && /6/.test(notice),
      "notice: " + (notice || "(none)"),
    );
    await page.close();
  }
  {
    // The old server shape: no total, no truncated. The length is all the
    // page has, and it must not blank the count or invent a notice.
    state.legacy = true;
    const page = await open();
    const count = (await page.textContent("#notesCount")).trim();
    check(
      "an older server without a total still renders its number",
      count.includes("2"),
      "showed: " + count,
    );
    const legacyNotice = await page.$("#notesTruncation");
    check(
      "an older server does not claim the list is partial",
      !legacyNotice || !(await legacyNotice.isVisible()),
    );
    state.legacy = false;
    await page.close();
  }

  // --- one grade, one request ------------------------------------------
  {
    const page = await open();
    await page.click("#tab-review");
    await page.waitForSelector("#reviewCard:not([hidden])");
    check(
      "the grades are hidden until the answer is shown",
      await page.getAttribute("#dashReviewActions", "hidden") !== null,
    );
    await page.click("#reviewCard");
    check(
      "the grades appear once the answer is shown",
      await page.getAttribute("#dashReviewActions", "hidden") === null,
    );
    state.reviewPosts = [];
    await page.evaluate(() => {
      const button = document.querySelector('#dashReviewActions .grade-btn[data-grade="3"]');
      button.click();
      button.click();
    });
    await page.waitForTimeout(700);
    check(
      "a double click sends one grade, not two",
      state.reviewPosts.length === 1,
      "posts: " + state.reviewPosts.length,
    );
    check(
      "the next card is the one after this one, not the one after that",
      (await page.textContent("#dashReviewTerm")).trim() === "climate",
      "showed: " + (await page.textContent("#dashReviewTerm")).trim(),
    );
    check(
      "the next card hides the grades again",
      await page.getAttribute("#dashReviewActions", "hidden") !== null,
    );
    await page.close();
  }

  // --- the keyboard stays where the reader put it -----------------------
  {
    const page = await open();
    await page.click("#tab-vocabulary");
    await page.waitForSelector("#vocabularyList .status-select");
    await page.focus("#vocabularyList .status-select");
    await page.selectOption("#vocabularyList .status-select", "reviewing");
    await page.waitForTimeout(400);
    const active = await page.evaluate(() => ({
      tag: document.activeElement && document.activeElement.tagName,
      key: document.activeElement && document.activeElement.dataset
        ? document.activeElement.dataset.focusKey
        : "",
    }));
    check(
      "a re-render keeps the keyboard on the control the reader was on",
      active.tag === "SELECT" && active.key === "vocabulary:status:v1",
      JSON.stringify(active),
    );
    await page.close();
  }

  // --- the page does not scroll sideways on a phone ---------------------
  {
    const page = await open();
    for (const width of [320, 360, 375, 414]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(base, { waitUntil: "networkidle" });
      const measured = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      check(
        "the page fits a " + width + "px viewport",
        measured.scrollWidth === measured.innerWidth,
        "scrollWidth " + measured.scrollWidth + " vs viewport " + measured.innerWidth,
      );
    }
    await page.close();
  }

  // --- an expired session is explained ----------------------------------
  {
    const page = await open();
    state.mode = "expired";
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(600);
    const status = (await page.textContent("#statusLine")).trim();
    check("an expired session says so", /expired/i.test(status), "status: " + status);
    check(
      "the token goes only after the reason is on screen",
      (await page.evaluate(() => window.localStorage.getItem("ytd_dashboard_token"))) === null,
    );
    state.mode = "ok";
    await page.close();
  }

  // --- a Chinese page never shows the server's English ------------------
  {
    const page = await open({ language: "zh-CN" });
    state.mode = "boom";
    await page.click("#refreshBtn");
    await page.waitForTimeout(600);
    const status = (await page.textContent("#statusLine")).trim();
    check(
      "a Chinese page localizes a server failure",
      status.length > 0 && !status.includes("boom"),
      "status: " + status,
    );
    state.mode = "ok";
    await page.close();
  }

  // --- the controls have names ------------------------------------------
  {
    const page = await open();
    const head = await page.$("#notesList .card .card-head");
    const buttons = await head.$$("button");
    check(
      "the copy button names the note it copies",
      /note/i.test((await buttons[1].getAttribute("aria-label")) || ""),
      "aria-label: " + (await buttons[1].getAttribute("aria-label")),
    );
    check(
      "the delete button names the note it deletes",
      /delete/i.test((await buttons[2].getAttribute("aria-label")) || ""),
      "aria-label: " + (await buttons[2].getAttribute("aria-label")),
    );
    check(
      "copy and delete are not painted with the same class",
      (await buttons[1].getAttribute("class")) !== (await buttons[2].getAttribute("class")),
    );
    check(
      "the star says which note it stars",
      !!(await buttons[0].getAttribute("aria-describedby")),
    );
    const select = await page.$("#vocabularyList .status-select");
    check(
      "the status picker has a name",
      !!(await select.getAttribute("aria-label")),
    );
    await page.close();
  }

  // --- signing out takes the words with it -------------------------------
  {
    const page = await open();
    await page.click("#logoutBtn");
    await page.waitForTimeout(200);
    const left = await page.innerHTML("#notesList");
    check("signing out empties the notes the next reader could read", left === "");
    check(
      "the privacy policy is reachable when signed out",
      await page.isVisible("#footer a[href='/privacy.html']"),
    );
    await page.close();
  }
  {
    const page = await open({ token: null });
    check(
      "the privacy policy is reachable before signing in",
      await page.isVisible("#footer a[href='/privacy.html']"),
    );
    await page.close();
  }

  // --- the sign-in link carries its nonce before it is pressed ----------
  {
    const page = await open({ token: null });
    const href = await page.getAttribute("#signedOut a.login-btn", "href");
    check(
      "the sign-in link carries the nonce before any click",
      String(href).includes("nonce=") && String(href).includes("device="),
      "href: " + href,
    );
    await page.close();
  }

  // --- a tab switch does not fetch the account again ---------------------
  {
    const page = await open();
    const calls = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/notes")) calls.push(request.url());
    });
    await page.click("#tab-favorites");
    await page.waitForTimeout(600);
    check(
      "switching tabs does not fetch the notes again",
      calls.length === 0,
      "requests: " + calls.length,
    );
    await page.close();
  }

  // --- the frame header --------------------------------------------------
  {
    const headersPath = path.join(DASHBOARD, "_headers");
    const exists = fs.existsSync(headersPath);
    const text = exists ? fs.readFileSync(headersPath, "utf8") : "";
    check("the dashboard ships a _headers file", exists);
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [header, value] of [
      ["X-Frame-Options", "DENY"],
      ["Content-Security-Policy", "frame-ancestors 'none'"],
      ["X-Content-Type-Options", "nosniff"],
      ["Referrer-Policy", "no-referrer"],
    ]) {
      check(
        "the _headers file declares " + header + ": " + value,
        new RegExp(escape(header) + ":\\s*" + escape(value), "i").test(text),
      );
    }
    // A meta tag cannot refuse a frame: the browser ignores frame-ancestors
    // there. If the policy only exists in the markup, it is not a policy.
    check(
      "the frame refusal is a header rule, not a meta tag",
      /^\s*\/\*[\s\S]*?frame-ancestors/m.test(text),
    );
  }

  await browser.close();
  server.close();

  console.log("");
  console.log(checks - failures.length + " of " + checks + " gates passed");
  if (failures.length) {
    console.log("");
    for (const failure of failures) console.log("FAILED: " + failure);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
