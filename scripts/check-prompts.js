#!/usr/bin/env node
/**
 * Validates the prompt files the way the service worker reads them.
 *
 * `background.js` parses a prompt file with `loadPromptSection()`: it looks
 * for `## <heading>`, takes the text up to the next `## ` heading and expects
 * a fenced code block inside it. A file whose fence is missing or malformed
 * throws "Prompt section not found: <file>#<section>" at runtime, which takes
 * the whole feature down with it. The release gate used to accept such a
 * file, so a broken prompt shipped unnoticed.
 *
 * This module is the release gate's copy of that parser.
 * `tests/prompt-fences.test.js` drives the real `loadPromptSection()` and
 * compares it with `parsePromptSection()` here, so the two cannot drift.
 *
 * The gate also reads the names the other way round. The worker asks for a
 * section by name, and some of those names are chosen while it runs, so a
 * file and the code could drift apart without any call showing it. A
 * section the code does not name is a section the code cannot read, and
 * the name the code does use is missing from the file: the feature breaks
 * in the browser and the gate says nothing. So every section of a prompt
 * file has to be named by the code.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Sections that document the placeholders or the output of a prompt file
 * instead of holding a prompt. They are the only sections allowed to have
 * no fence, and the only ones the code is not expected to ask for.
 */
const PROMPT_DOCUMENTATION_SECTIONS = new Set(["Variables", "Output format"]);

/**
 * Reads one section of a prompt file, exactly like the runtime does.
 *
 * @param {string} markdown the whole prompt file.
 * @param {string} heading the `## ` heading of the wanted section.
 * @param {string} [fileName] used in the error message.
 * @returns {string} the text inside the section's code fence.
 */
function parsePromptSection(markdown, heading, fileName = "prompt") {
  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  return fenceMatch[1];
}

/**
 * Every `## ` section of a prompt file, with the text it holds.
 *
 * @param {string} markdown the whole prompt file.
 * @returns {{heading: string, body: string}[]}
 */
function listPromptSections(markdown) {
  const sections = [];
  const pattern = /^## (.+)$/gm;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const heading = match[1].trim();
    const bodyStart = match.index + match[0].length;
    const nextSection = markdown.indexOf("\n## ", bodyStart);
    sections.push({
      heading,
      body: markdown.slice(
        bodyStart,
        nextSection === -1 ? markdown.length : nextSection,
      ),
    });
  }
  return sections;
}

/**
 * The prompt sections the production code asks for.
 *
 * The scan mirrors the call sites: `loadPromptSection("<file>", "<heading>")`.
 * A heading that is computed at runtime (the translation prompts pick one of
 * two sections) is not listed here, so the per-file check covers it: a
 * section the code does not name is a section the code cannot read.
 *
 * @param {string} source the JavaScript that loads the prompts.
 * @returns {{file: string, heading: string}[]}
 */
function collectRequiredSections(source) {
  const required = [];
  const pattern = /\bloadPromptSection\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    required.push({ file: match[1], heading: match[2] });
  }
  return required;
}

/**
 * Whether the production code names this prompt section.
 *
 * The worker asks for a section by its name. Some of the names are written
 * in the call, but the translation prompts pick theirs while they run, so
 * the code and the file can drift apart without the call ever showing it:
 * a renamed heading passed the gate and then threw "Prompt section not
 * found" in the browser on every translation.
 *
 * @param {{source: string}[]} sources the production code.
 * @param {string} heading the name of the section.
 * @returns {boolean} true when the code uses this name.
 */
function namesSection(sources, heading) {
  if (!Array.isArray(sources)) {
    // The check is the one thing that catches a renamed section, so it may
    // not be skipped by a caller that forgot to pass the code along.
    throw new Error("the prompt check needs the production code to compare the names with");
  }
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(["'])${escaped}\\1`);
  return sources.some((entry) => pattern.test(entry.source));
}

/**
 * Checks the prompt documents.
 *
 * Three rules:
 * 1. every section the production code asks for must exist and carry a
 *    parseable code fence;
 * 2. every other section of a prompt file must carry one too, unless it is
 *    a documentation section;
 * 3. every section that is not documentation must be named by the code.
 *    A section the code never names is a section the code cannot read, and
 *    the name the code does use is missing from the file.
 *
 * @param {{file: string, markdown: string}[]} documents the prompt files.
 * @param {{file: string, heading: string}[]} required the sections the code asks for.
 * @param {{file: string, source: string}[]} sources the production code.
 * @returns {string[]} the problems found, empty when the prompts are fine.
 */
function validatePromptDocuments(documents, required, sources) {
  const problems = [];
  const byFile = new Map(documents.map((doc) => [doc.file, doc]));

  for (const { file, heading } of required) {
    const document = byFile.get(file);
    if (!document) {
      problems.push(`the code asks for ${file}#${heading}, but ${file} is missing`);
      continue;
    }
    try {
      parsePromptSection(document.markdown, heading, file);
    } catch (error) {
      problems.push(error.message);
    }
  }

  for (const document of documents) {
    for (const section of listPromptSections(document.markdown)) {
      if (PROMPT_DOCUMENTATION_SECTIONS.has(section.heading)) continue;
      try {
        parsePromptSection(document.markdown, section.heading, document.file);
      } catch (error) {
        problems.push(
          `${document.file}#${section.heading} has no readable code fence`,
        );
      }
      if (!namesSection(sources, section.heading)) {
        problems.push(
          `${document.file}#${section.heading} is not the name the code asks for, ` +
            "so the code is looking for a section this file does not have",
        );
      }
    }
  }

  return problems;
}

/**
 * Reads the prompt files and the sources that load them from a checkout.
 *
 * @param {string} root the repository root.
 */
function readPromptProject(root) {
  const promptsDir = path.join(root, "prompts");
  const documents = fs
    .readdirSync(promptsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      file: name,
      markdown: fs.readFileSync(path.join(promptsDir, name), "utf8"),
    }));

  const sources = fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => ({
      file: name,
      source: fs.readFileSync(path.join(root, name), "utf8"),
    }));

  const required = sources.flatMap((entry) => collectRequiredSections(entry.source));
  return { documents, required, sources };
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex === -1
      ? path.resolve(__dirname, "..")
      : path.resolve(argv[rootIndex + 1] || ".");

  const { documents, required, sources } = readPromptProject(root);
  const problems = validatePromptDocuments(documents, required, sources);

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`Prompt check failed: ${problem}`);
    }
    process.exit(1);
  }

  console.error(
    `Prompt checks passed (${documents.length} files, ${required.length} required sections).`,
  );
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parsePromptSection,
  listPromptSections,
  collectRequiredSections,
  namesSection,
  validatePromptDocuments,
  readPromptProject,
  PROMPT_DOCUMENTATION_SECTIONS,
};
