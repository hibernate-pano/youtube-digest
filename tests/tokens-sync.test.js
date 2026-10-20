const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const tokens = require("../tokens.js");

/* ---------- parsing tokens.css ---------- */

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
  const parsed = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    parsed[match[1]] = match[2].trim();
  }
  return parsed;
};

/* A token that is only an alias in the stylesheet resolves to the value it
   points at, so the mirror can hold a value a caller can use directly. */
const resolveAlias = (theme, name, seen = new Set()) => {
  const value = theme[name];
  if (value === undefined) return undefined;
  const match = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
  if (!match || seen.has(match[1])) return value;
  seen.add(match[1]);
  return resolveAlias(theme, match[1], seen);
};

const tokenSource = read("tokens.css");
const darkStart = tokenSource.indexOf("@media (prefers-color-scheme: dark)");
assert.notEqual(darkStart, -1, "tokens.css must define a dark theme");

const declared = {
  light: parseTokens(rootBody(tokenSource.slice(0, darkStart))),
  dark: parseTokens(rootBody(tokenSource.slice(darkStart))),
};

/* The value a token really has in a theme. The dark theme only overrides
   part of the scale; the rest cascades from the light theme, exactly as the
   browser resolves it. */
const effective = {};
for (const theme of ["light", "dark"]) {
  const resolved = {};
  for (const name of Object.keys(declared[theme])) {
    resolved[name] = resolveAlias(declared[theme], name);
  }
  if (theme === "dark") {
    for (const name of Object.keys(declared.light)) {
      if (resolved[name] === undefined) {
        resolved[name] = resolveAlias(declared.light, name);
      }
    }
  }
  effective[theme] = resolved;
}

/* The stylesheet may wrap a long value over several lines. That is the same
   value, so the comparison ignores the difference in whitespace. */
const normalise = (value) => value.replace(/\s+/g, " ").trim();

/* ============================================================
   THE MIRROR MUST NOT DRIFT FROM THE STYLESHEET
   ============================================================ */

for (const theme of ["light", "dark"]) {
  test(`the ${theme} mirror holds exactly the tokens the stylesheet defines`, () => {
    assert.deepEqual(
      Object.keys(tokens[theme]).sort(),
      Object.keys(effective[theme]).sort(),
      "tokens.js and tokens.css disagree about which tokens exist",
    );
  });

  test(`every mirrored ${theme} value is the value in the stylesheet`, () => {
    for (const [name, value] of Object.entries(tokens[theme])) {
      assert.equal(
        normalise(value),
        normalise(effective[theme][name]),
        `${name} is "${value}" in tokens.js but "${effective[theme][name]}" in tokens.css`,
      );
    }
  });
}

test("the dark mirror is a dark theme and not a copy of the light one", () => {
  assert.notEqual(tokens.dark["--accent-solid"], tokens.light["--accent-solid"]);
  assert.notEqual(tokens.dark["--on-accent"], tokens.light["--on-accent"]);
  assert.notEqual(tokens.dark["--surface"], tokens.light["--surface"]);
});

test("the tokens the dark theme does not override keep their light value", () => {
  for (const name of ["--sp-3", "--r-lg", "--font-sans", "--fs-md"]) {
    assert.equal(
      tokens.dark[name],
      tokens.light[name],
      `${name} must cascade from the light theme`,
    );
  }
});

test("the functional border is mirrored in both themes", () => {
  assert.equal(tokens.light["--border-strong"], "#96886f");
  assert.equal(tokens.dark["--border-strong"], "#80756c");
});

/* ============================================================
   THE MIRROR MUST BE THE ONLY SOURCE OF PAINT
   ============================================================ */

test("the content script paints with tokens and with no colour of its own", () => {
  const source = read("content.js");
  const withoutUrls = source.replace(/url\([^)]*\)/g, "");

  assert.doesNotMatch(
    withoutUrls,
    /#[0-9a-fA-F]{3,8}\b/,
    "content.js hard-codes a colour; use a token",
  );
  assert.doesNotMatch(
    withoutUrls,
    /rgba?\(/,
    "content.js hard-codes a colour; use a token",
  );
});

test("the content script is loaded after the token table", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);

  assert.equal(
    scripts.indexOf("tokens.js") >= 0,
    true,
    "the manifest must load tokens.js",
  );
  assert.equal(
    scripts.indexOf("tokens.js") < scripts.indexOf("content.js"),
    true,
    "tokens.js must be loaded before content.js",
  );
});

test("the token table is released with the extension", () => {
  const release = read("scripts/check-release.sh");

  assert.match(
    release,
    /public_allowlist=\([\s\S]*?"tokens\.js"/,
    "tokens.js must be on the release allowlist, or a packaged install breaks",
  );
  assert.match(
    release,
    /required_public_files=\([\s\S]*?"tokens\.js"/,
    "tokens.js must be a required public file",
  );
});
