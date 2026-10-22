/**
 * Opens the real side panel in a real browser and walks through the tabs.
 *
 * The panel is the product, so a review has to look at the product, not at
 * the source. This boots sidepanel.html with a stubbed chrome API, walks
 * the five tabs, and writes a screenshot of each one.
 *
 * Usage: node scripts/panel-review.js [outputDir]
 *
 * This is a GATE, not a picture generator. It fails (non-zero exit) when the
 * panel cannot actually be driven:
 *
 *   - a chrome API the panel uses is missing from the stub, so the panel
 *     throws while it loads and every tab renders the error screen;
 *   - the panel logs a console error or throws an uncaught exception;
 *   - a tab does not reach its loaded state;
 *   - the panel shows an error screen instead of the product.
 *
 * The first version of this script had none of those checks. It wrote a
 * screenshot of whatever was on screen and called it a review, so a panel
 * that was completely broken still produced six handsome pictures of an
 * error message. A gate that cannot fail is not a gate.
 */

const fs = require("node:fs");
const path = require("node:path");
const { launchReviewBrowser } = require("./lib/review-browser.js");

const root = path.resolve(__dirname, "..");

/**
 * `--store` writes the panel pictures the store listing is built from
 * instead of the review set: the same tabs, at the size Chrome's listing
 * reserves, with sample content that belongs to one video. The listing used
 * to be assembled by hand and drifted a day behind the product every time
 * the panel changed.
 */
const args = process.argv.slice(2);
const storeMode = args.includes("--store");
const outArg = args.find((argument) => !argument.startsWith("--"));
const outDir = path.resolve(
  outArg || path.join(root, storeMode ? ".review-store" : ".review"),
);

/**
 * The clock the sample data is written against.
 *
 * It has to be the real clock. The panel compares its cache entries against
 * `Date.now()` to decide what has aged out, so a fixed date in the past
 * made every sample entry look thirty days old: the library emptied itself
 * and the panel said it had removed entries. The screenshots then showed a
 * cleanup notice for something that never happened.
 */
const NOW = Date.now();

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
    // The panel reads the note body out of `text`. The worker's note object
    // carries it under that name, and a stub that uses `note` instead leaves
    // a note card with a timestamp and nothing written on it.
    text: "This is the key idea: every time you remember, you rewrite it.",
    timestampedUrl: "https://www.youtube.com/watch?v=abc123xyz&t=92",
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
    text: "Sleep is not downtime, it is the filing cabinet.",
    timestampedUrl: "https://www.youtube.com/watch?v=abc123xyz&t=240",
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

/**
 * A word that is due for review.
 *
 * The shape is the one the server really sends: the scheduler's numbers in
 * `review`, the word itself in `vocabulary`. The panel reads
 * `review.vocabulary.term`, so a stub that puts the term at the top level
 * produces a review card with nothing on it.
 */
const SAMPLE_REVIEW = {
  review: {
    dueAt: NOW,
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
  },
  vocabulary: {
    id: "vocab_1",
    term: "ephemeral",
    translation: "短暂的",
    sentenceTranslation: "lasting a very short time",
    sentence: "the trend proved ephemeral",
    videoId: "abc123xyz",
    videoTitle: "How Memory Works",
    timestampSeconds: 92,
    status: "learning",
    createdAt: NOW - 86400000,
    updatedAt: NOW - 86400000,
  },
};

/**
 * The panel asks the worker for the video it is looking at. The stub answers
 * with the same video the transcript belongs to, so the panel shows a real
 * video instead of an empty state.
 */
const VIDEO_INFO = {
  title: "How Memory Works",
  channelName: "Some Channel",
  description: "A talk about how memory reconstructs instead of recording.",
  duration: 900,
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
    ytd_github_session: { token: "t", login: "jasper", githubId: 1001, savedAt: NOW },
    // The library is not a list of its own: it is every `digest_*` entry in
    // local storage, minus the video the user is looking at right now. The
    // stub has to store one, or the Library tab can only ever show its
    // empty state — and an empty state is not a review of the product.
    digest_def456uvw: {
      analysis: null,
      transcript: [],
      transcriptText: "",
      transcriptTimestamped: "",
      transcriptLanguage: null,
      videoTitle: "Building Teams That Last",
      channelName: "Another Channel",
      paragraphCache: {},
      interfaceCache: {},
      timestamp: NOW - 3 * 86400000,
    },
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

/**
 * The chrome API the panel actually uses.
 *
 * Every name here is one the panel calls at load time. A missing name is
 * not a small problem: `chrome.tabs.onActivated.addListener(...)` sits at the
 * top level of sidepanel.js, so a stub without it throws during script
 * evaluation, every later `const` in the file stays in its temporal dead
 * zone, and the panel renders its error screen instead of the product.
 * That is exactly what happened: the first version of this stub did not
 * have `chrome.tabs.onActivated`, so every screenshot in the repository
 * was a picture of an error message.
 *
 * Keep this list in step with the panel. When the panel starts using a new
 * chrome API, add it here — and the gate below will tell you when you
 * forgot.
 *
 * This function is stringified into the page, so it must not close over
 * anything outside itself.
 */
function buildChromeStub(payload) {
  const formatStamp = (total) => {
    const seconds = Math.max(0, Number(total) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
    }
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  };
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
  return {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        switch (message?.action) {
          case "getVocabulary":
            return { success: true, items: payload.words };
          case "getNotes":
            return { success: true, notes: payload.notes };
          case "getDueReviews":
            return { success: true, reviews: [payload.review], count: 1 };
          case "getLibrary":
            return { success: true, items: payload.library };
          case "getTranscript":
            return { success: true, segments: payload.transcript };
          case "getAnalysis":
            return { success: true, analysis: payload.analysis };
          case "fetchTranscript":
            // The panel asks the worker for the captions. The stub hands
            // back the same transcript the page would have produced.
            return {
              success: true,
              transcript: payload.transcript,
              transcriptText: payload.transcript
                .map((segment) => segment.text)
                .join(" "),
              transcriptTextTimestamped: payload.transcript
                .map(
                  (segment) => `[${formatStamp(segment.start)}] ${segment.text}`,
                )
                .join("\n"),
              language: "en",
            };
          case "analyzeTranscript":
            return { success: true, analysis: payload.analysis };
          case "translateContent":
            // The panel sends batches of segments to the provider and paints
            // what comes back. The stub answers with the translation the
            // segment already carries, so the bilingual view is the real
            // view and not a picture of a pending request. Interface copy
            // has no entry in the transcript and is answered with itself,
            // which is what a translation of a label looks like when the
            // provider returns the same words.
            return {
              success: true,
              translatedContent: {
                segments: (message?.content?.segments || []).map((segment) => {
                  const transcript = payload.transcript || [];
                  // The panel groups segments before it sends them, so the id
                  // on the batch is not always the id in the transcript. The
                  // text is, so the text is the second way of finding the
                  // translation this segment already carries.
                  const source =
                    transcript.find((item) => item.id === segment.id) ||
                    transcript.find((item) => item.text === segment.text);
                  return {
                    id: segment.id,
                    text: (source && source.translation) || segment.text || "",
                  };
                }),
              },
            };
          case "getSettings":
            return { success: true, settings: {} };
          case "getVideoInfo":
            return { success: true, ...payload.videoInfo };
          case "relayToContent":
            // The panel asks the worker, which relays to the page. The
            // stub answers as if the page had replied.
            if (message?.payload?.action === "getVideoInfo") {
              return { success: true, response: payload.videoInfo };
            }
            if (message?.payload?.action === "getCurrentTime") {
              // The panel reads `currentTime` out of the reply. A reply
              // that carries `seconds` instead leaves the note composer
              // saying it cannot know the moment.
              return { success: true, response: { currentTime: 92 } };
            }
            return { success: true, response: {} };
          case "getGithubSession":
            return {
              success: true,
              session: { login: "jasper", githubId: 1001, savedAt: payload.now },
              expired: false,
            };
          case "checkConfig":
            // The panel must be able to get past its own configuration gate,
            // otherwise every tab renders the error screen and the review
            // photographs an error screen instead of the product.
            //
            // `hasAiKey: false` is a state a real user is in: the free half
            // of the product works without a key, and the panel says which
            // half does not. The gate reviews that state too, because a
            // notice nobody looked at is a notice nobody checked.
            return {
              success: true,
              hasSupadataKey: payload.hasSupadataKey !== false,
              hasAiKey: payload.hasAiKey !== false,
              provider: "DeepSeek",
            };
          case "getUiLanguage":
            return { success: true, language: "en" };
          case "getCurrentTime":
            return { success: true, seconds: 92 };
          case "getDueReviewsCount":
            return { success: true, count: 4 };
          default:
            return { success: true };
        }
      },
      getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      getManifest: () => ({ version: "1.7.3" }),
    },
    storage: { local, session, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 1, url: "https://www.youtube.com/watch?v=abc123xyz" }],
      get: async () => ({
        id: 1,
        url: "https://www.youtube.com/watch?v=abc123xyz",
        windowId: 1,
      }),
      sendMessage: async () => ({}),
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
      create: async () => ({ id: 1 }),
      remove: async () => {},
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    i18n: { getMessage: (key) => key },
    action: { setBadgeText: async () => {} },
  };
}

/**
 * Reads the panel's own state out of the page.
 *
 * The panel keeps its state in module-scope variables, so the only honest
 * way to ask "is the panel showing the product or an error?" is to look at
 * the DOM the user looks at.
 */
const READ_PANEL_STATE = () => {
  const visible = (id) => {
    const element = document.getElementById(id);
    if (!element) return "missing";
    if (element.hidden) return "hidden";
    if (element.style && element.style.display === "none") return "hidden";
    return "visible";
  };
  const panelFor = (name) => {
    const panel = document.querySelector(`[data-panel="${name}"]`);
    if (!panel) return "missing";
    if (panel.hidden) return "hidden";
    // The panels are shown and hidden with a CSS class, not with the hidden
    // attribute, so the only honest check is the one the browser makes:
    // what is actually painted.
    const display = window.getComputedStyle(panel).display;
    if (display === "none") return "hidden";
    return "visible";
  };
  const text = (id) => (document.getElementById(id)?.textContent || "").trim();
  return {
    welcome: visible("welcomeState"),
    loading: visible("loadingState"),
    error: visible("errorState"),
    results: visible("resultsState"),
    errorTitle: text("errorTitle"),
    errorMessage: text("errorMessage"),
    transcript: panelFor("transcript"),
    overview: panelFor("overview"),
    activePanel: (() => {
      const active = document.querySelector(".tab-panel.active");
      return active ? active.dataset.panel : "";
    })(),
    notes: panelFor("notes"),
    words: panelFor("words"),
    library: panelFor("library"),
    transcriptSegments: document.querySelectorAll("#transcriptList > *").length,
    chapterItems: document.querySelectorAll("#chapterList > *").length,
    noteItems: document.querySelectorAll("#notesList > *").length,
    wordItems: document.querySelectorAll("#wordsList > *").length,
    libraryItems: document.querySelectorAll("#libraryList > *").length,
    summaryText: text("summaryText"),
    // The review card is the one place where a wrong payload shape produces
    // a card with a button on it and nothing to review: the term lives in
    // `review.vocabulary.term`, and the panel reads it from exactly there.
    reviewTerm: text("reviewTerm"),
    reviewSentence: text("reviewSentence"),
    reviewCardHidden: document.getElementById("reviewCard")?.hidden !== false,
  };
};

/**
 * Each tab has to reach a loaded state, not just exist.
 *
 * The keys are the tab's own `data-tab` value, so the script cannot click a
 * button that does not exist. The first version of this script clicked
 * `[data-tab="summary"]`; the tab is called `overview` in the markup and
 * only reads "Summary" on screen, so that click did nothing and the file
 * it wrote was a second picture of the transcript.
 *
 * The Summary tab needs the analysis the stub provides; the others need
 * their own list drawn. A tab that is present but empty is a broken tab,
 * and the first version of this script called that "shown".
 */
const TAB_EXPECTATIONS = {
  transcript: { panel: "transcript", atLeast: 1, countKey: "transcriptSegments" },
  overview: { panel: "overview", atLeast: 1, countKey: "summaryText", text: true },
  notes: { panel: "notes", atLeast: 1, countKey: "noteItems" },
  words: { panel: "words", atLeast: 1, countKey: "wordItems" },
  library: { panel: "library", atLeast: 1, countKey: "libraryItems" },
};

/**
 * The widths the panel has to survive.
 *
 * A side panel is a narrow column that the user drags to whatever suits
 * them, so a layout that only works at one width is a layout that breaks on
 * somebody's screen. Chrome's own side panel goes down to about 320px.
 */
const LAYOUT_WIDTHS = [320, 360, 420, 520];

/**
 * Reads the layout faults the user can see.
 *
 * A button whose label wraps onto a second line reads as two buttons, and
 * it grows its row until the row does not fit. The browser does not call
 * that an overflow — the button simply gets taller — so the only honest
 * check is the one the reader makes: how many lines of text are there.
 *
 * The label next to the button is a different matter. It is a sentence, it
 * is allowed to wrap, and it must not push the button out of the row.
 */
const READ_LAYOUT = () => {
  const problems = [];
  const isPainted = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (element.offsetParent === null && style.position !== "fixed") return false;
    return true;
  };

  for (const button of document.querySelectorAll("button")) {
    if (!isPainted(button)) continue;
    const label = (button.textContent || "").trim().replace(/\s+/g, " ");
    if (!label) continue;
    // A button that holds a whole card is not a label that can wrap. Only
    // the short ones are held to the one-line rule.
    if (label.length > 40) continue;

    // The number of line boxes the label's own text is painted on. Only the
    // text nodes are measured: a range that starts outside a child element
    // counts that element's box as well, which would report every icon
    // button as a wrapped label.
    //
    // The lines are counted by where they sit, not by how many pieces of
    // text there are. A label that is made of several elements - a title, a
    // separator and a time chip, say - is still one line when all three sit
    // on the same row, and counting the pieces would call it three lines
    // and send the reader looking for a fault that is not on the screen.
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    const boxes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.height > 1) boxes.push(rect);
      }
    }
    // The rows the text sits on. Two boxes belong to the same row when
    // their tops are within half a line of each other.
    const rows = [];
    for (const box of boxes) {
      const onRow = rows.find((row) => Math.abs(row.top - box.top) < box.height / 2);
      if (!onRow) rows.push({ top: box.top });
    }
    if (rows.length > 1) {
      problems.push(
        `The button "${label}" is painted on ${rows.length} lines; ` +
          `a button label belongs on one.`,
      );
    }

    // The button must stay inside the box it lives in.
    const parent = button.parentElement;
    const parentStyle = parent ? window.getComputedStyle(parent) : null;
    if (parent && parentStyle && !/hidden|auto|scroll/.test(parentStyle.overflow)) {
      const box = button.getBoundingClientRect();
      const parentBox = parent.getBoundingClientRect();
      if (box.right > parentBox.right + 1 || box.left < parentBox.left - 1) {
        problems.push(
          `The button "${label}" sticks out of its row ` +
            `(${Math.round(box.left)}–${Math.round(box.right)} in ` +
            `${Math.round(parentBox.left)}–${Math.round(parentBox.right)}).`,
        );
      }
    }
  }

  // The panel itself must not scroll sideways.
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) {
    problems.push(
      `The panel scrolls sideways: ${root.scrollWidth}px of content in a ` +
        `${root.clientWidth}px column.`,
    );
  }

  return problems;
};

/**
 * Reads the text that cannot be read.
 *
 * The panel has a dark theme, and a colour that works on cream can be
 * invisible on charcoal. The browser does not complain about either: it
 * paints the text and moves on. The only honest check is the one the eye
 * makes, and the eye measures contrast.
 *
 * The threshold is the one the web accessibility guidelines use: 4.5 to 1
 * for body text, 3 to 1 for large text.
 */
const READ_CONTRAST = () => {
  const problems = [];
  const parse = (value) => {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => parseFloat(part.trim()));
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts.length > 3 ? parts[3] : 1,
    };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const backgroundOf = (element) => {
    let node = element;
    while (node && node !== document.documentElement) {
      const background = parse(window.getComputedStyle(node).backgroundColor);
      if (background && background.a > 0.95) return background;
      node = node.parentElement;
    }
    const page = parse(window.getComputedStyle(document.body).backgroundColor);
    return page && page.a > 0.95 ? page : { r: 255, g: 255, b: 255, a: 1 };
  };

  for (const element of document.querySelectorAll("body *")) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (element.offsetParent === null && style.position !== "fixed") continue;
    // Only the element that holds the text is measured: a parent inherits
    // the colour but the child is what is painted.
    const text = [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .join(" ")
      .trim();
    if (!text) continue;

    const color = parse(style.color);
    if (!color) continue;
    const background = backgroundOf(element);
    const painted = over(color, background);
    const lighter = Math.max(luminance(painted), luminance(background));
    const darker = Math.min(luminance(painted), luminance(background));
    const ratio = (lighter + 0.05) / (darker + 0.05);

    const size = parseFloat(style.fontSize) || 0;
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const floor = large ? 3 : 4.5;
    if (ratio < floor) {
      problems.push(
        `The text "${text.slice(0, 40)}" has ${ratio.toFixed(2)} to 1 ` +
          `contrast on its background; ${floor} to 1 is the floor.`,
      );
    }
  }
  return problems;
};

/**
 * Reads the timestamp chips.
 *
 * A timestamp is the one control that shows up in four places, and the
 * panel is supposed to draw it as one pill everywhere. It did not: the
 * transcript chip was a real button, so it carried the border the browser
 * gives a button, and the stamp the reader sees most often was a grey
 * groove around a pill. The stylesheet owns the chip now, and this gate
 * measures what the browser painted, so the groove cannot come back
 * unnoticed.
 *
 * The height is measured too. The transcript chip sits in a flex row, and
 * a flex item that says nothing about itself is stretched to the height of
 * the row, which turned the stamp into an oval on every long line.
 */
const READ_CHIPS = () => {
  const problems = [];
  const chips = document.querySelectorAll(
    ".chapter-timestamp, .quote-timestamp, .note-timestamp, .transcript-time, .word-timestamp",
  );
  for (const chip of chips) {
    const style = window.getComputedStyle(chip);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (chip.offsetParent === null && style.position !== "fixed") continue;
    const label = (chip.textContent || "").trim() || "the timestamp";
    const border = parseFloat(style.borderTopWidth) || 0;
    if (border > 0) {
      problems.push(
        `The timestamp "${label}" is painted with a ${border}px border. ` +
          `The chip carries its own shape; a border around it is the ` +
          `browser's, not the design's.`,
      );
    }
    // A stamp is one line tall. A chip that is taller than its own text is
    // a chip that has been stretched into something else.
    const fontSize = parseFloat(style.fontSize) || 0;
    const height = chip.getBoundingClientRect().height;
    if (fontSize && height > fontSize * 2.4) {
      problems.push(
        `The timestamp "${label}" is ${Math.round(height)}px tall. ` +
          `A stamp is one line, so it belongs under ` +
          `${Math.round(fontSize * 2.4)}px here.`,
      );
    }
    // A stamp is one size. The chip is wide enough for the longest stamp
    // the panel writes - "1:30:00" - so a short one and a long one are the
    // same width and the stamps of one video stay in a straight column.
    // The promise was half a pixel short of seven characters, and the long
    // stamp stepped out of the column, so the two labels are measured on
    // the chip itself: the same element and the same font, only the text
    // differs.
    chip.textContent = "0:00";
    const shortWidth = chip.getBoundingClientRect().width;
    chip.textContent = "1:30:00";
    const longWidth = chip.getBoundingClientRect().width;
    chip.textContent = label;
    if (Math.abs(longWidth - shortWidth) > 0.5) {
      problems.push(
        `The timestamp chip is ${Math.round(shortWidth)}px wide for "0:00" ` +
          `and ${Math.round(longWidth)}px for "1:30:00". A stamp is one ` +
          `size, or the column steps in and out with the length of each one.`,
      );
    }
  }
  return problems;
};

/**
 * Opens the panel with a given configuration.
 *
 * The panel is opened in its own browser context because the configuration
 * is decided when the page loads: a user without a key is a different state
 * of the product, not a different click inside one state.
 */
async function openPanel(
  browser,
  payloadOverrides = {},
  viewport = { width: 420, height: 900 },
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
  });

  const chrome = makeChrome();
  const { local: localOverride, ...rest } = payloadOverrides;
  await context.addInitScript(
    ({ buildSource, payload }) => {
      // The stub is rebuilt inside the page from its own source, because an
      // init script only receives plain data.
      const build = new Function(`return (${buildSource});`)();
      window.chrome = build(payload);
    },
    {
      buildSource: buildChromeStub.toString(),
      payload: {
        local: { ...chrome.local.values, ...(localOverride || {}) },
        words: WORDS,
        notes: NOTES,
        review: SAMPLE_REVIEW,
        library: LIBRARY,
        transcript: TRANSCRIPT,
        analysis: ANALYSIS,
        videoInfo: VIDEO_INFO,
        now: NOW,
        ...rest,
      },
    },
  );

  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error && error.stack ? error.stack : error)));

  await page.goto(`file://${path.join(root, "sidepanel.html")}`);
  await page.waitForTimeout(900);

  return { context, page, errors };
}

/**
 * Reads what the panel says about the key it does not have.
 */
const READ_KEY_NOTICE = () => {
  const notice = document.getElementById("aiKeyNotice");
  const button = document.getElementById("summaryGenerateBtn");
  const gate = document.getElementById("summaryGate");
  return {
    missing: !notice,
    hidden: notice ? notice.hidden : true,
    text: notice ? notice.textContent.trim() : "",
    button: button ? button.textContent.trim() : "",
    gate: gate ? gate.textContent.trim() : "",
  };
};

/**
 * The video the store listing shows.
 *
 * Every picture on the listing is this one video. The panel is pasted into a
 * photograph of its real watch page, so the title, the channel and the
 * transcript have to be the ones on that page: a listing where the page says
 * one video and the panel another reads as two sessions glued together.
 */
const STORE_VIDEO = {
  videoId: "sam-altman-building-openai",
  title: "Sam Altman on Building OpenAI & Betting on the Impossible",
  channelName: "David Senra",
  description:
    "Sam Altman on the people he learns from, how he takes feedback, and what he expects from the next few years of AI.",
  duration: 3600,
};

/**
 * Lines of the interview as they were read out of the page.
 *
 * They are the video's own words and their translations, not filler written
 * to fill a screenshot. The three segments are the ones a reader can check
 * against the video.
 */
const STORE_TRANSCRIPT = [
  {
    id: "s1",
    start: 98,
    end: 107,
    text: "A lot of people send product feedback. He is the only person at the intersection of like CEO of a large company and extremely accurate, detailed on the cutting edge feedback.",
    translation:
      "很多人都会给产品反馈。他是唯一一个既是大型公司的 CEO、又能给出极其准确、细致且处于前沿的反馈的人。",
  },
  {
    id: "s2",
    start: 107,
    end: 114,
    text: "Yeah, he told me I don't know if it was on the episode uh that we if it was in the episode or if it was after, but he said he was very um adamant.",
    translation:
      "是的，他告诉我，我不知道那是在录节目的时候，还是录完之后，但他非常坚持。",
  },
  {
    id: "s3",
    start: 114,
    end: 121,
    text: 'He\'s like, "We\'re going to look back in 2026."',
    translation: "他说：“到 2026 年回头再看。”",
  },
];

const STORE_ANALYSIS = {
  title: STORE_VIDEO.title,
  channelName: STORE_VIDEO.channelName,
  summary:
    "Sam Altman explains why Toby Lu stands out: he writes the software himself and gives exact feedback on what the models can really do. They disagree on when AI reshapes business, and agree it is a people problem, not a software problem.",
  chapters: [
    {
      title: "Why Toby Lu stands out",
      timestamp: "0:00",
      timestampSeconds: 0,
      summary:
        "He builds the software himself and gives exact, unvarnished feedback on what the models can really do.",
    },
    {
      title: "A year every business is up for grabs",
      timestamp: "1:28",
      timestampSeconds: 88,
      summary:
        "Toby's bet that 2026 belongs to whoever rebuilds a business AI-native.",
    },
    {
      title: "Where the two timelines diverge",
      timestamp: "3:36",
      timestampSeconds: 216,
      summary:
        "Sam thinks the economy's inertia will make the shift slower than Toby expects.",
    },
  ],
  keyPoints: [
    "Exact, unvarnished feedback is rarer than good product ideas.",
    "The disagreement is about when AI reshapes a business, not whether.",
    "Both agree the hard part is people, not software.",
  ],
};

const STORE_NOTES = [
  {
    id: "note_1",
    clientId: "note_1",
    videoId: STORE_VIDEO.videoId,
    videoTitle: STORE_VIDEO.title,
    channelName: STORE_VIDEO.channelName,
    timestampSeconds: 98,
    quote:
      "the only person at the intersection of like CEO of a large company and extremely accurate, detailed on the cutting edge feedback",
    text: "Most feedback is either directionally right or precisely right. This is the case for both.",
    timestampedUrl:
      "https://www.youtube.com/watch?v=sam-altman-building-openai&t=98",
    starred: true,
    createdAt: NOW - 3600000,
    updatedAt: NOW - 3600000,
  },
  {
    id: "note_2",
    clientId: "note_2",
    videoId: STORE_VIDEO.videoId,
    videoTitle: STORE_VIDEO.title,
    channelName: STORE_VIDEO.channelName,
    timestampSeconds: 107,
    quote: "he said he was very um adamant",
    text: "Worth re-listening to this part in full.",
    timestampedUrl:
      "https://www.youtube.com/watch?v=sam-altman-building-openai&t=107",
    starred: false,
    createdAt: NOW - 7200000,
    updatedAt: NOW - 7200000,
  },
];

const STORE_WORDS = [
  {
    id: "vocab_1",
    term: "adamant",
    translation: "坚决的",
    explanation: "refusing to be persuaded or to change one's mind",
    sentence: "he said he was very um adamant",
    videoId: STORE_VIDEO.videoId,
    videoTitle: STORE_VIDEO.title,
    timestampSeconds: 107,
    status: "learning",
    createdAt: NOW - 3600000,
    updatedAt: NOW - 3600000,
  },
  {
    id: "vocab_2",
    term: "unvarnished",
    translation: "不加修饰的",
    explanation: "stated plainly, without softening anything",
    sentence: "exact, unvarnished feedback",
    videoId: STORE_VIDEO.videoId,
    videoTitle: STORE_VIDEO.title,
    timestampSeconds: 0,
    status: "reviewing",
    createdAt: NOW - 86400000,
    updatedAt: NOW - 86400000,
  },
  {
    id: "vocab_3",
    term: "the cutting edge",
    translation: "最前沿",
    explanation: "the newest stage of development of something",
    sentence: "detailed on the cutting edge feedback",
    videoId: STORE_VIDEO.videoId,
    videoTitle: STORE_VIDEO.title,
    timestampSeconds: 98,
    status: "mastered",
    createdAt: NOW - 172800000,
    updatedAt: NOW - 172800000,
  },
];

const STORE_REVIEW = {
  review: { dueAt: NOW, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 },
  vocabulary: STORE_WORDS[0],
};

const STORE_LIBRARY = [
  {
    id: STORE_VIDEO.videoId,
    videoId: STORE_VIDEO.videoId,
    title: STORE_VIDEO.title,
    channelName: STORE_VIDEO.channelName,
    createdAt: NOW - 3600000,
    expiresAt: NOW + 23 * 86400000,
    noteCount: 2,
  },
  {
    id: "def456uvw",
    videoId: "def456uvw",
    title: "The Business of AI Agents",
    channelName: "Latent Space",
    createdAt: NOW - 86400000,
    expiresAt: NOW + 20 * 86400000,
    noteCount: 4,
  },
  {
    id: "ghi789rst",
    videoId: "ghi789rst",
    title: "How Memory Works",
    channelName: "Some Channel",
    createdAt: NOW - 3 * 86400000,
    expiresAt: NOW + 17 * 86400000,
    noteCount: 1,
  },
];

/** The size the Chrome Web Store reserves for a screenshot of the panel. */
const STORE_PANEL = { width: 450, height: 780 };

/** What each store picture shows, and the file it is written to. */
const STORE_SHOTS = [
  { name: "overview", tab: "overview", generate: true },
  { name: "transcript-bilingual", tab: "transcript", bilingual: true },
  { name: "notes", tab: "notes" },
  { name: "words", tab: "words" },
  { name: "library", tab: "library" },
];

/**
 * Writes the panel pictures the store listing is built from.
 *
 * The listing showed a generation of the panel that no longer existed, and
 * nothing regenerated it, so the pictures drifted a day behind the product
 * while every gate stayed green. This is the other half of that fix:
 * `scripts/store-shots.js` composites these onto the demo photograph.
 *
 * It fails rather than writes a picture of a broken panel, for the same
 * reason the review does: a listing built from an error screen is worse than
 * a listing with no pictures.
 */
async function renderStoreShots(browser, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const failures = [];
  const { context, page, errors } = await openPanel(
    browser,
    {
      local: {
        ytd_notes: STORE_NOTES,
        ytd_vocabulary: STORE_WORDS,
        // The library is every `digest_*` entry in local storage, so the
        // library picture needs more than one entry in storage to have
        // more than one row in it.
        digest_def456uvw: {
          analysis: null,
          transcript: [],
          transcriptText: "",
          transcriptTimestamped: "",
          transcriptLanguage: null,
          videoTitle: "The Business of AI Agents",
          channelName: "Latent Space",
          paragraphCache: {},
          interfaceCache: {},
          timestamp: NOW - 86400000,
        },
        digest_ghi789rst: {
          analysis: {
            title: "How Memory Works",
            channelName: "Some Channel",
            summary:
              "A talk about how memory reconstructs instead of recording.",
            chapters: [],
            keyPoints: [],
          },
          transcript: TRANSCRIPT,
          transcriptText: TRANSCRIPT.map((segment) => segment.text).join(" "),
          transcriptTimestamped: TRANSCRIPT.map(
            (segment) => `[${segment.start}] ${segment.text}`,
          ).join("\n"),
          transcriptLanguage: "en",
          videoTitle: "How Memory Works",
          channelName: "Some Channel",
          paragraphCache: {},
          interfaceCache: {},
          timestamp: NOW - 3 * 86400000,
        },
        digest_jkl012mno: {
          analysis: {
            title: "Building a Second Brain",
            channelName: "Every",
            summary: "How a notes system becomes a thinking system.",
            chapters: [],
            keyPoints: [],
          },
          transcript: TRANSCRIPT,
          transcriptText: TRANSCRIPT.map((segment) => segment.text).join(" "),
          transcriptTimestamped: TRANSCRIPT.map(
            (segment) => `[${segment.start}] ${segment.text}`,
          ).join("\n"),
          transcriptLanguage: "en",
          videoTitle: "Building a Second Brain",
          channelName: "Every",
          paragraphCache: {},
          interfaceCache: {},
          timestamp: NOW - 6 * 86400000,
        },
      },
      words: STORE_WORDS,
      notes: STORE_NOTES,
      review: STORE_REVIEW,
      library: STORE_LIBRARY,
      transcript: STORE_TRANSCRIPT,
      analysis: STORE_ANALYSIS,
      videoInfo: STORE_VIDEO,
    },
    STORE_PANEL,
  );

  for (const shot of STORE_SHOTS) {
    await page.evaluate((name) => {
      document.querySelector(`[data-tab="${name}"]`)?.click();
    }, shot.tab);
    await page.waitForTimeout(700);


    if (shot.generate) {
      await page.evaluate(() => {
        document.getElementById("summaryGenerateBtn")?.click();
      });
      // The summary is painted after the answer arrives, so a fixed wait
      // photographs a half-drawn summary about half the time. The listing
      // has to show the finished thing.
      await page
        .waitForFunction(
          () => {
            const node = document.getElementById("summaryText");
            return node && node.textContent.trim().length > 40;
          },
          { timeout: 8000 },
        )
        .catch(() => {
          failures.push(
            `The ${shot.name} picture would show a summary that never arrived.`,
          );
        });
      await page.waitForTimeout(400);
    }

    if (shot.bilingual) {
      // The language is switched the way a user switches it: press the
      // button, answer the price question, wait for the lines. Driving the
      // state directly would photograph a view the product never produces.
      await page.evaluate(() => {
        document.getElementById("contentLanguageBilingual")?.click();
      });
      await page.waitForTimeout(400);
      const asked = await page.evaluate(() => {
        const confirm = document.getElementById("translationCostConfirmBtn");
        if (!confirm) return false;
        confirm.click();
        return true;
      });
      if (!asked) {
        failures.push(
          "Switching to bilingual did not ask what the translation costs. " +
            "A switch that spends money without asking is the defect this " +
            "review exists to catch.",
        );
      }
      await page.waitForTimeout(1500);
      // A row is `translated` only once a translation is painted on it;
      // until then it says it is still translating.
      const translated = await page.evaluate(
        () => document.querySelectorAll(".transcript-entry.translated").length,
      );
      if (!translated) {
        failures.push(
          "The bilingual picture has no translation under any line, so it " +
            "would show the same thing as the original.",
        );
      }
    }

    // A picture of a list that has not been filled in yet is a picture of
    // nothing. Each tab is given its content before it is photographed.
    const expectation = TAB_EXPECTATIONS[shot.tab];
    await page
      .waitForFunction(
        ({ source, key, text }) => {
          const state = new Function(`return (${source});`)()();
          return text
            ? String(state[key] || "").trim().length > 0
            : Number(state[key] || 0) > 0;
        },
        {
          source: READ_PANEL_STATE.toString(),
          key: expectation.countKey,
          text: !!expectation.text,
        },
        { timeout: 8000 },
      )
      .catch(() => {
        failures.push(
          `The ${shot.name} picture would show an empty ${shot.tab} tab; ` +
            `nothing was drawn in it.`,
        );
      });

    const state = await page.evaluate(READ_PANEL_STATE);
    const panel = TAB_EXPECTATIONS[shot.tab].panel;
    if (state[panel] !== "visible" || state.error === "visible") {
      failures.push(
        `The ${shot.name} picture would show ${state.error === "visible" ? "the error screen" : `nothing (${panel} is ${state[panel]})`}.`,
      );
      continue;
    }

    const file = path.join(targetDir, `${shot.name}.png`);
    // Not fullPage: the panel is exactly one viewport tall and scrolls its
    // own content area, so the viewport is the picture.
    await page.screenshot({ path: file });
    const bytes = fs.readFileSync(file);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const expectedWidth = STORE_PANEL.width * 2;
    const expectedHeight = STORE_PANEL.height * 2;
    if (width !== expectedWidth || height !== expectedHeight) {
      failures.push(
        `${shot.name}.png came out ${width}x${height}; the listing needs ` +
          `${expectedWidth}x${expectedHeight} (${STORE_PANEL.width}x${STORE_PANEL.height} at 2x).`,
      );
      continue;
    }
    console.log(`${shot.name}: ${width}x${height}`);

    // The language is one choice for the whole panel, so every picture after
    // this one would be bilingual too. A note is painted twice in that view
    // (the line, then its translation), which on a listing reads as the
    // product repeating every note. The listing goes back to the language
    // most of its readers use.
    if (shot.bilingual) {
      await page.evaluate(() => {
        document.getElementById("contentLanguageOriginal")?.click();
      });
      await page.waitForTimeout(700);
    }
  }

  if (errors.length) {
    failures.push(
      `The panel logged ${errors.length} console error(s):\n` +
        errors.map((error) => `    ${error}`).join("\n"),
    );
  }
  await context.close();

  if (failures.length) {
    console.error("\nSTORE SHOTS FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    return false;
  }
  console.log(`\nStore panel shots in ${targetDir}`);
  return true;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launchReviewBrowser();

  if (storeMode) {
    const ok = await renderStoreShots(browser, outDir);
    await browser.close();
    if (!ok) process.exit(1);
    return;
  }

  const { context, page, errors } = await openPanel(browser);

  const failures = [];

  const boot = await page.evaluate(READ_PANEL_STATE);
  if (boot.error === "visible") {
    failures.push(
      `The panel booted into its error screen ("${boot.errorTitle}: ${boot.errorMessage}"). ` +
        `A review that photographs an error screen is not a review of the product.`,
    );
  }
  if (boot.results !== "visible") {
    failures.push(
      `The panel never reached its results view (welcome=${boot.welcome}, ` +
        `loading=${boot.loading}, error=${boot.error}, results=${boot.results}).`,
    );
  }

  const tabs = Object.keys(TAB_EXPECTATIONS);
  for (const tab of tabs) {
    await page.evaluate((name) => {
      const button = document.querySelector(`[data-tab="${name}"]`);
      if (button) button.click();
    }, tab);
    await page.waitForTimeout(600);

    // The summary is behind a paywall gate on purpose: it costs the user
    // money, so it is never bought by opening the tab. A review has to walk
    // through the gate the user walks through, or it never sees the summary
    // at all.
    if (tab === "overview") {
      const gateVisible = await page.evaluate(() => {
        const gate = document.getElementById("summaryGate");
        return gate ? !gate.hidden : false;
      });
      if (gateVisible) {
        await page.evaluate(() => {
          document.getElementById("summaryGenerateBtn")?.click();
        });
        await page.waitForTimeout(1200);
      }
    }

    await page.screenshot({ path: path.join(outDir, `${tab}.png`), fullPage: true });

    const state = await page.evaluate(READ_PANEL_STATE);
    const expectation = TAB_EXPECTATIONS[tab];

    // The tab that was clicked has to be the tab that is on screen. A panel
    // that quietly shows the wrong tab is a broken panel, and the first
    // version of this gate missed exactly that.
    const activeTab = await page.evaluate(() => {
      const active = document.querySelector(".tab-panel.active");
      return active ? active.dataset.panel : "";
    });
    if (activeTab !== expectation.panel) {
      failures.push(
        `Clicking the ${tab} tab showed the "${activeTab}" panel, ` +
          `not the "${expectation.panel}" one.`,
      );
      console.log(`${tab}: WRONG PANEL (${activeTab})`);
      continue;
    }

    if (state[expectation.panel] !== "visible") {
      failures.push(`The ${tab} tab is not visible (${state[expectation.panel]}).`);
      console.log(`${tab}: panel ${state[expectation.panel]}`);
      continue;
    }
    if (expectation.text) {
      const text = state[expectation.countKey];
      if (!text) {
        failures.push(`The ${tab} tab is visible but empty (no ${expectation.countKey}).`);
        console.log(`${tab}: visible, EMPTY`);
        continue;
      }
    } else {
      const count = state[expectation.countKey];
      if (typeof count !== "number" || count < expectation.atLeast) {
        failures.push(
          `The ${tab} tab is visible but shows ${count} item(s); ` +
            `at least ${expectation.atLeast} was expected.`,
        );
        console.log(`${tab}: visible, ${count} item(s)`);
        continue;
      }
    }

    // A card with nothing on it is not a card. The review card reads its
    // term out of `review.vocabulary.term`, so a payload with the wrong
    // shape leaves the user with a "Show answer" button and no word.
    if (tab === "words" && !state.reviewCardHidden && !state.reviewTerm) {
      failures.push(
        "The review card is showing but has no term on it. The panel reads " +
          "the term from review.vocabulary.term; a payload with a different " +
          "shape leaves an empty card.",
      );
      console.log(`${tab}: loaded, but the review card is empty`);
      continue;
    }

    console.log(`${tab}: loaded`);
  }

  if (errors.length) {
    failures.push(
      `The panel logged ${errors.length} console error(s) while loading:\n` +
        errors.map((error) => `    ${error}`).join("\n"),
    );
  }

  // The text has to be readable in the theme the reader is actually using.
  // The dark theme is not a variation of the light one: it is a different
  // set of colours, and each one has to be read on its own.
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const tab of Object.keys(TAB_EXPECTATIONS)) {
      await page.evaluate((name) => {
        document.querySelector(`[data-tab="${name}"]`)?.click();
      }, tab);
      await page.waitForTimeout(220);
      const problems = await page.evaluate(READ_CONTRAST);
      for (const problem of problems) {
        failures.push(`In the ${scheme} theme, on the ${tab} tab: ${problem}`);
      }
    }
    if (scheme === "dark") {
      await page.evaluate(() => {
        document.querySelector('[data-tab="notes"]')?.click();
      });
      await page.waitForTimeout(220);
      await page.screenshot({
        path: path.join(outDir, "dark-notes.png"),
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });

  // The panel has to fit the column it is given. The pictures above are
  // taken at one width; this walks the tabs again at every width a user can
  // drag the side panel to.
  for (const width of LAYOUT_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of Object.keys(TAB_EXPECTATIONS)) {
      await page.evaluate((name) => {
        document.querySelector(`[data-tab="${name}"]`)?.click();
      }, tab);
      await page.waitForTimeout(220);
      const problems = await page.evaluate(READ_LAYOUT);
      for (const problem of problems) {
        failures.push(`At ${width}px, on the ${tab} tab: ${problem}`);
      }
      const chipProblems = await page.evaluate(READ_CHIPS);
      for (const problem of chipProblems) {
        failures.push(`At ${width}px, on the ${tab} tab: ${problem}`);
      }
    }
  }
  await page.setViewportSize({ width: 420, height: 900 });

  // The panel without a key is a state every user starts in. It has to
  // open, it has to say which half of the product is waiting for a key,
  // and the notice has to be readable in both themes and at every width.
  const noKey = await openPanel(browser, { hasAiKey: false });
  const noKeyState = await noKey.page.evaluate(READ_PANEL_STATE);
  if (noKeyState.error === "visible") {
    failures.push(
      `Without a key the panel shows its error screen ("${noKeyState.errorTitle}: ` +
        `${noKeyState.errorMessage}"). The free half of the product has to open ` +
        `without a key.`,
    );
  }
  if (noKeyState.results !== "visible") {
    failures.push(
      `Without a key the panel never reaches its results view (welcome=${noKeyState.welcome}, ` +
        `loading=${noKeyState.loading}, error=${noKeyState.error}, results=${noKeyState.results}).`,
    );
  }

  const notice = await noKey.page.evaluate(READ_KEY_NOTICE);
  if (notice.missing) {
    failures.push("The panel has no notice for the features that are waiting for a key.");
  } else {
    if (notice.hidden) {
      failures.push("The panel has no AI key and does not say that anything is waiting for one.");
    }
    if (!/summary/i.test(notice.text)) {
      failures.push(`The notice does not name the feature that needs a key: "${notice.text}".`);
    }
    if (!/notes|vocabulary|reading/i.test(notice.text)) {
      failures.push(`The notice does not say what works without a key: "${notice.text}".`);
    }
  }
  if (notice.button !== "Open Settings") {
    failures.push(
      `Without a key the summary button says "${notice.button}" instead of "Open Settings". ` +
        `The button has to do the one thing that can change the situation.`,
    );
  }
  if (/AI call/i.test(notice.gate)) {
    failures.push(
      `Without a key the summary gate still quotes the price of a call: "${notice.gate}".`,
    );
  }
  await noKey.page.screenshot({ path: path.join(outDir, "no-key.png"), fullPage: true });

  for (const scheme of ["light", "dark"]) {
    await noKey.page.emulateMedia({ colorScheme: scheme });
    await noKey.page.waitForTimeout(220);
    const problems = await noKey.page.evaluate(READ_CONTRAST);
    for (const problem of problems) {
      failures.push(`Without a key, in the ${scheme} theme: ${problem}`);
    }
  }
  await noKey.page.emulateMedia({ colorScheme: "light" });
  for (const width of LAYOUT_WIDTHS) {
    await noKey.page.setViewportSize({ width, height: 900 });
    await noKey.page.waitForTimeout(220);
    const problems = await noKey.page.evaluate(READ_LAYOUT);
    for (const problem of problems) {
      failures.push(`Without a key, at ${width}px: ${problem}`);
    }
  }
  if (noKey.errors.length) {
    failures.push(
      `The panel logged ${noKey.errors.length} console error(s) without a key:\n` +
        noKey.errors.map((error) => `    ${error}`).join("\n"),
    );
  }
  await noKey.context.close();

  if (failures.length) {
    console.error("\nPANEL REVIEW FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(`\nScreenshots in ${outDir} (they show the broken state, not the product).`);
    await browser.close();
    process.exit(1);
  }

  console.log("\nThe panel loaded every tab with no console error.");
  console.log(`Screenshots in ${outDir}`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
