const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * The Summary tab has to carry a summary.
 *
 * The chain that produces one is long: the prompt has to ask the model for
 * a summary, the worker has to keep the field instead of rebuilding the
 * object without it, the panel has to render it, and the translator has to
 * be able to translate it. Every link of that chain was missing at some
 * point, and every missing link looked fine from the outside, because the
 * tab was called "Overview" and nobody looked for a summary.
 *
 * These tests hold the whole chain in place. They are written against the
 * real files, not against a mock, so a link that breaks turns them red.
 */

const ANALYSIS_PROMPT = read("prompts/analysis.md");

// ============================================================
// The prompt asks for a summary
// ============================================================

test("the analysis prompt asks the model for a summary", () => {
  assert.match(
    ANALYSIS_PROMPT,
    /summary/i,
    "the prompt never mentions a summary, so the model never writes one",
  );
  // The output shape is what the model copies. A summary that is only
  // mentioned in the prose still comes back missing. The chapter template
  // also has a "summary" field, so the top-level one has to be found by
  // its position: it sits beside "chapters", not inside it.
  const template = ANALYSIS_PROMPT.match(
    /Output JSON \(no markdown fences\):\s*\{[\s\S]*?\n\}/,
  );
  assert.ok(template, "the output template of the prompt is gone");
  // Two spaces is the top level of that template; the chapter's own
  // "summary" sits four spaces deep, inside the chapters array.
  assert.match(
    template[0],
    /^\s{2}"summary"\s*:/m,
    "the JSON template has no top-level summary field, so the model does not return one",
  );
});

test("the analysis prompt asks for a summary of the whole video", () => {
  // A summary that only describes the opening is worse than no summary.
  const prompt = ANALYSIS_PROMPT.toLowerCase();
  assert.match(
    prompt,
    /summary/,
    "the prompt says nothing about a summary",
  );
});

// ============================================================
// The worker keeps the summary the model wrote
// ============================================================

/**
 * Loads the real service worker so the test can call the runtime's own
 * `validateAndFixTimestamps()`. The function is a top-level declaration, so
 * it lands on the sandbox's global object.
 */
function loadBackgroundRuntime() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    importScripts() {},
    fetch: async () => {
      throw new Error("no network in this test");
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
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
        onMessage: { addListener() {} },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: async () => ({ success: true }),
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        create: async () => ({ id: 1, url: "" }),
        get: async () => null,
        sendMessage: async () => ({ success: true }),
      },
    },
    YTD_SETTINGS: require("../settings.js"),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox;
}

test("the worker keeps the summary the model wrote", () => {
  const runtime = loadBackgroundRuntime();
  const result = runtime.validateAndFixTimestamps(
    {
      summary: "This video argues that taste beats pedigree.",
      chapters: [
        {
          title: "Opening",
          summary: "What the video covers",
          timestampSeconds: 0,
        },
      ],
      keyQuotes: [
        { quote: "A quote", timestampSeconds: 30 },
      ],
    },
    600,
  );

  assert.equal(
    result.summary,
    "This video argues that taste beats pedigree.",
    "the summary was thrown away on the way to the panel",
  );
});

test("the worker turns a missing summary into an empty string, not undefined", () => {
  const runtime = loadBackgroundRuntime();
  const result = runtime.validateAndFixTimestamps(
    { chapters: [], keyQuotes: [] },
    600,
  );
  assert.equal(result.summary, "");
  assert.equal(typeof result.summary, "string");
});

test("the worker trims a summary that is far too long", () => {
  const runtime = loadBackgroundRuntime();
  const result = runtime.validateAndFixTimestamps(
    { summary: "x".repeat(9000), chapters: [], keyQuotes: [] },
    600,
  );
  assert.ok(
    result.summary.length <= 2000,
    `the summary was not trimmed: ${result.summary.length} characters`,
  );
});

// ============================================================
// The panel renders the summary
// ============================================================

test("the panel has a place to show the summary", () => {
  const html = read("sidepanel.html");
  assert.match(
    html,
    /id="summaryText"|id="summary-text"|id="analysisSummary"/,
    "the Summary tab has no element to hold the summary",
  );
});

test("the panel renders the summary the analysis carries", () => {
  const panel = read("sidepanel.js");
  assert.match(
    panel,
    /analysis\.summary|currentAnalysis\.summary|summaryText/,
    "the panel never reads the summary out of the analysis",
  );
});

test("the Summary tab asks for the chapter list under the summary", () => {
  // The summary is the answer to "what is this video about". It has to come
  // before the chapters, not after them.
  const html = read("sidepanel.html");
  const summaryAt = html.search(/id="summaryText"|id="summary-text"|id="analysisSummary"/);
  const chaptersAt = html.search(/id="chapterList"/);
  assert.ok(summaryAt > -1, "the summary element is missing");
  assert.ok(chaptersAt > -1, "the chapter list is missing");
  assert.ok(
    summaryAt < chaptersAt,
    "the summary comes after the chapters, so the reader meets the list first",
  );
});

test("the summary is cleared when the panel moves to another video", () => {
  // A summary that survives a video change is a lie: it belongs to the
  // video the user just left.
  const panel = read("sidepanel.js");
  const clear = panel.match(/function clearOverviewLists\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(clear, "clearOverviewLists() is gone");
  assert.match(
    clear[0],
    /summaryText|analysisSummary|summary/,
    "clearOverviewLists() leaves the previous video's summary on screen",
  );
});

test("the summary can be translated like the rest of the overview", () => {
  const panel = read("sidepanel.js");
  const segments = panel.match(
    /function getOverviewTranslationSegments\(\)\s*\{[\s\S]*?\n\}/,
  );
  assert.ok(segments, "getOverviewTranslationSegments() is gone");
  // The chapter summaries are a different thing: the top-level summary is
  // the one the reader meets first, and it is the one that was missing.
  // `currentAnalysis.summary` is the only way to reach it.
  assert.match(
    segments[0],
    /currentAnalysis\.summary/,
    "the top-level summary is left out of the translation, so a Chinese reader sees English",
  );
});
