const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const checker = require("../scripts/check-prompts.js");

/**
 * Loads the real service worker so the test can call the runtime's own
 * `loadPromptSection()`. The function is a top-level declaration, so it
 * lands on the sandbox's global object.
 */
function loadPromptRuntime(overrides = {}) {
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
    fetch: async (url) => {
      const name = /\/prompts\/([^/?#]+)$/.exec(String(url));
      if (!name) throw new Error("unexpected fetch: " + url);
      const file = name[1];
      return {
        ok: true,
        text: async () =>
          overrides[file] ??
          fs.readFileSync(path.join(root, "prompts", file), "utf8"),
      };
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
  // cloud-sync.js is imported by background.js through importScripts, which
  // the sandbox stubs, so it is loaded explicitly first.
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox;
}

/** Copies the prompt files into a scratch root the checker can read. */
function makeScratchRoot(mutate = () => {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ytd-prompts-"));
  fs.mkdirSync(path.join(scratch, "prompts"));
  for (const name of fs.readdirSync(path.join(root, "prompts"))) {
    if (!name.endsWith(".md")) continue;
    fs.copyFileSync(
      path.join(root, "prompts", name),
      path.join(scratch, "prompts", name),
    );
  }
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".js")) continue;
    fs.copyFileSync(path.join(root, name), path.join(scratch, name));
  }
  mutate(scratch);
  return scratch;
}

// ============================================================
// The release gate accepts the shipped prompts
// ============================================================

test("the release gate accepts every prompt file that ships", () => {
  const { documents, required } = checker.readPromptProject(root);

  assert.ok(documents.length >= 5, "the extension ships several prompt files");
  assert.ok(required.length >= 8, "the worker asks for several prompt sections");
  assert.deepEqual(checker.validatePromptDocuments(documents, required), []);
});

test("the release gate runs as a command and passes on the shipped prompts", () => {
  // The gate reports on stderr, because stdout belongs to the release file
  // list that scripts/package-extension.sh reads.
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "check-prompts.js"), "--root", root],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Prompt checks passed/);
});

// ============================================================
// The release gate rejects a broken prompt file
// ============================================================

test("the release gate rejects a prompt file whose first fence is gone", () => {
  const scratch = makeScratchRoot((directory) => {
    const file = path.join(directory, "prompts", "vocabulary.md");
    const markdown = fs.readFileSync(file, "utf8");
    // Remove the opening fence of the first section, exactly the kind of
    // edit that used to break the vocabulary feature in production.
    fs.writeFileSync(file, markdown.replace("```\n", ""));
  });

  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "check-prompts.js"), "--root", scratch],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "the release gate must reject a broken prompt");
  assert.match(result.stderr, /Prompt check failed/);
});

test("the release gate rejects a prompt section the code asks for but that is gone", () => {
  const { documents, required } = checker.readPromptProject(root);
  const broken = documents.map((document) =>
    document.file === "vocabulary.md"
      ? {
          file: document.file,
          markdown: document.markdown.replace("## System prompt", "## Rules"),
        }
      : document,
  );

  const problems = checker.validatePromptDocuments(broken, required);
  assert.ok(
    problems.some((problem) => problem.includes("vocabulary.md#System prompt")),
    `the renamed section must be reported, got: ${problems.join(" | ")}`,
  );
});

test("the release gate rejects a prompt file with a malformed fence", () => {
  const { documents, required } = checker.readPromptProject(root);
  const broken = documents.map((document) =>
    document.file === "vocabulary.md"
      ? {
          file: document.file,
          // A fence with a broken header cannot be read by the runtime
          // parser: the reader expects the tag to be followed by a newline.
          markdown: document.markdown.replace("```\n", "```text extra\n"),
        }
      : document,
  );

  const problems = checker.validatePromptDocuments(broken, required);
  assert.ok(
    problems.length > 0,
    "a fence that never closes must be reported",
  );
});

// ============================================================
// The gate and the runtime read the files the same way
// ============================================================

test("the release gate and the runtime read a prompt section the same way", async () => {
  const runtime = loadPromptRuntime();
  const { documents, required } = checker.readPromptProject(root);
  const byFile = new Map(documents.map((doc) => [doc.file, doc.markdown]));

  for (const { file, heading } of required) {
    const fromRuntime = await runtime.loadPromptSection(file, heading);
    const fromGate = checker.parsePromptSection(byFile.get(file), heading, file);
    assert.equal(
      fromGate,
      fromRuntime,
      `the gate and the runtime must read ${file}#${heading} the same way`,
    );
  }
});

test("the runtime refuses a section whose fence is gone, and so does the gate", async () => {
  const markdown = read("prompts/vocabulary.md").replace("## System prompt", "## Rules");
  const runtime = loadPromptRuntime({ "vocabulary.md": markdown });

  await assert.rejects(
    () => runtime.loadPromptSection("vocabulary.md", "System prompt"),
    /Prompt section not found/,
  );
  assert.throws(
    () => checker.parsePromptSection(markdown, "System prompt", "vocabulary.md"),
    /Prompt section not found/,
  );
});
