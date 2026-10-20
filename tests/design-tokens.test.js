const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* Every file that can reach a user's eye: the two extension pages, the
   injected YouTube UI, the shared stylesheets and the web dashboard. */
const productUiFiles = [
  "sidepanel.html",
  "sidepanel.js",
  "sidepanel.css",
  "content.js",
  "options.html",
  "options.js",
  "options.css",
  "tokens.css",
  "server/dashboard/index.html",
  "server/dashboard/app.js",
  "server/dashboard/style.css",
  "server/dashboard/privacy.html",
  "server/dashboard/tokens.css",
];

/* A pictograph is any emoji, plus the arrows and geometric marks that are
   usually typed as characters instead of drawn as icons. */
const PICTOGRAPH = /\p{Extended_Pictographic}|[✓✕⧉▶→←↑↓＋]/u;

/* An entity-encoded arrow is still an arrow once the browser renders it, so
   the markup is decoded before it is checked. */
const decodeEntities = (text) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    );

test("the whole product UI is free of emoji and character icons", () => {
  for (const file of productUiFiles) {
    const source = read(file);
    const rendered = file.endsWith(".html") ? decodeEntities(source) : source;
    const match = PICTOGRAPH.exec(rendered);
    assert.equal(
      match,
      null,
      `${file} contains a pictograph: ${match ? match[0] : ""}`,
    );
  }
});

/* ---------- colour maths ---------- */

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

/* The colour that is actually on screen once a translucent token is painted
   over its backdrop. */
const composite = (color, background) =>
  color.rgb.map((channel, index) =>
    Math.round(
      color.alpha * channel + (1 - color.alpha) * background.rgb[index],
    ),
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

/* ---------- token parsing ---------- */

const rootBody = (source) => {
  const start = source.indexOf(":root");
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return "";
};

const parseTokens = (body) => {
  const tokens = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
};

const tokenSource = read("tokens.css");
const darkStart = tokenSource.indexOf("@media (prefers-color-scheme: dark)");
assert.notEqual(darkStart, -1, "tokens.css must define a dark theme");

const themes = {
  light: parseTokens(rootBody(tokenSource.slice(0, darkStart))),
  dark: parseTokens(rootBody(tokenSource.slice(darkStart))),
};

const color = (theme, name) => parseColor(themes[theme][name]);

/* A translucent token is measured against the surface it is painted on: the
   wash is composited over a card first, then the text is measured against
   the result. */
const on = (theme, foreground, backdrop) => {
  const fg = color(theme, foreground);
  const bg = color(theme, backdrop);
  const base = color(theme, "--surface");
  const paintedBg = bg.alpha < 1 ? composite(bg, base) : bg.rgb;
  const paintedFg = fg.alpha < 1 ? composite(fg, { rgb: paintedBg }) : fg.rgb;
  return contrast(paintedFg, paintedBg);
};

const pairs = [
  /* [foreground, backdrop, minimum, what it is] */
  ["--text", "--bg", 4.5, "body text on the page background"],
  ["--text", "--surface", 4.5, "body text on a card"],
  ["--text-secondary", "--bg", 4.5, "secondary text on the page background"],
  ["--text-secondary", "--surface", 4.5, "secondary text on a card"],
  ["--text-secondary", "--surface-raised", 4.5, "secondary text on a raised card"],
  ["--text-muted", "--bg", 4.5, "muted text on the page background"],
  ["--text-muted", "--surface", 4.5, "muted text on a card"],
  ["--text-muted", "--surface-raised", 4.5, "muted text on a raised card"],
  ["--accent", "--bg", 4.5, "accent text on the page background"],
  ["--accent", "--surface", 4.5, "accent text on a card"],
  ["--accent", "--surface-raised", 4.5, "accent text on a raised card"],
  ["--on-accent", "--accent-solid", 4.5, "the label on a filled accent button"],
  ["--on-accent", "--accent-hover", 4.5, "the label on a hovered accent button"],
  ["--danger", "--surface", 4.5, "an error message on a card"],
  ["--text", "--highlight-soft", 4.5, "a matched word in the transcript"],
  ["--on-highlight", "--highlight", 4.5, "the current matched word"],
  ["--focus-ring", "--surface", 3, "the keyboard focus ring on a card"],
  ["--focus-ring", "--bg", 3, "the keyboard focus ring on the page background"],
  ["--star", "--surface", 3, "a starred note"],
];

for (const theme of ["light", "dark"]) {
  test(`the ${theme} theme clears WCAG AA on every measured pair`, () => {
    for (const [foreground, backdrop, minimum, description] of pairs) {
      const ratio = on(theme, foreground, backdrop);
      assert.ok(
        ratio >= minimum,
        `${theme}: ${description} measures ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      );
    }
  });

  test(`the ${theme} theme keeps text readable on tinted surfaces`, () => {
    for (const [foreground, tint, minimum, description] of [
      ["--text", "--accent-dim", 4.5, "body text on an accent wash"],
      ["--text-secondary", "--accent-dim", 4.5, "secondary text on an accent wash"],
      ["--accent", "--accent-dim", 4.5, "accent text on an accent wash"],
      ["--accent-hover", "--accent-dim", 4.5, "hovered accent text on an accent wash"],
      ["--sage", "--sage-dim", 4.5, "a tag on its own wash"],
      ["--danger", "--danger-dim", 4.5, "an error on its own wash"],
      ["--text-secondary", "--danger-dim", 4.5, "secondary text on an error wash"],
    ]) {
      const ratio = on(theme, foreground, tint);
      assert.ok(
        ratio >= minimum,
        `${theme}: ${description} measures ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      );
    }
  });
}

test("the dark theme does not put white text on the accent fill", () => {
  const white = parseColor("#ffffff");
  const fill = color("dark", "--accent-solid");
  assert.ok(
    contrast(white.rgb, fill.rgb) < 4.5,
    "white on the dark accent fill is readable, so --on-accent may be wrong",
  );
  assert.ok(
    contrast(color("dark", "--on-accent").rgb, fill.rgb) >= 4.5,
    "the dark ink on the dark accent fill must stay readable",
  );
});

/* ---------- one source of truth ---------- */

test("the dashboard serves a byte-identical copy of the shared tokens", () => {
  assert.equal(
    read("tokens.css"),
    read("server/dashboard/tokens.css"),
    "tokens.css and server/dashboard/tokens.css have diverged",
  );
});

test("every surface loads the shared tokens before its own stylesheet", () => {
  for (const [page, sheet] of [
    ["sidepanel.html", "sidepanel.css"],
    ["options.html", "options.css"],
    ["server/dashboard/index.html", "/style.css"],
    ["server/dashboard/privacy.html", "/style.css"],
  ]) {
    const source = read(page);
    const tokensAt = source.indexOf("tokens.css");
    const sheetAt = source.indexOf(sheet);
    assert.ok(tokensAt !== -1, `${page} does not load tokens.css`);
    assert.ok(sheetAt !== -1, `${page} does not load ${sheet}`);
    assert.ok(
      tokensAt < sheetAt,
      `${page} must load tokens.css before ${sheet}`,
    );
  }
});

test("the surface stylesheets hold no colour values of their own", () => {
  for (const file of [
    "sidepanel.css",
    "options.css",
    "server/dashboard/style.css",
  ]) {
    const source = read(file).replace(/url\([^)]*\)/g, "");
    const match = source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    assert.equal(
      match,
      null,
      `${file} hard-codes a colour (${match ? match[0] : ""}); use a token`,
    );
  }
});

test("the type scale has no half-pixel steps", () => {
  for (const theme of ["light", "dark"]) {
    for (const [name, value] of Object.entries(themes[theme])) {
      if (!name.startsWith("--fs-")) continue;
      assert.match(
        value,
        /^\d+px$/,
        `${name} is ${value}; every size must be a whole pixel`,
      );
    }
  }
});
