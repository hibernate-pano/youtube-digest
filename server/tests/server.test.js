const test = require("node:test");
const assert = require("node:assert/strict");

const jwt = require("../src/jwt");
const auth = require("../src/auth");
const { MemoryStore, createStore, applyGrade } = require("../src/db");
const worker = require("../src/index");

// The server refuses to sign or verify tokens with a secret shorter than 32
// characters, so the test secret has to clear that bar.
const SECRET = "test-" + "secret-0123456789abcdef-0123456789";

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
  // The token carries the account's token version, so deleting the account
  // revokes it (see the revocation test below).
  return jwt.signToken(
    {
      sub: String(user.id),
      githubId: user.githubId,
      login: user.login,
      tokenVersion: Number(user.tokenVersion) || 0,
    },
    SECRET,
    3600,
  );
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

test("sync responses carry the server's own clock", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");

  // The rows are stamped with the server's clock, but the client compares
  // them against timestamps taken from the device clock. Without a server
  // timestamp the client cannot tell which side of a conflict is newer, so
  // every sync response has to carry the server's own time.
  const before = Date.now();
  const listed = await api(env, "GET", "/api/notes", { token });
  const after = Date.now();
  assert.equal(typeof listed.data.serverTime, "string");
  const serverMs = Date.parse(listed.data.serverTime);
  assert.ok(Number.isFinite(serverMs), "serverTime must be a parsable timestamp");
  assert.ok(
    serverMs >= before - 1000 && serverMs <= after + 1000,
    "serverTime must be the server's current time, not a row timestamp",
  );

  const vocabulary = await api(env, "GET", "/api/vocabulary", { token });
  assert.equal(typeof vocabulary.data.serverTime, "string");
  const delta = await api(env, "GET", "/api/sync", { token });
  assert.equal(typeof delta.data.serverTime, "string");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "with a clock", videoId: "abc123xyz", clientId: "clock_1" },
  });
  assert.equal(typeof created.data.serverTime, "string");
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


test("export returns only the caller's data and deletes the account cleanly", async () => {
  const env = makeEnv();
  const aliceToken = await signIn(env, 1001, "alice");
  const bobToken = await signIn(env, 1002, "bob");
  await api(env, "POST", "/api/notes", {
    token: aliceToken,
    body: { note: "alice note", videoId: "abc123xyz", clientId: "alice_1" },
  });
  await api(env, "POST", "/api/notes", {
    token: bobToken,
    body: { note: "bob note", videoId: "def456uvw", clientId: "bob_1" },
  });
  await api(env, "POST", "/api/vocabulary", {
    token: aliceToken,
    body: { term: "insight", sentence: "A deep insight." },
  });

  const exported = await api(env, "GET", "/api/export", { token: aliceToken });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.user.login, "alice");
  assert.equal(exported.data.notes.length, 1);
  assert.equal(exported.data.notes[0].note, "alice note");
  assert.equal(exported.data.vocabulary.length, 1);
  assert.equal(exported.data.format, "youtube-digest-export-v1");

  const deleted = await api(env, "DELETE", "/api/account", { token: aliceToken });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.deleted, true);

  const after = await api(env, "GET", "/api/export", { token: aliceToken });
  assert.equal(
    after.status,
    401,
    "deleting the account revokes its token, so the export must be refused",
  );

  const bobExport = await api(env, "GET", "/api/export", { token: bobToken });
  assert.equal(bobExport.data.notes.length, 1);
});

test("status endpoint is public and reports service health", async () => {
  const env = makeEnv();
  const result = await api(env, "GET", "/api/status");
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.ok(typeof result.data.uptimeSeconds === "number");
  // The status probe is public: it must not hand an unauthenticated caller
  // internal error text or the request paths (which contain user ids).
  assert.deepEqual(
    Object.keys(result.data).sort(),
    ["ok", "uptimeSeconds"],
    "the public status payload must only expose health information",
  );
});

test("the status probe never echoes an internal error back to an anonymous caller", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  // Provoke a server-side failure whose message mentions a table name.
  env.store.listNotes = async () => {
    throw new Error('invalid input syntax for type uuid: "secret-note-id"');
  };
  await api(env, "GET", "/api/notes", { token });

  const status = await api(env, "GET", "/api/status");
  assert.equal(status.status, 200);
  const body = JSON.stringify(status.data);
  assert.doesNotMatch(body, /uuid/i, "the public probe must not leak driver messages");
  assert.doesNotMatch(body, /secret-note-id/, "the public probe must not leak resource ids");
  assert.doesNotMatch(body, /api\/notes/, "the public probe must not leak request paths");
});

// ---------------------------------------------------------------------------
// Security and correctness regressions
// ---------------------------------------------------------------------------

test("a review body that is not JSON is rejected without touching the schedule", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/vocabulary", {
    token,
    body: { term: "ephemeral", sentence: "Fleeting moment." },
  });
  const vocabId = created.data.vocabulary.id;

  const graded = await api(env, "POST", "/api/reviews/" + vocabId, {
    token,
    body: { grade: 4 },
  });
  assert.equal(graded.status, 200);
  const before = await api(env, "GET", "/api/export", { token });
  const beforeReview = before.data.reviews[0];
  assert.equal(beforeReview.lapses, 0);
  assert.equal(beforeReview.intervalDays, 2);

  // A truncated body must not be mistaken for grade 0 ("Again").
  const truncated = new Request("https://test.example/api/reviews/" + vocabId, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: '{"grade":',
  });
  const response = await worker.fetch(truncated, env);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /must be JSON/i);

  // The schedule must be untouched: no lapse, no ease drop, same interval.
  const after = await api(env, "GET", "/api/export", { token });
  const afterReview = after.data.reviews[0];
  assert.equal(afterReview.lapses, beforeReview.lapses, "a bad body must not count as a lapse");
  assert.equal(afterReview.intervalDays, beforeReview.intervalDays);
  assert.equal(afterReview.ease, beforeReview.ease);
});

test("a JSON review body with an invalid grade names the grade, not the body", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/vocabulary", {
    token,
    body: { term: "ephemeral", sentence: "Fleeting moment." },
  });
  const vocabId = created.data.vocabulary.id;

  for (const body of [{}, { grade: null }, { grade: "" }, { grade: "high" }, { grade: 9 }]) {
    const result = await api(env, "POST", "/api/reviews/" + vocabId, { token, body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.data.error, /grade must be an integer from 0 to 5/i);
  }

  // The word is still untouched: it was never graded.
  const exported = await api(env, "GET", "/api/export", { token });
  assert.equal(exported.data.reviews[0].reps, 0);
  assert.equal(exported.data.reviews[0].lapses, 0);
});

test("a malformed review grade is never coerced into a numeric zero", async () => {
  const { parseReviewGrade } = require("../src/validate");
  assert.equal(parseReviewGrade(null), null);
  assert.equal(parseReviewGrade(undefined), null);
  assert.equal(parseReviewGrade(""), null);
  assert.equal(parseReviewGrade("   "), null);
  assert.equal(parseReviewGrade(false), null);
  assert.equal(parseReviewGrade([]), null);
  assert.equal(parseReviewGrade({}), null);
  assert.equal(parseReviewGrade(3), 3);
  assert.equal(parseReviewGrade("3"), 3);
  assert.equal(parseReviewGrade(0), 0);
  assert.equal(parseReviewGrade(5), 5);
  assert.equal(parseReviewGrade(1.5), null);
  assert.equal(parseReviewGrade(6), null);
});

test("a malformed JWT signature is an expired session, not a server error", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const parts = token.split(".");

  const badSignature = await api(env, "GET", "/api/me", {
    token: parts[0] + "." + parts[1] + ".!!!!not-base64!!!!",
  });
  assert.equal(badSignature.status, 401, "a broken signature must be 401, never 500");
  assert.match(badSignature.data.error, /invalid or expired session/i);

  const badBody = await api(env, "GET", "/api/me", {
    token: parts[0] + ".!!!not-base64!!!." + parts[2],
  });
  assert.equal(badBody.status, 401);
});

test("a missing or short JWT secret is reported as a configuration error", async () => {
  for (const secret of ["", "too-short"]) {
    const env = makeEnv({ JWT_SECRET: secret });
    const login = await api(env, "GET", "/api/auth/login");
    assert.equal(login.status, 500, JSON.stringify(secret));
    assert.match(login.data.error, /JWT_SECRET missing or too short/i);

    const callback = new Request(
      "https://test.example/api/auth/callback?code=abc&state=state-1",
      { headers: { cookie: "ytd_oauth_state=state-1" } },
    );
    const response = await worker.fetch(callback, env);
    assert.equal(response.status, 500);
    const data = await response.json();
    assert.match(data.error, /JWT_SECRET missing or too short/i);

    // The data routes must say the same thing. A 401 here would look like
    // "your session expired" and send the user round the sign-in loop
    // instead of telling the operator the server is misconfigured.
    const me = await api(env, "GET", "/api/me");
    assert.equal(me.status, 500, JSON.stringify(secret));
    assert.match(me.data.error, /JWT_SECRET missing or too short/i);
  }
});

test("OAuth cookies are marked Secure", async () => {
  const env = makeEnv();
  const login = await api(env, "GET", "/api/auth/login?redirect=/dashboard");
  const cookies = login.response.headers.getSetCookie
    ? login.response.headers.getSetCookie()
    : [login.response.headers.get("set-cookie") || ""];
  assert.ok(cookies.length >= 1);
  for (const cookie of cookies) {
    assert.match(cookie, /Secure/, "the CSRF state cookie must not travel in cleartext");
    assert.match(cookie, /HttpOnly/);
  }
});

test("responses carry hardening headers", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");

  const me = await api(env, "GET", "/api/me", { token });
  assert.equal(me.response.headers.get("cache-control"), "no-store");
  assert.equal(me.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(me.response.headers.get("x-content-type-options"), "nosniff");

  const login = await api(env, "GET", "/api/auth/login");
  assert.equal(login.response.headers.get("cache-control"), "no-store");
  assert.equal(login.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(login.response.headers.get("x-content-type-options"), "nosniff");

  const complete = await api(env, "GET", "/auth/complete");
  assert.equal(complete.response.headers.get("cache-control"), "no-store");
  assert.equal(complete.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(complete.response.headers.get("x-content-type-options"), "nosniff");
});

test("the dashboard ships a Content-Security-Policy", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(
    path.join(__dirname, "..", "dashboard", "index.html"),
    "utf8",
  );
  assert.match(html, /http-equiv="Content-Security-Policy"/i);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  // The policy is only safe because the dashboard has no inline handlers.
  assert.doesNotMatch(html, /on(click|change|submit|load|input|error)\s*=/i);
});

test("an oversized request body is rejected before it is parsed", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const big = JSON.stringify({ note: "x".repeat(200_000), clientId: "big_1" });

  const declared = new Request("https://test.example/api/notes", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Content-Length": String(big.length),
    },
    body: big,
  });
  const declaredResponse = await worker.fetch(declared, env);
  assert.equal(declaredResponse.status, 413);

  // Even without a content-length header the body must be capped.
  const undeclared = new Request("https://test.example/api/notes", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: big,
  });
  const undeclaredResponse = await worker.fetch(undeclared, env);
  assert.equal(undeclaredResponse.status, 413);

  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.data.notes.length, 0, "a rejected body must not be stored");
});

test("mutating routes are rate limited per user", async () => {
  const env = makeEnv();
  const token = await signIn(env, 4242, "flooder");
  const statuses = [];
  for (let i = 0; i < 125; i += 1) {
    const result = await api(env, "POST", "/api/notes", {
      token,
      body: { note: "flood " + i, videoId: "abc123xyz", clientId: "flood_1" },
    });
    statuses.push(result.status);
  }
  assert.equal(statuses[119], 201, "the 120th request in the window is still allowed");
  assert.equal(statuses[120], 429, "the 121st request in the window is rejected");
  assert.equal(statuses[124], 429);
});

test("reads are rate limited per user too", async () => {
  const env = makeEnv();
  const token = await signIn(env, 4343, "reader");
  const statuses = [];
  for (let i = 0; i < 605; i += 1) {
    const result = await api(env, "GET", "/api/notes", { token });
    statuses.push(result.status);
  }
  // A read is not free: every list endpoint can return thousands of rows.
  assert.equal(statuses[599], 200, "the 600th read in the window is still allowed");
  assert.equal(statuses[600], 429, "the 601st read in the window is rejected");
});

test("the rate limiter releases a key once the window passes", () => {
  const { createRateLimiter } = require("../src/middleware");
  const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter("k"), true);
  assert.equal(limiter("k"), true);
  assert.equal(limiter("k"), false);
  assert.equal(limiter.mapSize(), 1);
  // Past the window the key is dropped instead of lingering in the map.
  assert.equal(limiter("k", Date.now() + 5000), true);
  assert.equal(limiter.mapSize(), 1);
  assert.equal(limiter("k", Date.now() + 20000), true);
  assert.equal(limiter.mapSize(), 1, "an idle key must not stay in the map forever");
});

test("a malformed cookie is skipped instead of crashing the callback", async () => {
  const env = makeEnv();
  const request = new Request("https://test.example/api/auth/callback?code=abc&state=wrong", {
    headers: { cookie: "ytd_oauth_state=%; other=1" },
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /state mismatch/i);
});

test("a malformed path segment is a bad request, not a server error", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  // A truncated percent-escape: decoding it throws, which must be reported
  // as a client error instead of crashing the worker.
  const request = new Request("https://test.example/api/notes/%", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ note: "x" }),
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 400);
});

test("a malformed id in the path is a not-found, not a database error", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const patch = await api(env, "PATCH", "/api/notes/not-a-uuid", {
    token,
    body: { note: "x" },
  });
  assert.equal(patch.status, 404);
  const review = await api(env, "POST", "/api/reviews/not-a-uuid", {
    token,
    body: { grade: 3 },
  });
  assert.equal(review.status, 404);
  const vocab = await api(env, "PATCH", "/api/vocabulary/not-a-uuid", {
    token,
    body: { status: "mastered" },
  });
  assert.equal(vocab.status, 404);
});

test("a database failure is reported generically", async () => {
  const env = makeEnv();
  const token = await jwt.signToken(
    { sub: "1", githubId: 1001, login: "alice", tokenVersion: 0 },
    SECRET,
    3600,
  );
  env.store = {
    async getTokenVersion() {
      return 0;
    },
    async listNotes() {
      throw new Error('invalid input syntax for type uuid: "abc"');
    },
  };
  const result = await api(env, "GET", "/api/notes", { token });
  assert.equal(result.status, 500);
  assert.match(result.data.error, /internal server error/i);
  assert.doesNotMatch(JSON.stringify(result.data), /uuid/i, "driver messages must not leak");
});

test("the review interval never grows past a year", () => {
  let review = { intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 };
  for (let i = 0; i < 40; i += 1) {
    review = applyGrade(review, 5, new Date("2026-01-01T00:00:00Z"));
  }
  assert.ok(review.intervalDays <= 365, "the interval must be capped: " + review.intervalDays);
});

test("a partial note update leaves the fields it did not mention alone", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: {
      note: "original",
      clientId: "sparse_1",
      videoId: "abc123xyz",
      videoTitle: "A title",
      channelName: "A channel",
      timestampSeconds: 42,
      quote: "a quote",
    },
  });
  assert.equal(created.status, 201);
  const id = created.data.note.id;

  const patched = await api(env, "PATCH", "/api/notes/" + id, {
    token,
    body: { note: "edited" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.note.note, "edited");
  assert.equal(patched.data.note.videoTitle, "A title", "an omitted field must survive");
  assert.equal(patched.data.note.channelName, "A channel");
  assert.equal(patched.data.note.timestampSeconds, 42);
  assert.equal(patched.data.note.quote, "a quote");
  assert.equal(patched.data.note.clientId, "sparse_1", "the client id is the sync key");
});

test("a note update cannot rewrite the client id", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "original", clientId: "immutable_1", videoId: "abc123xyz" },
  });
  const id = created.data.note.id;
  const patched = await api(env, "PATCH", "/api/notes/" + id, {
    token,
    body: { note: "edited", clientId: "hijacked_1" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.note.clientId, "immutable_1");
  const exported = await api(env, "GET", "/api/export", { token });
  assert.equal(exported.data.notes[0].clientId, "immutable_1");
});

test("deleting the account revokes the session token", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  assert.equal((await api(env, "GET", "/api/me", { token })).status, 200);

  const deleted = await api(env, "DELETE", "/api/account", { token });
  assert.equal(deleted.status, 200);

  const after = await api(env, "GET", "/api/me", { token });
  assert.equal(after.status, 401, "a deleted account must not keep a working token");
  const write = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "after deletion", clientId: "ghost_1" },
  });
  assert.equal(write.status, 401);
});

test("/api/sync rejects an unparseable since parameter", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const result = await api(env, "GET", "/api/sync?since=not-a-date", { token });
  assert.equal(result.status, 400);
  const ok = await api(env, "GET", "/api/sync?since=2000-01-01T00:00:00Z", { token });
  assert.equal(ok.status, 200);
});

test("the export reports whether rows were left out", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  await api(env, "POST", "/api/notes", {
    token,
    body: { note: "a note", clientId: "export_1" },
  });
  const exported = await api(env, "GET", "/api/export", { token });
  assert.equal(exported.status, 200);
  assert.ok(exported.data.truncated, "the export must report truncation");
  assert.equal(exported.data.truncated.notes, 0);
  assert.equal(exported.data.truncated.vocabulary, 0);
});

