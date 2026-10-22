const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const { loadBackgroundHelpers } = require("./helpers/background-harness.js");

/**
 * True for a host that lives on the user's own machine.
 *
 * A published extension that can reach a loopback port is a liability: any
 * process listening there could be handed the user's saved notes and their
 * GitHub session token. Local development does not need it in the shipped
 * manifest, so the release gate keeps it out.
 */
function isLoopbackHost(host) {
  const name = String(host || "").toLowerCase();
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "0.0.0.0" ||
    name === "::1" ||
    name === "[::1]" ||
    /^127\./.test(name)
  );
}

/** The host a match pattern points at, or "" when it has none. */
function hostOf(pattern) {
  const match = /^(?:\*|https?|file|ftp):\/\/([^/]+)/i.exec(String(pattern));
  if (!match) return "";
  const authority = match[1];
  if (authority.startsWith("[")) {
    // An IPv6 literal such as [::1] or [::1]:8787.
    const end = authority.indexOf("]");
    return end === -1 ? authority : authority.slice(0, end + 1);
  }
  return authority.split(":")[0];
}

test("the released manifest never asks for a host on the user's own machine", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const patterns = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
  ];

  for (const pattern of patterns) {
    assert.equal(
      isLoopbackHost(hostOf(pattern)),
      false,
      `a published extension must not be allowed to reach ${pattern}`,
    );
  }
});

test("manifest uses minimized install-time permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.options_ui.page, "options.html");
  assert.ok(!manifest.permissions.includes("activeTab"));
  assert.ok(manifest.host_permissions.includes("https://api.deepseek.com/*"));
  assert.ok(manifest.host_permissions.includes("https://api.minimaxi.com/*"));
  assert.ok(manifest.host_permissions.includes("https://opencode.ai/zen/go/*"));
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
  assert.equal(manifest.version, "1.7.3");
});

test("release copy documents current scope without em dashes", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.doesNotMatch(readme, /—/);
  assert.doesNotMatch(chineseReadme, /—/);
  assert.doesNotMatch(manifest.description, /—/);
  assert.doesNotMatch(packageJson.description, /—/);

  assert.equal(manifest.name, "YouTube Digest");
  assert.equal(packageJson.name, "youtube-digest");
  assert.match(read("scripts/package-extension.sh"), /youtube-digest-v\$version\.zip/);
  assert.doesNotMatch(
    [readme, chineseReadme, read("PRIVACY.md"), read("SECURITY.md")].join("\n"),
    /\bYT Digest\b/,
  );
  assert.match(readme, /^# YouTube Digest$/m);
  assert.match(
    readme,
    /Turn every YouTube video into a resource for deep learning\./,
  );
  assert.doesNotMatch(readme, /before deciding how much of it to watch/i);
  assert.match(readme, /^## Install with your coding agent$/m);
  assert.match(
    readme,
    /permanent folder I choose[\s\S]*tell me its exact full path[\s\S]*If I need a suggestion during this first installation[\s\S]*`~\/Documents\/youtube-digest`[\s\S]*`%USERPROFILE%\\Documents\\youtube-digest`[\s\S]*do not assume either path/,
  );
  assert.match(
    readme,
    /Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location\./,
  );
  assert.match(
    readme,
    /selecting the exact project folder you chose in Chrome with \*\*Load unpacked\*\*/,
  );
  assert.match(
    readme,
    /Select the exact project folder you chose, which must contain `manifest\.json`/,
  );
  assert.match(readme, /upstream issues and pull requests are not accepted/i);
  assert.doesNotMatch(readme, /^## Contributing$/m);
  assert.match(chineseReadme, /^# YouTube Digest$/m);
  assert.match(chineseReadme, /把每个 YouTube 视频变成一份可以深入学习的资料/);
  assert.match(chineseReadme, /^## 让你的编程 Agent 帮你安装$/m);
  assert.match(
    chineseReadme,
    /我选择的长期保留文件夹[\s\S]*告诉我准确的完整路径[\s\S]*第一次安装时需要位置建议[\s\S]*`~\/Documents\/youtube-digest`[\s\S]*`%USERPROFILE%\\Documents\\youtube-digest`[\s\S]*不要假设我一定使用这些路径/,
  );
  assert.match(
    chineseReadme,
    /如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。/,
  );
  assert.match(
    chineseReadme,
    /“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹/,
  );
  assert.match(
    chineseReadme,
    /选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest\.json`/,
  );
  assert.match(chineseReadme, /不接受上游 Issue 或 Pull Request/);
  assert.match(chineseReadme, /增加更多翻译语言/);

  assert.match(readme, /100 credits per month/i);
  assert.match(readme, /native transcript request uses \*\*1 credit\*\*/i);
  assert.match(readme, /generated transcript costs \*\*2 credits per video minute\*\*/i);
  assert.match(readme, /HTTP `206` still uses \*\*1 credit\*\*/i);
  assert.match(readme, /forces `mode=native`/i);
  assert.match(readme, /roughly 100 fallback lookups per month/i);
  // The transcript is read out of the page first, so the common case costs
  // nothing. The README has to say so, or the credit paragraph reads as if
  // every video costs a credit.
  assert.match(readme, /no transcript credit is spent/i);
  assert.match(readme, /Most videos cost nothing/i);
  assert.match(readme, /supadata\.ai\/pricing/i);
  assert.match(readme, /docs\.supadata\.ai\/get-transcript/i);
  assert.match(readme, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(readme, /platform\.deepseek\.com\/api_keys/i);
  assert.match(readme, /api-docs\.deepseek\.com/i);
  assert.match(readme, /api-docs\.deepseek\.com\/quick_start\/pricing/i);
  assert.match(readme, /\$0\.003[\s\S]*\$0\.006/);
  assert.match(readme, /\$0\.15[\s\S]*\$0\.30/);
  assert.match(readme, /\$0\.60[\s\S]*\$1\.20/);
  assert.match(readme, /01:00–04:00[\s\S]*06:00–10:00 UTC/);
  assert.match(readme, /20-minute English talk/i);
  assert.match(readme, /32,600 input tokens/i);
  assert.match(readme, /\$0\.002[^\n]*\$0\.008 USD/i);
  assert.match(readme, /\$0\.004[^\n]*\$0\.015 USD/i);
  assert.match(chineseReadme, /api-docs\.deepseek\.com\/quick_start\/pricing/i);
  assert.match(chineseReadme, /\$0\.003[\s\S]*\$0\.006/);
  assert.match(chineseReadme, /\$0\.15[\s\S]*\$0\.30/);
  assert.match(chineseReadme, /\$0\.60[\s\S]*\$1\.20/);
  assert.match(chineseReadme, /UTC 01:00–04:00[\s\S]*06:00–10:00/);
  assert.match(chineseReadme, /20 \u5206\u949f\u82f1\u6587\u89c6\u9891/);
  assert.match(chineseReadme, /32,600 \u4e2a\u8f93\u5165 token/);
  assert.match(chineseReadme, /\$0\.002[^\n]*\$0\.008 USD/);
  assert.match(chineseReadme, /\$0\.004[^\n]*\$0\.015 USD/);
  assert.match(chineseReadme, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(chineseReadme, /platform\.deepseek\.com\/api_keys/i);
  assert.match(readme, /^### The Digest button is missing on a YouTube video$/m);
  assert.match(
    chineseReadme,
    /^### YouTube 视频页面没有显示 Digest 按钮$/m,
  );

  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const optionsScript = read("options.js");
  assert.match(optionsPage, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(optionsPage, /platform\.deepseek\.com\/api_keys/i);
  assert.doesNotMatch(optionsPage, /<select\b/i);
  assert.doesNotMatch(optionsPage, /id="(?:provider|aiBaseUrl|aiModel)"/);
  const detailsTag = optionsPage.match(
    /<details\b[^>]*class="card customization-card"[^>]*>/,
  );
  assert.ok(detailsTag, "Expected a native Local remix details disclosure");
  assert.doesNotMatch(detailsTag[0], /\sopen(?:\s|=|>)/i);
  assert.match(
    optionsPage,
    /<summary class="customization-summary">[\s\S]*Want to use another AI model\?[\s\S]*Edit and copy a safe prompt for your coding agent[\s\S]*<\/summary>/,
  );
  assert.match(
    optionsPage,
    /class="customization-steps"[\s\S]*Open the extracted YouTube Digest project folder in your coding[\s\S]*Replace \[PROVIDER\] and \[MODEL\][\s\S]*Never include API keys[\s\S]*<\/ol>/,
  );
  assert.match(
    optionsPage,
    /class="prompt-reminder"[\s\S]*Before copying, replace \[PROVIDER\] and \[MODEL\]/,
  );
  assert.doesNotMatch(optionsPage, /~\/Documents\/youtube-digest/);
  assert.doesNotMatch(optionsPage, /%USERPROFILE%\\Documents\\youtube-digest/);
  assert.match(optionsPage, /id="copyCustomizationPromptBtn"/);
  assert.match(optionsStyles, /\.customization-summary:hover\s*\{/);
  assert.match(optionsStyles, /\.customization-summary:focus-visible\s*\{/);
  assert.match(optionsStyles, /\.data-card\s*\{[^}]*margin-top:\s*36px;/);
  assert.match(optionsScript, /clipboard\.writeText/);
  assert.match(optionsScript, /Edited prompt copied\./);
  assert.match(optionsScript, /migration\.migrated[\s\S]*storage\.set/);

  const customizationPrompt = `Customize this local YouTube Digest workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is YouTube Digest. If verification fails, stop and ask me to open the extracted YouTube Digest project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real YouTube video.`;
  assert.ok(optionsPage.includes(`>${customizationPrompt}</textarea>`));
  assert.doesNotMatch(customizationPrompt, /Documents|USERPROFILE/);

  assert.match(readme, /^## Remix it with your coding agent$/m);
  assert.match(readme, /more translation languages/i);
  assert.match(readme, /customized summary templates/i);
  assert.match(readme, /vocabulary notebook/i);
  assert.match(
    readme,
    /first open the exact YouTube Digest project folder that Chrome loaded through \*\*Load unpacked\*\* in your coding agent/,
  );
  assert.match(
    chineseReadme,
    /先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 YouTube Digest 项目文件夹/,
  );

  const publishedDocs = [
    readme,
    chineseReadme,
    read("PRIVACY.md"),
    read("SECURITY.md"),
  ].join("\n");
  assert.doesNotMatch(publishedDocs, /custom OpenAI-compatible/i);
  assert.doesNotMatch(publishedDocs, /optional custom-origin/i);
  assert.doesNotMatch(publishedDocs, /configure a different OpenAI-compatible/i);
  assert.doesNotMatch(publishedDocs, /only AI provider/i);
  assert.doesNotMatch(publishedDocs, /只支持 DeepSeek V4 Flash/);
  assert.match(readme, /published version supports three AI providers/i);
  assert.match(
    readme,
    /DeepSeek:\s+Base URL https:\/\/api\.deepseek\.com\s+Model deepseek-v4-flash/i,
  );
  assert.match(
    readme,
    /MiniMax:\s+Base URL https:\/\/api\.minimaxi\.com\/v1\s+Model MiniMax-M3/i,
  );
  assert.match(
    readme,
    /OpenCode Go:\s+Base URL https:\/\/opencode\.ai\/zen\/go\/v1\s+Model deepseek-v4-flash/i,
  );
  assert.match(chineseReadme, /发布版本支持三个 AI 服务/);
  assert.match(
    chineseReadme,
    /MiniMax:\s+Base URL https:\/\/api\.minimaxi\.com\/v1\s+Model MiniMax-M3/,
  );
  assert.match(
    chineseReadme,
    /OpenCode Go:\s+Base URL https:\/\/opencode\.ai\/zen\/go\/v1\s+Model deepseek-v4-flash/,
  );
  assert.match(optionsPage, /platform\.minimaxi\.com/);
  assert.match(optionsPage, /opencode\.ai\/auth/);
  assert.match(optionsPage, /name="aiProviderChoice"/);
});

test("product UI contains no emoji or emoji-like pictographs", () => {
  const productUi = [
    read("sidepanel.html"),
    read("sidepanel.js"),
    read("content.js"),
    read("options.html"),
    read("options.js"),
  ].join("\n");

  assert.doesNotMatch(
    productUi,
    /\p{Extended_Pictographic}|[✓✕⧉▶]/u,
  );
  assert.doesNotMatch(productUi, /&#(?:9655|9888);/);
});

test("selection actions use equal edge-to-edge hover areas", () => {
  const css = read("sidepanel.css");

  assert.match(
    css,
    /\.explain-tooltip\s*\{[^}]*padding:\s*0;[^}]*overflow:\s*hidden;/,
  );
  // Three actions share the bar evenly: Explain, Note and Word. The third
  // button is the one that adds a paid action, so it has to sit next to the
  // other two in the same bar, not in a row of its own.
  assert.match(
    css,
    /\.explain-btn,\s*\.selection-note-btn,\s*\.selection-word-btn\s*\{[^}]*flex:\s*1 1 33%;[^}]*border-radius:\s*0;/,
  );
  assert.match(
    css,
    /\.explain-tooltip\s*\{[^}]*animation:\s*selectionToolbarIn/,
  );
  assert.match(
    css,
    /@keyframes selectionToolbarIn\s*\{[\s\S]*transform:\s*translate\(-50%, 4px\);[\s\S]*transform:\s*translate\(-50%, 0\);/,
  );
});

test("the five tab names still fit in a panel dragged all the way in", () => {
  const css = read("sidepanel.css");

  // The English labels need 248px of text. A 320px panel leaves 264px for
  // the whole strip, so without a narrow-panel rule every name loses a few
  // pixels and the ellipsis takes over: "Transcr...", "Summ...", "Not...".
  // The strip has to give up gap and padding instead.
  const narrow = css.match(
    /@media\s*\(max-width:\s*359px\)\s*\{[\s\S]*?\n\}/,
  );
  assert.ok(
    narrow,
    "the tab strip has no narrow-panel rule, so a 320px panel truncates every tab name",
  );
  assert.match(narrow[0], /\.tabs\s*\{[^}]*gap:\s*2px;/);
  assert.match(narrow[0], /\.tab\s*\{[^}]*padding-right:\s*1px;[^}]*padding-left:\s*1px;/);
  // The rule must not change the panel at its normal width.
  const normal = css.match(/\.tabs\s*\{[^}]*gap:\s*var\(--sp-1\);/);
  assert.ok(normal, "the tab strip no longer uses the shared spacing token");
});

test("note delete is an accessible SVG action at the end of the action row", () => {
  const js = read("sidepanel.js");
  const css = read("sidepanel.css");

  assert.match(
    js,
    /<div class="note-actions">[\s\S]*class="[^"]*note-play[^"]*"[\s\S]*class="note-delete"[\s\S]*aria-label="\$\{escapeHtml\(panelCopy\("deleteNote"\)\)\}"[\s\S]*<svg viewBox="0 0 24 24" aria-hidden="true">/,
  );
  assert.doesNotMatch(js, /class="note-delete"[^>]*>Delete<\/button>/);
  assert.match(
    css,
    /\.note-delete\s*\{[^}]*place-items:\s*center;[^}]*margin-left:\s*auto;/,
  );
  assert.match(css, /\.note-delete:focus-visible\s*\{[^}]*outline:/);
});

test("notes filters preserve selected contrast and expose pressed state", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /id="notesFilterThis"[\s\S]*?aria-pressed="true"[\s\S]*?>[\s\S]*?This Video/,
  );
  assert.match(
    html,
    /id="notesFilterAll"[\s\S]*?aria-pressed="false"[\s\S]*?>[\s\S]*?All Notes/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn\.active:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-hover\);[^}]*color:\s*white;/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn:hover:not\(:disabled\)\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-secondary\);/,
  );
  assert.match(css, /\.notes-filter \.enhance-btn:focus-visible\s*\{[^}]*outline:/);
  assert.match(js, /setNotesFilter\(false\)/);
  assert.match(js, /setNotesFilter\(true\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(!showAll\)\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(showAll\)\)/);
});

test("runtime has no source-file credential dependency or retired model", () => {
  const runtime = [
    "background.js",
    "content.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(runtime, /\bCONFIG\./);
  assert.doesNotMatch(runtime, /importScripts\(["']config\.js/);
  assert.doesNotMatch(runtime, /\bdeepseek-chat\b/);
  assert.match(runtime, /deepseek-v4-flash/);
});

/**
 * The side panel follows the tab the user is on.
 *
 * The worker listens for tab updates and decides, from the update itself,
 * whether the panel has to move. A title or a favicon says nothing about
 * where the user is, so it must not move anything: a panel that opens and
 * closes while the user reads is a panel the user cannot look at.
 *
 * The worker is run here, not read: a test that matches the source proves
 * that the words are still there, not that the panel behaves.
 */
function recordPanelCalls(rejectTabClose = false) {
  const calls = [];
  return {
    calls,
    sidePanel: {
      setPanelBehavior() {},
      close: async (options) => {
        calls.push(["close", options]);
        if (rejectTabClose && options.tabId) {
          throw new Error("Global panel");
        }
      },
      setOptions: async (options) => calls.push(["setOptions", options]),
    },
  };
}

/** Lets the worker's own promises settle. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Fires every tab listener the worker registered, the way Chrome does. */
function fireTabUpdate(background, tabId, changeInfo, tab) {
  for (const listener of background.tabUpdatedListeners) {
    listener(tabId, changeInfo, tab);
  }
}

test("a title change on its own does not move the side panel", async () => {
  const { calls, sidePanel } = recordPanelCalls();
  const background = loadBackgroundHelpers({ sidePanel });

  fireTabUpdate(
    background,
    17,
    { title: "A video with a new name" },
    {
      id: 17,
      url: "https://www.youtube.com/watch?v=abc123",
      windowId: 4,
    },
  );
  await settle();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [],
    "a title says nothing about where the user is, so the panel must stay",
  );
});

test("a navigation away from YouTube closes the panel and disables it", async () => {
  const { calls, sidePanel } = recordPanelCalls();
  const background = loadBackgroundHelpers({ sidePanel });

  fireTabUpdate(
    background,
    17,
    { url: "https://example.com/somewhere-else", status: "loading" },
    { id: 17, url: "https://example.com/somewhere-else", windowId: 4 },
  );
  await settle();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [
      ["close", { tabId: 17 }],
      ["setOptions", { tabId: 17, enabled: false }],
    ],
    "the panel has to be closed before it is disabled, or Chrome opens it again",
  );
});

test("a global panel is closed by window when the tab close is rejected", async () => {
  const { calls, sidePanel } = recordPanelCalls(true);
  const background = loadBackgroundHelpers({ sidePanel });

  fireTabUpdate(
    background,
    17,
    { url: "https://example.com/somewhere-else", status: "loading" },
    { id: 17, url: "https://example.com/somewhere-else", windowId: 4 },
  );
  await settle();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [
      ["close", { tabId: 17 }],
      ["close", { windowId: 4 }],
      ["setOptions", { tabId: 17, enabled: false }],
    ],
    "Chrome 145 and later reject a tab id for a global panel",
  );
});

test("a navigation to YouTube opens the panel for that tab", async () => {
  const { calls, sidePanel } = recordPanelCalls();
  const background = loadBackgroundHelpers({ sidePanel });

  fireTabUpdate(
    background,
    17,
    { url: "https://www.youtube.com/watch?v=abc123", status: "loading" },
    { id: 17, url: "https://www.youtube.com/watch?v=abc123", windowId: 4 },
  );
  await settle();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [["setOptions", { tabId: 17, path: "sidepanel.html", enabled: true }]],
    "the panel has to be enabled for the tab the user is on",
  );
});

test("the panel follows the tab the user switched to", async () => {
  const { calls, sidePanel } = recordPanelCalls();
  const background = loadBackgroundHelpers({
    sidePanel,
    tabs: {
      get: async () => ({
        id: 23,
        url: "https://www.youtube.com/watch?v=def456",
        windowId: 4,
      }),
    },
  });

  for (const listener of background.tabActivatedListeners) {
    listener({ tabId: 23, windowId: 4 });
  }
  await settle();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [["setOptions", { tabId: 23, path: "sidepanel.html", enabled: true }]],
    "the tab the user switched to is the tab the panel belongs to",
  );
});

test("retired Remix and reader files are absent", () => {
  for (const file of [
    "reader.html",
    "reader.js",
    "remix-prompts.js",
    "config.example.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test("published prompt files contain runtime sections", () => {
  const expectedSections = {
    "prompts/analysis.md": ["System prompt", "User prompt"],
    "prompts/explain.md": ["System prompt", "User prompt"],
    "prompts/note-cleanup.md": ["System prompt", "User prompt"],
    "prompts/translation.md": [
      "Shared base rules",
      "Chinese rules",
      "Transcript batch translation",
    ],
  };

  for (const [file, sections] of Object.entries(expectedSections)) {
    const markdown = read(file);
    for (const section of sections) {
      assert.match(markdown, new RegExp(`^## ${section}$`, "m"));
    }
  }
});

/**
 * The store's own rules, checked here.
 *
 * The Chrome Web Store rejects an upload for reasons that have nothing to
 * do with whether the product works: a description over 132 characters, an
 * icon with an alpha channel, a screenshot that is not 1280x800. Every one
 * of those was correct by hand and by luck, and the repository's doctrine
 * is that a rule nobody checks is a rule that will be broken by the next
 * edit. So the rules the store enforces are enforced here too.
 */

/** The width and height a PNG declares, or null when it is not a PNG. */
function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** The PNG colour type at byte 25: 2 is RGB, 6 is RGBA (has alpha). */
function pngColorType(buffer) {
  if (buffer.length < 26) return null;
  return buffer.readUInt8(25);
}

test("the store description fits in the 132 characters the listing allows", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const length = [...manifest.description].length;
  assert.ok(
    length <= 132,
    `the manifest description the store shows is ${length} characters; the limit is 132`,
  );
});

test("the store icon is opaque, because the store rejects one with alpha", () => {
  const icon = fs.readFileSync(path.join(root, "store/icon128.png"));
  const size = pngSize(icon);
  assert.ok(size, "store/icon128.png is not a PNG");
  assert.equal(size.width, 128, "the store icon is not 128 pixels wide");
  assert.equal(size.height, 128, "the store icon is not 128 pixels tall");
  assert.equal(
    pngColorType(icon),
    2,
    "the store icon has an alpha channel; the store rejects that",
  );
});

test("the store screenshots are the size the store accepts", () => {
  const storeDir = path.join(root, "store");
  const shots = fs
    .readdirSync(storeDir)
    .filter((name) => /^\d\d-.*\.png$/.test(name));
  assert.ok(shots.length > 0, "store/ has no numbered screenshots");
  assert.ok(
    shots.length <= 5,
    `store/ has ${shots.length} screenshots; the store shows at most 5`,
  );
  for (const name of shots) {
    const size = pngSize(fs.readFileSync(path.join(storeDir, name)));
    assert.ok(size, `store/${name} is not a PNG`);
    assert.equal(size.width, 1280, `store/${name} is not 1280 pixels wide`);
    assert.equal(size.height, 800, `store/${name} is not 800 pixels tall`);
  }
});

test("every link the product shows a reader points at something that exists", () => {
  // An extension page cannot open a path inside its own package: Chrome
  // serves the page, not the folder, and a link to PRIVACY.md in the
  // package is a dead end for the reader who taps it. The privacy link is
  // the one a store reviewer follows, so it has to be a web address.
  for (const file of ["options.html", "sidepanel.html"]) {
    const source = read(file);
    for (const match of source.matchAll(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
    )) {
      const href = match[1];
      if (href.startsWith("#")) continue;
      if (/^https?:/i.test(href)) continue;
      assert.fail(
        `${file} links to ${href}, which an extension page cannot open; ` +
          `point at a web address or at a resource declared in the manifest`,
      );
    }
  }
});

test("the settings page paints the links the copy holds, not the markup's", () => {
  // The settings page localizes itself at start-up: every element with
  // data-i18n-html is overwritten with the sentence from COPY. A fix
  // applied to options.html alone is undone the moment the page loads,
  // which is exactly what happened to the privacy link: the markup was
  // changed, the copy still said PRIVACY.md, and the reader got the dead
  // link back. This gate reads the sentences that are actually painted.
  const { COPY } = require("../options.js");
  const dead = [];
  for (const [language, copy] of Object.entries(COPY)) {
    for (const [key, value] of Object.entries(copy)) {
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(
        /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
      )) {
        const href = match[1];
        if (href.startsWith("#") || /^https?:/i.test(href)) continue;
        dead.push(`${language}.${key} links to ${href}`);
      }
    }
  }
  assert.deepEqual(
    dead,
    [],
    `these sentences send the reader to a file the extension page cannot open: ${dead.join("; ")}`,
  );
});

