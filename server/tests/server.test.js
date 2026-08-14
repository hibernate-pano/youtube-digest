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
    body: { note: "Alice's note", videoId: "abc123xyz" },
  });
  assert.equal(created.status, 201);
  const noteId = created.data.note.id;

  const aliceList = await api(env, "GET", "/api/notes", { token: aliceToken });
  assert.equal(aliceList.data.notes.length, 1);
  assert.equal(aliceList.data.notes[0].note, "Alice's note");

  const bobList = await api(env, "GET", "/api/notes", { token: bobToken });
  assert.equal(bobList.data.notes.length, 0);

  const bobUpdate = await api(env, "PATCH", "/api/notes/" + noteId, {
    token: bobToken,
    body: { note: "stolen" },
  });
  assert.equal(bobUpdate.status, 404);

  const bobDelete = await api(env, "DELETE", "/api/notes/" + noteId, { token: bobToken });
  assert.equal(bobDelete.status, 404);

  const aliceStillHasIt = await api(env, "GET", "/api/notes", { token: aliceToken });
  assert.equal(aliceStillHasIt.data.notes.length, 1);
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
    body: { note: "before", videoId: "abc123xyz" },
  });
  await api(env, "POST", "/api/notes", {
    token: bobToken,
    body: { note: "bob note", videoId: "def456uvw" },
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
  const oversized = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "x".repeat(25_000), videoId: "abc123xyz" },
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
