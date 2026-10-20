/**
 * Opens the real side panel in a real browser and walks through the tabs.
 *
 * The panel is the product, so a review has to look at the product, not at
 * the source. This boots sidepanel.html with a stubbed chrome API, walks
 * the five tabs, and writes a screenshot of each one.
 *
 * Usage: node scripts/panel-review.js [outputDir]
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.resolve(process.argv[2] || path.join(root, ".review"));

const NOW = Date.parse("2026-01-15T10:30:00Z");

/** A word that is already in the notebook. */
const WORDS = [
  {
    id: "vocab_1",
    term: "ephemeral",
    translation: "短暂的",
    explanation: "lasting a very short time",
    sentence: "the trend proved ephemeral",
    videoId: "abc123xyz",
    videoTitle: "How Memory Works",
    timestampSeconds: 92,
    status: "learning",
    createdAt: NOW - 86400000,
    updatedAt: NOW - 86400000,
  },
  {
    id: "vocab_2",
    term: "serendipity",
    translation: "意外发现美好事物的能力",
    explanation: "a happy accident that leads to something good",
    sentence: "the serendipity of finding the right book",
    videoId: "abc123xyz",
    videoTitle: "How Memory Works",
    timestampSeconds: 240,
    status: "reviewing",
    createdAt: NOW - 172800000,
    updatedAt: NOW - 172800000,
  },
  {
    id: "vocab_3",
    term: "resilient",
    translation: "有韧性的",
    explanation: "able to recover quickly from difficulties",
    sentence: "a resilient team",
    videoId: "def456uvw",
    videoTitle: "Building Teams",
    timestampSeconds: 61,
    status: "mastered",
    createdAt: NOW - 259200000,
    updatedAt: NOW - 259200000,
  },
];

const NOTES = [
  {
    id: "note_1",
    clientId: "note_1",
    videoId: "abc123xyz",
    videoTitle: "How Memory Works",
    channelName: "Some Channel",
    timestampSeconds: 92,
    quote: "memory is not a recording but a reconstruction",
    note: "This is the key idea: every time you remember, you rewrite it.",
    starred: true,
    createdAt: NOW - 3600000,
    updatedAt: NOW - 3600000,
  },
  {
    id: "note_2",
    clientId: "note_2",
    videoId: "abc123xyz",
    videoTitle: "How Memory Works",
    channelName: "Some Channel",
    timestampSeconds: 240,
    quote: "sleep is when the brain files things away",
    note: "Sleep is not downtime, it is the filing cabinet.",
    starred: false,
    createdAt: NOW - 7200000,
    updatedAt: NOW - 7200000,
  },
];

const LIBRARY = [
  {
    id: "abc123xyz",
    videoId: "abc123xyz",
    title: "How Memory Works",
    channelName: "Some Channel",
    createdAt: NOW - 86400000,
    expiresAt: NOW + 20 * 86400000,
    noteCount: 2,
  },
  {
    id: "def456uvw",
    videoId: "def456uvw",
    title: "Building Teams That Last",
    channelName: "Another Channel",
    createdAt: NOW - 3 * 86400000,
    expiresAt: NOW + 17 * 86400000,
    noteCount: 0,
  },
];

const TRANSCRIPT = [
  {
    id: "s1",
    start: 0,
    end: 6,
    text: "Every time you remember something, you are not playing it back.",
    translation: "每当你想起一件事，你都不是在回放它。",
  },
  {
    id: "s2",
    start: 6,
    end: 13,
    text: "You are rebuilding it from whatever is left of it.",
    translation: "你是在用剩下的部分重新构建它。",
  },
  {
    id: "s3",
    start: 13,
    end: 19,
    text: "That is why the memory of a thing changes every time you recall it.",
    translation: "这就是为什么一件事的记忆每次被回想时都会改变。",
  },
];

const ANALYSIS = {
  title: "How Memory Works",
  channelName: "Some Channel",
  summary:
    "The video argues that memory is a reconstruction rather than a recording. Every recall rewrites the trace, which means memories change shape as we keep using them. The talk closes on the practical implication: what you rehearse is what you keep.",
  chapters: [
    { title: "Memory is not a recording", timestamp: "0:00", timestampSeconds: 0 },
    { title: "Why memories drift", timestamp: "6:12", timestampSeconds: 372 },
    { title: "What you rehearse is what you keep", timestamp: "14:30", timestampSeconds: 870 },
  ],
  keyPoints: [
    "Every recall is a rewrite, not a replay.",
    "Rehearsal decides which traces survive.",
    "The brain optimizes for what it uses.",
  ],
};

const SAMPLE_REVIEW = {
  term: "ephemeral",
  sentence: "the trend proved ephemeral",
  translation: "短暂的",
  explanation: "lasting a very short time",
  due: true,
};

function storageArea(initial) {
  const values = { ...initial };
  return {
    values,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...values };
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of wanted) {
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

/** The stub the panel talks to. It answers the messages the panel sends. */
function makeChrome() {
  const local = storageArea({
    ytd_options_language: "en",
    ytd_notes: NOTES,
    ytd_vocabulary: WORDS,
    ytd_vocabulary_dropped: { total: 3, lastCount: 2, lastAt: NOW },
    ytd_library: LIBRARY,
    ytd_github_session: { token: "t", login: "jasper", githubId: 1001, savedAt: NOW },
  });
  const session = storageArea({});
  return {
    local,
    session,
    async sendMessage(message) {
      switch (message?.action) {
        case "getVocabulary":
          return { success: true, items: WORDS };
        case "getNotes":
          return { success: true, items: NOTES };
        case "getDueReviews":
          return { success: true, item: SAMPLE_REVIEW, count: 4 };
        case "getLibrary":
          return { success: true, items: LIBRARY };
        case "getTranscript":
          return { success: true, segments: TRANSCRIPT };
        case "getAnalysis":
          return { success: true, analysis: ANALYSIS };
        case "getSettings":
          return { success: true, settings: {} };
        case "getGithubSession":
          return {
            success: true,
            session: { login: "jasper", githubId: 1001, savedAt: NOW },
            expired: false,
          };
        case "getPanelLanguage":
          return { success: true, language: "en" };
        default:
          return { success: true };
      }
    },
  };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 420, height: 900 },
    deviceScaleFactor: 2,
  });

  const chrome = makeChrome();
  await context.addInitScript((payload) => {
    const area = (initial) => {
      const values = { ...initial };
      return {
        values,
        async get(keys) {
          if (keys === null || keys === undefined) return { ...values };
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) {
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
    };
    const local = area(payload.local);
    const session = area({});
    window.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => {
          switch (message?.action) {
            case "getVocabulary":
              return { success: true, items: payload.words };
            case "getNotes":
              return { success: true, items: payload.notes };
            case "getDueReviews":
              return { success: true, item: payload.review, count: 4 };
            case "getLibrary":
              return { success: true, items: payload.library };
            case "getTranscript":
              return { success: true, segments: payload.transcript };
            case "getAnalysis":
              return { success: true, analysis: payload.analysis };
            case "getSettings":
              return { success: true, settings: {} };
            case "getGithubSession":
              return {
                success: true,
                session: { login: "jasper", githubId: 1001, savedAt: payload.now },
                expired: false,
              };
            default:
              return { success: true };
          }
        },
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        getManifest: () => ({ version: "1.6.0" }),
      },
      storage: { local, session, onChanged: { addListener() {} } },
      tabs: {
        query: async () => [{ id: 1, url: "https://www.youtube.com/watch?v=abc123xyz" }],
        sendMessage: async () => ({}),
        onUpdated: { addListener() {} },
        create: async () => ({ id: 1 }),
        remove: async () => {},
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      i18n: { getMessage: (key) => key },
      action: { setBadgeText: async () => {} },
    };
  }, {
    local: chrome.local.values,
    words: WORDS,
    notes: NOTES,
    review: SAMPLE_REVIEW,
    library: LIBRARY,
    transcript: TRANSCRIPT,
    analysis: ANALYSIS,
    now: NOW,
  });

  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`file://${path.join(root, "sidepanel.html")}`);
  await page.waitForTimeout(700);

  const tabs = ["transcript", "summary", "notes", "words", "library"];
  for (const tab of tabs) {
    await page.evaluate((name) => {
      const button = document.querySelector(`[data-tab="${name}"]`);
      if (button) button.click();
    }, tab);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, `${tab}.png`), fullPage: true });
    const visible = await page.evaluate((name) => {
      const panel = document.querySelector(`[data-panel="${name}"]`);
      if (!panel) return "no panel";
      return panel.classList.contains("hidden") || panel.hidden ? "hidden" : "shown";
    }, tab);
    console.log(`${tab}: ${visible}`);
  }

  if (errors.length) {
    console.log("\nCONSOLE ERRORS:");
    for (const error of errors) console.log("  " + error);
  } else {
    console.log("\nNo console errors.");
  }
  console.log(`\nScreenshots in ${outDir}`);

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
