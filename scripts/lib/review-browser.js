/**
 * The browser the review gates look at the product with.
 *
 * The gates exist to catch what the unit tests cannot: a panel that is
 * painted wrong, a button label on two lines, a sentence nobody can read
 * in the theme they are actually using. For that they need a real browser.
 *
 * Playwright's own browser build is a download. It is also a shared
 * directory: when another project on the machine installs a different
 * version of Playwright, the browser this project needs is collected as
 * "no longer used", and the gate stops being able to run at all. The
 * browser the user has installed is always there, and it is the browser
 * the user will see the product in, which is the point of a review.
 *
 * So: the installed Chrome is used when it is there, and the downloaded
 * build is the fallback for a machine that has no Chrome.
 */

const { chromium } = require("playwright");

/**
 * Opens a browser for a review.
 *
 * The installed Chrome is tried first. A machine without it falls back to
 * the downloaded build, and a machine with neither says so plainly rather
 * than failing with a path.
 */
async function launchReviewBrowser() {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch (error) {
    try {
      return await chromium.launch();
    } catch (fallbackError) {
      throw new Error(
        "The review needs a browser. Install Google Chrome, or run " +
          "`npx playwright install chromium` to get the downloaded build.\n" +
          `Chrome: ${error.message}\n` +
          `Downloaded build: ${fallbackError.message}`,
      );
    }
  }
}

module.exports = { launchReviewBrowser };
