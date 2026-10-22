/**
 * A sign-in that is bound to the browser that started it.
 *
 * The README says that a token copied out of another browser is refused.
 * That is only true if the browser is named: the sync service binds the
 * session it issues to the name the sign-in carried, and refuses that
 * session in any other browser. The extension has to say which browser it
 * is, at the sign-in and on every request that follows it.
 *
 * These tests drive the extension the way background.js drives it and
 * check the three things that have to hold together: the sign-in names the
 * browser, the name is the same one every time, and every request that
 * carries a token carries the name with it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settings = require("../settings.js");

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * Loads cloud-sync.js into a sandbox that records the requests it makes
 * and the tabs it opens.
 */
function loadCloudSync({ storage = {}, session = {} } = {}) {
  const requests = [];
  const tabs = [];
  const sandbox = {
    console: { ...console, warn: () => {} },
    URL,
    Date,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options: options || {} });
      return jsonResponse({ user: { login: "jane", githubId: 7 } });
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (Array.isArray(key)) {
              const out = {};
              for (const k of key) if (k in storage) out[k] = storage[k];
              return out;
            }
            return key in storage ? { [key]: storage[key] } : {};
          },
          async set(patch) {
            Object.assign(storage, patch);
          },
          async remove(key) {
            delete storage[key];
          },
        },
        session: {
          async get(key) {
            if (Array.isArray(key)) {
              const out = {};
              for (const k of key) if (k in session) out[k] = session[k];
              return out;
            }
            return key in session ? { [key]: session[key] } : {};
          },
          async set(patch) {
            Object.assign(session, patch);
          },
          async remove(key) {
            delete session[key];
          },
        },
      },
      runtime: { sendMessage: async () => ({}) },
      tabs: {
        onUpdated: { addListener() {} },
        create: async (options) => {
          tabs.push(options);
          return { id: tabs.length };
        },
      },
    },
    "YTD_SETTINGS": {
      ...settings,
      GITHUB_SESSION_KEY: "ytd_github_session",
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  return { sandbox, storage, session, requests, tabs };
}

test("the sign-in names the browser it was started from", async () => {
  const { sandbox, tabs, storage } = loadCloudSync();

  await sandbox.handleStartGithubLogin();

  assert.equal(tabs.length, 1, "no sign-in tab was opened");
  const url = tabs[0].url;
  const match = url.match(/[?&]device=([^&]+)/);
  assert.ok(
    match,
    `the sign-in does not name the browser: ${url}`,
  );
  const named = decodeURIComponent(match[1]);
  assert.match(
    named,
    /^[A-Za-z0-9_-]{16,64}$/,
    `the name of the browser is not one the service accepts: ${named}`,
  );
  assert.equal(
    named,
    storage[settings.DEVICE_ID_KEY],
    "the sign-in names a browser that is not the one this device kept",
  );
});

test("the browser keeps the same name between two sign-ins", async () => {
  const storage = {};
  const first = loadCloudSync({ storage });
  await first.sandbox.handleStartGithubLogin();
  const named = storage[settings.DEVICE_ID_KEY];

  // A second load of the same storage is the same browser after a restart.
  const second = loadCloudSync({ storage });
  await second.sandbox.handleStartGithubLogin();

  assert.equal(
    storage[settings.DEVICE_ID_KEY],
    named,
    "the browser was given a new name, so its session would be refused",
  );
  const url = second.tabs[0].url;
  assert.ok(
    url.includes(`device=${encodeURIComponent(named)}`),
    `the second sign-in names a different browser: ${url}`,
  );
});

test("every request that carries a token names the browser", async () => {
  const { sandbox, requests, storage } = loadCloudSync();

  await sandbox.cloudFetch("/api/me", { token: "the-token" });

  assert.equal(requests.length, 1, "the request was not made");
  const headers = requests[0].options.headers || {};
  assert.ok(
    typeof storage[settings.DEVICE_ID_KEY] === "string" &&
      storage[settings.DEVICE_ID_KEY].length > 0,
    "this browser was never given a name",
  );
  assert.equal(
    headers["X-Device-Id"],
    storage[settings.DEVICE_ID_KEY],
    "the request does not name the browser that holds the session",
  );
});

test("a request without a session does not claim to be one", async () => {
  const { sandbox, requests } = loadCloudSync();

  await sandbox.cloudFetch("/api/status", {});

  const headers = requests[0].options.headers || {};
  assert.equal(
    headers["X-Device-Id"],
    undefined,
    "a request that carries no session names a browser anyway",
  );
});
