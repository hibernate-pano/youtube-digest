const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadBackgroundHelpers } = require("./helpers/background-harness.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* ============================================================
   The prompt the model receives.

   A prompt file holds placeholders: {videoTitle}, {langName} and the
   rest. The worker fills them in before it sends anything. If it did
   not, the model would be asked about a video called "{videoTitle}",
   and it would answer about nothing at all - and every test in the
   repository stayed green, because none of them looked at the request
   that leaves the extension.

   These tests look at the request. They drive the real worker with the
   real prompt files and read what the model is asked.
   ============================================================ */

/**
 * The placeholders a prompt file documents.
 *
 * The list comes from the file, so a prompt that grows a placeholder
 * grows this check with it.
 */
function documentedPlaceholders(file) {
  const markdown = read(path.join("prompts", file));
  const variables = markdown.slice(markdown.indexOf("## Variables"));
  return [...variables.matchAll(/`\{(\w+)\}`/g)].map((match) => match[1]);
}

/**
 * A fetch that serves the prompt files from disk and records what was sent
 * to the model.
 */
function createModelFetch(answer) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const address = String(url);
    const prompt = /\/prompts\/([^/?#]+)$/.exec(address);
    if (prompt) {
      return {
        ok: true,
        text: async () => read(path.join("prompts", prompt[1])),
      };
    }
    requests.push({ url: address, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: answer } }] }),
    };
  };
  return { requests, fetchImpl };
}

/** Sends a message to the worker and waits for its answer. */
function sendMessage(helpers, message) {
  const [listener] = helpers.messageListeners;
  assert.ok(listener, "the worker must listen for messages");
  return new Promise((resolve) => {
    listener(message, {}, resolve);
  });
}

test("the analysis prompt has the video's own words, not the placeholders", async () => {
  const { requests, fetchImpl } = createModelFetch(
    JSON.stringify({
      summary: "A video about bread.",
      chapters: [{ title: "The first chapter", timestampSeconds: 0 }],
      keyQuotes: [],
    }),
  );
  const helpers = loadBackgroundHelpers({ fetchImpl });

  const response = await sendMessage(helpers, {
    action: "analyzeTranscript",
    transcriptText: "[0:00] The first line of the talk.\n[0:30] The second line.",
    videoTitle: "How to bake bread",
    channelName: "A Baker",
    videoDescription: "A video about bread.",
    videoDuration: 120,
  });

  assert.ok(response.success, JSON.stringify(response));
  assert.equal(requests.length, 1, "the model must be asked exactly once");

  const prompt = requests[0].body.messages
    .map((message) => message.content)
    .join("\n");
  assert.match(
    prompt,
    /Video title: How to bake bread/,
    "the model must be told which video it is looking at",
  );
  assert.match(
    prompt,
    /The first line of the talk\./,
    "the model must be given the transcript",
  );
  for (const placeholder of documentedPlaceholders("analysis.md")) {
    assert.doesNotMatch(
      prompt,
      new RegExp(`\\{${placeholder}\\}`),
      `the prompt still carries {${placeholder}}`,
    );
  }
});

test("the transcript prompt has the language and the title filled in", async () => {
  const { requests, fetchImpl } = createModelFetch(
    JSON.stringify({
      segments: [{ id: "seg-1", text: "这是翻译之后的中文句子。" }],
    }),
  );
  const helpers = loadBackgroundHelpers({ fetchImpl });

  const result = await helpers.handleTranslateContent(
    {
      segments: [
        {
          id: "seg-1",
          text: "This is the English sentence that has to be translated.",
        },
      ],
    },
    "transcriptBatch",
    "zh",
    "How to bake bread",
  );

  assert.ok(result.success, JSON.stringify(result));
  const prompt = requests[0].body.messages
    .map((message) => message.content)
    .join("\n");
  assert.match(
    prompt,
    /Simplified Chinese/,
    "the model must be told which language to write in",
  );
  assert.match(
    prompt,
    /How to bake bread/,
    "the model must be told which video the words come from",
  );
  for (const placeholder of documentedPlaceholders("translation.md")) {
    assert.doesNotMatch(
      prompt,
      new RegExp(`\\{${placeholder}\\}`),
      `the prompt still carries {${placeholder}}`,
    );
  }
});

test("the interface prompt is the section of its own, and it is filled in too", async () => {
  // The worker does not name the section in the call: it picks one of the
  // two while it runs. A section that was renamed in the file is a section
  // the worker cannot read, and the translation fails in the browser with
  // "Prompt section not found".
  const { requests, fetchImpl } = createModelFetch(
    JSON.stringify({
      segments: [{ id: "seg-1", text: "这是翻译之后的中文句子。" }],
    }),
  );
  const helpers = loadBackgroundHelpers({ fetchImpl });

  const result = await helpers.handleTranslateContent(
    {
      segments: [
        {
          id: "seg-1",
          text: "This is the English sentence that has to be translated.",
        },
      ],
    },
    "interfaceBatch",
    "zh",
    "How to bake bread",
  );

  assert.ok(result.success, JSON.stringify(result));
  const prompt = requests[0].body.messages
    .map((message) => message.content)
    .join("\n");
  assert.match(
    prompt,
    /The related video is titled "How to bake bread"/,
    "the interface prompt is a different section of the same file",
  );
  for (const placeholder of documentedPlaceholders("translation.md")) {
    assert.doesNotMatch(
      prompt,
      new RegExp(`\\{${placeholder}\\}`),
      `the prompt still carries {${placeholder}}`,
    );
  }
});
