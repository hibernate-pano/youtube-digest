#!/usr/bin/env node
/**
 * Looks for credentials in the files that are about to be published.
 *
 * This used to be a heredoc inside scripts/check-release.sh, which made it
 * impossible to prove: a gate that cannot fail is not a gate. It is its own
 * program now, so a test can plant a secret in a scratch file and watch this
 * exit non-zero.
 *
 * What it looks for:
 *   - the key formats of the providers this product talks to;
 *   - a private key block;
 *   - an assignment whose NAME says it holds a secret, whether the value is
 *     quoted or not;
 *   - a connection string that carries a password.
 *
 * What it deliberately does NOT do: guess. A value is only reported when it
 * looks like a secret, so an example file full of `YOUR_KEY_HERE` does not
 * block a release. The cost of that choice is stated in SECURITY.md: the
 * scan is a net, not a guarantee.
 *
 * Usage: node scripts/scan-credentials.js <file>...
 * Exits 1 when something is found, 0 when nothing is.
 */

const fs = require("fs");

/** The byte that says "this file is not text". */
const NUL = String.fromCharCode(0);

/**
 * Files whose bytes are not text. Everything else is read, including files
 * with no extension at all: a secret in a file called `config` is still a
 * secret, and the old scan skipped every extension-less file.
 */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".zip",
  ".gz",
  ".pdf",
  ".mp4",
  ".webm",
  ".mov",
]);

/**
 * The names of things that hold a secret. The word after the name is what
 * makes the line suspicious; the value has to look like a secret too.
 *
 * The leading `(?:NAME_)*` matters: a secret is rarely called `secret`, it
 * is called `GITHUB_CLIENT_SECRET` or `SUPADATA_API_KEY`. Without the
 * prefix the rule missed every one of them, because the word boundary
 * between `GITHUB_` and `CLIENT` is not one.
 */
const SECRET_NAME =
  "(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|app[_-]?secret|webhook[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|private[_-]?key|encryption[_-]?key|signing[_-]?key|jwt[_-]?secret|session[_-]?secret|database[_-]?url|connection[_-]?string|passwd|password|pwd|secret|token)";

/**
 * Words that mean "this is not a real secret". A value that contains one of
 * these is an example, a template or a placeholder, and reporting it would
 * train people to ignore the scan.
 */
const PLACEHOLDER_MARKERS = [
  /example/i,
  /placeholder/i,
  /replace/i,
  /change[-_ ]?me/i,
  /redacted/i,
  /dummy/i,
  /sample/i,
  /\bfake\b/i,
  /x{4,}/i,
  /\byour\b/i,
  /\bhere\b/i,
  /\btodo\b/i,
  /lorem/i,
  /\.\.\./,
  /<[^>]*>/,
  // An all-caps brace is the placeholder style (`{{DATABASE_URL}}`), not a
  // secret. A brace with anything else in it is one.
  /\{\{[A-Z][A-Z0-9_]*\}\}/,
  // A value that says what it is ("somebody-elses-token", "not-a-real-key")
  // is a fixture, not a secret.
  /\b(?:token|secret|password|passwd|key|apikey|credential|credentials)\b/i,
];

/**
 * Values that are literally the word, not a secret wearing its shape.
 */
const PLACEHOLDER_VALUES = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "key",
  "apikey",
  "api_key",
  "none",
  "null",
  "nil",
  "undefined",
  "true",
  "false",
  "localhost",
  "user",
  "username",
  "test",
  "example",
  "changeme",
  "your_key_here",
]);

const patterns = [
  ["private key block", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["Supadata-style key", /\bsd_[A-Za-z0-9_-]{16,}\b/g],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "connection string with a password",
    /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:/@"'`<>]{1,64}:([^\s@/"'`<>]{12,128})@/gi,
  ],
];

/**
 * The assignment rule. The value may be quoted or bare: the old scan only
 * matched quoted values, so `DATABASE_URL=postgres://...` and `JWT_SECRET=...`
 * walked straight past it.
 */
const ASSIGNMENT = new RegExp(
  `\\b${SECRET_NAME}\\b\\s*[:=]\\s*(?:"([^"\\n]{8,})"|'([^'\\n]{8,})'|(\\{+[^{}\\n]{8,}\\}+)|([A-Za-z0-9+/=_-]{16,}))`,
  "gi",
);

/**
 * Is this value an example rather than a secret?
 *
 * @param {string} value the text after the name.
 * @returns {boolean} true when the value is a placeholder.
 */
function isPlaceholder(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (PLACEHOLDER_VALUES.has(text.toLowerCase())) return true;
  if (PLACEHOLDER_MARKERS.some((marker) => marker.test(text))) return true;
  // `0123456789abcdef0123456789abcdef` is one pattern written four times.
  // That is a fixture, not a key.
  for (let size = 1; size <= text.length / 2; size += 1) {
    if (text.length % size) continue;
    if (text.slice(0, size).repeat(text.length / size) === text) return true;
  }
  return false;
}

/**
 * Does this value look like a secret rather than a word?
 *
 * @param {string} value the text after the name.
 * @returns {boolean} true when the value is worth reporting.
 */
function looksLikeSecret(value) {
  const text = String(value || "").trim();
  if (text.length < 16) return false;
  // A sentence is not a secret, however long it is.
  if (/\s/.test(text)) return false;
  // A storage key name is not a secret: `ytd_github_session` is 18
  // characters long and means nothing to an attacker. The underscore is
  // what tells a name from a key: a lowercase hex string has none.
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(text)) return false;
  return !isPlaceholder(text);
}

/**
 * Is this file text we can read?
 *
 * @param {string} file the path.
 * @returns {boolean} true when the file should be read.
 */
function isTextFile(file) {
  const dot = file.lastIndexOf(".");
  const extension = dot > 0 ? file.slice(dot).toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(extension)) return false;
  return true;
}

/**
 * Scans one file and reports what it found.
 *
 * @param {string} file the path.
 * @returns {string[]} the findings, empty when the file is clean.
 */
function scanFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return [];
  }
  // A file with a NUL byte in it is not text, whatever it is called.
  if (text.includes(NUL)) return [];

  const findings = [];
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // The connection-string rule carries the password in group 1.
      const subject = label.startsWith("connection string")
        ? match[1]
        : match[0];
      if (label.startsWith("connection string")) {
        if (isPlaceholder(subject)) continue;
      }
      findings.push(label);
      break;
    }
  }

  ASSIGNMENT.lastIndex = 0;
  let assignment;
  while ((assignment = ASSIGNMENT.exec(text)) !== null) {
    const value =
      assignment[1] || assignment[2] || assignment[3] || assignment[4] || "";
    // `const secret = readSecret();` is code, not a secret. A value that
    // starts with a call is never a literal.
    const afterName = assignment[0].slice(
      assignment[0].search(/[:=]/) + 1,
    );
    if (/^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(afterName)) continue;
    if (!looksLikeSecret(value)) continue;
    findings.push("credential assignment");
    break;
  }

  return [...new Set(findings)];
}

module.exports = { scanFile, looksLikeSecret, isPlaceholder, isTextFile };

const files = process.argv.slice(2);
let found = false;
for (const file of files) {
  if (!isTextFile(file)) continue;
  for (const label of scanFile(file)) {
    console.error(`possible ${label} found in publishable repository file: ${file}`);
    found = true;
  }
}

if (found) process.exit(1);
