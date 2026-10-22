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

  for (const key of [
    "tabTranscript",
    "tabSummary",
    "tabNotes",
    "tabWords",
    "tabLibrary",
  ]) {
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

function createSettingsHarness(initialStorage = {}, harness = {}) {
  const storage = { ...initialStorage };
  const removed = [];
  const elements = new Map();
  const requests = [];
  const messages = [];
  const asked = [];

  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createElementStub());
    return elements.get(id);
  };

  // The next-steps guide starts hidden in the page's markup, so the stub
  // starts hidden too. A stub that started visible would make the test
  // pass without the page doing anything.
  elements.set("setupGuide", Object.assign(createElementStub(), { hidden: true }));

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
      runtime: {
        // The page asks the background for anything that touches the sync
        // service, because the session is bound to this browser and only
        // the background knows its id.
        sendMessage: async (message) => {
          messages.push(message);
          if (harness.sendMessageImpl) {
            return harness.sendMessageImpl(message, messages.length);
          }
          return {};
        },
      },
    },
    navigator: {},
    confirm: (message) => {
      asked.push(message);
      return harness.confirm ? harness.confirm(message, asked.length) : true;
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (harness.fetchImpl) return harness.fetchImpl(url, init, requests.length);
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  root.globalThis = root;

  const api = options.initialize(root);
  return { api, storage, removed, getElementById, requests, messages, asked };
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
    "Deleted 0 notes on this device.",
  );
});

test("Delete my account removes the account and its data, and asks twice first", async () => {
  let releaseProfile;
  const profileGate = new Promise((resolve) => {
    releaseProfile = resolve;
  });
  const { api, storage, removed, requests, messages, asked, getElementById } =
    createSettingsHarness(
      {
        ytd_github_session: {
          token: "token-alice",
          login: "alice",
          githubId: 1001,
          savedAt: 1,
        },
        ytd_notes_1001: [{ id: "note-1" }],
        ytd_vocabulary_1001: [{ id: "word-1" }],
        ytd_notes_2002: [{ id: "note-of-another-account" }],
        ytd_notes_filter: "all",
        ytd_settings: { aiApiKey: "x" },
      },
      {
        sendMessageImpl: async (message) => {
          if (message.action === "verifyGithubSession") {
            // The background is slow to answer who the reader is. The
            // answer arrives after the account was deleted, and it must
            // not sign the reader back in.
            await profileGate;
            return {
              success: true,
              expired: false,
              session: { login: "alice", githubId: 1001 },
            };
          }
          return { success: true };
        },
      },
    );

  await api.deleteGithubAccount();
  // Now the slow answer arrives.
  releaseProfile();
  await settle();

  // Two questions: the first one can be clicked through by accident, the
  // second one cannot.
  assert.equal(asked.length, 2, "the deletion was not confirmed twice");
  assert.match(asked[0], /cannot be undone/);
  assert.match(asked[1], /permanent/);

  // The account is deleted through the background, which is the only half
  // that can put this browser's id on the request. Asking the server from
  // the page itself would be refused, and the account would never go.
  const deletions = messages.filter(
    (message) => message.action === "deleteGithubAccount",
  );
  assert.equal(deletions.length, 1, "the account was never deleted");
  assert.equal(requests.length, 0, "the page still calls the server itself");

  // The account's own data goes with it.
  assert.ok(removed.includes("ytd_notes_1001"), "the notes stayed on the device");
  assert.ok(
    removed.includes("ytd_vocabulary_1001"),
    "the words stayed on the device",
  );
  assert.ok(
    removed.includes("ytd_github_session"),
    "the session stayed on the device",
  );
  assert.equal(storage.ytd_github_session, undefined);
  // Another account's data on the same device is not this account's to
  // delete.
  assert.ok(storage.ytd_notes_2002, "another account's notes were deleted");
  assert.ok(storage.ytd_notes_filter, "the notes filter was deleted");

  // And the page says it happened.
  assert.equal(
    getElementById("githubStatus").textContent,
    "Account deleted. Your notes and words were removed from this device too.",
  );
  assert.equal(getElementById("githubLoginBtn").hidden, false);
});

test("a refused confirmation leaves the account alone", async () => {
  const { api, storage, messages, asked } = createSettingsHarness(
    {
      ytd_github_session: { token: "token-alice", login: "alice", githubId: 1001 },
      ytd_notes_1001: [{ id: "note-1" }],
    },
    { confirm: () => false },
  );

  await api.deleteGithubAccount();

  assert.equal(asked.length, 1, "the second question was asked anyway");
  assert.equal(
    messages.filter((message) => message.action === "deleteGithubAccount")
      .length,
    0,
    "the account was deleted without consent",
  );
  assert.ok(storage.ytd_github_session, "the session was removed anyway");
  assert.ok(storage.ytd_notes_1001, "the notes were removed anyway");
});

test("a refused account deletion keeps the account and says why", async () => {
  const { api, storage, messages, getElementById } = createSettingsHarness(
    {
      ytd_github_session: { token: "token-alice", login: "alice", githubId: 1001 },
      ytd_notes_1001: [{ id: "note-1" }],
    },
    {
      sendMessageImpl: async (message) => {
        if (message.action === "deleteGithubAccount") {
          return {
            success: false,
            error: "The database is unreachable.",
            status: 500,
          };
        }
        return {};
      },
    },
  );

  await api.deleteGithubAccount();

  assert.equal(
    messages.filter((message) => message.action === "deleteGithubAccount")
      .length,
    1,
  );
  // The account is still there, and still on the device.
  assert.ok(storage.ytd_github_session, "the session was removed on a failure");
  assert.ok(storage.ytd_notes_1001, "the notes were removed on a failure");
  assert.match(
    getElementById("githubStatus").textContent,
    /Could not delete the account: The database is unreachable\./,
  );
});

/** Lets the page's promise chains finish. */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("a sync service that is having a bad minute does not sign the reader out", async () => {
  // A 500 is the service's problem, not the reader's session. Signing
  // somebody out because the server hiccuped would throw away a working
  // sign-in over nothing.
  const { api, storage, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
        savedAt: 1,
      },
    },
    {
      // The background could not reach the service, so it says so without
      // claiming the token was rejected.
      sendMessageImpl: async () => ({
        success: false,
        session: null,
        expired: false,
        error: "Service unavailable",
      }),
    },
  );

  await api.loadOptions();
  await settle();

  assert.ok(
    storage.ytd_github_session,
    "a broken server signed the reader out",
  );
  assert.notEqual(
    getElementById("githubStatus").textContent,
    "Your session expired. Sign in again.",
    "the reader was told the session expired when the server was simply down",
  );
});

test("only a rejected token ends the session", async () => {
  const { api, storage, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
        savedAt: 1,
      },
    },
    {
      // The service really did reject the token: expired, not unreachable.
      sendMessageImpl: async () => ({
        success: true,
        session: null,
        expired: true,
      }),
    },
  );

  await api.loadOptions();
  await settle();

  assert.equal(storage.ytd_github_session, undefined);
  assert.equal(
    getElementById("githubStatus").textContent,
    "Your session expired. Sign in again.",
  );
});

// ============================================================
// The key fields and the account
// ============================================================

test("the key fields say what to paste in the page's language", () => {
  // A placeholder is a label. The four key fields carried English
  // placeholders on a Chinese page, so a Chinese user was told to paste a
  // key in a language they were not reading.
  const html = read("options.html");
  const fields = [...html.matchAll(/data-i18n-placeholder="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(
    fields.length,
    4,
    "the four key fields do not all have a placeholder of their own",
  );

  for (const key of fields) {
    const english = options.translate("en", key);
    const chinese = options.translate("zh-CN", key);
    assert.ok(english, `Missing English copy for ${key}`);
    assert.ok(chinese, `Missing Chinese copy for ${key}`);
    assert.notEqual(
      chinese,
      english,
      `${key} says the same thing in both languages`,
    );
  }

  // The Chinese placeholder has to be Chinese. A sentence that is only
  // half translated is the failure this is about.
  for (const key of fields) {
    assert.match(
      options.translate("zh-CN", key),
      /[一-鿿]/,
      `${key} is not written in Chinese`,
    );
  }

  // The page has to bind them, or the copy exists and never reaches the
  // field.
  assert.match(
    read("options.js"),
    /data-i18n-placeholder/,
    "the page never applies the placeholder copy",
  );
});

test("the settings page does not promise a polishing the panel does not do", () => {
  // The panel saves a note exactly as it was written. Only the Note button
  // on the video page sends the line to the AI, and the settings page
  // used to promise a tidying-up for every note.
  for (const language of ["en", "zh-CN"]) {
    const help = [
      "deepseekHelp",
      "minimaxHelp",
      "opencodeGoHelp",
      "localDataHelp",
    ].map((key) => options.translate(language, key));
    for (const sentence of help) {
      assert.doesNotMatch(
        sentence,
        /note polish/i,
        "the settings page still promises a polishing",
      );
      assert.doesNotMatch(
        sentence,
        /笔记润色|润色笔记/,
        "the Chinese settings page still promises a polishing",
      );
    }
  }
  assert.match(
    options.translate("en", "localDataHelp"),
    /saved exactly as you wrote it/i,
    "the settings page does not say how a note is saved",
  );
});

test("Delete my account takes the notes and words off this device too", async () => {
  // The button promises that everything on this device goes. The buckets
  // that hold what was written while signed out are on the disk as well,
  // and they are the user's notes and words too.
  const { api, storage, removed } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_notes: [{ id: "note-1" }],
      ytd_vocabulary: [{ id: "word-1" }],
      ytd_settings: { aiApiKey: "x" },
    },
    {
      // The server really did delete the account. Only then is the local
      // copy this account's to remove.
      sendMessageImpl: async () => ({ success: true }),
    },
  );

  await api.deleteGithubAccount();

  assert.ok(
    removed.includes("ytd_notes"),
    "the notes written while signed out stayed on the device",
  );
  assert.ok(
    removed.includes("ytd_vocabulary"),
    "the words written while signed out stayed on the device",
  );
  assert.equal(storage.ytd_notes, undefined);
  assert.equal(storage.ytd_vocabulary, undefined);
  assert.ok(storage.ytd_settings, "the settings were wiped as well");
});

// ============================================================
// The account: the page asks the background, never the server
// ============================================================

test("the page never talks to the sync service itself", () => {
  // A session belongs to the browser that started the sign-in, and only
  // the background knows this browser's id. A request from the page would
  // be refused: deleting an account would fail, and reading the profile
  // would look like an expired session.
  const source = read("options.js");
  assert.doesNotMatch(
    source,
    /\/api\/(me|account)/,
    "the settings page still builds a sync service request of its own",
  );
  assert.doesNotMatch(
    source,
    /buildGithubLoginUrl|createLoginNonce/,
    "the settings page still builds a sign-in link that cannot name this browser",
  );
});

test("signing in asks the background for the link", async () => {
  const { api, messages } = createSettingsHarness();

  await api.startGithubLogin();

  const request = messages.find(
    (message) => message.action === "startGithubLogin",
  );
  assert.ok(request, "the sign-in never reached the background");
});

test("a service that did not answer leaves the reader signed in", async () => {
  // success:false means the service did not answer. That says nothing
  // about the token, and a sign-out here would throw away a working
  // sign-in because a server had a bad minute.
  const { api, storage, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
        savedAt: 1,
      },
    },
    {
      sendMessageImpl: async () => ({
        success: false,
        session: null,
        expired: false,
        error: "Network unreachable",
      }),
    },
  );

  await api.loadOptions();
  await settle();

  assert.ok(storage.ytd_github_session, "the reader was signed out over a failed request");
  assert.notEqual(
    getElementById("githubStatus").textContent,
    "Your session expired. Sign in again.",
    "a service that did not answer was reported as an expired session",
  );
});

test("a session the service refused signs the reader out", async () => {
  const { api, storage, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
        savedAt: 1,
      },
    },
    {
      sendMessageImpl: async () => ({
        success: true,
        session: null,
        expired: true,
      }),
    },
  );

  await api.loadOptions();
  await settle();

  assert.equal(storage.ytd_github_session, undefined, "the refused session stayed on the device");
  assert.equal(
    getElementById("githubStatus").textContent,
    "Your session expired. Sign in again.",
  );
});

// ============================================================
// The data the account leaves on this device
// ============================================================

test("Delete my account removes the queues of deletes that have not reached the server", async () => {
  // The queue of word deletes holds the user's own word and sentence text.
  // "Delete my account" promises that this device is clean, so a queue
  // left behind is a sentence the user can still read.
  const { api, storage, removed } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_notes_1001: [{ id: "note-1" }],
      ytd_vocabulary_1001: [{ id: "word-1" }],
      ytd_pending_deletes_1001: [{ clientId: "note-1", deletedAt: 1 }],
      ytd_pending_vocab_deletes_1001: [
        {
          key: "word-1",
          term: "a word",
          sentence: "the user's own sentence",
        },
      ],
      ytd_vocabulary_claim: { ids: { w1: "1001", w2: "2002" } },
      ytd_notes_claim: { ids: { n1: "1001" } },
      ytd_notes_2002: [{ id: "note-of-another-account" }],
    },
    { sendMessageImpl: async () => ({ success: true }) },
  );

  await api.deleteGithubAccount();

  assert.ok(
    removed.includes("ytd_pending_deletes_1001"),
    "the queued note deletes stayed on the device",
  );
  assert.ok(
    removed.includes("ytd_pending_vocab_deletes_1001"),
    "the queued word deletes stayed on the device",
  );
  assert.equal(
    storage.ytd_pending_vocab_deletes_1001,
    undefined,
    "the user's own sentences are still on the device",
  );
  // The ownership record is global, but the ownership is per account.
  assert.deepEqual(storage.ytd_vocabulary_claim, { ids: { w2: "2002" } });
  assert.equal(storage.ytd_notes_claim, undefined);
  assert.ok(
    storage.ytd_notes_2002,
    "another account's notes were deleted",
  );
});

test("Sign out takes the account's data off this device", async () => {
  // On a shared browser the next person must not read the notes of the
  // person who was here before.
  const { api, storage, messages, getElementById } = createSettingsHarness({
    ytd_github_session: {
      token: "token-alice",
      login: "alice",
      githubId: 1001,
    },
    ytd_notes_1001: [{ id: "note-1", cloudId: "uuid-1" }],
    ytd_vocabulary_1001: [{ id: "word-1", cloudId: "uuid-2" }],
    ytd_pending_vocab_deletes_1001: [
      { key: "word-1", term: "a word", sentence: "the user's own sentence" },
    ],
    ytd_notes_2002: [{ id: "note-of-another-account" }],
  });

  await api.logoutGithub();

  assert.ok(
    messages.some((message) => message.action === "logoutGithub"),
    "the sign-out did not go through the background",
  );
  assert.equal(storage.ytd_github_session, undefined, "the session stayed");
  assert.equal(
    storage.ytd_notes_1001,
    undefined,
    "the account's notes stayed on the device",
  );
  assert.equal(
    storage.ytd_pending_vocab_deletes_1001,
    undefined,
    "the user's own sentences stayed on the device",
  );
  assert.ok(
    storage.ytd_notes_2002,
    "another account's notes were deleted",
  );
  assert.match(
    getElementById("githubStatus").textContent,
    /removed from this device/i,
    "the page does not say what happened to the data on this device",
  );
});

test("the sign-out says something different when there was no account", async () => {
  const { api, getElementById } = createSettingsHarness({
    ytd_notes: [{ id: "note-1" }],
  });

  await api.logoutGithub();

  const signedOut = getElementById("githubStatus").textContent;
  assert.notEqual(
    signedOut,
    options.translate("en", "githubSignedOutWithAccount"),
    "a signed-out reader is told that account data was removed",
  );
});

test("Delete my account says something different when there is no account", async () => {
  const { api, asked, getElementById } = createSettingsHarness({
    ytd_notes: [{ id: "note-1" }],
  });

  await api.deleteGithubAccount();

  assert.equal(asked.length, 0, "the page asked to delete an account that is not there");
  assert.equal(
    getElementById("githubStatus").textContent,
    options.translate("en", "githubDeleteAccountNotSignedIn"),
  );
});

// ============================================================
// "Delete all notes" has to reach the account
// ============================================================

test("Delete all notes deletes the notes in the account as well", async () => {
  const { api, storage, messages, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_notes_1001: [{ id: "note-1" }],
      ytd_notes: [{ id: "note-2" }],
    },
    {
      sendMessageImpl: async (message) => {
        if (message.action === "deleteAllNotes") {
          return { success: true, deleted: 12 };
        }
        return {};
      },
    },
  );

  await api.clearNotes();

  assert.ok(
    messages.some((message) => message.action === "deleteAllNotes"),
    "the account was never asked to delete its notes",
  );
  assert.equal(storage.ytd_notes_1001, undefined, "the notes stayed");
  assert.equal(storage.ytd_notes, undefined, "the notes stayed");
  assert.match(
    getElementById("dataStatus").textContent,
    /12 notes in your account/,
    `the page does not say what was deleted: ${getElementById("dataStatus").textContent}`,
  );
});

test("Delete all notes keeps the notes and says so when the account cannot delete them", async () => {
  const { api, storage, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_notes_1001: [{ id: "note-1" }],
    },
    {
      sendMessageImpl: async (message) => {
        if (message.action === "deleteAllNotes") {
          return { success: false, error: "The database is unreachable." };
        }
        return {};
      },
    },
  );

  await api.clearNotes();

  assert.ok(
    storage.ytd_notes_1001,
    "the notes were removed from the device while the account still had them",
  );
  assert.match(
    getElementById("dataStatus").textContent,
    /Could not delete the notes in your account/,
    "the page claims the notes are gone",
  );
});

test("Delete all notes while signed out only touches this device", async () => {
  const { api, storage, messages, getElementById } = createSettingsHarness({
    ytd_notes: [{ id: "note-1" }],
  });

  await api.clearNotes();

  assert.equal(
    messages.filter((message) => message.action === "deleteAllNotes").length,
    0,
    "the page asked an account it is not signed in to",
  );
  assert.equal(storage.ytd_notes, undefined);
  assert.equal(
    getElementById("dataStatus").textContent,
    "Deleted 1 note on this device.",
  );
});

// ============================================================
// The settings page must not throw away what the user typed
// ============================================================

test("the settings page saves what does not need an AI key", async () => {
  // The Supadata key is a fallback and the provider is a choice: neither
  // of them needs an AI key. Refusing the whole save threw away the key
  // the user had just pasted, and with it the language they had chosen.
  const { api, storage, getElementById } = createSettingsHarness({});
  getElementById("supadataApiKey").value = "supadata-key";
  getElementById("aiApiKey").value = "";

  await api.saveSettings({ preventDefault() {} });

  assert.ok(storage.ytd_settings, "nothing was saved at all");
  assert.equal(
    storage.ytd_settings.supadataApiKey,
    "supadata-key",
    "the Supadata key was thrown away",
  );
  assert.equal(storage.ytd_settings.provider, "deepseek");
  assert.match(
    getElementById("saveStatus").textContent,
    /Add the API key of your chosen AI provider/,
    `the page does not say what is still missing: ${getElementById("saveStatus").textContent}`,
  );
});

test("the settings page says that everything was saved when the AI key is there", async () => {
  const { api, storage, getElementById } = createSettingsHarness({});
  getElementById("aiApiKey").value = "ai-key";

  await api.saveSettings({ preventDefault() {} });

  assert.equal(storage.ytd_settings.aiApiKey, "ai-key");
  assert.equal(
    getElementById("saveStatus").textContent,
    "Saved. Reopen YouTube Digest to use these settings.",
  );
});

test("the next steps are shown even when nothing was saved", async () => {
  // The guide is what tells the user that pressing "n" on a video saves a
  // note, and that shortcut works without any key at all.
  const { api, getElementById } = createSettingsHarness({});

  await api.loadOptions();

  assert.equal(
    getElementById("setupGuide").hidden,
    false,
    "the next steps only appear after a successful save",
  );
});

test("the page says when the storage could not be locked away from the page", async () => {
  // The user did not cause it, so the page says it in one calm sentence
  // and keeps it on screen.
  const { api, getElementById } = createSettingsHarness(
    {},
    {
      sendMessageImpl: async (message) => {
        if (message.action === "getStorageIsolation") {
          return { success: true, restricted: false };
        }
        return {};
      },
    },
  );

  await api.loadOptions();

  assert.match(
    getElementById("saveStatus").textContent,
    /could not lock/i,
    `the page does not say that the storage is open: ${getElementById("saveStatus").textContent}`,
  );
});

test("the page says nothing about the storage when it was locked", async () => {
  const { api, getElementById } = createSettingsHarness(
    {},
    {
      sendMessageImpl: async (message) => {
        if (message.action === "getStorageIsolation") {
          return { success: true, restricted: true };
        }
        return {};
      },
    },
  );

  await api.loadOptions();

  assert.equal(getElementById("saveStatus").textContent, "");
});

// ============================================================
// The first sign-in has to say what it moved
// ============================================================

test("the settings page says how many notes and words the sign-in moved into the account", async () => {
  const { api, storage, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_import_report: { notes: 12, words: 3, at: 1 },
    },
    {
      sendMessageImpl: async () => ({
        success: true,
        expired: false,
        session: { login: "alice", githubId: 1001 },
      }),
    },
  );

  await api.loadOptions();
  await settle();

  const status = getElementById("githubStatus").textContent;
  assert.match(status, /12 notes/, `the page does not say the notes: ${status}`);
  assert.match(status, /3 words/, `the page does not say the words: ${status}`);
  assert.equal(
    storage.ytd_import_report,
    undefined,
    "the report is shown over and over",
  );
});

test("the Chinese page says how many notes and words the sign-in moved into the account", async () => {
  const { api, getElementById } = createSettingsHarness(
    {
      ytd_options_language: "zh-CN",
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_import_report: { notes: 12, words: 3, at: 1 },
    },
    {
      sendMessageImpl: async () => ({
        success: true,
        expired: false,
        session: { login: "alice", githubId: 1001 },
      }),
    },
  );

  await api.loadOptions();
  await settle();

  const status = getElementById("githubStatus").textContent;
  assert.match(status, /12 条笔记/, `the Chinese page does not say the notes: ${status}`);
  assert.match(status, /3 个单词/, `the Chinese page does not say the words: ${status}`);
});

test("the page says nothing about an import that moved nothing", async () => {
  const { api, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_import_report: { notes: 0, words: 0, at: 1 },
    },
    {
      sendMessageImpl: async () => ({
        success: true,
        expired: false,
        session: { login: "alice", githubId: 1001 },
      }),
    },
  );

  await api.loadOptions();
  await settle();

  assert.equal(getElementById("githubStatus").textContent, "");
});

// ============================================================
// The copy has to be true
// ============================================================

test("the copy for a signed-in and a signed-out reader is different", () => {
  for (const language of ["en", "zh-CN"]) {
    const signedIn = options.translate(language, "githubSignedOutWithAccount");
    const signedOut = options.translate(language, "githubSignedOut");
    assert.notEqual(
      signedIn,
      signedOut,
      `the sign-out says the same thing in ${language} with and without an account`,
    );

    const deleted = options.translate(language, "githubDeleteAccountDeleted");
    const notSignedIn = options.translate(language, "githubDeleteAccountNotSignedIn");
    assert.notEqual(
      deleted,
      notSignedIn,
      `the account deletion says the same thing in ${language} with and without an account`,
    );

    const notesInAccount = options.translate(language, "notesDeletedSignedIn", {
      count: 3,
    });
    const notesOnDevice = options.translate(language, "notesDeletedSignedOut", {
      count: 3,
    });
    assert.notEqual(
      notesInAccount,
      notesOnDevice,
      `the note deletion says the same thing in ${language} with and without an account`,
    );
  }
});

test("the copy never promises more than the extension does", () => {
  for (const language of ["en", "zh-CN"]) {
    const signedOut = options.translate(language, "githubSignedOut");
    assert.doesNotMatch(
      signedOut,
      /stays on this device|仍保留在这台设备上/,
      "the sign-out still says the data stays on the device",
    );
    const failed = options.translate(language, "notesDeleteFailed", {
      message: "The database is unreachable.",
    });
    assert.doesNotMatch(
      failed,
      /Deleted|已删除/,
      "a failed deletion still claims that the notes are gone",
    );
  }
});

// ============================================================
// The last copy of a note is not deleted without a word
// ============================================================

test("Sign out asks before it deletes a note the account has never received", async () => {
  // A note with no cloud id exists only on this device. The account has
  // never seen it, so signing out deletes its last copy. On a shared
  // browser that is the right thing to do, but it cannot be undone, so
  // the user is asked first.
  const { api, storage, asked, messages, getElementById } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_notes_1001: [
        { id: "note-synced", cloudId: "uuid-1" },
        { id: "note-unsynced", cloudId: "" },
      ],
      ytd_vocabulary_1001: [{ id: "word-unsynced", cloudId: "" }],
    },
    { confirm: () => false },
  );

  await api.logoutGithub();

  assert.equal(asked.length, 1, "the last copy of a note was deleted without asking");
  assert.match(asked[0], /1 note and 1 word/, asked[0]);
  assert.match(asked[0], /never received/, asked[0]);
  // The user said no: nothing was signed out and nothing was removed.
  assert.ok(storage.ytd_github_session, "the session was removed after a cancel");
  assert.equal(storage.ytd_notes_1001.length, 2, "the notes were removed after a cancel");
  assert.equal(
    messages.filter((message) => message.action === "logoutGithub").length,
    0,
    "the background was asked to sign out after a cancel",
  );
  assert.doesNotMatch(
    getElementById("githubStatus").textContent,
    /Signed out/,
    "the page says the reader signed out after a cancel",
  );
});

test("Sign out deletes the last copy of a note when the user confirms", async () => {
  const { api, storage, asked } = createSettingsHarness(
    {
      ytd_github_session: {
        token: "token-alice",
        login: "alice",
        githubId: 1001,
      },
      ytd_notes_1001: [{ id: "note-unsynced", cloudId: "" }],
    },
    { confirm: () => true },
  );

  await api.logoutGithub();

  assert.equal(asked.length, 1);
  assert.equal(storage.ytd_github_session, undefined, "the sign-out did not happen");
  assert.equal(storage.ytd_notes_1001, undefined, "the note stayed on the device");
});

test("Sign out does not ask when everything reached the account", async () => {
  // The account still has every item, so signing out loses nothing and
  // the reader is not interrupted.
  const { api, storage, asked } = createSettingsHarness({
    ytd_github_session: {
      token: "token-alice",
      login: "alice",
      githubId: 1001,
    },
    ytd_notes_1001: [{ id: "note-1", cloudId: "uuid-1" }],
    ytd_vocabulary_1001: [{ id: "word-1", cloudId: "uuid-2" }],
  });

  await api.logoutGithub();

  assert.equal(asked.length, 0, "the reader was interrupted for nothing");
  assert.equal(storage.ytd_github_session, undefined, "the sign-out did not happen");
});

test("the warning names the items in the language the page is showing", () => {
  const english = options.translate("en", "logoutUnsyncedConfirm", {
    notes: 2,
    words: 1,
  });
  const chinese = options.translate("zh-CN", "logoutUnsyncedConfirm", {
    notes: 2,
    words: 1,
  });

  assert.match(english, /2 notes and 1 word/);
  assert.match(english, /never received/);
  assert.match(chinese, /2 条笔记和1 个单词/);
  assert.notEqual(english, chinese);
  assert.doesNotMatch(english, /—/);
  assert.doesNotMatch(chinese, /—/);
});
