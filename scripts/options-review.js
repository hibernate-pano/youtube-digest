/**
 * Opens the real settings page in a real browser and looks at it.
 *
 * The settings page is where the user goes first: it is where the API keys
 * are entered, and a user who cannot get through it never sees the product
 * at all. It was the one surface of the extension with no visual review, so
 * nobody had looked at it since it was written.
 *
 * Usage: node scripts/options-review.js [outputDir]
 *
 * This is a GATE, not a picture generator. It fails (non-zero exit) when:
 *
 *   - the page logs a console error or throws an uncaught exception;
 *   - the page does not finish loading its settings;
 *   - a heading or a form control the user needs is not on screen;
 *   - a button label wraps onto a second line at a width a user can drag
 *     the window to;
 *   - the page scrolls sideways.
 */

const fs = require("node:fs");
const path = require("node:path");
const { launchReviewBrowser } = require("./lib/review-browser.js");

const root = path.resolve(__dirname, "..");
const outDir = path.resolve(
  process.argv[2] || path.join(root, ".review-options"),
);

/** The widths the settings page has to survive. */
const LAYOUT_WIDTHS = [360, 480, 720, 1024];

/**
 * The chrome API the settings page uses.
 *
 * It is stringified into the page, so it must not close over anything
 * outside itself.
 */
function buildChromeStub(payload) {
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
      async clear() {
        for (const key of Object.keys(values)) delete values[key];
      },
    };
  };
  const local = area(payload.local);
  const session = area(payload.session);
  return {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async () => ({ success: true }),
      getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      getManifest: () => ({ version: "1.7.3" }),
    },
    storage: { local, session, onChanged: { addListener() {} } },
    tabs: { create: async () => ({ id: 1 }) },
    windows: { getCurrent: async () => ({ id: 1 }) },
    i18n: { getMessage: (key) => key },
  };
}

/**
 * What the user has to find on this page.
 *
 * Every one of these is a step between a new user and a working product.
 */
const REQUIRED = [
  { selector: "h1", name: "the page heading" },
  { selector: "#supadataApiKey", name: "the Supadata key field" },
  { selector: "#aiApiKey", name: "the AI key field" },
  { selector: "#settingsForm button[type=submit]", name: "the save button" },
  { selector: "#githubLoginBtn", name: "the GitHub sign-in button" },
];

/**
 * Reads the layout faults the user can see.
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
    if (!label || label.length > 40) continue;

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
    if (boxes.length > 1) {
      problems.push(
        `The button "${label}" is painted on ${boxes.length} lines; ` +
          `a button label belongs on one.`,
      );
    }
  }

  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) {
    problems.push(
      `The page scrolls sideways: ${root.scrollWidth}px of content in a ` +
        `${root.clientWidth}px window.`,
    );
  }
  return problems;
};

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launchReviewBrowser();
  const context = await browser.newContext({
    viewport: { width: 720, height: 1000 },
    deviceScaleFactor: 2,
  });

  await context.addInitScript(
    ({ buildSource, payload }) => {
      const build = new Function(`return (${buildSource});`)();
      window.chrome = build(payload);
    },
    {
      buildSource: buildChromeStub.toString(),
      payload: {
        local: {
          ytd_options_language: "en",
          ytd_settings: {
            provider: "deepseek",
            aiApiKey: "",
            supadataApiKey: "",
          },
        },
        session: {},
      },
    },
  );

  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) =>
    errors.push(String(error && error.stack ? error.stack : error)),
  );

  await page.goto(`file://${path.join(root, "options.html")}`);
  await page.waitForTimeout(700);

  const failures = [];

  await page.screenshot({
    path: path.join(outDir, "settings.png"),
    fullPage: true,
  });

  for (const item of REQUIRED) {
    const found = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    }, item.selector);
    if (!found) {
      failures.push(`The settings page is missing ${item.name} (${item.selector}).`);
    }
  }

  for (const width of LAYOUT_WIDTHS) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    const problems = await page.evaluate(READ_LAYOUT);
    for (const problem of problems) {
      failures.push(`At ${width}px: ${problem}`);
    }
  }
  await page.setViewportSize({ width: 720, height: 1000 });

  if (errors.length) {
    failures.push(
      `The settings page logged ${errors.length} console error(s) while loading:\n` +
        errors.map((error) => `    ${error}`).join("\n"),
    );
  }

  if (failures.length) {
    console.error("\nSETTINGS REVIEW FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(`\nScreenshot in ${outDir} (it shows the broken state).`);
    await browser.close();
    process.exit(1);
  }

  console.log("\nThe settings page loaded with no console error.");
  console.log(`Screenshot in ${outDir}`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
