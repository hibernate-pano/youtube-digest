const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const SYNC_BASE_URL = "https://sync.test";

/**
 * Loads the real service worker into a vm sandbox.
 *
 * The worker is `background.js` plus the `cloud-sync.js` it pulls in through
 * importScripts, so both files are executed here. The settings module is the
 * real one: only the sync server URL is redirected, because that is a
 * deployment value and not a behaviour.
 */
function loadBackground({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    supadataApiKey: "sd_test",
  },
  storage = {},
  fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "{}" } }] }),
  }),
  runtimeSendMessage = async () => ({ success: true }),
} = {}) {
  const listeners = { addListener() {} };
  const messageListeners = [];
  const localValues = { ytd_settings: settings, ...storage };
  const sentMessages = [];
  const requests = [];

  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    // The worker builds note ids with crypto.randomUUID(), which a bare vm
    // context does not provide.
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    importScripts() {},
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return fetchImpl(String(url), options, requests.length - 1);
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          async get(key) {
            if (key === null || key === undefined) return { ...localValues };
            if (Array.isArray(key)) {
              return Object.fromEntries(
                key.map((item) => [item, localValues[item]]),
              );
            }
            return { [key]: localValues[key] };
          },
          async set(items) {
            Object.assign(localValues, items);
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localValues[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
        close: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            messageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: async (message) => {
          sentMessages.push(message);
          return runtimeSendMessage(message);
        },
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        create: async () => ({ id: 1, url: "" }),
        get: async () => null,
        sendMessage: async () => ({ success: true }),
      },
    },
    // The real settings module, with the sync server redirected to a test
    // host. Everything else, including the provider registry and
    // `chatCompletionsUrl`, is the production code.
    YTD_SETTINGS: {
      ...require("../settings.js"),
      SERVER_BASE_URL: SYNC_BASE_URL,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);

  const helpers = sandbox.__YTD_TRANSLATION_TESTING__;
  helpers.storage = localValues;
  helpers.sentMessages = sentMessages;
  helpers.requests = requests;
  helpers.messageListeners = messageListeners;
  return helpers;
}

/** A fetch stub that answers prompt files from the repository. */
function promptAwareFetchRaw(content) {
  return async (url) => {
    if (/\/prompts\//.test(url)) {
      return {
        ok: true,
        text: async () =>
          fs.readFileSync(path.join(root, "prompts", "vocabulary.md"), "utf8"),
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}

/** A fetch stub that answers prompt files from the repository. */
function promptAwareFetch(aiResponse) {
  return async (url) => {
    const match = /\/prompts\/([^/?#]+)$/.exec(url);
    if (match) {
      const markdown = fs.readFileSync(
        path.join(root, "prompts", match[1]),
        "utf8",
      );
      return { ok: true, text: async () => markdown };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(aiResponse) } }],
      }),
    };
  };
}

// ============================================================
// handleExtractVocabulary
// ============================================================

test("vocabulary extraction refuses to run without an AI key", async () => {
  const background = loadBackground({
    settings: { provider: "deepseek", aiApiKey: "" },
  });

  const result = await background.handleExtractVocabulary("a sentence");

  assert.equal(result.success, false);
  assert.equal(result.error, "NO_AI_KEY");
});

test("vocabulary extraction refuses an empty sentence", async () => {
  const background = loadBackground();

  const result = await background.handleExtractVocabulary("   ");

  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_SENTENCE");
});

test("vocabulary extraction asks the active provider and returns the words", async () => {
  const background = loadBackground({
    fetchImpl: promptAwareFetch({
      words: [
        { term: " agent ", translation: " 代理 ", explanation: " a program " },
        { term: "tool", translation: "工具", explanation: "a thing" },
      ],
    }),
  });

  const result = await background.handleExtractVocabulary(
    "Agents use tools to plan their work.",
  );

  assert.equal(result.success, true);
  // The sandbox is its own realm, so the values are compared as plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(result.words)), [
    { term: "agent", translation: "代理", explanation: "a program" },
    { term: "tool", translation: "工具", explanation: "a thing" },
  ]);

  const providerCall = background.requests.find(
    (request) => !request.url.includes("/prompts/"),
  );
  assert.ok(providerCall, "the provider must be called");
  assert.equal(
    providerCall.url,
    "https://api.deepseek.com/chat/completions",
    "the request must go to the active provider's chat endpoint",
  );
  assert.equal(
    providerCall.options.headers.Authorization,
    "Bearer test-key",
    "the active provider's own key must be sent",
  );

  const body = JSON.parse(providerCall.options.body);
  const userPrompt = body.messages.find((message) => message.role === "user").content;
  assert.match(
    userPrompt,
    /Agents use tools to plan their work\./,
    "the sentence must reach the model",
  );
  const systemPrompt = body.messages.find(
    (message) => message.role === "system",
  ).content;
  const vocabularyPrompt = fs.readFileSync(
    path.join(root, "prompts", "vocabulary.md"),
    "utf8",
  );
  const expected = /## System prompt[\s\S]*?```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/.exec(
    vocabularyPrompt,
  );
  assert.ok(expected, "the prompt file must carry a fenced system prompt");
  assert.equal(
    systemPrompt,
    expected[1],
    "the system prompt must be the fenced section of prompts/vocabulary.md",
  );
});

test("vocabulary extraction keeps at most three words and drops the broken ones", async () => {
  const background = loadBackground({
    fetchImpl: promptAwareFetch({
      words: [
        { term: "one", translation: "1", explanation: "" },
        { term: "two", translation: "2", explanation: "" },
        { term: "three", translation: "3", explanation: "" },
        { term: "four", translation: "4", explanation: "" },
        { term: "   ", translation: "5", explanation: "" },
        { translation: "6", explanation: "" },
      ],
    }),
  });

  const result = await background.handleExtractVocabulary("a sentence");

  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.words.map((word) => word.term))),
    ["one", "two", "three"],
    "at most three usable words must come back",
  );
});

test("vocabulary extraction reads the words out of a chatty answer", async () => {
  const background = loadBackground({
    fetchImpl: promptAwareFetchRaw(
      'Sure! Here are the words: {"words":[{"term":"agent","translation":"代理","explanation":"a program"}]}',
    ),
  });

  const result = await background.handleExtractVocabulary("a sentence");

  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.words.map((word) => word.term))),
    ["agent"],
    "prose around the JSON must not lose the words",
  );
});

test("vocabulary extraction reports a model answer that is not JSON at all", async () => {
  const background = loadBackground({
    fetchImpl: promptAwareFetchRaw("not json at all"),
  });

  const result = await background.handleExtractVocabulary("a sentence");

  assert.equal(
    result.success,
    false,
    "an answer without any JSON must be reported, not silently accepted",
  );
  assert.equal(
    result.words,
    undefined,
    "a broken answer must not invent words",
  );
});

test("the extractVocabulary message reaches the vocabulary handler", async () => {
  const background = loadBackground({
    fetchImpl: promptAwareFetch({
      words: [{ term: "agent", translation: "代理", explanation: "a program" }],
    }),
  });

  const response = await new Promise((resolve) => {
    const listener = background.messageListeners.at(-1);
    const kept = listener(
      { action: "extractVocabulary", sentence: "Agents use tools." },
      {},
      resolve,
    );
    assert.equal(kept, true, "the message channel must stay open");
  });

  assert.equal(response.success, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(response.words.map((word) => word.term))),
    ["agent"],
  );
});

// ============================================================
// handleGetVocabulary
// ============================================================

test("the vocabulary list is read from the signed-out namespace", async () => {
  const background = loadBackground({
    storage: {
      ytd_vocabulary: [
        { id: "v1", term: "agent", status: "learning" },
        { id: "v2", term: "tool", status: "reviewing" },
      ],
    },
  });

  const result = await background.handleGetVocabulary();

  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.items.map((item) => item.term))),
    ["agent", "tool"],
  );
});

test("the vocabulary list is read from the signed-in namespace", async () => {
  const background = loadBackground({
    storage: {
      ytd_github_session: { token: "tok", githubId: 42 },
      ytd_vocabulary_42: [{ id: "v9", term: "private-word" }],
      ytd_vocabulary: [{ id: "v1", term: "signed-out-word" }],
    },
  });

  const result = await background.handleGetVocabulary();

  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.items.map((item) => item.term))),
    ["private-word"],
    "a signed-in account must only see its own vocabulary",
  );
});

test("an empty vocabulary list is not an error", async () => {
  const background = loadBackground();

  const result = await background.handleGetVocabulary();

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), []);
});

// ============================================================
// handleDeleteVocabulary
// ============================================================

test("deleting a vocabulary entry removes it locally", async () => {
  const background = loadBackground({
    storage: {
      ytd_vocabulary: [
        { id: "v1", term: "agent" },
        { id: "v2", term: "tool" },
      ],
    },
  });

  const result = await background.handleDeleteVocabulary("v1");

  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.storage.ytd_vocabulary.map((item) => item.id))),
    ["v2"],
  );
});

test("deleting a vocabulary entry removes it from the cloud too", async () => {
  const background = loadBackground({
    storage: {
      ytd_github_session: { token: "tok", githubId: 42 },
      ytd_vocabulary_42: [{ id: "v1", term: "agent", cloudId: "cloud-1" }],
    },
  });

  const result = await background.handleDeleteVocabulary("v1");

  assert.equal(result.success, true);
  const cloudCall = background.requests.find((request) =>
    request.url.startsWith(SYNC_BASE_URL),
  );
  assert.ok(cloudCall, "the cloud copy must be deleted too");
  assert.equal(cloudCall.url, `${SYNC_BASE_URL}/api/vocabulary/cloud-1`);
  assert.equal(cloudCall.options.method, "DELETE");
  assert.equal(cloudCall.options.headers.Authorization, "Bearer tok");
});

test("deleting a vocabulary entry that was never stored is harmless", async () => {
  const background = loadBackground({
    storage: { ytd_vocabulary: [{ id: "v1", term: "agent" }] },
  });

  const result = await background.handleDeleteVocabulary("nope");

  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.storage.ytd_vocabulary.map((item) => item.id))),
    ["v1"],
  );
});

// ============================================================
// The starred-note route
// ============================================================

test("the setNoteStarred route stars a note without rewriting its text", async () => {
  const background = loadBackground({
    storage: {
      ytd_notes: [
        { id: "n1", text: "the original text", starred: false },
        { id: "n2", text: "another note", starred: false },
      ],
    },
  });

  const response = await new Promise((resolve) => {
    const listener = background.messageListeners.at(-1);
    const kept = listener(
      { action: "setNoteStarred", noteId: "n1", starred: true },
      {},
      resolve,
    );
    assert.equal(kept, true, "the message channel must stay open");
  });

  assert.equal(response.success, true);
  const stored = background.storage.ytd_notes.find((note) => note.id === "n1");
  assert.equal(stored.starred, true, "the note must be starred");
  assert.equal(
    stored.text,
    "the original text",
    "starring a note must not rewrite its text",
  );
  assert.equal(
    background.storage.ytd_notes.find((note) => note.id === "n2").starred,
    false,
    "another note must not be touched",
  );
});

test("the setNoteStarred route tells the cloud about the flag", async () => {
  const background = loadBackground({
    storage: {
      ytd_github_session: { token: "tok", githubId: 42 },
      ytd_notes_42: [
        { id: "n1", text: "a note", starred: false, cloudId: "cloud-1" },
      ],
    },
  });

  const response = await new Promise((resolve) => {
    background.messageListeners.at(-1)(
      { action: "setNoteStarred", noteId: "n1", starred: true },
      {},
      resolve,
    );
  });

  assert.equal(response.success, true);
  const cloudCall = background.requests.find((request) =>
    request.url.startsWith(SYNC_BASE_URL),
  );
  assert.ok(cloudCall, "the cloud must learn about the flag");
  assert.equal(cloudCall.url, `${SYNC_BASE_URL}/api/notes/cloud-1/star`);
  assert.equal(cloudCall.options.method, "PATCH");
  assert.deepEqual(JSON.parse(cloudCall.options.body), { starred: true });
});

test("the setNoteStarred route reports a note it cannot find", async () => {
  const background = loadBackground({ storage: { ytd_notes: [] } });

  const response = await new Promise((resolve) => {
    background.messageListeners.at(-1)(
      { action: "setNoteStarred", noteId: "nope", starred: true },
      {},
      resolve,
    );
  });

  assert.equal(response.success, false);
  assert.match(response.error, /not found/i);
});

// ============================================================
// formatSyncTimestamp
// ============================================================

test("a sync timestamp reads as minutes and seconds", () => {
  const background = loadBackground();

  assert.equal(background.formatSyncTimestamp(0), "0:00");
  assert.equal(background.formatSyncTimestamp(9), "0:09");
  assert.equal(background.formatSyncTimestamp(65), "1:05");
  assert.equal(background.formatSyncTimestamp(3599), "59:59");
});

test("a sync timestamp grows an hours part", () => {
  const background = loadBackground();

  assert.equal(background.formatSyncTimestamp(3600), "1:00:00");
  assert.equal(background.formatSyncTimestamp(3665), "1:01:05");
});

test("a sync timestamp never goes below zero", () => {
  const background = loadBackground();

  assert.equal(background.formatSyncTimestamp(-10), "0:00");
  assert.equal(background.formatSyncTimestamp("nonsense"), "0:00");
  assert.equal(background.formatSyncTimestamp(null), "0:00");
});

// ============================================================
// The expired session latch
// ============================================================

test("marking the session expired stores the latch and tells the panel", async () => {
  const background = loadBackground();

  await background.markSyncSessionExpired();

  assert.equal(background.storage.ytd_sync_expired, true);
  assert.ok(
    background.sentMessages.some(
      (message) => message.action === "syncSessionExpired",
    ),
    "the open panel must be told that the session is dead",
  );
});

test("clearing the expired session removes the latch", async () => {
  const background = loadBackground({
    storage: { ytd_sync_expired: true },
  });

  await background.clearSyncSessionExpired();

  assert.equal(
    Object.hasOwn(background.storage, "ytd_sync_expired"),
    false,
    "the latch must be gone after a successful request",
  );
});

test("clearing the expired session on a clean account changes nothing", async () => {
  const background = loadBackground();

  await background.clearSyncSessionExpired();

  assert.equal(
    Object.hasOwn(background.storage, "ytd_sync_expired"),
    false,
  );
});

// ============================================================
// cloudFetch
// ============================================================

test("a cloud request carries the token and the JSON body", async () => {
  const background = loadBackground({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }),
  });

  const data = await background.cloudFetch("/api/notes", {
    method: "POST",
    token: "tok",
    body: { note: "hello" },
  });

  assert.deepEqual(data, { ok: true });
  const request = background.requests.at(-1);
  assert.equal(request.url, `${SYNC_BASE_URL}/api/notes`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer tok");
  assert.equal(request.options.body, JSON.stringify({ note: "hello" }));
});

test("a cloud request without a token sends no authorization header", async () => {
  const background = loadBackground({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  await background.cloudFetch("/api/reviews/due");

  const request = background.requests.at(-1);
  assert.equal(
    Object.hasOwn(request.options.headers, "Authorization"),
    false,
    "an anonymous request must not claim a session",
  );
});

test("a rejected cloud request reports the status", async () => {
  const background = loadBackground({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }),
  });

  await assert.rejects(
    () => background.cloudFetch("/api/notes", { token: "tok" }),
    (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.message, "boom");
      return true;
    },
  );
});

test("an expired session is reported as terminal, not as a transient failure", async () => {
  const background = loadBackground({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    }),
  });

  await assert.rejects(
    () => background.cloudFetch("/api/notes", { token: "dead" }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "SYNC_SESSION_EXPIRED");
      assert.equal(background.isSyncSessionExpired(error), true);
      return true;
    },
  );
});
