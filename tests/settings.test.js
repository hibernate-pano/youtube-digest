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

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
});
