const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  createHarness,
  createActionRow,
} = require("./helpers/content-harness.js");

const tokens = require("../tokens.js");

/* ============================================================
   THE INJECTED UI IS PAINTED FROM THE SHARED TOKENS
   ============================================================ */

test("the injected UI is styled by a stylesheet the document adopts", () => {
  const harness = createHarness();
  const css = harness.stylesheet();

  assert.ok(css.length > 0, "the content script must hand the page a stylesheet");
  assert.equal(
    harness.context.document.adoptedStyleSheets.length,
    1,
    "the stylesheet must be adopted by the document",
  );
  assert.equal(
    harness.context.document.head.children.length,
    0,
    "no <style> element may be added to the page",
  );
});

test("the stylesheet paints the controls with the shared tokens", () => {
  const css = createHarness().stylesheet();

  assert.match(
    css,
    /#ytd-digest-button \{[^}]*background: var\(--yd-accent-solid\)/,
  );
  assert.match(css, /#ytd-digest-button \{[^}]*color: var\(--yd-on-accent\)/);
  assert.match(css, /#ytd-digest-button \{[^}]*border-radius: var\(--yd-r-lg\)/);
  assert.match(css, /font-family: var\(--yd-font-sans\)/);
  assert.match(css, /#ytd-note-button \{[^}]*border-radius: var\(--yd-r-pill\)/);
  assert.match(css, /#ytd-note-button \{[^}]*box-shadow: var\(--yd-shadow-accent\)/);

  /* The tokens themselves, not a copy of them. */
  assert.ok(css.includes(tokens.light["--accent-solid"]));
  assert.ok(css.includes(tokens.light["--focus-ring"]));
  assert.ok(css.includes(tokens.light["--font-sans"]));
});

test("the stylesheet carries both themes", () => {
  const css = createHarness().stylesheet();

  assert.match(css, /\.ytd-ui \{/);
  assert.match(css, /\.ytd-ui\[data-theme="dark"\] \{/);

  const darkBlock = css.slice(css.indexOf('.ytd-ui[data-theme="dark"]'));
  assert.ok(
    darkBlock.includes(tokens.dark["--accent-solid"]),
    "the dark theme must use the dark accent",
  );
  assert.ok(
    darkBlock.includes(tokens.dark["--on-accent"]),
    "the dark theme must use the dark ink",
  );
});

test("every injected control has a visible focus ring", () => {
  const css = createHarness().stylesheet();

  for (const selector of [
    "#ytd-digest-button",
    "#ytd-note-button",
    ".ytd-toast-link",
  ]) {
    assert.match(
      css,
      new RegExp(
        `${selector.replace(/\./g, "\\.")}:focus-visible \\{[^}]*outline: 2px solid var\\(--yd-focus-ring\\)`,
      ),
      `${selector} must show a focus ring`,
    );
  }
});

test("the controls are big enough to hit", () => {
  const harness = createHarness();
  const { row } = createActionRow({ width: 500, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();

  const button = harness.elements.find(
    (element) => element.id === "ytd-digest-button",
  );

  /* WCAG 2.2 SC 2.5.8 asks for 24x24 CSS pixels at the very least. */
  assert.match(button.style.cssText, /height: 36px/);
  assert.match(createHarness().stylesheet(), /\.ytd-toast-link \{[^}]*min-height: 24px/);
});

test("the Digest button keeps its geometry inline and no colour", () => {
  const harness = createHarness();
  const { row } = createActionRow({ width: 500, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();

  const button = harness.elements.find(
    (element) => element.id === "ytd-digest-button",
  );
  const cssText = button.style.cssText;

  /* The page must not be able to resize it... */
  assert.match(cssText, /flex:\s*0 0 auto/);
  assert.match(cssText, /width:\s*max-content/);
  /* ...but it must not carry the design either: the stylesheet owns that. */
  assert.doesNotMatch(cssText, /background|color|font-family|font-size/);
  assert.doesNotMatch(cssText, /border-radius|box-shadow/);
});

/* ============================================================
   THE HIDDEN NOTE BUTTON MUST NOT BE A LANDMINE
   ============================================================ */

function noteButtonHarness(options = {}) {
  const harness = createHarness({ withPlayer: true, ...options });
  harness.context.injectNoteButton();
  const button = harness.elements.find(
    (element) => element.id === "ytd-note-button",
  );
  return { harness, button };
}

test("the hidden note button is out of the tab order and out of sight", () => {
  const { button } = noteButtonHarness();

  assert.equal(button.getAttribute("aria-hidden"), "true");
  assert.equal(button.getAttribute("tabindex"), "-1");
  assert.equal(button.getAttribute("data-hidden"), "true");
});

test("the note button comes back when the pointer brings it out", () => {
  const { harness, button } = noteButtonHarness();

  harness.context.showNoteButton();

  assert.equal(button.getAttribute("aria-hidden"), null);
  assert.equal(button.getAttribute("tabindex"), null);
  assert.equal(button.getAttribute("data-hidden"), "false");
});

test("the note button says what it is doing", () => {
  const { harness, button } = noteButtonHarness();
  const label = button.children.find(
    (child) => child.className === "ytd-note-label",
  );

  assert.equal(label.textContent, "Note");

  harness.context.setNoteButtonState("saved", "Saved");
  assert.equal(label.textContent, "Saved");
  assert.equal(button.getAttribute("data-state"), "saved");
});

/* ============================================================
   THE VIDEO ID, WHATEVER SHAPE THE URL HAS
   ============================================================ */

test("the video id is found in every shape YouTube serves a video", () => {
  const { extractVideoId } = createHarness().context;

  const shapes = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ];

  for (const [href, expected] of shapes) {
    assert.equal(
      extractVideoId({ href }),
      expected,
      `${href} should yield ${expected}`,
    );
  }
});

test("a page without a video has no video id", () => {
  const { extractVideoId } = createHarness().context;

  for (const href of [
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch?v=not a video id",
  ]) {
    assert.equal(extractVideoId({ href }), null, `${href} has no video id`);
  }
});

test("a note is saved against the video the page is showing", async () => {
  const sent = [];
  const { harness } = noteButtonHarness({
    location: { href: "https://youtu.be/dQw4w9WgXcQ", pathname: "/watch" },
    sendMessage: async (message) => {
      sent.push(message);
      return {
        success: true,
        note: {
          text: "A note",
          timestamp: "0:39",
          videoTitle: "A video",
          timestampedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=39s",
        },
      };
    },
  });

  await harness.context.saveCurrentNote();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "saveNote");
  assert.equal(sent[0].videoId, "dQw4w9WgXcQ");
  assert.equal(sent[0].timestamp, 39);
});

test("a note on a page with no video id is reported, not swallowed", async () => {
  const sent = [];
  const { harness } = noteButtonHarness({
    location: { href: "https://www.youtube.com/watch", pathname: "/watch" },
    sendMessage: async (message) => {
      sent.push(message);
      return { success: true };
    },
  });

  await harness.context.saveCurrentNote();

  assert.equal(sent.length, 0, "nothing may be saved without a video id");

  const toast = harness.elements.find(
    (element) => element.id === "ytd-toast" && element.isConnected,
  );
  assert.ok(toast, "the failure must be visible on the page");
  assert.match(toast.innerHTML, /Could not save the note/);
});

test("a failed save is reported on the page", async () => {
  const { harness, button } = noteButtonHarness({
    sendMessage: async () => ({ success: false, error: "Storage is full." }),
  });

  await harness.context.saveCurrentNote();

  const toast = harness.elements.find(
    (element) => element.id === "ytd-toast" && element.isConnected,
  );
  assert.ok(toast, "the failure must be visible on the page");
  assert.match(toast.innerHTML, /Could not save the note/);
  assert.equal(button.getAttribute("data-state"), "error");
});

/* ============================================================
   THE CONTROLS FOLLOW THE PAGE, NOT THE SYSTEM
   ============================================================ */

function digestButtonIn(harness) {
  const { row } = createActionRow({ width: 500, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();
  return harness.elements.find((element) => element.id === "ytd-digest-button");
}

test("a light page gets the light controls", () => {
  const harness = createHarness();
  harness.context.watchPageTheme();

  assert.equal(digestButtonIn(harness).getAttribute("data-theme"), "light");
});

test("a dark page gets the dark controls", () => {
  const harness = createHarness({ pageBackground: "rgb(15, 15, 15)" });
  harness.context.watchPageTheme();

  assert.equal(digestButtonIn(harness).getAttribute("data-theme"), "dark");
});

test("the controls repaint when the page changes theme", () => {
  const harness = createHarness();
  harness.context.watchPageTheme();
  const button = digestButtonIn(harness);

  harness.setPageBackground("rgb(15, 15, 15)");
  harness.observers[0].callback([]);

  assert.equal(button.getAttribute("data-theme"), "dark");
});

test("a page that paints its app dark gets the dark controls", () => {
  const harness = createHarness({ appBackground: "rgb(15, 15, 15)" });
  harness.context.watchPageTheme();

  assert.equal(digestButtonIn(harness).getAttribute("data-theme"), "dark");
});

test("a page that says it is dark gets the dark controls", () => {
  const harness = createHarness();
  harness.context.document.documentElement.setAttribute("dark-theme", "true");
  harness.context.watchPageTheme();

  assert.equal(digestButtonIn(harness).getAttribute("data-theme"), "dark");
});

test("the controls follow YouTube's dark marker when it appears", () => {
  const harness = createHarness();
  harness.context.watchPageTheme();
  const button = digestButtonIn(harness);

  assert.equal(button.getAttribute("data-theme"), "light");

  /* YouTube switches its appearance by marking the document element. */
  harness.context.document.documentElement.setAttribute("dark-theme", "true");
  harness.observers[0].callback([]);

  assert.equal(button.getAttribute("data-theme"), "dark");
});

test("the page watcher keeps an eye on the attribute YouTube uses", () => {
  const harness = createHarness();
  harness.context.watchPageTheme();

  assert.ok(harness.observers[0].options, "the observer must say what it watches");
  assert.ok(
    harness.observers[0].options.attributeFilter.includes("dark-theme"),
    "the observer must notice YouTube's dark marker",
  );
});

/* ============================================================
   THE CONTROLS SPEAK THE USER'S LANGUAGE
   ============================================================ */

test("the Digest button speaks the language the user picked", async () => {
  const harness = createHarness({ language: "zh-CN" });
  await harness.context.loadPanelLanguage();

  const button = digestButtonIn(harness);

  assert.equal(button.children[0].textContent, "摘要");
  assert.equal(button.getAttribute("aria-label"), "打开 YouTube Digest 摘要面板");
});

test("the Note button speaks the language the user picked", async () => {
  const harness = createHarness({ language: "zh-CN", withPlayer: true });
  await harness.context.loadPanelLanguage();
  harness.context.injectNoteButton();

  const button = harness.elements.find(
    (element) => element.id === "ytd-note-button",
  );
  const label = button.children.find(
    (child) => child.className === "ytd-note-label",
  );

  assert.equal(label.textContent, "笔记");
});

test("a language change reaches the buttons without re-injecting them", async () => {
  const harness = createHarness({ language: "en" });
  await harness.context.loadPanelLanguage();
  const button = digestButtonIn(harness);

  assert.equal(button.children[0].textContent, "Digest");

  /* The background pushes the new language to the page. */
  harness.setLanguage("zh-CN");
  assert.equal(button.children[0].textContent, "摘要");
  assert.equal(button.getAttribute("aria-label"), "打开 YouTube Digest 摘要面板");

  harness.setLanguage("en");
  assert.equal(button.children[0].textContent, "Digest");
});

test("the content script asks the background for the language", async () => {
  const sent = [];
  const harness = createHarness({
    language: "zh-CN",
    sendMessage: async (message) => {
      sent.push(message);
      return { success: true, language: "zh-CN" };
    },
  });

  await harness.context.loadPanelLanguage();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "getUiLanguage");
});

test("the controls still speak English when the background cannot answer", async () => {
  const harness = createHarness({
    sendMessage: async () => {
      throw new Error("Could not establish connection.");
    },
  });

  await harness.context.loadPanelLanguage();

  const button = digestButtonIn(harness);
  assert.equal(button.children[0].textContent, "Digest");
});

test("a language the product does not ship falls back to English", () => {
  const { normalizePanelLanguage } = createHarness().context;

  assert.equal(normalizePanelLanguage("zh-CN"), "zh-CN");
  assert.equal(normalizePanelLanguage("en"), "en");
  assert.equal(normalizePanelLanguage("zh"), "en");
  assert.equal(normalizePanelLanguage("fr"), "en");
  assert.equal(normalizePanelLanguage(undefined), "en");
  assert.equal(normalizePanelLanguage(null), "en");
  assert.equal(normalizePanelLanguage(""), "en");
});

test("a key a language is missing falls back to English", () => {
  const { copyFor } = createHarness().context;
  const table = {
    en: { digest: "Digest", note: "Note" },
    "zh-CN": { digest: "摘要" },
  };

  const chinese = copyFor("zh-CN", table);
  assert.equal(chinese.digest, "摘要");
  assert.equal(chinese.note, "Note", "a missing key falls back to English");

  const unsupported = copyFor("zh", table);
  assert.equal(unsupported.digest, "Digest");
  assert.equal(unsupported.note, "Note");

  const english = copyFor("en", table);
  assert.equal(english.digest, "Digest");
  assert.equal(english.note, "Note");
});

test("the toast speaks the language the user picked", async () => {
  const harness = createHarness({
    language: "zh-CN",
    withPlayer: true,
    location: { href: "https://www.youtube.com/watch", pathname: "/watch" },
  });
  await harness.context.loadPanelLanguage();
  harness.context.injectNoteButton();

  await harness.context.saveCurrentNote();

  const toast = harness.elements.find(
    (element) => element.id === "ytd-toast" && element.isConnected,
  );
  assert.ok(toast, "the failure must be visible on the page");
  assert.match(toast.innerHTML, /没能保存笔记/);
});

/* ============================================================
   THE INJECTED SURFACES MUST BE READABLE
   ============================================================ */

const parseColor = (value) => {
  const text = value.trim();
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((char) => char + char)
            .join("")
        : hex;
    return {
      rgb: [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16)),
      alpha: 1,
    };
  }
  const match = text.match(/rgba?\(([^)]+)\)/i);
  if (!match) throw new Error(`unsupported colour: ${text}`);
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
};

const composite = (color, background) =>
  color.rgb.map((channel, index) =>
    Math.round(color.alpha * channel + (1 - color.alpha) * background.rgb[index]),
  );

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (first, second) => {
  const a = luminance(first);
  const b = luminance(second);
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
};

const on = (theme, foreground, backdrop) => {
  const fg = parseColor(tokens[theme][foreground]);
  const bg = parseColor(tokens[theme][backdrop]);
  const base = parseColor(tokens[theme]["--surface"]);
  const paintedBg = bg.alpha < 1 ? composite(bg, base) : bg.rgb;
  const paintedFg = fg.alpha < 1 ? composite(fg, { rgb: paintedBg }) : fg.rgb;
  return contrast(paintedFg, paintedBg);
};

const pairs = [
  /* [foreground, backdrop, minimum, what it is] */
  ["--on-accent", "--accent-solid", 4.5, "the label on the Digest button"],
  ["--on-accent", "--accent-hover", 4.5, "the label on the hovered button"],
  ["--on-accent", "--sage", 4.5, "the label on the saved note button"],
  ["--on-accent", "--danger", 4.5, "the label on the failed note button"],
  ["--accent", "--surface", 4.5, "the title on a toast"],
  ["--text", "--surface", 4.5, "the body of a toast"],
  ["--text-secondary", "--surface", 4.5, "the subtitle of a toast"],
  ["--accent", "--accent-dim", 4.5, "the copy link on its own wash"],
  ["--accent-solid", "--surface", 3, "the edge of the Digest button"],
  ["--border-strong", "--surface", 3, "the edge of the copy link"],
  ["--focus-ring", "--surface", 3, "the focus ring on a toast"],
];

for (const theme of ["light", "dark"]) {
  test(`the injected ${theme} surfaces clear WCAG AA`, () => {
    for (const [foreground, backdrop, minimum, description] of pairs) {
      const ratio = on(theme, foreground, backdrop);
      assert.ok(
        ratio >= minimum,
        `${theme}: ${description} measures ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      );
    }
  });
}
