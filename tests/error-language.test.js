const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { loadBackgroundHelpers } = require("./helpers/background-harness.js");
const { createPanel, workerRouter } = require("./helpers/panel-harness.js");

/* ============================================================
   The language of a failure.

   The panel is the layer that speaks the user's language. A sentence the
   provider wrote, or a sentence the worker wrote, is in the writer's
   language, and on a Chinese screen it is the one English line the user
   sees.

   So the worker sends a code and keeps the provider's words for the
   console, where the developer reads them, and the panel turns the code
   into a sentence of its own.
   ============================================================ */

test("a provider that fails leaves the worker with a code", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      const match = /\/prompts\/([^/?#]+)$/.exec(url);
      if (match) {
        const markdown = fs.readFileSync(
          path.join(root, "prompts", match[1]),
          "utf8",
        );
        return { ok: true, text: async () => markdown };
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({
          error: { message: "Internal Server Error: model overloaded" },
        }),
      };
    },
  });

  const result = await helpers.handleExtractVocabulary("a sentence");

  assert.equal(result.success, false);
  assert.equal(
    result.code,
    "AI_REQUEST_FAILED",
    "the failure left the worker without a code, so the panel has nothing " +
      "to turn into a sentence of the user's own",
  );
});

test("a provider that is busy leaves the worker with the busy code", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      const match = /\/prompts\/([^/?#]+)$/.exec(url);
      if (match) {
        const markdown = fs.readFileSync(
          path.join(root, "prompts", match[1]),
          "utf8",
        );
        return { ok: true, text: async () => markdown };
      }
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "Rate limit reached" } }),
      };
    },
  });

  const result = await helpers.handleExtractVocabulary("a sentence");

  assert.equal(result.success, false);
  assert.equal(
    result.code,
    "RATE_LIMITED",
    "a busy provider and a broken one are two different problems, and the " +
      "user can only be told apart if the worker says which one it was",
  );
});

test("a failed explanation shows the panel's sentence, not the provider's words", async () => {
  const panel = createPanel({
    sendMessageImpl: workerRouter({
      explainSelection: async () => ({
        success: false,
        error: "AI_REQUEST_FAILED",
        code: "AI_REQUEST_FAILED",
        message: "The provider said: Model Not Exist (HTTP 400).",
      }),
    }),
  });
  await panel.helpers.loadPanelLanguage();

  await panel.helpers.showExplanation("a sentence the reader picked");

  const modal = panel.el("explainModal");
  assert.ok(modal, "the explanation did not open");
  const text = modal.textContent || "";
  assert.doesNotMatch(
    text,
    /Model Not Exist/i,
    "the provider's own words reached the reader",
  );
  assert.doesNotMatch(
    text,
    /AI_REQUEST_FAILED/,
    "the code reached the reader instead of a sentence",
  );
  assert.match(
    text,
    /provider/i,
    "the panel does not say what went wrong",
  );
});

test("the code of a failure has a sentence in the reader's language", async () => {
  const english = createPanel({ sendMessageImpl: workerRouter() });
  const chinese = createPanel({
    sendMessageImpl: workerRouter(),
    language: "zh-CN",
  });
  await chinese.helpers.loadPanelLanguage();

  const englishText = english.helpers.panelFailureMessage({
    code: "AI_REQUEST_FAILED",
  });
  const chineseText = chinese.helpers.panelFailureMessage({
    code: "AI_REQUEST_FAILED",
  });

  assert.notEqual(englishText, "AI_REQUEST_FAILED", "the code reached the reader");
  assert.ok(englishText.trim().length > 10, "there is no English sentence");
  assert.ok(chineseText.trim().length > 4, "there is no Chinese sentence");
  assert.notEqual(
    chineseText,
    englishText,
    "the failure says the same thing in both languages",
  );
});
