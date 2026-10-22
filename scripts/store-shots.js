#!/usr/bin/env node
/**
 * Builds the five Chrome Web Store screenshots from the current product.
 *
 * Why this exists: the listing showed a generation of the panel that had
 * already been replaced, two of the five pictures were a pasted panel over a
 * demo photograph and the other three were plain shots, and nothing
 * regenerated any of them. The listing and the product drifted apart while
 * every gate stayed green.
 *
 * The composite is faithful or it is not shipped:
 *   - the base is the demo photograph of a real YouTube watch page;
 *   - the panel is captured from the product as it is now, at the size the
 *     photograph already reserves for the panel, and pasted exactly there;
 *   - every shot uses the same video, because a listing that shows one video
 *     behind the panel in one picture and another in the next reads as two
 *     sessions glued together.
 *
 * The panel does not photograph itself. `scripts/panel-review.js --store`
 * writes the panel shots (one per tab, at the listing's size) and this
 * script composes them. Run that first.
 *
 *   node scripts/store-shots.js [--shots <dir>] [--out <dir>]
 *
 * Exits 1 when a shot is missing or the wrong size, because a listing built
 * from a half-written set is worse than no listing.
 */

const fs = require("node:fs");
const path = require("node:path");

const { launchReviewBrowser } = require("./lib/review-browser.js");

const root = path.resolve(__dirname, "..");

/** The size Chrome asks for. 1280x800 is the largest a listing accepts. */
const STORE_WIDTH = 1280;
const STORE_HEIGHT = 800;

/**
 * Where the panel sits inside the demo photograph.
 *
 * The photograph is 2660x1560 and the panel is the right 900 pixels of it:
 * measured, not guessed, by scanning the photograph for the column where the
 * page becomes the panel's own surface. A panel captured at 450 CSS pixels
 * with a 2x pixel ratio is 900 pixels wide and 1560 tall, so it drops into
 * that column without being resized. Resizing would blur the text, and
 * blurred text is the first thing a reviewer notices.
 */
const BASE_WIDTH = 2660;
const BASE_HEIGHT = 1560;
const PANEL_LEFT = 1760;
const PANEL_WIDTH = BASE_WIDTH - PANEL_LEFT;
const PANEL_HEIGHT = BASE_HEIGHT;

/**
 * The five shots the listing uses, in order.
 *
 * `shot` names the file `scripts/panel-review.js --store` writes, `base`
 * names the demo photograph, and `alt` says what the picture has to show so
 * a reader can judge whether the result is honest without opening it.
 */
const SHOTS = [
  {
    out: "01-summary.png",
    shot: "overview",
    base: "YouTube Digest demo.jpg",
    alt: "The summary tab: the AI summary, chapters, and key points",
  },
  {
    out: "02-bilingual.png",
    shot: "transcript-bilingual",
    base: "YouTube Digest demo bilingual.jpg",
    alt: "The transcript with each line above its Chinese translation",
  },
  {
    out: "03-notes.png",
    shot: "notes",
    base: "YouTube Digest demo.jpg",
    alt: "The notes tab with timestamped notes and the composer",
  },
  {
    out: "04-words.png",
    shot: "words",
    base: "YouTube Digest demo.jpg",
    alt: "The words tab with the review card and the saved words",
  },
  {
    out: "05-library.png",
    shot: "library",
    base: "YouTube Digest demo.jpg",
    alt: "The library of videos already read",
  },
];

/**
 * Reads the width and height out of a PNG header without decoding the image.
 *
 * @param {string|Buffer} file the path, or the bytes themselves.
 * @returns {{width: number, height: number} | null} the size, or null.
 */
function pngSize(file) {
  const buffer = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Turns a picture into a data URL.
 *
 * The images are embedded rather than linked because the composed page is
 * built with `setContent`, which has no directory to resolve a relative
 * path against, and a file URL is refused from an about:blank document.
 *
 * @param {string} file the path.
 * @returns {string} the data URL.
 */
function dataUrl(file) {
  const name = path.extname(file).toLowerCase();
  const type = name === ".jpg" || name === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
}

/**
 * The page that draws one screenshot.
 *
 * The photograph and the panel are laid out at their own size, then the
 * whole frame is scaled once by the browser, so the panel keeps its pixel
 * density and the result is not resampled twice.
 *
 * @param {{base: string, panel: string}} images data URLs.
 * @returns {string} the HTML.
 */
function composeHtml({ base, panel }) {
  const scale = STORE_WIDTH / BASE_WIDTH;
  // 2660x1560 is wider than 16:10, so the frame is centred and the page's
  // own white shows above and below. Padding is honest; stretching the
  // photograph is not.
  const top = Math.round((STORE_HEIGHT - BASE_HEIGHT * scale) / 2);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; overflow: hidden; }
  #frame {
    position: absolute; left: 0; top: ${top}px;
    width: ${BASE_WIDTH}px; height: ${BASE_HEIGHT}px;
    transform: scale(${scale}); transform-origin: top left;
  }
  #base { position: absolute; left: 0; top: 0;
          width: ${BASE_WIDTH}px; height: ${BASE_HEIGHT}px; }
  #panel { position: absolute; left: ${PANEL_LEFT}px; top: 0;
           width: ${PANEL_WIDTH}px; height: ${PANEL_HEIGHT}px; }
</style></head>
<body>
  <div id="frame">
    <img id="base" src="${base}" alt="">
    <img id="panel" src="${panel}" alt="">
  </div>
</body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const shotsDir = path.resolve(root, option("--shots", ".review-store"));
  const outDir = path.resolve(root, option("--out", "store"));

  const problems = [];
  for (const shot of SHOTS) {
    const file = path.join(shotsDir, `${shot.shot}.png`);
    if (!fs.existsSync(file)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const size = pngSize(file);
    if (!size || size.width !== PANEL_WIDTH || size.height !== PANEL_HEIGHT) {
      problems.push(
        `${file} is ${size ? `${size.width}x${size.height}` : "not a PNG"}; ` +
          `the listing reserves ${PANEL_WIDTH}x${PANEL_HEIGHT}`,
      );
    }
  }
  if (problems.length) {
    console.error("The store screenshots cannot be built yet:");
    for (const line of problems) console.error(`  ${line}`);
    console.error(
      "Run `node scripts/panel-review.js --store` first: it writes the panel " +
        "shots at the size the listing reserves.",
    );
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const check = args.includes("--check");
  const browser = await launchReviewBrowser();
  const stale = [];
  try {
    const page = await browser.newPage({
      viewport: { width: STORE_WIDTH, height: STORE_HEIGHT },
      deviceScaleFactor: 1,
    });
    for (const shot of SHOTS) {
      const baseFile = path.join(root, shot.base);
      if (!fs.existsSync(baseFile)) {
        console.error(`The demo photograph is missing: ${shot.base}`);
        process.exit(1);
      }
      await page.setContent(
        composeHtml({
          base: dataUrl(baseFile),
          panel: dataUrl(path.join(shotsDir, `${shot.shot}.png`)),
        }),
        { waitUntil: "load" },
      );
      const out = path.join(outDir, shot.out);
      const buffer = await page.screenshot(check ? {} : { path: out });
      if (check) {
        // The listing on disk has to be the picture this script makes out
        // of the product as it is now. A listing that was assembled by hand
        // and never regenerated is a picture of a product that no longer
        // exists, and no gate can see that unless one rebuilds it.
        const committed = fs.existsSync(out)
          ? fs.readFileSync(out)
          : Buffer.alloc(0);
        if (!committed.equals(buffer)) {
          stale.push(shot.out);
          continue;
        }
      }
      const size = pngSize(buffer);
      if (!size || size.width !== STORE_WIDTH || size.height !== STORE_HEIGHT) {
        console.error(
          `${shot.out} came out ${size ? `${size.width}x${size.height}` : "unreadable"}; ` +
            `the listing needs ${STORE_WIDTH}x${STORE_HEIGHT}`,
        );
        process.exit(1);
      }
      console.log(`${shot.out}  ${shot.alt}`);
    }
    await page.close();
  } finally {
    await browser.close();
  }

  if (stale.length) {
    console.error(
      "The listing is not the product any more:\n" +
        stale.map((name) => `  ${name}`).join("\n"),
    );
    console.error(
      "Run `node scripts/panel-review.js --store` and then " +
        "`node scripts/store-shots.js` to rebuild the listing.",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
