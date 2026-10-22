const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const tokensSource = read("tokens.js");
const settingsSource = read("settings.js");
const contentSource = read("content.js");

/* ============================================================
   THE PAGE IS A REAL PAGE.

   The content script lives in the page, so the only honest way to test
   it is against a page that behaves like one: a document that answers
   selectors, elements that carry styles and listeners, and a window with
   a location and a selection. These tests run the shipped content.js
   inside such a page.

   Every assertion is about what the page shows, what the page sends, or
   what the user ends up with. Nothing here reads the source of a file
   and looks for a string in it.
   ============================================================ */

/**
 * A YouTube watch page, with the parts the extension reads.
 *
 * The description is inside the box that also holds the line with the
 * view count, because that is how YouTube builds it: the box around the
 * description is the metadata column, and the view count is the first
 * thing in it. The head of the page carries an element called
 * "description" as well, so a page that only looks at the name reads
 * the wrong text.
 */
const WATCH_PAGE = `<!doctype html>
<html>
  <head>
    <style>#movie_player { position: relative; }</style>
  </head>
  <body>
    <div id="movie_player" class="html5-video-player">
      <video class="html5-main-video"></video>
    </div>
    <div id="title">
      <h1><yt-formatted-string>The video title</yt-formatted-string></h1>
    </div>
    <div id="channel-name">
      <yt-formatted-string><a>The channel</a></yt-formatted-string>
    </div>
    <div id="description-inner">
      <ytd-watch-info-text id="ytd-watch-info-text">1.2B views - 3 days ago</ytd-watch-info-text>
      <div id="description"></div>
      <ytd-text-inline-expander id="description-inline-expander">
        <div id="snippet">
          <span id="snippet-text">
            <yt-attributed-string>The real description of the video.</yt-attributed-string>
          </span>
        </div>
        <div id="expanded"><yt-attributed-string></yt-attributed-string></div>
      </ytd-text-inline-expander>
    </div>
    <p id="page-text">the sentence the user highlighted</p>
  </body>
</html>`;

/**
 * Boots the real content script in a real page.
 *
 * @param {Object} options
 * @param {string} options.url the page the script is run in
 * @param {string} options.html the page's markup
 * @param {Function} options.onSend answers the messages the page sends
 * @returns {Promise<Object>} the page and the pieces a test needs
 */
async function createPage({
  url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  html = WATCH_PAGE,
  onSend = null,
} = {}) {
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  const document = window.document;
  const sent = [];
  const listeners = [];

  // The page's own player. The number of listeners it carries is what
  // the navigation test watches.
  const player = document.getElementById("movie_player");
  const liveListeners = new Map();
  if (player) {
    const add = player.addEventListener.bind(player);
    const remove = player.removeEventListener.bind(player);
    player.addEventListener = (type, listener, options) => {
      liveListeners.set(type, (liveListeners.get(type) || 0) + 1);
      add(type, listener, options);
    };
    player.removeEventListener = (type, listener, options) => {
      liveListeners.set(type, (liveListeners.get(type) || 0) - 1);
      remove(type, listener, options);
    };
  }

  window.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      async sendMessage(message) {
        sent.push(message);
        if (onSend) return onSend(message);
        return { success: true };
      },
    },
  };

  // tokens.js and settings.js first, exactly as the manifest loads them.
  window.eval(tokensSource);
  window.eval(settingsSource);
  // The script's own functions are handed out at the end, so a test can
  // call the same code the page calls.
  window.eval(`${contentSource}
;window.__ytd = {
  saveCurrentNote,
  injectNoteButton,
  extractVideoInfo,
  handleNoteKeyboardShortcut,
  showToast,
  readSelectedText,
  panelCopy,
  detachNoteButtonFromPlayer,
};`);

  const video = document.querySelector("video.html5-main-video");
  if (video) {
    video.currentTime = 42;
    video.paused = false;
  }

  // The script starts when the page is ready, the way it does in the
  // browser. A test that looks at the page before that is looking at a
  // page the user never sees.
  if (document.readyState !== "complete") {
    await new Promise((resolve) => {
      window.addEventListener("load", resolve, { once: true });
    });
  }
  await wait(0);

  return {
    dom,
    window,
    document,
    player,
    video,
    sent,
    listeners,
    liveListeners,
    /** The messages the page sent, of one kind only. */
    messages(action) {
      return sent.filter((message) => message.action === action);
    },
    /** Asks the page a question, the way the worker does. */
    ask(message) {
      return new Promise((resolve) => {
        listeners.forEach((listener) => {
          listener(message, {}, resolve);
        });
      });
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================================
   THE DESCRIPTION IS THE DESCRIPTION
   ============================================================ */

test("the description that is read is the description, not the view count", async () => {
  const page = await createPage();

  const info = page.window.__ytd.extractVideoInfo();

  assert.equal(
    info.description,
    "The real description of the video.",
    "the page read something else than the description",
  );
  assert.doesNotMatch(
    info.description,
    /views/i,
    "the description is the line with the view count",
  );
});

test("the title and the channel are still read from the page", async () => {
  const page = await createPage();

  const info = page.window.__ytd.extractVideoInfo();

  assert.equal(info.title, "The video title");
  assert.equal(info.channelName, "The channel");
});

/* ============================================================
   A NOTE IS ABOUT THE WORDS THE USER HIGHLIGHTED
   ============================================================ */

test("a note carries the words the user had highlighted", async () => {
  const page = await createPage();
  const paragraph = page.document.getElementById("page-text");
  const selection = page.window.getSelection();
  const range = page.document.createRange();
  range.selectNodeContents(paragraph);
  selection.removeAllRanges();
  selection.addRange(range);

  await page.window.__ytd.saveCurrentNote();

  const notes = page.messages("saveNote");
  assert.equal(notes.length, 1, "the note was not saved");
  assert.equal(
    notes[0].selectedText,
    "the sentence the user highlighted",
    "the note does not carry the words the user highlighted",
  );
});

test("a note without a selection carries no text of its own", async () => {
  const page = await createPage();

  await page.window.__ytd.saveCurrentNote();

  const notes = page.messages("saveNote");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].selectedText, "");
});

/* ============================================================
   THE SHORTCUT IS OURS, AND ONLY THE PLAIN KEY
   ============================================================ */

test("the plain n saves a note", async () => {
  const page = await createPage();

  page.document.dispatchEvent(
    new page.window.KeyboardEvent("keydown", {
      key: "n",
      bubbles: true,
      cancelable: true,
    }),
  );
  await wait(10);

  assert.equal(
    page.messages("saveNote").length,
    1,
    "the shortcut did not save a note",
  );
});

test("Shift and N is YouTube's shortcut, not ours", async () => {
  const page = await createPage();

  page.document.dispatchEvent(
    new page.window.KeyboardEvent("keydown", {
      key: "N",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await wait(10);

  assert.equal(
    page.messages("saveNote").length,
    0,
    "the shortcut took the key YouTube uses to skip to the next video",
  );
});

test("Ctrl and N is the browser's shortcut, not ours", async () => {
  const page = await createPage();

  page.document.dispatchEvent(
    new page.window.KeyboardEvent("keydown", {
      key: "n",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await wait(10);

  assert.equal(
    page.messages("saveNote").length,
    0,
    "the shortcut took the key the browser uses for a new window",
  );
});

/* ============================================================
   THE PLAYER DOES NOT KEEP EVERY VIDEO'S LISTENERS
   ============================================================ */

test("the player does not collect a listener for every video the user opens", async () => {
  const page = await createPage();

  for (let round = 0; round < 3; round += 1) {
    page.document.dispatchEvent(new page.window.Event("yt-navigate-finish"));
    await wait(700);
  }

  assert.equal(
    page.liveListeners.get("mouseenter"),
    1,
    "the player carries the mouse handlers of every video the user opened",
  );
  assert.equal(
    page.liveListeners.get("mousemove"),
    1,
    "the player carries the mouse handlers of every video the user opened",
  );
  assert.equal(
    page.liveListeners.get("mouseleave"),
    1,
    "the player carries the mouse handlers of every video the user opened",
  );
});

/* ============================================================
   THE FEEDBACK FOLLOWS THE VIDEO INTO FULLSCREEN
   ============================================================ */

test("the toast is shown inside the fullscreen player", async () => {
  const page = await createPage();
  Object.defineProperty(page.document, "fullscreenElement", {
    configurable: true,
    get: () => page.player,
  });

  page.window.__ytd.showToast("Note saved", "The note is on the video.");

  const toast = page.document.getElementById("ytd-toast");
  assert.ok(toast, "the toast is not on the page");
  assert.equal(
    toast.parentElement,
    page.player,
    "the toast is outside the fullscreen video, so nobody can see it",
  );
});

test("the toast is on the page when nothing is fullscreen", async () => {
  const page = await createPage();

  page.window.__ytd.showToast("Note saved", "The note is on the video.");

  const toast = page.document.getElementById("ytd-toast");
  assert.ok(toast, "the toast is not on the page");
  assert.equal(toast.parentElement, page.document.body);
});

/* ============================================================
   THE PAGE'S OWN STYLES ARE LEFT ALONE
   ============================================================ */

test("the player's own position is not written over", async () => {
  const page = await createPage();

  // YouTube's own stylesheet already positions the player. An inline
  // style outranks that stylesheet, so writing one here would silence
  // any change YouTube makes to the player later.
  assert.equal(
    page.player.style.position,
    "",
    "the player already carried an inline position",
  );

  page.window.__ytd.injectNoteButton();

  assert.equal(
    page.player.style.position,
    "",
    "the page wrote a position onto YouTube's element",
  );
});

test("a position the page already set is kept", async () => {
  const page = await createPage();
  page.player.style.position = "absolute";

  page.window.__ytd.injectNoteButton();

  assert.equal(
    page.player.style.position,
    "absolute",
    "the page overwrote a position that was already there",
  );
});

test("a player with no position gets one, so the button has an anchor", () => {
  const dom = new JSDOM(WATCH_PAGE.replace(/<style>[\s\S]*?<\/style>/, ""), {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage() {
        return { success: true };
      },
    },
  };
  window.eval(tokensSource);
  window.eval(settingsSource);
  window.eval(`${contentSource}
;window.__ytd = { injectNoteButton };`);

  const player = window.document.getElementById("movie_player");
  window.__ytd.injectNoteButton();

  assert.equal(
    player.style.position,
    "relative",
    "the button has nothing to position itself against",
  );
});

/* ============================================================
   A MESSAGE NOBODY SENDS
   ============================================================ */

test("a message the product never sends puts nothing on the page", async () => {
  const page = await createPage();

  const answer = await page.ask({ action: "showNoteSavedFeedback" });

  assert.ok(answer, "the page did not answer at all");
  assert.notEqual(
    answer.success,
    true,
    "the page answered a message nobody sends as if it were live",
  );
  assert.equal(
    page.document.getElementById("ytd-note-toast"),
    null,
    "the page put feedback on the screen for a message nobody sends",
  );
});

/* ============================================================
   A PAGE WITH NO VIDEO SAYS SO
   ============================================================ */

test("a page with no video does not report a moment", async () => {
  const page = await createPage();
  page.document
    .querySelector("video.html5-main-video")
    .remove();

  const answer = await page.ask({ action: "getCurrentTime" });

  assert.ok(answer, "the page did not answer at all");
  assert.equal(
    Number.isFinite(Number(answer.currentTime)),
    false,
    "the page reported a moment it does not have, and a note lands at it",
  );
});

test("a page with a video reports the moment it is at", async () => {
  const page = await createPage();

  const answer = await page.ask({ action: "getCurrentTime" });

  assert.equal(answer.currentTime, 42);
});

/* ============================================================
   THE EMBEDDED PLAYER SAYS WHERE THE EXTENSION WORKS
   ============================================================ */

test("the embedded player says where the extension works", async () => {
  const page = await createPage({
    url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  });

  const toast = page.document.getElementById("ytd-embed-hint");
  assert.ok(toast, "the embedded player says nothing about the extension");
  assert.match(
    toast.textContent,
    /YouTube Digest/,
    "the hint does not say what the extension is",
  );
  assert.match(
    toast.textContent,
    /video/i,
    "the hint does not say where the extension works",
  );
});

test("the embedded player does not put a note button on a player that cannot answer", async () => {
  const page = await createPage({
    url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  });

  assert.equal(
    page.document.getElementById("ytd-note-button"),
    null,
    "the button is on a page that cannot save a note",
  );
});

/* ============================================================
   THE PAGE AND THE PANEL SAY THE SAME THING
   ============================================================ */

/**
 * Reads the copy table of a file.
 *
 * @param {string} file the file to read
 * @returns {{en: Object, zh: Object}} the wording of both languages
 */
function copyTable(file) {
  const source = read(file);
  const table = source.match(/const PANEL_COPY = \{[\s\S]*?\n\};/);
  assert.ok(table, `${file} needs a copy table`);
  const [english, chinese] = table[0].split('"zh-CN":');
  const entries = (block) => {
    const found = {};
    for (const [, key, value] of block.matchAll(
      /^\s{4}([A-Za-z0-9]+):\s*"((?:[^"\\]|\\.)*)"/gm,
    )) {
      found[key] = value;
    }
    return found;
  };
  return { en: entries(english), zh: entries(chinese || "") };
}

test("the page and the panel say the same thing about the same thing", () => {
  const page = copyTable("content.js");
  const panel = copyTable("sidepanel.js");

  for (const language of ["en", "zh"]) {
    for (const [key, wording] of Object.entries(page[language])) {
      if (!(key in panel[language])) continue;
      assert.equal(
        panel[language][key],
        wording,
        `the page and the panel say different things about "${key}"`,
      );
    }
  }
});
