const test = require("node:test");
const assert = require("node:assert/strict");

const jwt = require("../src/jwt");
const auth = require("../src/auth");
const { MemoryStore, createStore, applyGrade } = require("../src/db");
const worker = require("../src/index");

const SECRET = "test-" + "secret-0123456789abcdef";

function makeEnv(overrides) {
  return Object.assign({
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    JWT_SECRET: SECRET,
    DATABASE_URL: "",
    store: new MemoryStore(),
  }, overrides || {});
}

async function api(env, method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request("https://test.example" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data, response };
}

async function signIn(env, githubId, login) {
  const user = await env.store.upsertUser({ githubId, login, avatarUrl: "" });
  return jwt.signToken({ sub: String(user.id), githubId: user.githubId, login: user.login }, SECRET, 3600);
}

test("JWT round-trips, rejects tampering, and rejects expiry", async () => {
  const token = await jwt.signToken({ sub: "1", githubId: 42, login: "alice" }, SECRET, 3600);
  const payload = await jwt.verifyToken(token, SECRET);
  assert.equal(payload.sub, "1");
  assert.equal(payload.githubId, 42);
  assert.equal(payload.login, "alice");
  assert.equal(await jwt.verifyToken(token + "x", SECRET), null);
  assert.equal(await jwt.verifyToken(token, SECRET + "other"), null);
  const expired = await jwt.signToken({ sub: "1" }, SECRET, -10);
  assert.equal(await jwt.verifyToken(expired, SECRET), null);
});

test("authorize URL carries client id, redirect, and state", () => {
  const url = auth.buildAuthorizeUrl({
    clientId: "abc",
    redirectUri: "https://example.test/api/auth/callback",
    state: "state-1",
    scope: "read:user",
  });
  assert.match(url, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.match(url, /client_id=abc/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fexample\.test%2Fapi%2Fauth%2Fcallback/);
  assert.match(url, /state=state-1/);
  assert.match(url, /scope=read%3Auser/);
  assert.equal(auth.randomState().length, 48);
});

test("login route redirects to GitHub and sets a state cookie", async () => {
  const env = makeEnv();
  const result = await api(env, "GET", "/api/auth/login");
  assert.equal(result.status, 302);
  const location = result.response.headers.get("location");
  assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.match(location, /client_id=client-id/);
  const cookie = result.response.headers.get("set-cookie") || "";
  assert.match(cookie, /ytd_oauth_state=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("unauthenticated data routes return 401", async () => {
  const env = makeEnv();
  for (const path of ["/api/me", "/api/notes", "/api/vocabulary", "/api/reviews/due"]) {
    const result = await api(env, "GET", path);
    assert.equal(result.status, 401, path);
  }
});

test("notes are fully isolated between GitHub accounts", async () => {
  const env = makeEnv();
  const aliceToken = await signIn(env, 1001, "alice");
  const bobToken = await signIn(env, 1002, "bob");

  const created = await api(env, "POST", "/api/notes", {
    token: aliceToken,
    body: { note: "Alice's note", videoId: "abc123xyz", clientId: "note_local_1" },
  });
  assert.equal(created.status, 201);
  const noteId = created.data.note.id;
  assert.equal(created.data.note.clientId, "note_local_1");

  // Idempotent: pushing the same clientId again updates, never duplicates.
  const recreated = await api(env, "POST", "/api/notes", {
    token: aliceToken,
    body: { note: "Alice's note v2", videoId: "abc123xyz", clientId: "note_local_1" },
  });
  assert.equal(recreated.status, 201);
  assert.equal(recreated.data.note.id, noteId);
  const afterDedupe = await api(env, "GET", "/api/notes", { token: aliceToken });
  assert.equal(afterDedupe.data.notes.length, 1);
  assert.equal(afterDedupe.data.notes[0].note, "Alice's note v2");

  // Bob cannot delete by Alice's clientId.
  const bobClientDelete = await api(env, "DELETE", "/api/notes/client/note_local_1", {
    token: bobToken,
  });
  assert.equal(bobClientDelete.status, 404);
  const aliceClientDelete = await api(env, "DELETE", "/api/notes/client/note_local_1", {
    token: aliceToken,
  });
  assert.equal(aliceClientDelete.status, 200);
  const afterDelete = await api(env, "GET", "/api/notes", { token: aliceToken });
  assert.equal(afterDelete.data.notes.length, 0);

  // Bob never sees Alice's rows and cannot act on her ids.
  const bobList = await api(env, "GET", "/api/notes", { token: bobToken });
  assert.equal(bobList.data.notes.length, 0);
  const bobUpdate = await api(env, "PATCH", "/api/notes/" + noteId, {
    token: bobToken,
    body: { note: "stolen" },
  });
  assert.equal(bobUpdate.status, 404);
  const bobDelete = await api(env, "DELETE", "/api/notes/" + noteId, { token: bobToken });
  assert.equal(bobDelete.status, 404);
});

test("vocabulary upserts by (user, term, sentence) and is isolated", async () => {
  const env = makeEnv();
  const aliceToken = await signIn(env, 1001, "alice");
  const bobToken = await signIn(env, 1002, "bob");
  const base = { term: "serendipity", sentence: "A happy accident.", translation: "意外之喜" };

  const first = await api(env, "POST", "/api/vocabulary", { token: aliceToken, body: base });
  assert.equal(first.status, 201);
  const second = await api(env, "POST", "/api/vocabulary", { token: aliceToken, body: base });
  assert.equal(second.status, 201);
  assert.equal(second.data.vocabulary.id, first.data.vocabulary.id);

  await api(env, "POST", "/api/vocabulary", { token: bobToken, body: base });
  const bobList = await api(env, "GET", "/api/vocabulary", { token: bobToken });
  assert.equal(bobList.data.vocabulary.length, 1);
  const aliceList = await api(env, "GET", "/api/vocabulary", { token: aliceToken });
  assert.equal(aliceList.data.vocabulary.length, 1);
  assert.equal(aliceList.data.vocabulary[0].id, first.data.vocabulary.id);
});

test("review scheduling follows SM-2 flavors and is isolated", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const again = applyGrade({ intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 }, 0, now);
  assert.equal(again.intervalDays, 0);
  assert.equal(again.lapses, 1);
  assert.ok(again.ease < 2.5);
  const firstGood = applyGrade({ intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 }, 3, now);
  assert.equal(firstGood.intervalDays, 1);
  assert.equal(firstGood.reps, 1);
  const secondEasy = applyGrade(firstGood, 5, now);
  assert.equal(secondEasy.intervalDays, 4);
  assert.equal(secondEasy.reps, 2);

  const env = makeEnv();
  const aliceToken = await signIn(env, 1001, "alice");
  const bobToken = await signIn(env, 1002, "bob");
  const created = await api(env, "POST", "/api/vocabulary", {
    token: aliceToken,
    body: { term: "ephemeral", sentence: "Fleeting moment." },
  });
  const vocabId = created.data.vocabulary.id;

  const due = await api(env, "GET", "/api/reviews/due", { token: aliceToken });
  assert.equal(due.data.reviews.length, 1);
  assert.equal(due.data.reviews[0].vocabulary.term, "ephemeral");

  const graded = await api(env, "POST", "/api/reviews/" + vocabId, {
    token: aliceToken,
    body: { grade: 4 },
  });
  assert.equal(graded.status, 200);
  assert.equal(graded.data.review.intervalDays, 2);
  assert.equal(graded.data.review.reps, 1);
  assert.ok(new Date(graded.data.review.dueAt) > new Date());

  const bobGrade = await api(env, "POST", "/api/reviews/" + vocabId, {
    token: bobToken,
    body: { grade: 5 },
  });
  assert.equal(bobGrade.status, 404);
  const bobDue = await api(env, "GET", "/api/reviews/due", { token: bobToken });
  assert.equal(bobDue.data.reviews.length, 0);
});

test("sync delta returns only changed rows for the caller", async () => {
  const env = makeEnv();
  const aliceToken = await signIn(env, 1001, "alice");
  const bobToken = await signIn(env, 1002, "bob");
  await api(env, "POST", "/api/notes", {
    token: aliceToken,
    body: { note: "before", videoId: "abc123xyz", clientId: "alice_sync_1" },
  });
  await api(env, "POST", "/api/notes", {
    token: bobToken,
    body: { note: "bob note", videoId: "def456uvw", clientId: "bob_sync_1" },
  });
  const aliceDelta = await api(env, "GET", "/api/sync?since=2000-01-01T00:00:00Z", { token: aliceToken });
  assert.equal(aliceDelta.data.notes.length, 1);
  assert.equal(aliceDelta.data.notes[0].note, "before");
  assert.equal(aliceDelta.data.vocabulary.length, 0);
  const bobDelta = await api(env, "GET", "/api/sync?since=2000-01-01T00:00:00Z", { token: bobToken });
  assert.equal(bobDelta.data.notes.length, 1);
  assert.equal(bobDelta.data.notes[0].note, "bob note");
});

test("input validation caps lengths and rejects empty payloads", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const empty = await api(env, "POST", "/api/notes", { token, body: { note: "   " } });
  assert.equal(empty.status, 400);
  const noClient = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "valid but no clientId", videoId: "abc123xyz" },
  });
  assert.equal(noClient.status, 400);
  const oversized = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "x".repeat(25_000), videoId: "abc123xyz", clientId: "oversized_1" },
  });
  assert.equal(oversized.status, 201);
  assert.ok(oversized.data.note.note.length <= 20_000);
  const badStatus = await api(env, "POST", "/api/vocabulary", {
    token,
    body: { term: "t", status: "hacked" },
  });
  assert.equal(badStatus.status, 201);
  assert.equal(badStatus.data.vocabulary.status, "learning");
});

test("callback rejects mismatched OAuth state", async () => {
  const env = makeEnv();
  const request = new Request("https://test.example/api/auth/callback?code=abc&state=wrong", {
    headers: { cookie: "ytd_oauth_state=expected" },
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /state mismatch/i);
});

test("login endpoint rate-limits repeated attempts per client", async () => {
  const env = makeEnv();
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  let lastStatus = 0;
  for (let i = 0; i < 25; i++) {
    const request = new Request("https://test.example/api/auth/login", { headers });
    const response = await worker.fetch(request, env);
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429);
  const other = await worker.fetch(
    new Request("https://test.example/api/auth/login", { headers: { "cf-connecting-ip": "203.0.113.10" } }),
    env,
  );
  assert.equal(other.status, 302);
});

test("unconfigured server refuses to start OAuth", async () => {
  const env = makeEnv({ GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" });
  const result = await api(env, "GET", "/api/auth/login");
  assert.equal(result.status, 500);
  assert.match(result.data.error, /not configured/i);
});

test("createStore falls back to memory without DATABASE_URL", () => {
  const store = createStore({});
  assert.ok(store instanceof MemoryStore);
});

test("notes can be starred and unstarred by their owner only", async () => {
  const env = makeEnv();
  const aliceToken = await signIn(env, 1001, "alice");
  const bobToken = await signIn(env, 1002, "bob");
  const created = await api(env, "POST", "/api/notes", {
    token: aliceToken,
    body: { note: "favorite idea", videoId: "abc123xyz", clientId: "note_star_1" },
  });
  const noteId = created.data.note.id;
  assert.equal(created.data.note.starred, false);

  const starred = await api(env, "PATCH", "/api/notes/" + noteId + "/star", {
    token: aliceToken,
    body: { starred: true },
  });
  assert.equal(starred.status, 200);
  assert.equal(starred.data.note.starred, true);

  const bobStar = await api(env, "PATCH", "/api/notes/" + noteId + "/star", {
    token: bobToken,
    body: { starred: true },
  });
  assert.equal(bobStar.status, 404);

  const badBody = await api(env, "PATCH", "/api/notes/" + noteId + "/star", {
    token: aliceToken,
    body: { starred: "yes" },
  });
  assert.equal(badBody.status, 400);

  const unstarred = await api(env, "PATCH", "/api/notes/" + noteId + "/star", {
    token: aliceToken,
    body: { starred: false },
  });
  assert.equal(unstarred.data.note.starred, false);
});

test("OAuth login honors only same-origin redirect paths", async () => {
  const env = makeEnv();
  const login = await api(env, "GET", "/api/auth/login?redirect=/dashboard");
  const setCookieHeaders = login.response.headers.getSetCookie
    ? login.response.headers.getSetCookie()
    : [login.response.headers.get("set-cookie") || ""];
  const joined = setCookieHeaders.join("\n");
  // Both cookies must survive: a single Set-Cookie header would have been
  // overwritten by the second one (the bug that broke dashboard sign-in).
  assert.equal(setCookieHeaders.length, 2, joined);
  assert.match(joined, /ytd_oauth_state=/);
  assert.match(joined, /ytd_oauth_redirect=%2Fdashboard/);
  assert.match(joined, /HttpOnly/);

  const evil = await api(env, "GET", "/api/auth/login?redirect=https://evil.example");
  const evilCookies = evil.response.headers.get("set-cookie") || "";
  assert.doesNotMatch(evilCookies, /ytd_oauth_redirect=/);

  const protoRelative = await api(env, "GET", "/api/auth/login?redirect=//evil.example");
  const protoCookies = protoRelative.response.headers.get("set-cookie") || "";
  assert.doesNotMatch(protoCookies, /ytd_oauth_redirect=/);

  const weird = await api(env, "GET", "/api/auth/login?redirect=/dash%0dboard");
  const weirdCookies = weird.response.headers.get("set-cookie") || "";
  assert.doesNotMatch(weirdCookies, /ytd_oauth_redirect=/);
});

test("callback redirects to the stored same-origin path with the token", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const request = new Request("https://test.example/api/auth/callback?code=abc&state=expected", {
    headers: {
      cookie: "ytd_oauth_state=expected; ytd_oauth_redirect=%2Fdashboard",
    },
  });
  // Stub the GitHub exchange so no network is needed.
  const originalExchange = require("../src/auth").exchangeCode;
  const originalFetchUser = require("../src/auth").fetchGithubUser;
  require("../src/auth").exchangeCode = async () => "gh-token";
  require("../src/auth").fetchGithubUser = async () => ({
    githubId: 1001,
    login: "alice",
    avatarUrl: "",
  });
  try {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";
    assert.match(location, /^https:\/\/test\.example\/dashboard#access_token=/);
    assert.ok(location.length > 60);
  } finally {
    require("../src/auth").exchangeCode = originalExchange;
    require("../src/auth").fetchGithubUser = originalFetchUser;
  }
});

