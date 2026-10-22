const test = require("node:test");
const assert = require("node:assert/strict");

const jwt = require("../src/jwt");
const auth = require("../src/auth");
const {
  MemoryStore,
  createStore,
  applyGrade,
  StorageLimitError,
  MAX_ACCOUNT_ROWS,
  MAX_EXPORT_BYTES,
} = require("../src/db");
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

async function api(env, method, path, { token, body, device } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (device) headers["X-Device-Id"] = device;
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

/**
 * Runs a request with the console output captured.
 *
 * @param {() => Promise<unknown>} run what to do while the capture is on.
 * @returns {Promise<{result: unknown, log: string}>}
 */
async function captureLog(run) {
  const lines = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    const result = await run();
    return { result, log: lines.join("\n") };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    console.log = originalLog;
  }
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

test("a token's signature is checked without a timing side channel", async () => {
  // A signature that is compared byte by byte, stopping at the first
  // difference, tells an attacker how many bytes of a forgery were right.
  // The platform's verify does the comparison in constant time, so the
  // test watches for it being the one that checks the signature.
  const original = crypto.subtle.verify;
  const calls = [];
  crypto.subtle.verify = function (...args) {
    calls.push(args);
    return original.apply(this, args);
  };
  try {
    const token = await jwt.signToken(
      { sub: "1", githubId: 42, login: "alice" },
      SECRET,
      3600,
    );

    // A valid token still verifies, and the token format is unchanged.
    assert.equal(token.split(".").length, 3);
    const payload = await jwt.verifyToken(token, SECRET);
    assert.equal(payload.sub, "1");
    assert.equal(payload.githubId, 42);
    assert.equal(calls.length, 1, "the signature must be checked by crypto.subtle.verify");

    // A forged signature of the right length still fails.
    const parts = token.split(".");
    const forged =
      parts[0] + "." + parts[1] + "." + (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    assert.equal(await jwt.verifyToken(forged, SECRET), null);

    // A token signed with another key fails too.
    assert.equal(await jwt.verifyToken(token, SECRET + "other"), null);
    assert.equal(calls.length, 3);

    // And a malformed signature is an expired session, never a crash.
    assert.equal(await jwt.verifyToken(token + "x", SECRET), null);
  } finally {
    crypto.subtle.verify = original;
  }
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
  assert.match(cookie, /__Host-ytd_oauth_state=/);
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

test("a capped delta says so, so the device does not keep what was deleted", async () => {
  // A delta that stops at the cap without saying so is a lie the device
  // believes. The deletion list is the dangerous half: "delete all notes"
  // stamps every tombstone with one timestamp, so no later `since` can fetch
  // the rows the cap left behind. The device would keep notes the user
  // deleted, and the truth would never reach it.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  for (let index = 0; index < 5_001; index += 1) {
    env.store.notes.set("n" + index, {
      id: "n" + index,
      userId: String(user.id),
      clientId: "c" + index,
      videoId: "abc123xyz",
      videoTitle: "Video",
      channelName: "Channel",
      timestampSeconds: 0,
      quote: "",
      note: "note " + index,
      starred: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });
  }

  const changed = await api(env, "GET", "/api/sync?since=2000-01-01T00:00:00Z", { token });
  assert.equal(changed.data.notes.length, 5_000, "the changed list is capped");
  assert.equal(changed.data.truncated.notes, true, "the changed list does not say it was capped");
  assert.equal(changed.data.truncated.deletedNotes, false, "nothing was deleted");

  await api(env, "DELETE", "/api/notes", { token });
  const after = await api(env, "GET", "/api/sync?since=2000-01-01T00:00:00Z", { token });
  assert.equal(after.data.deleted.notes.length, 5_000, "the deletion list is capped");
  assert.equal(
    after.data.truncated.deletedNotes,
    true,
    "the deletion list does not say it was capped",
  );

  // An account under the cap is not cut short, and says so on every list.
  const small = makeEnv();
  const smallToken = await signIn(small, 1002, "bob");
  await api(small, "POST", "/api/notes", {
    token: smallToken,
    body: { note: "one note", videoId: "abc123xyz", clientId: "small_1" },
  });
  const smallDelta = await api(small, "GET", "/api/sync?since=2000-01-01T00:00:00Z", {
    token: smallToken,
  });
  assert.deepEqual(smallDelta.data.truncated, {
    notes: false,
    vocabulary: false,
    deletedNotes: false,
    deletedVocabulary: false,
  });
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
    headers: { cookie: "__Host-ytd_oauth_state=expected" },
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

test("a Worker without a database refuses to serve instead of pretending", async () => {
  // The in-memory store lives in one instance of the Worker: every account
  // would look empty, every note would vanish at the next deploy, and no
  // error would ever mention the database.
  assert.throws(
    () => createStore({}),
    /database/i,
    "a Worker without a database must not fall back to a store in memory",
  );

  const env = makeEnv({ DATABASE_URL: "", store: undefined });
  const result = await api(env, "GET", "/api/status");
  assert.equal(result.status, 503);
  assert.match(
    result.data.error,
    /database/i,
    "the error has to name the database, not just say something went wrong",
  );
});

test("a deleted note is never handed back", async () => {
  // The privacy policy says a marked row is never served. The lists keep
  // that promise, but the three PATCH routes did not: they updated the
  // tombstone and returned the note - the user's own words - in the
  // answer. A second device that still held the note would star it, get
  // the deleted text back, and put it into its own storage.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");

  const created = await api(env, "POST", "/api/notes", {
    token,
    body: {
      note: "the sentence the user wrote and then deleted",
      videoId: "abc123xyz",
      clientId: "note_local_deleted",
    },
  });
  assert.equal(created.status, 201);
  const noteId = created.data.note.id;

  const deleted = await api(env, "DELETE", "/api/notes/" + noteId, { token });
  assert.equal(deleted.status, 200);

  const starred = await api(env, "PATCH", "/api/notes/" + noteId + "/star", {
    token,
    body: { starred: true },
  });
  assert.equal(starred.status, 404, "a deleted note was starred");
  assert.equal(
    JSON.stringify(starred.data).includes("the sentence the user wrote"),
    false,
    `the answer carried the deleted note back: ${JSON.stringify(starred.data)}`,
  );

  const edited = await api(env, "PATCH", "/api/notes/" + noteId, {
    token,
    body: { note: "edited after deletion" },
  });
  assert.equal(edited.status, 404, "a deleted note was edited");
  assert.equal(
    JSON.stringify(edited.data).includes("the sentence the user wrote"),
    false,
    `the answer carried the deleted note back: ${JSON.stringify(edited.data)}`,
  );

  // The list keeps its promise too, and so does the export.
  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.data.notes.length, 0);
});

test("a deleted word is never handed back", async () => {
  // The same promise for the words. The answer carries the word and the
  // sentence it was seen in, which is the user's own text.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");

  const created = await api(env, "POST", "/api/vocabulary", {
    token,
    body: {
      term: "serendipity",
      sentence: "A happy accident, the sentence the user wrote.",
      translation: "意外之喜",
    },
  });
  assert.equal(created.status, 201);
  const vocabId = created.data.vocabulary.id;

  const deleted = await api(env, "DELETE", "/api/vocabulary/" + vocabId, { token });
  assert.equal(deleted.status, 200);

  const graded = await api(env, "PATCH", "/api/vocabulary/" + vocabId, {
    token,
    body: { status: "mastered" },
  });
  assert.equal(graded.status, 404, "a deleted word was graded");
  assert.equal(
    JSON.stringify(graded.data).includes("A happy accident"),
    false,
    `the answer carried the deleted word back: ${JSON.stringify(graded.data)}`,
  );
});

test("the export can be asked for one part at a time", async () => {
  // An account too big for one file used to be a dead end: the service
  // refused, and there was no way to get the data in pieces. Asking for the
  // notes alone, or the words alone, makes the download possible again.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  env.store.notes.set("n1", {
    id: "n1",
    userId: String(user.id),
    clientId: "c1",
    videoId: "abc123xyz",
    videoTitle: "Video",
    channelName: "Channel",
    timestampSeconds: 0,
    quote: "",
    note: "a note",
    starred: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  env.store.vocabulary.set("w1", {
    id: "w1",
    userId: String(user.id),
    term: "word",
    translation: "translation",
    sentence: "sentence",
    sentenceTranslation: "",
    videoId: "abc123xyz",
    videoTitle: "Video",
    timestampSeconds: 0,
    status: "learning",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const notesOnly = await api(env, "GET", "/api/export?type=notes", { token });
  assert.equal(notesOnly.status, 200);
  assert.equal(notesOnly.data.notes.length, 1, "the notes are missing");
  assert.equal(
    notesOnly.data.vocabulary,
    undefined,
    "the export still carries the words the caller did not ask for",
  );
  assert.equal(notesOnly.data.part, "notes");

  const wordsOnly = await api(env, "GET", "/api/export?type=vocabulary", {
    token,
  });
  assert.equal(wordsOnly.status, 200);
  assert.equal(wordsOnly.data.vocabulary.length, 1, "the words are missing");
  assert.equal(
    wordsOnly.data.notes,
    undefined,
    "the export still carries the notes the caller did not ask for",
  );

  const both = await api(env, "GET", "/api/export", { token });
  assert.equal(both.data.notes.length, 1, "the whole export lost a note");
  assert.equal(
    both.data.vocabulary.length,
    1,
    "the whole export lost a word",
  );

  const wrong = await api(env, "GET", "/api/export?type=nonsense", { token });
  assert.equal(wrong.status, 400, "a nonsense type was accepted");
});

test("the export gives back every row the account holds", async () => {
  // The promise is "all of it". The export used to hold half the account:
  // an account with 12000 notes got the first 10000 of them and a
  // `truncated` field nobody read. The download looked complete and was
  // not, and the user had no way to tell.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  for (let index = 0; index < 10_001; index += 1) {
    env.store.notes.set("n" + index, {
      id: "n" + index,
      // The id the request carries is the one the token names, and the
      // token names it as a string.
      userId: String(user.id),
      clientId: "c" + index,
      videoId: "abc123xyz",
      videoTitle: "Video",
      channelName: "Channel",
      timestampSeconds: 0,
      quote: "",
      note: "note " + index,
      starred: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  const result = await api(env, "GET", "/api/export", { token });
  assert.equal(result.status, 200);
  assert.equal(
    result.data.notes.length,
    10_001,
    `the export held ${result.data.notes.length} of the account's 10001 notes`,
  );
  assert.equal(result.data.truncated.notes, 0, "the export says it left rows out");
});

test("an account at the cap can be exported in one file", async () => {
  // The account may own 20000 rows, and the byte cap has to be able to hold
  // them. The cap used to be 8MB and a full account's export is about
  // 12.7MB, so the service refused to export the biggest account it
  // allows: the promise "download all your data" broke at exactly the
  // accounts that had the most of it.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  // A realistic row: the note the user wrote, with the video it came from.
  const text =
    "A line of the note that the user wrote, about a hundred and twenty characters of plain English text that goes on for a while.";
  for (let index = 0; index < MAX_ACCOUNT_ROWS; index += 1) {
    env.store.notes.set("n" + index, {
      id: "n" + index,
      userId: String(user.id),
      clientId: "c" + index,
      videoId: "dQw4w9WgXcQ",
      videoTitle: "How Memory Works: a talk about how memory works",
      channelName: "Some Channel Name",
      timestampSeconds: index,
      quote: text,
      note: text,
      starred: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  const bytes = await env.store.estimateExportBytes(String(user.id));
  assert.ok(
    bytes <= MAX_EXPORT_BYTES,
    `a full account is ${bytes} bytes, which is over the ${MAX_EXPORT_BYTES} byte cap`,
  );

  const result = await api(env, "GET", "/api/export", { token });
  assert.equal(
    result.status,
    200,
    `the export of a legal account was refused: ${JSON.stringify(result.data).slice(0, 200)}`,
  );
  assert.equal(result.data.notes.length, MAX_ACCOUNT_ROWS, "the export left rows out");
});

test("the size of the export is measured from the whole blob, not from the text", async () => {
  // The estimate is what the byte cap is compared with. It used to count
  // the text of every row and nothing else, so it said 6MB for a blob of
  // 11MB: the cap protected the Worker a third less than it claimed to,
  // and a pathological account could still build a blob over the cap.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  for (let index = 0; index < 50; index += 1) {
    env.store.notes.set("n" + index, {
      id: "n" + index,
      userId: String(user.id),
      clientId: "c" + index,
      videoId: "dQw4w9WgXcQ",
      videoTitle: "How Memory Works: a talk about how memory works",
      channelName: "Some Channel Name",
      timestampSeconds: index,
      quote: "a quote",
      note: "a note the user wrote",
      starred: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  const exported = await api(env, "GET", "/api/export", { token });
  assert.equal(exported.status, 200);
  const blob = Buffer.byteLength(
    JSON.stringify({ notes: exported.data.notes, vocabulary: exported.data.vocabulary }),
  );
  const bytes = await env.store.estimateExportBytes(String(user.id));
  assert.ok(
    bytes >= blob,
    `the estimate says ${bytes} bytes and the blob is ${blob}: the cap would not protect the Worker`,
  );
});

test("the export can be asked for one part at a time", async () => {
  // An account too big for one file is fetched in two. The estimate has to
  // answer for the part that is asked for, or the second half is refused
  // by the cap of the first.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  await api(env, "POST", "/api/notes", {
    token,
    body: { note: "a note", videoId: "abc123xyz", clientId: "c1" },
  });
  await api(env, "POST", "/api/vocabulary", {
    token,
    body: { term: "serendipity", sentence: "A happy accident.", translation: "意外之喜" },
  });

  const notesOnly = await api(env, "GET", "/api/export?type=notes", { token });
  assert.equal(notesOnly.status, 200);
  assert.equal(notesOnly.data.notes.length, 1);
  assert.equal(
    notesOnly.data.vocabulary,
    undefined,
    "the words came with the notes half",
  );

  const wordsOnly = await api(env, "GET", "/api/export?type=vocabulary", { token });
  assert.equal(wordsOnly.status, 200);
  assert.equal(wordsOnly.data.vocabulary.length, 1);
  assert.equal(wordsOnly.data.notes, undefined, "the notes came with the words half");

  const whole = await env.store.estimateExportBytes(String(user.id));
  const part = await env.store.estimateExportBytes(String(user.id), "notes");
  assert.ok(part < whole, "the half is measured as if it were the whole");
});

test("the list says how many notes the account holds", async () => {
  // The page is capped, the account is not. A dashboard that shows the
  // number of rows it received tells the user a false number about their
  // own data: "5000 notes" for an account that holds 5001.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  for (let index = 0; index < 5_001; index += 1) {
    env.store.notes.set("n" + index, {
      id: "n" + index,
      userId: String(user.id),
      clientId: "c" + index,
      videoId: "abc123xyz",
      videoTitle: "Video",
      channelName: "Channel",
      timestampSeconds: 0,
      quote: "",
      note: "note " + index,
      starred: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.notes.length, 5_000, "the page is cut short");
  assert.equal(listed.data.total, 5_001, "the total is not the account");
  assert.equal(listed.data.truncated, true, "the answer does not say it was cut short");
  assert.ok(listed.data.serverTime, "the clock travels with the rows");

  // A small account is not cut short, and says so.
  const small = makeEnv();
  const smallToken = await signIn(small, 1002, "bob");
  await api(small, "POST", "/api/notes", {
    token: smallToken,
    body: { note: "one note", videoId: "abc123xyz", clientId: "c1" },
  });
  const smallList = await api(small, "GET", "/api/notes", { token: smallToken });
  assert.equal(smallList.data.total, 1);
  assert.equal(smallList.data.truncated, false);
});

test("the word list says how many words the account holds", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  await api(env, "POST", "/api/vocabulary", {
    token,
    body: { term: "serendipity", sentence: "A happy accident.", translation: "意外之喜" },
  });

  const listed = await api(env, "GET", "/api/vocabulary", { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.vocabulary.length, 1);
  assert.equal(listed.data.total, 1, "the total is not the account");
  assert.equal(listed.data.truncated, false);
  assert.ok(listed.data.serverTime, "the clock travels with the rows");
});

test("deleting all notes reaches the account", async () => {
  // "Delete all notes" that only empties the device is undone by the next
  // sync: the account still holds the notes and they come back. The
  // delete therefore happens where the notes are.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  for (const clientId of ["c1", "c2", "c3"]) {
    const created = await api(env, "POST", "/api/notes", {
      token,
      body: { note: "note " + clientId, videoId: "abc123xyz", clientId },
    });
    assert.equal(created.status, 201);
  }

  const deleted = await api(env, "DELETE", "/api/notes", { token });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.ok, true, "the answer does not say it worked");
  assert.equal(deleted.data.deleted, 3, "the count is not the number of notes");

  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.data.notes.length, 0, "the account still holds the notes");
  assert.equal(listed.data.total, 0);

  // The rows are tombstones, not gone: the scheduled purge is what drops
  // them, and a device that still holds a note must not bring it back.
  const rows = [...env.store.notes.values()];
  assert.equal(rows.length, 3, "the rows were hard-deleted");
  assert.ok(
    rows.every((row) => row.deletedAt),
    "the rows were not marked as deleted",
  );
  const pushed = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "note c1", videoId: "abc123xyz", clientId: "c1" },
  });
  assert.equal(pushed.status, 201);
  const afterPush = await api(env, "GET", "/api/notes", { token });
  assert.equal(afterPush.data.notes.length, 0, "a deleted note came back");
});

test("the account limit carries the number the limit is", async () => {
  // The message is English. A UI that has to say the limit in the user's
  // own language needs the number as a number, not as a sentence.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  env.store.createNote = async () => {
    throw new StorageLimitError(
      "This account already holds 20000 notes and words, which is the limit of 20000.",
      MAX_ACCOUNT_ROWS,
    );
  };

  const result = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "text", clientId: "n1" },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.limit, MAX_ACCOUNT_ROWS, "the answer does not carry the cap");
});

test("the in-memory store is used only when it is asked for", () => {
  const store = createStore({ ALLOW_MEMORY_STORE: "1" });
  assert.ok(store instanceof MemoryStore);
});

test("a broken database configuration never reaches the log", async () => {
  // The driver's own error quotes the string it was given, so the check
  // happens before the driver sees it.
  const broken = "not-a-database-url";
  const env = makeEnv({ DATABASE_URL: broken, store: undefined });
  const { result, log } = await captureLog(() => api(env, "GET", "/api/status"));

  assert.equal(result.status, 503);
  assert.ok(
    !result.data.error.includes(broken),
    "the response must not carry the connection string",
  );
  assert.ok(!log.includes(broken), "the log must not carry the connection string");
});

test("a database error never logs what the user wrote", async () => {
  const noteText = "a note that must never be logged";
  const env = makeEnv();
  const token = await signIn(env, 1001, "{{USERNAME_5a9a8a1b808e8d0e}}");
  env.store.createNote = async () => {
    // A Postgres error carries the row that failed in `detail`.
    const error = new Error("duplicate key value violates unique constraint");
    error.code = "23505";
    error.detail = "Key (note)=(" + noteText + ") already exists.";
    throw error;
  };

  const { result, log } = await captureLog(() =>
    api(env, "POST", "/api/notes", { token, body: { note: noteText, clientId: "n1" } }),
  );

  assert.equal(result.status, 500);
  assert.ok(!log.includes(noteText), "the log must not carry the note text");
  assert.ok(
    log.includes("23505"),
    "the log has to carry the error code, that is what a failure is diagnosed from",
  );
});

test("an account cannot write past its storage limit", async () => {
  const store = new MemoryStore();
  const user = await store.upsertUser({ githubId: 1, login: "{{USERNAME_5a9a8a1b808e8d0e}}", avatarUrl: "" });
  // The account is full: the cap is a bound, not a suggestion.
  for (let index = 0; index < MAX_ACCOUNT_ROWS; index += 1) {
    store.notes.set("n" + index, {
      id: "n" + index,
      userId: user.id,
      clientId: "c" + index,
      note: "text",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  await assert.rejects(
    () => store.createNote(user.id, { clientId: "c_new", note: "one more" }),
    /limit/i,
    "an account that is full must not be able to write another row",
  );
});

test("a full account is told that it is full", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "{{USERNAME_5a9a8a1b808e8d0e}}");
  env.store.createNote = async () => {
    throw new StorageLimitError(
      "This account already holds 20000 notes and words, which is the limit of 20000.",
    );
  };

  const result = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "text", clientId: "n1" },
  });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /limit/i);
});

test("the export size is measured in bytes, not characters", async () => {
  // The Worker has no `Buffer`, so a size measured with it would throw
  // where it matters most: on a real export. A Chinese note is the case
  // that shows the difference: one character is three bytes.
  const store = new MemoryStore();
  const user = await store.upsertUser({ githubId: 1, login: "{{USERNAME_5a9a8a1b808e8d0e}}", avatarUrl: "" });
  await store.createNote(user.id, {
    clientId: "note_utf8",
    videoId: "abc123xyz",
    videoTitle: "",
    channelName: "",
    timestampSeconds: 0,
    quote: "",
    note: "笔记",
  });

  const bytes = await store.estimateExportBytes(user.id);
  assert.ok(bytes >= 6, "two Chinese characters are at least six bytes");
});

test("an export that is too big to download is refused with a reason", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "{{USERNAME_5a9a8a1b808e8d0e}}");
  env.store.estimateExportBytes = async () => 64 * 1024 * 1024;

  const result = await api(env, "GET", "/api/export", { token });
  assert.equal(result.status, 413);
  assert.match(result.data.error, /export limit/i);
});

test("a session that is bound to a device is refused in another browser", async () => {
  const env = makeEnv();
  const user = await env.store.upsertUser({ githubId: 1001, login: "{{USERNAME_5a9a8a1b808e8d0e}}", avatarUrl: "" });
  const device = "device-aaaaaaaaaaaaaaaa";
  const token = await jwt.signToken(
    {
      sub: String(user.id),
      githubId: user.githubId,
      login: user.login,
      tokenVersion: 0,
      device,
    },
    SECRET,
    3600,
  );

  const withoutDevice = await api(env, "GET", "/api/me", { token });
  assert.equal(withoutDevice.status, 401, "a bound session needs its device");

  const otherDevice = await api(env, "GET", "/api/me", { token, device: "device-bbbbbbbbbbbbbbbb" });
  assert.equal(otherDevice.status, 401, "a token copied to another browser is refused");

  const rightDevice = await api(env, "GET", "/api/me", { token, device });
  assert.equal(rightDevice.status, 200);
});

test("the scheduled run drops the tombstones that are no longer needed", async () => {
  const env = makeEnv();
  const user = await env.store.upsertUser({ githubId: 1001, login: "{{USERNAME_5a9a8a1b808e8d0e}}", avatarUrl: "" });
  const note = await env.store.createNote(user.id, {
    clientId: "note_old",
    videoId: "abc123xyz",
    videoTitle: "",
    channelName: "",
    timestampSeconds: 0,
    quote: "",
    note: "text",
  });
  await env.store.deleteNote(user.id, note.id);

  // A tombstone from long ago is dropped; a fresh one is kept, because a
  // device may still be holding the row it deleted.
  const stale = await worker.purgeExpiredTombstones(env);
  assert.equal(stale, 0, "a fresh tombstone must survive: a device may still hold the note");

  env.store.notes.get(note.id).deletedAt = "2020-01-01T00:00:00.000Z";
  const purged = await worker.purgeExpiredTombstones(env);
  assert.equal(purged, 1);
  assert.equal(env.store.notes.get(note.id), undefined, "the old tombstone is gone");
});

test("a sign-in that names its device gets a session bound to it", async () => {
  const env = makeEnv();
  const device = "device-cccccccccccccccc";
  const login = await api(env, "GET", "/api/auth/login?device=" + device);
  const cookies = login.response.headers.getSetCookie
    ? login.response.headers.getSetCookie()
    : [login.response.headers.get("set-cookie") || ""];
  assert.match(cookies.join("\n"), /__Host-ytd_oauth_device=/);

  const originalExchange = require("../src/auth").exchangeCode;
  const originalFetchUser = require("../src/auth").fetchGithubUser;
  require("../src/auth").exchangeCode = async () => "gh-token";
  require("../src/auth").fetchGithubUser = async () => ({
    githubId: 1001,
    login: "{{USERNAME_5a9a8a1b808e8d0e}}",
    avatarUrl: "",
  });
  try {
    const callback = new Request(
      "https://test.example/api/auth/callback?code=abc&state=expected",
      {
        headers: {
          cookie:
            "__Host-ytd_oauth_state=expected; __Host-ytd_oauth_device=" + device,
        },
      },
    );
    const response = await worker.fetch(callback, env);
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";
    const match = /#access_token=([^&]+)/.exec(location);
    assert.ok(match, "the callback has to hand out a token");
    const payload = await jwt.verifyToken(match[1], SECRET);
    assert.equal(payload.device, device, "the token has to name the device it is bound to");
  } finally {
    require("../src/auth").exchangeCode = originalExchange;
    require("../src/auth").fetchGithubUser = originalFetchUser;
  }
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
  assert.match(joined, /__Host-ytd_oauth_state=/);
  assert.match(joined, /__Host-ytd_oauth_redirect=%2Fdashboard/);
  assert.match(joined, /HttpOnly/);

  // A sign-in that asks for a language carries it along as a third cookie,
  // so the landing page can greet the reader in the right language.
  const withLanguage = await api(
    env,
    "GET",
    "/api/auth/login?redirect=/dashboard&lang=zh-CN",
  );
  const languageCookies = withLanguage.response.headers.getSetCookie().join("\n");
  assert.match(languageCookies, /__Host-ytd_oauth_lang=zh-CN/);

  const evil = await api(env, "GET", "/api/auth/login?redirect=https://evil.example");
  const evilCookies = evil.response.headers.get("set-cookie") || "";
  assert.doesNotMatch(evilCookies, /__Host-ytd_oauth_redirect=/);

  const protoRelative = await api(env, "GET", "/api/auth/login?redirect=//evil.example");
  const protoCookies = protoRelative.response.headers.get("set-cookie") || "";
  assert.doesNotMatch(protoCookies, /__Host-ytd_oauth_redirect=/);

  const weird = await api(env, "GET", "/api/auth/login?redirect=/dash%0dboard");
  const weirdCookies = weird.response.headers.get("set-cookie") || "";
  assert.doesNotMatch(weirdCookies, /__Host-ytd_oauth_redirect=/);
});

test("callback redirects to the stored same-origin path with the token", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const request = new Request("https://test.example/api/auth/callback?code=abc&state=expected", {
    headers: {
      cookie: "__Host-ytd_oauth_state=expected; __Host-ytd_oauth_redirect=%2Fdashboard",
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
      { headers: { cookie: "__Host-ytd_oauth_state=state-1" } },
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

test("the sign-in landing page speaks the language the sign-in started in", async () => {
  const env = makeEnv();
  // The extension asks for the language the user picked in the settings.
  const login = await api(env, "GET", "/api/auth/login?lang=zh-CN");
  const cookies = login.response.headers.getSetCookie
    ? login.response.headers.getSetCookie()
    : [login.response.headers.get("set-cookie") || ""];
  const joined = cookies.join("\n");
  // The language has to survive the trip to GitHub and back, so it travels
  // in a cookie next to the CSRF state.
  assert.match(joined, /__Host-ytd_oauth_lang=zh-CN/);
  assert.match(joined, /HttpOnly/);

  // The callback carries it on to the landing page.
  const originalExchange = require("../src/auth").exchangeCode;
  const originalFetchUser = require("../src/auth").fetchGithubUser;
  require("../src/auth").exchangeCode = async () => "gh-token";
  require("../src/auth").fetchGithubUser = async () => ({
    githubId: 1001,
    login: "alice",
    avatarUrl: "",
  });
  try {
    const callback = new Request(
      "https://test.example/api/auth/callback?code=abc&state=expected",
      {
        headers: {
          cookie: "__Host-ytd_oauth_state=expected; __Host-ytd_oauth_lang=zh-CN",
        },
      },
    );
    const response = await worker.fetch(callback, env);
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";
    assert.match(location, /\/auth\/complete\?lang=zh-CN#access_token=/);
    // The language cookie is spent, so a later sign-in starts fresh.
    const cleared = response.headers.getSetCookie
      ? response.headers.getSetCookie().join("\n")
      : response.headers.get("set-cookie") || "";
    assert.match(cleared, /__Host-ytd_oauth_lang=;/);
  } finally {
    require("../src/auth").exchangeCode = originalExchange;
    require("../src/auth").fetchGithubUser = originalFetchUser;
  }

  // The page itself greets the reader in that language.
  const page = await worker.fetch(
    new Request("https://test.example/auth/complete?lang=zh-CN"),
    env,
  );
  const html = await page.text();
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /已用 GitHub 登录/);
  assert.doesNotMatch(html, /Signed in to GitHub/);
});

test("the landing page greets a reader in the language they chose in the dashboard", async () => {
  const env = makeEnv();
  // The dashboard remembers the choice in a cookie, so the server can
  // greet a returning reader in their own language.
  const page = await worker.fetch(
    new Request("https://test.example/auth/complete", {
      headers: { cookie: "ytd_dashboard_lang=zh-CN" },
    }),
    env,
  );
  const html = await page.text();
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /已用 GitHub 登录/);
  // The page states its language, so the script does not have to guess it
  // and the reader never sees the page change language under them.
  assert.match(html, /<html lang="zh-CN" data-lang="zh-CN">/);

  // The browser's own language does not win over the reader's choice.
  const englishBrowser = await worker.fetch(
    new Request("https://test.example/auth/complete", {
      headers: {
        cookie: "ytd_dashboard_lang=zh-CN",
        "accept-language": "en-US,en;q=0.9",
      },
    }),
    env,
  );
  assert.match(await englishBrowser.text(), /已用 GitHub 登录/);

  // A sign-in started from the dashboard carries the choice to GitHub and
  // back, so the landing page keeps it.
  const login = await worker.fetch(
    new Request("https://test.example/api/auth/login", {
      headers: { cookie: "ytd_dashboard_lang=zh-CN" },
    }),
    env,
  );
  const cookies = login.headers.getSetCookie().join("\n");
  assert.match(cookies, /__Host-ytd_oauth_lang=zh-CN/);
});

test("the landing page falls back to the language the browser asks for", async () => {
  const env = makeEnv();
  const chinese = await worker.fetch(
    new Request("https://test.example/auth/complete", {
      headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
    }),
    env,
  );
  const chineseHtml = await chinese.text();
  assert.match(chineseHtml, /lang="zh-CN"/);
  assert.match(chineseHtml, /已用 GitHub 登录/);

  const english = await worker.fetch(
    new Request("https://test.example/auth/complete", {
      headers: { "accept-language": "en-GB,en;q=0.9" },
    }),
    env,
  );
  const englishHtml = await english.text();
  assert.match(englishHtml, /lang="en"/);
  assert.match(englishHtml, /Signed in to GitHub/);
  assert.doesNotMatch(englishHtml, /已用 GitHub 登录/);

  // A language the page does not speak falls back to English rather than
  // being reflected into the page.
  const unknown = await worker.fetch(
    new Request("https://test.example/auth/complete?lang=<script>"),
    env,
  );
  const unknownHtml = await unknown.text();
  assert.match(unknownHtml, /lang="en"/);
  assert.doesNotMatch(unknownHtml, /<script>alert/);
});

test("the landing page offers a language switch and ships no inline code", async () => {
  const env = makeEnv();
  const page = await worker.fetch(
    new Request("https://test.example/auth/complete"),
    env,
  );
  const html = await page.text();

  // The reader can fix the language without leaving the page.
  assert.match(html, /id="langSwitch"/);
  assert.match(html, /data-lang="zh-CN"/);
  // The page loads only same-origin files, so its strict policy costs
  // nothing and no inline script or style is needed.
  assert.match(html, /<script src="\/auth-complete\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/auth-complete\.css" \/>/);
  // The tab shows the product's own mark.
  assert.match(html, /<link rel="icon" href="\/favicon\.png" \/>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /style="/);
  assert.doesNotMatch(html, /on(click|change|submit|load|input|error)\s*=/i);

  const csp = page.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
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
    headers: { cookie: "__Host-ytd_oauth_state=%; other=1" },
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

test("a null in a note patch means 'not sent', not 'set to zero'", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: {
      note: "original",
      clientId: "null_patch_1",
      videoId: "abc123xyz",
      videoTitle: "A title",
      channelName: "A channel",
      timestampSeconds: 42,
      quote: "a quote",
    },
  });
  assert.equal(created.status, 201);
  const id = created.data.note.id;

  // A client that sends null for a field means "leave it alone". It used
  // to be read as a value: `Number(null)` is 0, so the timestamp became 0
  // and the note lost its link to its video.
  const patched = await api(env, "PATCH", "/api/notes/" + id, {
    token,
    body: { note: "edited", timestampSeconds: null, videoId: null },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.note.note, "edited");
  assert.equal(patched.data.note.timestampSeconds, 42, "a null timestamp must not become 0");
  assert.equal(patched.data.note.videoId, "abc123xyz", "a null video id must not erase the link");
  assert.equal(patched.data.note.videoTitle, "A title");
  assert.equal(patched.data.note.channelName, "A channel");
  assert.equal(patched.data.note.quote, "a quote");

  // And the row on disk kept them too.
  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.data.notes[0].timestampSeconds, 42);
  assert.equal(listed.data.notes[0].videoId, "abc123xyz");

  // A patch that leaves the note text alone does not write the note
  // column at all.
  const quoteOnly = await api(env, "PATCH", "/api/notes/" + id, {
    token,
    body: { note: null, quote: "a new quote" },
  });
  assert.equal(quoteOnly.status, 200);
  assert.equal(quoteOnly.data.note.note, "edited", "the note text must survive a patch without it");
  assert.equal(quoteOnly.data.note.quote, "a new quote");
});

test("every field of a note patch treats null as 'not sent'", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: {
      note: "original",
      clientId: "null_patch_all",
      videoId: "abc123xyz",
      videoTitle: "A title",
      channelName: "A channel",
      timestampSeconds: 42,
      quote: "a quote",
      starred: true,
    },
  });
  assert.equal(created.status, 201);
  const id = created.data.note.id;

  const patched = await api(env, "PATCH", "/api/notes/" + id, {
    token,
    body: {
      note: "edited",
      videoId: null,
      videoTitle: null,
      channelName: null,
      timestampSeconds: null,
      quote: null,
      starred: null,
    },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.note.videoId, "abc123xyz");
  assert.equal(patched.data.note.videoTitle, "A title");
  assert.equal(patched.data.note.channelName, "A channel");
  assert.equal(patched.data.note.timestampSeconds, 42);
  assert.equal(patched.data.note.quote, "a quote");
  assert.equal(patched.data.note.starred, true, "a null flag must not clear the favorite");
});

test("a note patch that changes nothing is refused", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: { note: "original", clientId: "null_patch_empty", videoId: "abc123xyz" },
  });
  const id = created.data.note.id;

  // Every field is "not sent": there is nothing to write, so the request
  // is refused instead of bumping the timestamp for no reason.
  const refused = await api(env, "PATCH", "/api/notes/" + id, {
    token,
    body: { note: null, timestampSeconds: null },
  });
  assert.equal(refused.status, 400);

  // The note is untouched.
  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.data.notes[0].note, "original");
  assert.equal(listed.data.notes[0].timestampSeconds, 0);
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

  // The GitHub identity is deleted as well. The promise is "my account and
  // all my data", not only the notes.
  const fresh = await signIn(env, 1001, "alice");
  const notes = await api(env, "GET", "/api/notes", { token: fresh });
  assert.deepEqual(notes.data.notes, []);
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


test("the sign-in token is bound to the client that asked for it", async () => {
  const env = makeEnv();
  const nonce = "aBcD1234efGh5678iJkL";
  const login = await worker.fetch(
    new Request("https://test.example/api/auth/login?nonce=" + nonce),
    env,
  );
  const loginCookies = login.headers.getSetCookie().join("\n");
  // The nonce is kept in a cookie the browser sends back on its own.
  assert.match(loginCookies, /__Host-ytd_oauth_nonce=aBcD1234efGh5678iJkL/);
  assert.match(loginCookies, /HttpOnly/);

  const originalExchange = require("../src/auth").exchangeCode;
  const originalFetchUser = require("../src/auth").fetchGithubUser;
  require("../src/auth").exchangeCode = async () => "gh-token";
  require("../src/auth").fetchGithubUser = async () => ({
    githubId: 1001,
    login: "alice",
    avatarUrl: "",
  });
  try {
    const callback = await worker.fetch(
      new Request("https://test.example/api/auth/callback?code=abc&state=expected", {
        headers: {
          cookie:
            "__Host-ytd_oauth_state=expected; __Host-ytd_oauth_nonce=" + nonce,
        },
      }),
      env,
    );
    const location = callback.headers.get("location") || "";
    // The nonce comes back with the token, so the client can tell its own
    // sign-in apart from a link somebody else made.
    assert.match(location, /#access_token=/);
    assert.match(location, /&nonce=aBcD1234efGh5678iJkL$/);
    // And it is spent with the sign-in.
    assert.match(
      callback.headers.getSetCookie().join("\n"),
      /__Host-ytd_oauth_nonce=;/,
    );
  } finally {
    require("../src/auth").exchangeCode = originalExchange;
    require("../src/auth").fetchGithubUser = originalFetchUser;
  }

  // A sign-in that asked for no nonce gets no nonce: a link that carries a
  // token but no nonce is not tied to any client, and the clients ignore it.
  const plain = await worker.fetch(
    new Request("https://test.example/api/auth/callback?code=abc&state=expected", {
      headers: { cookie: "__Host-ytd_oauth_state=expected" },
    }),
    env,
  );
  assert.doesNotMatch(plain.headers.get("location") || "", /nonce=/);
});

test("a nonce that does not look random is ignored", async () => {
  const env = makeEnv();
  const login = await worker.fetch(
    new Request(
      "https://test.example/api/auth/login?nonce=" +
        encodeURIComponent("<script>alert(1)</script>"),
    ),
    env,
  );
  assert.doesNotMatch(
    login.headers.getSetCookie().join("\n"),
    /__Host-ytd_oauth_nonce=/,
  );
});

test("the sign-in state is spent even when the exchange fails", async () => {
  const env = makeEnv();
  const originalExchange = require("../src/auth").exchangeCode;
  require("../src/auth").exchangeCode = async () => {
    throw new Error("GitHub said no");
  };
  try {
    const callback = await worker.fetch(
      new Request("https://test.example/api/auth/callback?code=abc&state=expected", {
        headers: { cookie: "__Host-ytd_oauth_state=expected" },
      }),
      env,
    );
    assert.equal(callback.status, 400);
    // The state cannot be replayed: the cookie is cleared with the failure,
    // so the same state cannot be used to ask GitHub again.
    assert.match(
      callback.headers.getSetCookie().join("\n"),
      /__Host-ytd_oauth_state=;/,
    );
  } finally {
    require("../src/auth").exchangeCode = originalExchange;
  }
});

// ============================================================
// POST /api/sync: a batch of notes and words in one request
//
// A device that holds a hundred notes and five hundred words used to push
// them one request at a time, and the write limiter refused everything past
// the first 120. The batch is the same rows over one request, so it is
// charged as one write and lands whole or not at all.
// ============================================================

/** A note body as a client sends it. */
function batchNote(clientId, text, extra) {
  return Object.assign(
    {
      clientId,
      note: text,
      videoId: "abc123xyz",
      videoTitle: "Video",
      channelName: "Channel",
      timestampSeconds: 0,
      quote: "",
    },
    extra || {},
  );
}

/** A word body as a client sends it. */
function batchWord(term, sentence, extra) {
  return Object.assign(
    {
      term,
      translation: "",
      sentence,
      sentenceTranslation: "",
      videoId: "abc123xyz",
      videoTitle: "Video",
      timestampSeconds: 0,
      status: "learning",
    },
    extra || {},
  );
}

test("a batch pushes notes and words in one request", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");

  const result = await api(env, "POST", "/api/sync", {
    token,
    body: {
      notes: [
        batchNote("batch_n1", "the first note", { timestampSeconds: 3 }),
        batchNote("batch_n2", "the second note"),
      ],
      vocabulary: [batchWord("serendipity", "A happy accident.", { translation: "意外之喜" })],
    },
  });

  assert.equal(result.status, 200);
  // The answer names every item of the batch, in the order it was sent: the
  // client matches the answer to its own rows by that identity.
  assert.deepEqual(
    result.data.pushed.notes.map((note) => note.clientId),
    ["batch_n1", "batch_n2"],
  );
  assert.deepEqual(
    result.data.pushed.vocabulary.map((word) => [word.term, word.sentence]),
    [["serendipity", "A happy accident."]],
  );
  for (const entry of result.data.pushed.notes.concat(result.data.pushed.vocabulary)) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0, "the server has to name the row it holds");
    assert.ok(
      Number.isFinite(Date.parse(entry.updatedAt)),
      "the server has to say when it changed the row",
    );
  }
  assert.ok(Number.isFinite(Date.parse(result.data.serverTime)), "the answer carries the server clock");

  // Both kinds really landed.
  const notes = await api(env, "GET", "/api/notes", { token });
  assert.deepEqual(
    notes.data.notes.map((note) => note.note).sort(),
    ["the first note", "the second note"],
  );
  const words = await api(env, "GET", "/api/vocabulary", { token });
  assert.equal(words.data.vocabulary.length, 1);
  assert.equal(words.data.vocabulary[0].translation, "意外之喜");

  // A word pushed in a batch is the same word the single route creates: due
  // for its first review immediately.
  const due = await api(env, "GET", "/api/reviews/due", { token });
  assert.equal(due.data.reviews.length, 1, "a new word of the batch is not reviewable");
});

test("a batch pushed twice writes each row once", async () => {
  // The whole point of the client id is that a retried push is harmless.
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const body = {
    notes: [batchNote("once_n1", "only one row")],
    vocabulary: [batchWord("once", "Only one row.")],
  };

  const first = await api(env, "POST", "/api/sync", { token, body });
  const second = await api(env, "POST", "/api/sync", { token, body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  assert.equal(
    second.data.pushed.notes[0].id,
    first.data.pushed.notes[0].id,
    "the retry must name the row the first push wrote",
  );
  const notes = await api(env, "GET", "/api/notes", { token });
  assert.equal(notes.data.notes.length, 1, "the retry wrote a second row");
  const words = await api(env, "GET", "/api/vocabulary", { token });
  assert.equal(words.data.vocabulary.length, 1, "the retry wrote a second word");
  const due = await api(env, "GET", "/api/reviews/due", { token });
  assert.equal(due.data.reviews.length, 1, "the retry created a second review row");
});

test("a batch item older than the stored row does not overwrite it", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: batchNote("stale_n1", "the newer text"),
  });
  assert.equal(created.status, 201);

  // A second device pushes an edit it made before the first one landed.
  const pushed = await api(env, "POST", "/api/sync", {
    token,
    body: {
      notes: [
        batchNote("stale_n1", "the older text", {
          updatedAt: Date.now() - 60_000,
        }),
      ],
    },
  });
  assert.equal(pushed.status, 200);
  assert.equal(
    pushed.data.pushed.notes[0].id,
    created.data.note.id,
    "the answer has to name the row the server holds",
  );

  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.data.notes[0].note, "the newer text", "the older edit won");

  // The other direction: a newer edit wins, and the answer carries the new
  // timestamp the client should keep.
  const newer = await api(env, "POST", "/api/sync", {
    token,
    body: {
      notes: [
        batchNote("stale_n1", "the newest text", {
          updatedAt: Date.now() + 60_000,
        }),
      ],
    },
  });
  assert.equal(newer.status, 200);
  assert.ok(
    Date.parse(newer.data.pushed.notes[0].updatedAt) >
      Date.parse(created.data.note.updatedAt),
    "the answer has to carry the moment the row changed",
  );
  const after = await api(env, "GET", "/api/notes", { token });
  assert.equal(after.data.notes[0].note, "the newest text", "the newer edit lost");
});

test("a batch does not bring a deleted note back", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const created = await api(env, "POST", "/api/notes", {
    token,
    body: batchNote("gone_n1", "the user deleted this"),
  });
  const deleted = await api(env, "DELETE", "/api/notes/client/gone_n1", { token });
  assert.equal(deleted.status, 200);

  // The device that still holds the note pushes it again, with a moment that
  // is newer than the delete. A tombstone is not a row a push can win.
  const pushed = await api(env, "POST", "/api/sync", {
    token,
    body: {
      notes: [
        batchNote("gone_n1", "the user deleted this", {
          updatedAt: Date.now() + 60_000,
        }),
      ],
    },
  });
  assert.equal(pushed.status, 200);
  assert.equal(
    pushed.data.pushed.notes[0].id,
    created.data.note.id,
    "the answer has to name the row, so the client can drop its copy",
  );

  const listed = await api(env, "GET", "/api/notes", { token });
  assert.equal(listed.data.notes.length, 0, "a deleted note came back");
});

test("a batch that would pass the account cap writes nothing", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const user = [...env.store.users.values()][0];
  const fullAt = MAX_ACCOUNT_ROWS - 1;
  for (let index = 0; index < fullAt; index += 1) {
    env.store.notes.set("seed" + index, {
      id: "seed" + index,
      // The account id the token carries is a string; the rows an API
      // request writes use the same form.
      userId: String(user.id),
      clientId: "seed_c" + index,
      note: "seed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  // One of the two would fit, the other would not. The batch is all or
  // nothing, so neither is written.
  const refused = await api(env, "POST", "/api/sync", {
    token,
    body: {
      notes: [batchNote("cap_n1", "one"), batchNote("cap_n2", "two")],
    },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.limit, MAX_ACCOUNT_ROWS, "the answer does not carry the cap");
  assert.match(refused.data.error, new RegExp(String(MAX_ACCOUNT_ROWS)));
  const rows = [...env.store.notes.values()];
  assert.equal(rows.length, fullAt, "a refused batch wrote a row");
  assert.ok(
    !rows.some((row) => row.clientId === "cap_n1" || row.clientId === "cap_n2"),
    "a refused batch wrote one of its items",
  );

  // The very same batch with one item fits, and one more is refused again.
  const fitted = await api(env, "POST", "/api/sync", {
    token,
    body: { notes: [batchNote("cap_n1", "one")] },
  });
  assert.equal(fitted.status, 200);
  const again = await api(env, "POST", "/api/sync", {
    token,
    body: { notes: [batchNote("cap_n2", "two")] },
  });
  assert.equal(again.status, 409, "an account at the cap accepted another row");
});

test("a batch larger than the limit is refused with a message to act on", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");
  const tooMany = [];
  for (let index = 0; index <= 200; index += 1) {
    tooMany.push(batchNote("big_" + index, "note " + index));
  }

  const refused = await api(env, "POST", "/api/sync", { token, body: { notes: tooMany } });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /201/);
  assert.match(refused.data.error, /200/);
  assert.equal(
    [...env.store.notes.values()].length,
    0,
    "an oversized batch wrote a row before being refused",
  );

  // The boundary itself is accepted: the client chunks by this number.
  const boundary = tooMany.slice(0, 200);
  const accepted = await api(env, "POST", "/api/sync", { token, body: { notes: boundary } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.pushed.notes.length, 200);
});

test("a batch may not name another account's row", async () => {
  const env = makeEnv();
  const aliceToken = await signIn(env, 1001, "alice");
  const bobToken = await signIn(env, 1002, "bob");
  const aliceNote = await api(env, "POST", "/api/notes", {
    token: aliceToken,
    body: batchNote("alice_n1", "alice's note"),
  });
  const aliceWord = await api(env, "POST", "/api/vocabulary", {
    token: aliceToken,
    body: batchWord("alice-word", "Alice's sentence."),
  });

  // The token decides the account. An id in the body that names somebody
  // else's row is a client bug the answer points at, not a way to write it.
  const noteAttack = await api(env, "POST", "/api/sync", {
    token: bobToken,
    body: {
      notes: [batchNote("bob_n1", "written over alice", { id: aliceNote.data.note.id })],
    },
  });
  assert.equal(noteAttack.status, 400);
  assert.match(noteAttack.data.error, /notes\[0\]: this id belongs to another account/);

  const wordAttack = await api(env, "POST", "/api/sync", {
    token: bobToken,
    body: {
      vocabulary: [
        batchWord("bob-word", "Bob's sentence.", { id: aliceWord.data.vocabulary.id }),
      ],
    },
  });
  assert.equal(wordAttack.status, 400);
  assert.match(wordAttack.data.error, /vocabulary\[0\]: this id belongs to another account/);

  const bobNotes = await api(env, "GET", "/api/notes", { token: bobToken });
  assert.equal(bobNotes.data.notes.length, 0, "a refused batch wrote bob a note");
  const bobWords = await api(env, "GET", "/api/vocabulary", { token: bobToken });
  assert.equal(bobWords.data.vocabulary.length, 0, "a refused batch wrote bob a word");
});

test("one bad item refuses the whole batch and names its position", async () => {
  const env = makeEnv();
  const token = await signIn(env, 1001, "alice");

  const empty = await api(env, "POST", "/api/sync", {
    token,
    body: {
      notes: [
        batchNote("bad_n1", "fine"),
        batchNote("bad_n2", ""),
        batchNote("bad_n3", "also fine"),
      ],
    },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /notes\[1\]: a non-empty note is required/);

  const noClient = await api(env, "POST", "/api/sync", {
    token,
    body: { notes: [{ note: "text without a client id" }] },
  });
  assert.equal(noClient.status, 400);
  assert.match(noClient.data.error, /notes\[0\]: clientId is required/);

  const badMoment = await api(env, "POST", "/api/sync", {
    token,
    body: { notes: [batchNote("bad_n4", "text", { updatedAt: "whenever" })] },
  });
  assert.equal(badMoment.status, 400);
  assert.match(badMoment.data.error, /notes\[0\]: updatedAt must be/);

  const badWord = await api(env, "POST", "/api/sync", {
    token,
    body: { vocabulary: [batchWord("ok", "fine"), { term: "  ", sentence: "" }] },
  });
  assert.equal(badWord.status, 400);
  assert.match(badWord.data.error, /vocabulary\[1\]: a non-empty term is required/);

  const nothing = await api(env, "GET", "/api/notes", { token });
  assert.equal(nothing.data.notes.length, 0, "a refused batch wrote one of its items");
  const noWords = await api(env, "GET", "/api/vocabulary", { token });
  assert.equal(noWords.data.vocabulary.length, 0);
});

test("the batch route spends one write of the rate limit, not one per row", async () => {
  // A batch of 150 notes plus 119 more requests is 269 rows over 120
  // requests. If the limiter charged rows, the device would be refused after
  // 120 rows; the first sync of a new device must not take five minutes.
  const env = makeEnv();
  const token = await signIn(env, 9101, "limiter");

  const many = [];
  for (let index = 0; index < 150; index += 1) {
    many.push(batchNote("rate_" + index, "note " + index));
  }
  const first = await api(env, "POST", "/api/sync", { token, body: { notes: many } });
  assert.equal(first.status, 200);

  for (let index = 0; index < 119; index += 1) {
    const result = await api(env, "POST", "/api/sync", {
      token,
      body: { notes: [batchNote("rate_single_" + index, "one " + index)] },
    });
    assert.equal(result.status, 200, "request " + (index + 2) + " was refused too early");
  }
  assert.equal(
    [...env.store.notes.values()].length,
    269,
    "the rows the batch wrote are not all there",
  );

  // The 121st request of the window is the one that is refused.
  const refused = await api(env, "POST", "/api/sync", {
    token,
    body: { notes: [batchNote("rate_over", "over the limit")] },
  });
  assert.equal(refused.status, 429);
});
