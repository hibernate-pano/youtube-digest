const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function createStorageMock(initial = {}) {
  const values = { ...initial };
  return {
    async get(keys) {
      if (keys === null) return { ...values };
      const requested = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) result[key] = values[key];
      }
      return result;
    },
    async set(items) {
      Object.assign(values, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
  };
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  storageMock,
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (keys) => {
            const mock = storageMock || {
              async get() {
                return { ytd_settings: settings };
              },
            };
            return mock.get(keys);
          },
          set: async (items) => {
            if (!storageMock) throw new Error("storage.set requires storageMock");
            return storageMock.set(items);
          },
          remove: async (keys) => {
            if (!storageMock) throw new Error("storage.remove requires storageMock");
            return storageMock.remove(keys);
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      GITHUB_SESSION_KEY: "ytd_github_session",
      SERVER_BASE_URL: "https://sync.test",
      normalize: (value) => value,
      getProvider: (id) => ({
        deepseek: {
          name: "DeepSeek V4 Flash",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          apiKeyField: "aiApiKey",
          usesThinkingDisabled: true,
          supportsJsonMode: true,
        },
        minimax: {
          name: "MiniMax M3",
          baseUrl: "https://api.minimaxi.com/v1",
          model: "MiniMax-M3",
          apiKeyField: "minimaxApiKey",
          usesThinkingDisabled: false,
          supportsJsonMode: true,
        },
        "opencode-go": {
          name: "OpenCode Go · DeepSeek V4 Flash",
          baseUrl: "https://opencode.ai/zen/go/v1",
          model: "deepseek-v4-flash",
          apiKeyField: "opencodeGoApiKey",
          usesThinkingDisabled: false,
          supportsJsonMode: true,
        },
      })[id] || {
        name: "AI provider",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKeyField: "aiApiKey",
        usesThinkingDisabled: false,
        supportsJsonMode: false,
      },
      chatCompletionsUrl: (providerId) => {
        const baseUrl = {
          deepseek: "https://api.deepseek.com",
          minimax: "https://api.minimaxi.com/v1",
          "opencode-go": "https://opencode.ai/zen/go/v1",
        }[providerId] || "https://api.deepseek.com";
        return `${baseUrl}/chat/completions`;
      },
    },
  };
  sandbox.globalThis = sandbox;
  // cloud-sync.js is imported by background.js via importScripts; the test
  // sandbox stubs importScripts, so load it explicitly first.
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Transcript header exposes and wires Original, Chinese, and bilingual modes", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(js, /handleTranscriptModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.match(js, /Original \(\$\{language\}\)/);
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /unavailable/i);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    5,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
    "handleExtractVocabulary",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /inactive for 50 seconds.*Retry/i);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /120-second limit.*Retry/i);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("active provider sends only its own key and skips unsupported fields", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    settings: {
      provider: "minimax",
      aiApiKey: "deepseek-secret",
      minimaxApiKey: "minimax-secret",
      opencodeGoApiKey: "opencode-secret",
      aiBaseUrl: "https://api.minimaxi.com/v1",
      aiModel: "MiniMax-M3",
    },
    fetchImpl: async (url, options) => {
      requests.push({
        url,
        auth: options.headers.Authorization,
        body: JSON.parse(options.body),
      });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
        }),
      };
    },
  });

  const result = await helpers.requestAiCompletion({
    maxTokens: 64,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(result.text, "ok");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.minimaxi.com/v1/chat/completions");
  // The DeepSeek key stored side by side must never leave the device.
  assert.equal(requests[0].auth, "Bearer minimax-secret");
  assert.equal(requests[0].body.model, "MiniMax-M3");
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[0].body, "thinking"), false);
});

test("provider rejecting response_format with HTTP 400 retries once without it", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => "Bad Request: response_format is not supported",
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
        }),
      };
    },
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.", {
    responseFormat: { type: "json_object" },
  });
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  // DeepSeek's non-thinking flag survives the retry.
  assert.deepEqual(requests[1].thinking, { type: "disabled" });
});

test("provider HTTP 400 surfaces an actionable message after the retry", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Model Not Exist" } }),
    }),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.match(result.error, /Model Not Exist.*HTTP 400/);
  assert.match(result.error, /DeepSeek V4 Flash/);
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, /timed out after 130 seconds.*Retry/i);
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});
// ============================================================
// CLOUD SYNC TESTS
// ============================================================

function makeSyncEnv({ signedIn = false, notes = [] } = {}) {
  const storageMock = createStorageMock({ ytd_notes: [...notes] });
  if (signedIn) {
    storageMock.set({
      ytd_github_session: {
        token: "jwt-token",
        login: "alice",
        githubId: 1001,
        savedAt: Date.now(),
      },
    });
  }
  return { storageMock };
}

test("mergeNotesForSync drops notes deleted elsewhere (cloud is truth)", () => {
  const helpers = loadBackgroundHelpers();
  const local = [
    // Synced before (has cloudId) but missing from cloud: deleted on the dashboard.
    { id: "note_gone", text: "deleted elsewhere", cloudId: "uuid-gone", createdAt: 5000 },
    // Never synced: must be kept and pushed.
    { id: "note_new", text: "brand new", createdAt: 6000 },
  ];
  const cloud = [];
  const { mergedNotes, toPush } = helpers.mergeNotesForSync(local, cloud);
  assert.equal(mergedNotes.length, 1);
  assert.equal(mergedNotes[0].id, "note_new");
  assert.equal(toPush.length, 1);
  assert.equal(toPush[0].id, "note_new");
});

test("mergeNotesForSync pulls cloud-only notes and pushes local-only notes", () => {
  const helpers = loadBackgroundHelpers();
  const local = [
    { id: "note_local_1", text: "local new", videoId: "abc123xyz", createdAt: 1000, updatedAt: 1000 },
  ];
  const cloud = [
    {
      id: "cloud-uuid-2",
      clientId: "note_cloud_2",
      note: "cloud only",
      videoId: "def456uvw",
      videoTitle: "Cloud Video",
      channelName: "Chan",
      timestampSeconds: 42,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const { mergedNotes, toPush } = helpers.mergeNotesForSync(local, cloud);
  assert.equal(mergedNotes.length, 2);
  assert.equal(toPush.length, 1);
  assert.equal(toPush[0].id, "note_local_1");
  const cloudMerged = mergedNotes.find((note) => note.id === "note_cloud_2");
  assert.equal(cloudMerged.text, "cloud only");
  assert.equal(cloudMerged.timestamp, "0:42");
  assert.equal(cloudMerged.cloudId, "cloud-uuid-2");
});

test("mergeNotesForSync picks the newer of local and cloud by clientId", () => {
  const helpers = loadBackgroundHelpers();
  const local = [{ id: "note_x", text: "local version", createdAt: 5000 }];
  const cloud = [{
    id: "uuid-x",
    clientId: "note_x",
    note: "cloud version",
    videoId: "abc123xyz",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  }];
  const { mergedNotes, toPush } = helpers.mergeNotesForSync(local, cloud);
  assert.equal(mergedNotes.length, 1);
  assert.equal(mergedNotes[0].text, "cloud version");
  assert.equal(toPush.length, 0);
});

test("signed-out save keeps notes local and never touches the network", async () => {
  let networkCalls = 0;
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("should not be called");
    },
    storageMock: createStorageMock(),
  });
  await helpers.saveNoteToStorage({
    id: "note_1",
    text: "offline note",
    videoId: "abc123xyz",
    videoTitle: "V",
    timestampSeconds: 10,
  });
  assert.equal(networkCalls, 0);
  const stored = await helpers.handleGetNotes();
  assert.equal(stored.success, true);
  assert.equal(stored.notes.length, 1);
  assert.equal(stored.notes[0].text, "offline note");
});

test("signed-in save mirrors the note to the account namespace and cloud", async () => {
  const requests = [];
  const storageMock = createStorageMock();
  await storageMock.set({
    ytd_github_session: { token: "jwt-token", login: "alice", githubId: 1001, savedAt: Date.now() },
  });
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      requests.push({ url, auth: options.headers.Authorization, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ note: { id: "uuid-1", clientId: "note_1" } }) };
    },
    storageMock,
  });
  await helpers.saveNoteToStorage({
    id: "note_1",
    text: "my learning note",
    videoId: "abc123xyz",
    videoTitle: "My Video",
    channelName: "Chan",
    timestampSeconds: 65,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://sync.test/api/notes");
  assert.equal(requests[0].auth, "Bearer jwt-token");
  assert.equal(requests[0].body.clientId, "note_1");
  assert.equal(requests[0].body.note, "my learning note");
  assert.equal(requests[0].body.timestampSeconds, 65);
  const raw = await storageMock.get(null);
  assert.equal(raw.ytd_notes, undefined);
  assert.equal(raw.ytd_notes_1001.length, 1);
  assert.equal(raw.ytd_notes_1001[0].text, "my learning note");
});

test("signed-in delete removes the note locally and on the server", async () => {
  const requests = [];
  const storageMock = createStorageMock();
  await storageMock.set({
    ytd_github_session: { token: "jwt-token", login: "alice", githubId: 1001, savedAt: Date.now() },
    ytd_notes_1001: [{ id: "note_1", text: "to delete", videoId: "abc123xyz" }],
  });
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      return { ok: true, json: async () => ({ deleted: true }) };
    },
    storageMock,
  });
  const result = await helpers.handleDeleteNote("note_1");
  assert.equal(result.success, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "DELETE");
  assert.equal(requests[0].url, "https://sync.test/api/notes/client/note_1");
  const raw = await storageMock.get(null);
  assert.equal(raw.ytd_notes_1001.length, 0);
});

test("fullSyncNotes pulls cloud notes, pushes local-only, and writes back", async () => {
  const requests = [];
  const storageMock = createStorageMock();
  await storageMock.set({
    ytd_github_session: { token: "jwt-token", login: "alice", githubId: 1001, savedAt: Date.now() },
    ytd_notes_1001: [{ id: "note_local", text: "local only", videoId: "abc123xyz", createdAt: Date.now() }],
  });
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      if (options.method === "GET") {
        return {
          ok: true,
          json: async () => ({
            notes: [{
              id: "uuid-c",
              clientId: "note_cloud",
              note: "from cloud",
              videoId: "def456uvw",
              videoTitle: "Cloud",
              timestampSeconds: 5,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({ note: { id: "uuid-l" } }) };
    },
    storageMock,
  });
  const result = await helpers.fullSyncNotes();
  assert.equal(result.success, true);
  assert.equal(result.synced, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[1].method, "POST");
  const raw = await storageMock.get(null);
  const ids = raw.ytd_notes_1001.map((note) => note.id).sort();
  assert.equal(ids.join(","), "note_cloud,note_local");
});

test("fullSyncNotes is a no-op when signed out", async () => {
  let networkCalls = 0;
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("should not be called");
    },
    storageMock: createStorageMock(),
  });
  const result = await helpers.fullSyncNotes();
  assert.equal(result.success, true);
  assert.equal(result.synced, false);
  assert.equal(networkCalls, 0);
});


test("login migrates signed-out notes into the account namespace once", async () => {
  const storageMock = createStorageMock({
    ytd_notes: [
      { id: "legacy_1", text: "old note", videoId: "abc123xyz", createdAt: 1000 },
      { id: "legacy_2", text: "another", videoId: "abc123xyz", createdAt: 2000 },
    ],
    ytd_notes_1001: [{ id: "legacy_1", text: "old note", videoId: "abc123xyz", createdAt: 1000 }],
  });
  const helpers = loadBackgroundHelpers({ storageMock });
  const added = await helpers.migrateLegacyLocalNotes(1001);
  assert.equal(added, 1);
  const raw = await storageMock.get(null);
  const ids = raw.ytd_notes_1001.map((note) => note.id).sort();
  assert.equal(ids.join(","), "legacy_1,legacy_2");
  // Second login does not import again.
  const again = await helpers.migrateLegacyLocalNotes(1001);
  assert.equal(again, 0);
});


// ============================================================
// VOCABULARY + REVIEW TESTS
// ============================================================

test("mergeVocabularyForSync pulls, pushes, and propagates deletion", () => {
  const helpers = loadBackgroundHelpers();
  const local = [
    { term: "serendipity", sentence: "A happy accident.", createdAt: 1000 },
    { term: "ephemeral", sentence: "Fleeting.", cloudId: "uuid-gone", createdAt: 2000 },
  ];
  const cloud = [
    { id: "uuid-c", term: "ephemeral", sentence: "Fleeting.", translation: "短暂的", sentenceTranslation: "", videoId: "", videoTitle: "", timestampSeconds: 0, status: "learning", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "uuid-d", term: "resilient", sentence: "Stay strong.", translation: "有韧性的", sentenceTranslation: "", videoId: "", videoTitle: "", timestampSeconds: 0, status: "learning", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  ];
  const { mergedItems, toPush } = helpers.mergeVocabularyForSync(local, cloud);
  // serendipity (new local) + ephemeral (cloud copy) + resilient (cloud only)
  assert.equal(mergedItems.length, 3);
  assert.equal(toPush.length, 1);
  assert.equal(toPush[0].term, "serendipity");
  const ephemeral = mergedItems.find((item) => item.term === "ephemeral");
  assert.equal(ephemeral.cloudId, "uuid-c");
  assert.equal(ephemeral.translation, "短暂的");
});

test("vocabulary save is local-only when signed out and namespaced when signed in", async () => {
  const storageMock = createStorageMock();
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      throw new Error("no network expected");
    },
    storageMock,
  });
  const saved = await helpers.handleSaveVocabulary({
    term: "insight",
    translation: "洞察",
    sentence: "She shared a deep insight.",
    videoId: "abc123xyz",
  });
  assert.equal(saved.success, true);
  const raw = await storageMock.get(null);
  assert.equal(raw.ytd_vocabulary.length, 1);
  assert.equal(raw.ytd_vocabulary[0].term, "insight");
  assert.equal(raw.ytd_vocabulary[0].status, "learning");
});

test("vocabulary save mirrors to the cloud and records cloudId", async () => {
  const requests = [];
  const storageMock = createStorageMock();
  await storageMock.set({
    ytd_github_session: { token: "jwt-token", login: "alice", githubId: 1001, savedAt: Date.now() },
  });
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      requests.push({ url, auth: options.headers.Authorization, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ vocabulary: { id: "uuid-v1" } }) };
    },
    storageMock,
  });
  const saved = await helpers.handleSaveVocabulary({
    term: "resilient",
    translation: "有韧性的",
    sentence: "Be resilient.",
    videoId: "abc123xyz",
  });
  assert.equal(saved.success, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://sync.test/api/vocabulary");
  assert.equal(requests[0].auth, "Bearer jwt-token");
  assert.equal(requests[0].body.term, "resilient");
  const raw = await storageMock.get(null);
  assert.equal(raw.ytd_vocabulary_1001[0].cloudId, "uuid-v1");
});

test("reviews require a session and submit grades to the cloud", async () => {
  const storageMock = createStorageMock();
  const helpers = loadBackgroundHelpers({ storageMock });
  const unsigned = await helpers.handleGetDueReviews();
  assert.equal(unsigned.success, false);
  assert.equal(unsigned.error, "NO_SESSION");

  const requests = [];
  await storageMock.set({
    ytd_github_session: { token: "jwt-token", login: "alice", githubId: 1001, savedAt: Date.now() },
  });
  const signedIn = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (options.method === "GET") {
        return {
          ok: true,
          json: async () => ({
            reviews: [{ review: { dueAt: "2026-01-01T00:00:00Z", intervalDays: 0, ease: 2.5, reps: 0 }, vocabulary: { id: "uuid-v1", term: "resilient", translation: "有韧性的", sentence: "Be resilient." } }],
          }),
        };
      }
      return { ok: true, json: async () => ({ review: { intervalDays: 2, reps: 1 } }) };
    },
    storageMock,
  });
  const due = await signedIn.handleGetDueReviews();
  assert.equal(due.success, true);
  assert.equal(due.reviews.length, 1);
  assert.equal(due.reviews[0].vocabulary.term, "resilient");

  const graded = await signedIn.handleSubmitReview("uuid-v1", 4);
  assert.equal(graded.success, true);
  assert.equal(graded.review.intervalDays, 2);
  assert.equal(requests[1].url, "https://sync.test/api/reviews/uuid-v1");
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].body.grade, 4);
});

