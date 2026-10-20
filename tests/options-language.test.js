const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function createLocalStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("Settings copy covers English and Simplified Chinese", () => {
  assert.equal(options.translate("en", "pageTitle"), "YouTube Digest Settings");
  assert.equal(options.translate("zh-CN", "pageTitle"), "YouTube Digest 设置");
  assert.equal(options.translate("en", "saveSettings"), "Save settings");
  assert.equal(options.translate("zh-CN", "saveSettings"), "保存设置");
  assert.equal(
    options.translate("zh-CN", "clearedDigests", { count: 2 }),
    "已清除 2 条缓存摘要。",
  );

  assert.deepEqual(
    Object.keys(options.COPY.en).sort(),
    Object.keys(options.COPY["zh-CN"]).sort(),
  );

  const html = read("options.html");
  const referencedKeys = [
    ...html.matchAll(/data-i18n(?:-html|-aria-label)?="([^"]+)"/g),
  ].map((match) => match[1]);
  for (const key of referencedKeys) {
    assert.ok(options.COPY.en[key], `Missing English copy for ${key}`);
    assert.ok(options.COPY["zh-CN"][key], `Missing Chinese copy for ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(options.COPY), /—/);
  assert.doesNotMatch(html, /—/);
});

test("language preference persists through extension-compatible storage", async () => {
  const storedValues = {};
  const chromeApi = {
    storage: {
      local: {
        async get(key) {
          return Object.hasOwn(storedValues, key)
            ? { [key]: storedValues[key] }
            : {};
        },
        async set(items) {
          Object.assign(storedValues, items);
        },
        async remove() {},
        async clear() {},
      },
    },
  };
  const storage = options.createStorageAdapter(chromeApi);

  await options.persistPreferredLanguage(storage, "zh-CN");

  assert.equal(storedValues[options.LANGUAGE_STORAGE_KEY], "zh-CN");
  assert.equal(await options.readPreferredLanguage(storage), "zh-CN");
});

test("non-extension preview safely persists language in localStorage", async () => {
  const localStorage = createLocalStorage();
  const firstSession = options.createStorageAdapter(null, localStorage);

  await options.persistPreferredLanguage(firstSession, "zh-CN");

  const reopenedSession = options.createStorageAdapter(null, localStorage);
  assert.equal(await options.readPreferredLanguage(reopenedSession), "zh-CN");
  assert.equal(options.normalizeLanguage("unsupported"), "en");
});

test("language controls expose a labelled group and one pressed button", () => {
  const html = read("options.html");
  assert.match(
    html,
    /class="language-switch"[\s\S]*role="group"[\s\S]*aria-label="Interface language"/,
  );
  assert.match(
    html,
    /data-language="en"[\s\S]*aria-pressed="true"[\s\S]*English/,
  );
  assert.match(
    html,
    /data-language="zh-CN"[\s\S]*aria-pressed="false"[\s\S]*中文/,
  );

  const buttons = ["en", "zh-CN"].map((language) => ({
    dataset: { language },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  }));
  options.updateLanguageButtonState(buttons, "zh-CN");

  assert.equal(buttons[0].attributes["aria-pressed"], "false");
  assert.equal(buttons[1].attributes["aria-pressed"], "true");
});

test("customization guidance is concise and has a visible placeholder reminder", () => {
  const html = read("options.html");
  const steps = html.match(
    /<ol class="customization-steps">([\s\S]*?)<\/ol>/,
  );

  assert.ok(steps, "Expected a numbered customization guide");
  assert.equal((steps[1].match(/<li\b/g) || []).length, 3);
  assert.match(html, /class="prompt-reminder"/);
  assert.match(html, /role="note"/);
  assert.equal(
    options.translate("zh-CN", "customizationReminder"),
    "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
  );
  assert.equal(
    options.translate("en", "customizationStepFolder"),
    "Open the extracted YouTube Digest project folder in your coding agent.",
  );
  assert.equal(
    options.translate("zh-CN", "customizationStepFolder"),
    "在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。",
  );
  assert.doesNotMatch(html, /~\/Documents\/youtube-digest/);
  assert.doesNotMatch(html, /%USERPROFILE%\\Documents\\youtube-digest/);
});

test("customization prompt switches languages and preserves technical values", () => {
  const html = read("options.html");
  const englishPrompt = options.translate("en", "customizationPrompt");
  const chinesePrompt = options.translate("zh-CN", "customizationPrompt");

  assert.match(html, /placeholder="Paste your Supadata key"/);
  assert.match(html, /placeholder="Paste your DeepSeek key"/);
  assert.match(html, /https:\/\/dash\.supadata\.ai\/auth\/sign-up/);
  assert.match(html, /https:\/\/platform\.deepseek\.com\/api_keys/);
  assert.ok(html.includes(`>${englishPrompt}</textarea>`));
  assert.match(chinesePrompt, /^请把当前本地 YouTube Digest 工作区改为使用/);
  assert.notEqual(chinesePrompt, englishPrompt);
  assert.match(
    englishPrompt,
    /Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek\. Handle provider-specific rules separately so one provider does not affect another\./,
  );
  assert.match(
    chinesePrompt,
    /DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。/,
  );

  for (const prompt of [englishPrompt, chinesePrompt]) {
    assert.match(prompt, /\[PROVIDER\]/);
    assert.match(prompt, /\[MODEL\]/);
    assert.match(prompt, /manifest\.json/);
    assert.match(prompt, /README\.md/);
    assert.match(prompt, /README\.zh-CN\.md/);
    assert.match(prompt, /PRIVACY\.md/);
    assert.match(prompt, /SECURITY\.md/);
    assert.match(prompt, /npm test/);
    assert.match(prompt, /npm run check/);
    assert.match(prompt, /npm run package/);
    assert.doesNotMatch(prompt, /—/);
  }
  const textareaTag = html.match(/<textarea id="customizationPrompt"[^>]*>/);
  assert.ok(textareaTag, "Expected the customization prompt textarea");
  assert.doesNotMatch(textareaTag[0], /\sreadonly(?:\s|=|>)/);
  assert.match(
    textareaTag[0],
    /aria-describedby="customizationPromptReminder"/,
  );
  assert.doesNotMatch(html, /<textarea id="customizationPrompt"[^>]*data-i18n/);
});

test("language switching preserves edited prompt drafts for the page session", () => {
  const drafts = options.createPromptDrafts();
  const chineseDefault = drafts["zh-CN"];

  const chinese = options.switchPromptDraft(
    drafts,
    "en",
    "zh-CN",
    "Edited English [PROVIDER] [MODEL]",
  );
  assert.equal(chinese.prompt, chineseDefault);

  const english = options.switchPromptDraft(
    drafts,
    "zh-CN",
    "en",
    "已编辑中文 [PROVIDER] [MODEL]",
  );
  assert.equal(english.prompt, "Edited English [PROVIDER] [MODEL]");

  const restoredChinese = options.switchPromptDraft(
    drafts,
    "en",
    "zh-CN",
    english.prompt,
  );
  assert.equal(restoredChinese.prompt, "已编辑中文 [PROVIDER] [MODEL]");
});

test("copy helper writes the current edited textarea value", async () => {
  const writes = [];
  const clipboard = {
    async writeText(value) {
      writes.push(value);
    },
  };

  await options.copyPromptValue(
    clipboard,
    "My edited prompt for [PROVIDER] and [MODEL]",
  );

  assert.deepEqual(writes, ["My edited prompt for [PROVIDER] and [MODEL]"]);
});

test("localized prompt updates preserve the textarea selection and scroll", () => {
  const textarea = {
    value: options.translate("en", "customizationPrompt"),
    selectionStart: 12,
    selectionEnd: 48,
    selectionDirection: "forward",
    scrollTop: 90,
    scrollLeft: 7,
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    },
  };
  const chinesePrompt = options.translate("zh-CN", "customizationPrompt");

  options.updateLocalizedPrompt(textarea, chinesePrompt);

  assert.equal(textarea.value, chinesePrompt);
  assert.equal(textarea.selectionStart, 12);
  assert.equal(textarea.selectionEnd, 48);
  assert.equal(textarea.selectionDirection, "forward");
  assert.equal(textarea.scrollTop, 90);
  assert.equal(textarea.scrollLeft, 7);
});

test("the static HTML fallback says the same thing as the runtime copy", () => {
  const html = read("options.html");
  const elements = [
    ...html.matchAll(
      /<(\w+)([^>]*\bdata-i18n="([^"]+)"[^>]*)>([\s\S]*?)<\/\1\s*>/g,
    ),
  ];
  let checked = 0;
  const drift = [];

  for (const [, , , key, inner] of elements) {
    // The runtime replaces the element's content with the translated
    // string, so any static text has to be that same string. A node the
    // script fills in later carries no static text and is skipped.
    const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    // Some copy names another part of the interface ({tabOverview}), so it
    // is resolved with the same parameters the page uses at runtime.
    const expected = options.translate("en", key, options.i18nParams("en"));
    assert.ok(expected, `Missing English copy for ${key}`);
    // Some strings carry a trailing space so a link that follows them as a
    // sibling keeps a visual gap. Compare on collapsed whitespace.
    const collapsed = expected.replace(/\s+/g, " ").trim();
    if (text !== collapsed) {
      drift.push({ key, staticText: text, runtimeCopy: collapsed });
    }
    checked += 1;
  }

  assert.deepEqual(
    drift,
    [],
    `the static HTML and the runtime copy disagree on: ${drift
      .map((item) => item.key)
      .join(", ")}`,
  );

  assert.ok(
    checked >= 20,
    `only ${checked} static strings were compared - the matcher probably stopped working`,
  );
});

test("the settings page names the panel's tabs the way the panel names them", () => {
  // The settings page walks the user through the panel, so it refers to the
  // panel's tabs by name. Those names are localized, and the two pages are
  // separate bundles with no shared copy table — so the two can drift apart
  // and leave a Chinese instruction pointing at a tab that does not exist.
  const sidepanel = read("sidepanel.js");
  const table = sidepanel.match(/const PANEL_COPY = \{[\s\S]*?\n\};/);
  assert.ok(table, "the panel needs a copy table");
  // The literal is evaluated, so this compares the real values rather than
  // the shape of the source.
  const panelCopy = vm.runInNewContext(
    `(${table[0].replace(/^const PANEL_COPY = /, "").replace(/;$/, "")})`,
  );

  for (const key of ["tabTranscript", "tabOverview", "tabNotes"]) {
    for (const language of ["en", "zh-CN"]) {
      assert.equal(
        options.translate(language, key, options.i18nParams(language)),
        panelCopy[language][key],
        `the settings page and the side panel disagree on ${key} in ${language}`,
      );
    }
  }
});

test("the Chinese copy names interface elements in Chinese, not in English", () => {
  // A Chinese instruction that says "click Note" while the button reads
  // 笔记 points at nothing the user can find. Product names stay in Latin
  // script; everything the user has to locate must not.
  const chinese = options.COPY["zh-CN"];
  for (const key of ["setupGuideStep3"]) {
    const value = options.translate("zh-CN", key, options.i18nParams("zh-CN"));
    assert.doesNotMatch(
      value,
      /\b(Overview|Transcript|Notes|Note)\b/,
      `the Chinese copy for ${key} still names an interface element in English: ${value}`,
    );
  }
});

test("every notes namespace is recognised, whatever account it belongs to", () => {
  const settings = require("../settings.js");

  assert.equal(settings.notesStorageKey(""), "ytd_notes");
  assert.equal(settings.notesStorageKey(undefined), "ytd_notes");
  assert.equal(settings.notesStorageKey("12345"), "ytd_notes_12345");
  assert.equal(settings.notesStorageKey(" 12345 "), "ytd_notes_12345");

  assert.equal(settings.isNotesStorageKey("ytd_notes"), true);
  assert.equal(settings.isNotesStorageKey("ytd_notes_12345"), true);
  // An empty account id is not a namespace: notesStorageKey("") returns
  // the base key, so "ytd_notes_" is never written.
  assert.equal(settings.isNotesStorageKey("ytd_notes_"), false);

  // Keys that only look similar must not be swept up by a wipe.
  assert.equal(settings.isNotesStorageKey("ytd_notes_filter"), false);
  assert.equal(settings.isNotesStorageKey("ytd_settings"), false);
  assert.equal(settings.isNotesStorageKey("digest_abc"), false);
  assert.equal(settings.isNotesStorageKey("ytd_vocabulary_12345"), false);
});

// ============================================================
// The data actions on the settings page
// ============================================================

function createElementStub() {
  return {
    value: "",
    textContent: "",
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    querySelectorAll: () => [],
  };
}

function createSettingsHarness(initialStorage = {}) {
  const storage = { ...initialStorage };
  const removed = [];
  const elements = new Map();

  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createElementStub());
    return elements.get(id);
  };

  const root = {
    document: {
      getElementById,
      querySelectorAll: () => [],
      readyState: "complete",
      documentElement: { lang: "en" },
      addEventListener() {},
    },
    YTD_SETTINGS: require("../settings.js"),
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (key === null || key === undefined) return { ...storage };
            if (typeof key === "string") {
              return key in storage ? { [key]: storage[key] } : {};
            }
            const out = {};
            for (const name of key) if (name in storage) out[name] = storage[name];
            return out;
          },
          async set(patch) {
            Object.assign(storage, patch);
          },
          async remove(key) {
            for (const name of Array.isArray(key) ? key : [key]) {
              removed.push(name);
              delete storage[name];
            }
          },
          async clear() {
            for (const name of Object.keys(storage)) delete storage[name];
          },
        },
      },
      runtime: { sendMessage: async () => ({}) },
    },
    navigator: {},
    confirm: () => true,
  };
  root.globalThis = root;

  const api = options.initialize(root);
  return { api, storage, removed, getElementById };
}

test("Delete all notes removes the notes of every signed-in account", async () => {
  const { api, storage, removed } = createSettingsHarness({
    ytd_notes: [{ id: "note-1" }],
    ytd_notes_1001: [{ id: "note-2" }],
    ytd_notes_2002: [{ id: "note-3" }],
    // Not notes: the panel's notes filter and the settings must survive.
    ytd_notes_filter: "all",
    ytd_settings: { aiApiKey: "x" },
    digest_abc123: { transcript: "hi" },
  });

  await api.clearNotes();

  assert.deepEqual(
    removed.sort(),
    ["ytd_notes", "ytd_notes_1001", "ytd_notes_2002"],
    "a signed-in account's notes were left on the device",
  );
  assert.equal(storage.ytd_notes, undefined);
  assert.equal(storage.ytd_notes_1001, undefined);
  assert.equal(storage.ytd_notes_2002, undefined);
  assert.equal(storage.ytd_notes_filter, "all", "the notes filter was wiped");
  assert.ok(storage.ytd_settings, "the settings were wiped");
  assert.ok(storage.digest_abc123, "the cached digests were wiped");
});

test("Delete all notes reports success even when there is nothing to delete", async () => {
  const { api, removed, getElementById } = createSettingsHarness({
    ytd_settings: { aiApiKey: "x" },
  });

  await api.clearNotes();

  assert.deepEqual(removed, []);
  assert.equal(
    getElementById("dataStatus").textContent,
    "Deleted all saved notes.",
  );
});
