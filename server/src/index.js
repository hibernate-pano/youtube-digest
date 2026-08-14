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
const { HttpError, requireUser, json } = require("./middleware");
const { createStore } = require("./db");
const auth = require("./auth");
const notes = require("./routes/notes");
const vocabulary = require("./routes/vocabulary");
const reviews = require("./routes/reviews");
const meRoutes = require("./routes/me");

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const STATE_COOKIE = "ytd_oauth_state";

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

const COMPLETE_PAGE = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" />",
  "<title>YouTube Digest</title></head><body style=\"font-family: system-ui; max-width: 32em; margin: 4em auto; line-height: 1.6\">",
  "<h1>Signed in to GitHub</h1>",
  "<p>You can close this tab and return to YouTube Digest. Your notes, vocabulary, and review progress are saved to your own account.</p>",
  "</body></html>",
].join("");

async function handleLogin(ctx) {
  const env = ctx.env;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new HttpError(500, "GitHub OAuth is not configured on the server.");
  }
  const origin = new URL(ctx.request.url).origin;
  const redirectUri = origin + "/api/auth/callback";
  const state = auth.randomState();
  const authorizeUrl = auth.buildAuthorizeUrl({
    clientId: env.GITHUB_CLIENT_ID,
    redirectUri,
    state,
    scope: "read:user",
  });
  const response = redirect(authorizeUrl);
  response.headers.set(
    "Set-Cookie",
    auth.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAgeSeconds: 600,
    }),
  );
  return response;
}

async function handleCallback(ctx) {
  const env = ctx.env;
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
    { sub: String(user.id), githubId: user.githubId, login: user.login },
    env.JWT_SECRET,
    SESSION_TTL_SECONDS,
  );
  const response = redirect(origin + "/auth/complete#access_token=" + token);
  response.headers.set(
    "Set-Cookie",
    auth.setCookie(STATE_COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAgeSeconds: 0 }),
  );
  return response;
}

async function handleComplete() {
  return new Response(COMPLETE_PAGE, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Tiny path router. Patterns use `:name` segments; matched values land in
 * ctx.params. All data routes run through requireUser first.
 */
const ROUTES = [
  { method: "GET", pattern: "/api/auth/login", handler: handleLogin, public: true },
  { method: "GET", pattern: "/api/auth/callback", handler: handleCallback, public: true },
  { method: "GET", pattern: "/auth/complete", handler: handleComplete, public: true },
  { method: "GET", pattern: "/api/me", handler: meRoutes.me },
  { method: "GET", pattern: "/api/sync", handler: meRoutes.syncDelta },
  { method: "GET", pattern: "/api/notes", handler: notes.listNotes },
  { method: "POST", pattern: "/api/notes", handler: notes.createNote },
  { method: "PATCH", pattern: "/api/notes/:id", handler: notes.updateNote },
  { method: "DELETE", pattern: "/api/notes/:id", handler: notes.deleteNote },
  { method: "DELETE", pattern: "/api/notes/client/:clientId", handler: notes.deleteNoteByClientId },
  { method: "GET", pattern: "/api/vocabulary", handler: vocabulary.listVocabulary },
  { method: "POST", pattern: "/api/vocabulary", handler: vocabulary.upsertVocabulary },
  { method: "PATCH", pattern: "/api/vocabulary/:id", handler: vocabulary.updateVocabularyStatus },
  { method: "DELETE", pattern: "/api/vocabulary/:id", handler: vocabulary.deleteVocabulary },
  { method: "GET", pattern: "/api/reviews/due", handler: reviews.listDueReviews },
  { method: "POST", pattern: "/api/reviews/:vocabId", handler: reviews.submitReview },
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
        params[patternPart.slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternPart !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const match = matchRoute(request.method, url.pathname);
  if (!match) throw new HttpError(404, "Not found.");
  const { route, params } = match;
  const ctx = {
    request,
    env,
    params,
    store: env.store,
  };
  if (!route.public) {
    ctx.user = await requireUser(request, env);
  }
  return route.handler(ctx);
}

module.exports = {
  async fetch(request, env) {
    if (!env.store) env.store = createStore(env);
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("[youtube-digest-server]", error);
      return json({ error: error.message || "Internal server error." }, status);
    }
  },
};
