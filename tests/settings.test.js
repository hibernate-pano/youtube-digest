const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("provider registry declares request capabilities for background.js", () => {
  const { PROVIDERS } = settings;
  assert.equal(PROVIDERS.deepseek.usesThinkingDisabled, true);
  assert.equal(PROVIDERS.minimax.usesThinkingDisabled, false);
  assert.equal(PROVIDERS["opencode-go"].usesThinkingDisabled, false);
  for (const provider of Object.values(PROVIDERS)) {
    assert.equal(typeof provider.supportsJsonMode, "boolean");
    assert.equal(typeof provider.baseUrl, "string");
    assert.equal(typeof provider.model, "string");
    assert.equal(typeof provider.apiKeyField, "string");
    assert.ok(provider.baseUrl.length > 0 && provider.model.length > 0);
  }
});

test("DeepSeek defaults use V4 Flash and fixed endpoint", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "  example-key  ",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: "  example-supadata  ",
  });

  assert.equal(normalized.provider, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
  assert.equal(
    settings.chatCompletionsUrl("deepseek"),
    "https://api.deepseek.com/chat/completions",
  );
});

test("MiniMax provider normalizes to fixed endpoint and M3 model", () => {
  const normalized = settings.normalize({
    provider: "minimax",
    aiApiKey: "deepseek-key",
    minimaxApiKey: "  minimax-secret  ",
    opencodeGoApiKey: "go-key",
  });

  assert.equal(normalized.provider, "minimax");
  assert.equal(normalized.aiBaseUrl, "https://api.minimaxi.com/v1");
  assert.equal(normalized.aiModel, "MiniMax-M3");
  assert.equal(normalized.minimaxApiKey, "minimax-secret");
  assert.equal(
    settings.chatCompletionsUrl("minimax"),
    "https://api.minimaxi.com/v1/chat/completions",
  );
});

test("OpenCode Go provider normalizes to fixed endpoint and DeepSeek V4 Flash", () => {
  const normalized = settings.normalize({
    provider: "opencode-go",
    opencodeGoApiKey: "  go-secret  ",
    minimaxApiKey: "minimax-key",
  });

  assert.equal(normalized.provider, "opencode-go");
  assert.equal(normalized.aiBaseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.opencodeGoApiKey, "go-secret");
  assert.equal(
    settings.chatCompletionsUrl("opencode-go"),
    "https://opencode.ai/zen/go/v1/chat/completions",
  );
});

test("provider keys stay side by side when switching providers", () => {
  const configured = settings.normalize({
    provider: "minimax",
    aiApiKey: "deepseek-key",
    minimaxApiKey: "minimax-key",
    opencodeGoApiKey: "go-key",
  });
  assert.equal(configured.aiApiKey, "deepseek-key");
  assert.equal(configured.minimaxApiKey, "minimax-key");
  assert.equal(configured.opencodeGoApiKey, "go-key");

  const switched = settings.normalize({
    ...configured,
    provider: "opencode-go",
  });
  assert.equal(switched.provider, "opencode-go");
  assert.equal(switched.aiApiKey, "deepseek-key");
  assert.equal(switched.opencodeGoApiKey, "go-key");
});

test("legacy custom migration clears only the AI key and is idempotent", () => {
  const legacy = {
    provider: "custom",
    aiApiKey: "custom-secret",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: " supadata-secret ",
  };
  const first = settings.migrateLegacyCustom(legacy);

  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "deepseek");
  assert.equal(first.settings.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(first.settings.aiModel, "deepseek-v4-flash");
  assert.equal(first.settings.aiApiKey, "");
  assert.equal(first.settings.supadataApiKey, "supadata-secret");

  const second = settings.migrateLegacyCustom(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);

  const configuredDeepSeek = settings.normalize({
    ...first.settings,
    aiApiKey: "new-deepseek-key",
  });
  assert.equal(configuredDeepSeek.aiApiKey, "new-deepseek-key");
});

test("the sign-in URL carries the interface language", () => {
  // The page the user lands on after GitHub belongs to the sync service,
  // so the language has to travel with the request.
  assert.equal(
    settings.buildGithubLoginUrl("zh-CN", "https://sync.test"),
    "https://sync.test/api/auth/login?lang=zh-CN",
  );
  assert.equal(
    settings.buildGithubLoginUrl("en", "https://sync.test"),
    "https://sync.test/api/auth/login?lang=en",
  );
  // An unknown language falls back to English instead of being passed on.
  assert.equal(
    settings.buildGithubLoginUrl("klingon", "https://sync.test"),
    "https://sync.test/api/auth/login?lang=en",
  );
  assert.equal(
    settings.buildGithubLoginUrl(undefined, "https://sync.test/"),
    "https://sync.test/api/auth/login?lang=en",
  );
  // A missing server URL is a configuration error, not a broken link.
  assert.throws(
    () => settings.buildGithubLoginUrl("en", ""),
    /sync service URL is not configured/,
  );
});

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,  );
});

// ============================================================
// The registry of what an account leaves on this device
// ============================================================

/**
 * A storage that behaves like chrome.storage.local: it takes a list of
 * keys as well as a single one, and it copies what it keeps.
 */
function createStorageFake(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(keys) {
      if (keys === null) return { ...values };
      const requested = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) out[key] = values[key];
      }
      return out;
    },
    async set(items) {
      Object.assign(values, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
  };
}

test("the registry knows every key an account left on this device", () => {
  // The notes, the words, the two drop notices, the two queues of
  // deletes that have not reached the server yet, and the two cursors that
  // say how far the device has seen the account. A key that is missing
  // here is data the user believes is gone and is not.
  assert.deepEqual(settings.accountScopedStorageKeys("1001"), [
    "ytd_notes_1001",
    "ytd_vocabulary_1001",
    "ytd_notes_dropped_1001",
    "ytd_vocabulary_dropped_1001",
    "ytd_pending_deletes_1001",
    "ytd_pending_vocab_deletes_1001",
    "ytd_sync_cursor_notes_1001",
    "ytd_sync_cursor_vocabulary_1001",
  ]);
});

test("the queues of deletes that have not reached the server are named after the account", () => {
  // The key strings are the ones the sync layer has always written, so the
  // queue the extension is looking for is the queue that is really there.
  assert.equal(
    settings.pendingDeletesStorageKey("1001"),
    "ytd_pending_deletes_1001",
  );
  assert.equal(settings.pendingDeletesStorageKey(""), "ytd_pending_deletes");
  assert.equal(
    settings.pendingVocabDeletesStorageKey("1001"),
    "ytd_pending_vocab_deletes_1001",
  );
  assert.equal(
    settings.pendingVocabDeletesStorageKey(undefined),
    "ytd_pending_vocab_deletes",
  );
});

test("clearing an account's data removes the queues that hold the user's own sentences", async () => {
  const storage = createStorageFake({
    ytd_notes_1001: [{ id: "note-1" }],
    ytd_vocabulary_1001: [{ id: "word-1" }],
    ytd_notes_dropped_1001: { total: 1 },
    ytd_vocabulary_dropped_1001: { total: 1 },
    ytd_pending_deletes_1001: [{ clientId: "note-1", deletedAt: 1 }],
    ytd_pending_vocab_deletes_1001: [
      { key: "word-1", term: "a word", sentence: "the user's own sentence" },
    ],
    // Another account on the same device: not this account's to delete.
    ytd_notes_2002: [{ id: "note-2" }],
    ytd_pending_vocab_deletes_2002: [
      { key: "word-2", term: "another word", sentence: "another sentence" },
    ],
  });

  const removed = await settings.clearAccountScopedStorage("1001", storage);

  assert.deepEqual(removed, settings.accountScopedStorageKeys("1001"));
  // The queues carry the user's own text, so they are named here rather
  // than only checked through the registry: a registry that forgot them
  // must not make this test forget them too.
  assert.ok(
    removed.includes("ytd_pending_deletes_1001"),
    "the queue of note deletes was not removed",
  );
  assert.ok(
    removed.includes("ytd_pending_vocab_deletes_1001"),
    "the queue of word deletes was not removed",
  );
  for (const key of [
    "ytd_notes_1001",
    "ytd_vocabulary_1001",
    "ytd_notes_dropped_1001",
    "ytd_vocabulary_dropped_1001",
    "ytd_pending_deletes_1001",
    "ytd_pending_vocab_deletes_1001",
  ]) {
    assert.equal(
      storage.values[key],
      undefined,
      `${key} was left on the device after the account was deleted`,
    );
  }
  assert.ok(storage.values.ytd_notes_2002, "another account's notes were deleted");
  assert.ok(
    storage.values.ytd_pending_vocab_deletes_2002,
    "another account's words were deleted",
  );
});

test("the ownership record keeps the entries of the other accounts", async () => {
  // The record is global, but the ownership is per account. Only this
  // account's entries may go.
  const storage = createStorageFake({
    ytd_vocabulary_claim: { ids: { w1: "1001", w2: "1001", w3: "2002" } },
    ytd_notes_claim: { ids: { n1: "1001", n2: "2002" } },
  });

  await settings.clearAccountScopedStorage("1001", storage);

  assert.deepEqual(storage.values.ytd_vocabulary_claim, {
    ids: { w3: "2002" },
  });
  assert.deepEqual(storage.values.ytd_notes_claim, { ids: { n2: "2002" } });
});

test("an ownership record that belongs to nobody else is removed entirely", async () => {
  const storage = createStorageFake({
    ytd_vocabulary_claim: { ids: { w1: "1001" } },
  });

  await settings.clearAccountScopedStorage("1001", storage);

  assert.equal(storage.values.ytd_vocabulary_claim, undefined);
});
