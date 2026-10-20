/**
 * YouTube Digest sync backend (Cloudflare Worker).
 *
 * Routes:
 *   GET  /api/auth/login              start GitHub OAuth (302 to GitHub)
 *   GET  /api/auth/callback           exchange code, sign JWT, redirect to /auth/complete#access_token=...
 *   GET  /auth/complete               tiny landing page shown after login
 *   GET  /api/me                      current user
 *   GET  /api/sync?since=...          notes+vocabulary changed since an ISO timestamp
 *   GET  /api/notes | POST /api/notes | PATCH/DELETE /api/notes/:id
 *   GET  /api/vocabulary | POST /api/vocabulary | PATCH/DELETE /api/vocabulary/:id
 *   GET  /api/reviews/due | POST /api/reviews/:vocabId
 *
 * Every /api route except the two auth endpoints requires
 * `Authorization: Bearer <jwt>`. Identity always comes from the verified
 * token, so one GitHub account can never read or write another account's rows.
 */

const { signToken } = require("./jwt");
const {
  HttpError,
  requireUser,
  json,
  createRateLimiter,
  requireJwtSecret,
  HARDENING_HEADERS,
} = require("./middleware");
const { createStore } = require("./db");
const auth = require("./auth");
const notes = require("./routes/notes");
const vocabulary = require("./routes/vocabulary");
const reviews = require("./routes/reviews");
const meRoutes = require("./routes/me");

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const STATE_COOKIE = "ytd_oauth_state";

// Simple per-worker rate limit for the public OAuth entry point. In-memory
// and per-isolate (approximate across replicas), which is fine for abuse
// damping: legitimate users log in a handful of times per day.
const LOGIN_RATE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_RATE_MAX = 20;
const loginAttempts = new Map(); // ip -> [timestamps]

function checkLoginRate(ip) {
  const now = Date.now();
  const cutoff = now - LOGIN_RATE_WINDOW_MS;
  const timestamps = (loginAttempts.get(ip) || []).filter((t) => t > cutoff);
  if (timestamps.length >= LOGIN_RATE_MAX) {
    loginAttempts.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  loginAttempts.set(ip, timestamps);
  // A key whose window has fully expired is dropped, so the map cannot grow
  // without bound when many distinct clients hit the login route.
  if (loginAttempts.size > 10_000) loginAttempts.clear();
  return true;
}

// Per-user rate limits for the authenticated data routes. A valid token must
// not be able to write an unbounded number of rows, and a read is not free
// either: every list endpoint can return thousands of rows.
const USER_RATE_WINDOW_MS = 60 * 1000;
const USER_WRITE_RATE_MAX = 120;
const USER_READ_RATE_MAX = 600;
const userWriteLimiter = createRateLimiter({
  windowMs: USER_RATE_WINDOW_MS,
  max: USER_WRITE_RATE_MAX,
  maxKeys: 10_000,
});
const userReadLimiter = createRateLimiter({
  windowMs: USER_RATE_WINDOW_MS,
  max: USER_READ_RATE_MAX,
  maxKeys: 10_000,
});

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: Object.assign({ Location: location }, HARDENING_HEADERS),
  });
}

/**
 * The words on the sign-in landing page. The page is built from this table
 * and not from two copies of the markup, so the two languages cannot drift
 * apart.
 */
const COMPLETE_COPY = {
  en: {
    title: "Signed in to GitHub · YouTube Digest",
    signedIn: "Signed in to GitHub",
    body: "You can close this tab and return to YouTube Digest. Your notes, vocabulary and review progress are saved to your own account.",
    note: "Nothing was shared with anyone but the sync service you signed in to.",
    languageLabel: "Language",
  },
  "zh-CN": {
    title: "已用 GitHub 登录 · YouTube Digest",
    signedIn: "已用 GitHub 登录",
    body: "你可以关掉这个标签页，回到 YouTube Digest。你的笔记、生词和复习进度都保存在你自己的账户里。",
    note: "除了你登录的同步服务，没有任何人拿到这些数据。",
    languageLabel: "语言",
  },
};

/**
 * The sign-in landing page.
 *
 * The language is baked into the markup, so the reader never sees the page
 * change language after it appears. The chosen language is also written to
 * `data-lang`, which lets the script tell which language the server picked
 * instead of guessing it a second time.
 */
function completePage(lang) {
  const language = COMPLETE_COPY[lang] ? lang : "en";
  const copy = COMPLETE_COPY[language];
  return [
    `<!doctype html><html lang="${language}" data-lang="${language}"><head><meta charset="utf-8" />`,
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<link rel="icon" href="/favicon.png" />',
    `<title>${copy.title}</title>`,
    '<link rel="stylesheet" href="/tokens.css" />',
    '<link rel="stylesheet" href="/auth-complete.css" />',
    '</head><body class="auth-body">',
    '<main class="auth-card">',
    '<div class="auth-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg></div>',
    `<h1 data-i18n="signedIn">${copy.signedIn}</h1>`,
    `<p data-i18n="body">${copy.body}</p>`,
    `<p class="auth-note" data-i18n="note">${copy.note}</p>`,
    '<div class="auth-lang">',
    `<span class="auth-lang-label" data-i18n-aria-label="languageLabel">${copy.languageLabel}</span>`,
    `<div class="lang-switch" id="langSwitch" role="group" data-i18n-aria-label="languageLabel" aria-label="${copy.languageLabel}">`,
    '<button type="button" class="lang-btn" data-lang="en" aria-pressed="false">English</button>',
    '<button type="button" class="lang-btn" data-lang="zh-CN" aria-pressed="false">简体中文</button>',
    "</div></div>",
    "</main>",
    '<script src="/auth-complete.js"></script>',
    "</body></html>",
  ].join("");
}

const REDIRECT_COOKIE = "ytd_oauth_redirect";
const LANG_COOKIE = "ytd_oauth_lang";
// The dashboard remembers the language the reader picked in a cookie as
// well as in localStorage, so the server can greet them in that language.
const DASHBOARD_LANG_COOKIE = "ytd_dashboard_lang";

/**
 * The languages the landing page speaks. Anything else falls back to
 * English, so a hand-edited query parameter cannot inject text.
 */
function normalizeLang(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "zh-CN") return "zh-CN";
  const lower = raw.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en";
  return "";
}

/**
 * The language the browser asked for. GitHub sends the user back to the
 * Worker, not to the browser's own page, so the landing page has to ask the
 * browser what it would have shown.
 */
function preferredLanguage(request) {
  const header = request.headers.get("accept-language") || "";
  for (const part of header.split(",")) {
    const tag = part.split(";")[0].trim();
    const lang = normalizeLang(tag);
    if (lang) return lang;
  }
  return "en";
}

/**
 * The language the reader picked in the dashboard. The dashboard stores it
 * in a cookie next to its localStorage copy, so a returning reader is
 * greeted in the language they chose.
 */
function chosenLanguage(request) {
  const cookies = auth.parseCookies(request);
  return normalizeLang(cookies[DASHBOARD_LANG_COOKIE]);
}

/**
 * Only same-origin paths starting with "/" (and not "//") may be used as
 * post-login redirects; anything else is ignored. This prevents open
 * redirects while letting the dashboard (and future web clients) return to
 * their own page after sign-in.
 */
function safeRedirectPath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (!value.startsWith("/") || value.startsWith("//")) return "";
  if (/[^A-Za-z0-9/._~-]/.test(value)) return "";
  return value;
}

async function handleLogin(ctx) {
  const env = ctx.env;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new HttpError(500, "GitHub OAuth is not configured on the server.");
  }
  // A missing secret would throw a DataError from `importKey` on every
  // request; fail with a clear configuration error instead.
  requireJwtSecret(env);
  if (!checkLoginRate(clientIp(ctx.request))) {
    throw new HttpError(429, "Too many sign-in attempts. Try again in a few minutes.");
  }
  const url = new URL(ctx.request.url);
  const origin = url.origin;
  const redirectUri = origin + "/api/auth/callback";
  const state = auth.randomState();
  const authorizeUrl = auth.buildAuthorizeUrl({
    clientId: env.GITHUB_CLIENT_ID,
    redirectUri,
    state,
    scope: "read:user",
  });
  const response = redirect(authorizeUrl);
  // Two Set-Cookie headers must be appended, not set: set() would replace
  // the first header with the second, silently dropping the CSRF state.
  response.headers.append(
    "Set-Cookie",
    auth.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAgeSeconds: 600,
    }),
  );
  const postLoginPath = safeRedirectPath(url.searchParams.get("redirect"));
  // The language has to survive the trip to GitHub and back, so an explicit
  // choice travels in a short-lived cookie next to the CSRF state. The
  // extension asks for the language the user picked in its settings; a
  // sign-in started from the dashboard carries the choice the reader made
  // there. A language that is only the browser's preference is not a
  // choice, so it is not stored: it is asked for again on the way back.
  const explicitLang =
    normalizeLang(url.searchParams.get("lang")) || chosenLanguage(ctx.request);
  if (explicitLang) {
    response.headers.append(
      "Set-Cookie",
      auth.setCookie(LANG_COOKIE, explicitLang, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAgeSeconds: 600,
      }),
    );
  }
  if (postLoginPath) {
    response.headers.append(
      "Set-Cookie",
      auth.setCookie(REDIRECT_COOKIE, postLoginPath, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAgeSeconds: 600,
      }),
    );
  }
  return response;
}

async function handleCallback(ctx) {
  const env = ctx.env;
  // Checked before the GitHub code is exchanged: a missing secret would
  // otherwise fail *after* the code was already spent.
  requireJwtSecret(env);
  const url = new URL(ctx.request.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code) throw new HttpError(400, "Missing OAuth code.");
  const cookies = auth.parseCookies(ctx.request);
  const expectedState = cookies[STATE_COOKIE];
  if (!expectedState || expectedState !== state) {
    throw new HttpError(400, "OAuth state mismatch. Restart sign-in.");
  }
  const origin = url.origin;
  const redirectUri = origin + "/api/auth/callback";
  const accessToken = await auth.exchangeCode({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code,
    redirectUri,
  });
  const githubUser = await auth.fetchGithubUser(accessToken);
  const user = await env.store.upsertUser(githubUser);
  const token = await signToken(
    {
      sub: String(user.id),
      githubId: user.githubId,
      login: user.login,
      // The token version lets a deleted account revoke the tokens it issued.
      tokenVersion: Number(user.tokenVersion) || 0,
    },
    env.JWT_SECRET,
    SESSION_TTL_SECONDS,
  );
  const postLoginPath = safeRedirectPath(cookies[REDIRECT_COOKIE]);
  const completePath = postLoginPath || "/auth/complete";
  // The landing page speaks the language the sign-in started in. An
  // explicit choice is written into the URL as well, so the page and the
  // script that switches it can never disagree. A language that is only
  // the browser's preference is not written down: the page states it in
  // its own markup instead. Other pages (the dashboard) pick their own
  // language and are left alone.
  const explicitLang =
    normalizeLang(cookies[LANG_COOKIE]) ||
    normalizeLang(cookies[DASHBOARD_LANG_COOKIE]);
  const lang = explicitLang || preferredLanguage(ctx.request);
  const query =
    completePath === "/auth/complete" && explicitLang
      ? "?lang=" + encodeURIComponent(lang)
      : "";
  const response = redirect(
    origin + completePath + query + "#access_token=" + token,
  );
  response.headers.append(
    "Set-Cookie",
    auth.setCookie(STATE_COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAgeSeconds: 0 }),
  );
  response.headers.append(
    "Set-Cookie",
    auth.setCookie(LANG_COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAgeSeconds: 0 }),
  );
  if (postLoginPath) {
    response.headers.append(
      "Set-Cookie",
      auth.setCookie(REDIRECT_COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAgeSeconds: 0 }),
    );
  }
  return response;
}

async function handleComplete(ctx) {
  const url = new URL(ctx.request.url);
  const lang =
    normalizeLang(url.searchParams.get("lang")) ||
    chosenLanguage(ctx.request) ||
    preferredLanguage(ctx.request);
  return new Response(completePage(lang), {
    headers: Object.assign(
      {
        "Content-Type": "text/html; charset=utf-8",
        // The page loads only same-origin scripts and styles, so the strict
        // policy costs it nothing. It also blocks the script Cloudflare's
        // edge injects into served HTML, which is the point.
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'",
      },
      HARDENING_HEADERS,
    ),
  });
}

/** A canonical UUID, as used by the notes and vocabulary primary keys. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tiny path router. Patterns use `:name` segments; matched values land in
 * ctx.params. All data routes run through requireUser first.
 *
 * `uuidParams` names the parameters that carry a row id. A value that is not
 * a UUID can never match a row, so it is answered with 404 instead of being
 * handed to the database (where it would raise a uuid syntax error).
 */
const ROUTES = [
  { method: "GET", pattern: "/api/auth/login", handler: handleLogin, public: true },
  { method: "GET", pattern: "/api/auth/callback", handler: handleCallback, public: true },
  { method: "GET", pattern: "/auth/complete", handler: handleComplete, public: true },
  { method: "GET", pattern: "/api/me", handler: meRoutes.me },
  { method: "GET", pattern: "/api/sync", handler: meRoutes.syncDelta },
  { method: "GET", pattern: "/api/export", handler: meRoutes.exportData },
  { method: "DELETE", pattern: "/api/account", handler: meRoutes.deleteAccount },
  { method: "GET", pattern: "/api/status", handler: handleStatus, public: true },
  { method: "GET", pattern: "/api/notes", handler: notes.listNotes },
  { method: "POST", pattern: "/api/notes", handler: notes.createNote },
  { method: "PATCH", pattern: "/api/notes/:id", handler: notes.updateNote, uuidParams: ["id"] },
  { method: "DELETE", pattern: "/api/notes/:id", handler: notes.deleteNote, uuidParams: ["id"] },
  { method: "PATCH", pattern: "/api/notes/:id/star", handler: notes.setNoteStarred, uuidParams: ["id"] },
  { method: "DELETE", pattern: "/api/notes/client/:clientId", handler: notes.deleteNoteByClientId },
  { method: "GET", pattern: "/api/vocabulary", handler: vocabulary.listVocabulary },
  { method: "POST", pattern: "/api/vocabulary", handler: vocabulary.upsertVocabulary },
  { method: "PATCH", pattern: "/api/vocabulary/:id", handler: vocabulary.updateVocabularyStatus, uuidParams: ["id"] },
  { method: "DELETE", pattern: "/api/vocabulary/:id", handler: vocabulary.deleteVocabulary, uuidParams: ["id"] },
  { method: "GET", pattern: "/api/reviews/due", handler: reviews.listDueReviews },
  { method: "POST", pattern: "/api/reviews/:vocabId", handler: reviews.submitReview, uuidParams: ["vocabId"] },
];

function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const patternParts = route.pattern.split("/");
    const pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i];
      if (patternPart.startsWith(":")) {
        let decoded;
        try {
          decoded = decodeURIComponent(pathParts[i]);
        } catch {
          // A malformed percent-escape is a client error, not a server error.
          throw new HttpError(400, "Malformed request path.");
        }
        const name = patternPart.slice(1);
        if (route.uuidParams && route.uuidParams.includes(name) && !UUID_PATTERN.test(decoded)) {
          // A row id that cannot be a UUID matches nothing. Answering 404
          // keeps the database from ever seeing it.
          throw new HttpError(404, "Not found.");
        }
        params[name] = decoded;
      } else if (patternPart !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

const STARTED_AT = Date.now();

/**
 * In-memory ring buffer of recent server errors so the service owner can
 * see failures without log access.
 *
 * Only the NORMALIZED route pattern is stored, never the raw request path:
 * the raw path contains the user's note and vocabulary ids. The buffer is
 * internal: the public status probe does not expose it.
 */
const recentErrors = [];

function recordError(request, error, routePattern) {
  try {
    recentErrors.push({
      at: new Date().toISOString(),
      route: routePattern || "unmatched",
      message: String((error && error.message) || error || "unknown error").slice(0, 300),
    });
    if (recentErrors.length > 50) recentErrors.shift();
  } catch {
    // Never let diagnostics break the error path.
  }
}

/**
 * Public health probe. It deliberately exposes nothing but liveness: the
 * error buffer contains internal messages and resource ids, which must not
 * reach an unauthenticated caller.
 */
async function handleStatus() {
  return json({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  // The dashboard is served by the Workers Assets binding, which takes
  // precedence for non-API paths; only /api/* reaches this router.
  const match = matchRoute(request.method, url.pathname);
  if (!match) throw new HttpError(404, "Not found.");
  const { route, params } = match;
  const ctx = {
    request,
    env,
    params,
    store: env.store,
  };
  try {
    if (!route.public) {
      ctx.user = await requireUser(request, env);
      // Rate limit per authenticated account: writes create rows, reads can
      // return thousands of them.
      const isWrite = request.method !== "GET" && request.method !== "HEAD";
      const allowed = isWrite
        ? userWriteLimiter(String(ctx.user.id))
        : userReadLimiter(String(ctx.user.id));
      if (!allowed) {
        throw new HttpError(429, "Too many requests. Try again in a moment.");
      }
    }
    return await route.handler(ctx);
  } catch (error) {
    // The route pattern, not the raw path: the path holds the user's row
    // ids, which must not be recorded in a buffer that could be exposed.
    if (error && typeof error === "object" && !error.routePattern) {
      error.routePattern = route.pattern;
    }
    throw error;
  }
}

module.exports = {
  async fetch(request, env) {
    if (!env.store) env.store = createStore(env);
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      recordError(request, error, error && error.routePattern);
      if (status === 500) console.error("[youtube-digest-server]", error);
      // A raw driver message ("invalid input syntax for type uuid") leaks
      // schema details, so only our own messages reach the client.
      const message =
        error instanceof HttpError ? error.message || "Request failed." : "Internal server error.";
      return json({ error: message }, status);
    }
  },
  async scheduled(event, env) {
    // Health probe: /api/me answers 401 when the service is alive.
    const probeBase = "https://ytd.panbo.space";
    try {
      const response = await fetch(probeBase + "/api/me", { method: "GET" });
      if (response.status === 401) {
        console.log("[probe] ok");
        return;
      }
      const message = "Health probe failed: HTTP " + response.status;
      console.error("[probe]", message);
      if (env.PROBE_WEBHOOK_URL) {
        await fetch(env.PROBE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "[YouTube Digest] " + message + " at " + new Date().toISOString() }),
        }).catch(() => {});
      }
    } catch (error) {
      console.error("[probe] fetch failed:", error.message);
    }
  },
};
