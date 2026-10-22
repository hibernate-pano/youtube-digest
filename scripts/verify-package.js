#!/usr/bin/env node
/**
 * Proves that a ZIP holds the code in this repository, file for byte.
 *
 * Why this exists: the packaging script builds a ZIP from the release
 * allowlist, and the release gate checks the tree. Nothing checked the ZIP
 * on disk, so an old ZIP could sit in dist/ for a week while every gate
 * stayed green, and uploading it would send the store a build of code that
 * nobody had tested. The store's review would then be looking at a
 * product that does not exist.
 *
 * What it compares:
 *   - the list of files in the ZIP against the release allowlist;
 *   - the contents of every file in the ZIP against the file in the tree.
 *
 * Usage: node scripts/verify-package.js <zip> [more zips...]
 * Exits 1 when a ZIP is not this code, 0 when it is.
 */

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

/**
 * The files a release ZIP is allowed to hold.
 *
 * The list comes from the release gate itself, so there is one answer to
 * "what ships" and this script cannot drift away from it. It is read out of
 * the shell script rather than by running it, because the gate runs the
 * whole test suite and this script has to work while a release is being
 * put together and something else is still red.
 *
 * @returns {string[]} the paths, relative to the repository root.
 */
function releaseFiles() {
  const source = fs.readFileSync(
    path.join(root, "scripts", "check-release.sh"),
    "utf8",
  );
  const start = source.indexOf("public_allowlist=(");
  if (start === -1) {
    console.error("scripts/check-release.sh has no public_allowlist array.");
    process.exit(2);
  }
  const end = source.indexOf("\n)", start);
  const block = source.slice(start, end === -1 ? undefined : end);
  const names = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  // The gate ships an entry only when the file is there. A missing optional
  // file is not in the ZIP either, so it is not compared.
  return names.filter((name) => fs.existsSync(path.join(root, name)));
}

/**
 * The SHA-256 of a file in the tree.
 *
 * @param {string} file the path, relative to the repository root.
 * @returns {string} the digest.
 */
function digestOf(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, file)))
    .digest("hex");
}

/**
 * The SHA-256 of the bytes of a file inside a ZIP.
 *
 * `unzip -p` writes the bytes to stdout, so nothing is written to disk and
 * nothing has to be cleaned up.
 *
 * @param {string} zip the ZIP.
 * @param {string} file the path inside the ZIP.
 * @returns {string} the digest.
 */
function digestInZip(zip, file) {
  const bytes = execFileSync("unzip", ["-p", zip, file], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * The files inside a ZIP.
 *
 * @param {string} zip the ZIP.
 * @returns {string[]} the paths.
 */
function filesInZip(zip) {
  const output = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function main() {
  const zips = process.argv.slice(2);
  if (!zips.length) {
    console.error("Usage: node scripts/verify-package.js <zip>...");
    process.exit(2);
  }

  const expected = releaseFiles().sort();
  let failed = false;

  for (const zip of zips) {
    const file = path.resolve(zip);
    if (!fs.existsSync(file)) {
      console.error(`${zip} does not exist.`);
      failed = true;
      continue;
    }

    const present = filesInZip(file).sort();
    const missing = expected.filter((name) => !present.includes(name));
    const extra = present.filter((name) => !expected.includes(name));
    if (missing.length || extra.length) {
      console.error(`${zip} is not this release:`);
      for (const name of missing) console.error(`  missing: ${name}`);
      for (const name of extra) console.error(`  not in the release: ${name}`);
      failed = true;
      continue;
    }

    const different = [];
    for (const name of expected) {
      if (digestInZip(file, name) !== digestOf(name)) different.push(name);
    }
    if (different.length) {
      console.error(`${zip} is not this code:`);
      for (const name of different) console.error(`  differs: ${name}`);
      failed = true;
      continue;
    }

    const bytes = fs.readFileSync(file);
    const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
    console.log(`${path.basename(file)}  ${expected.length} files  SHA-256 ${checksum}`);
  }

  if (failed) {
    console.error(
      "Build the package again with `npm run package`; the ZIP has to come " +
        "from the code that is in the repository now.",
    );
    process.exit(1);
  }
}

main();
