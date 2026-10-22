const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * A stand-in for chrome.storage that behaves like the real one: the values
 * are copied on the way in and on the way out.
 *
 * The real storage clones what it keeps. A mock that hands back the very
 * array it was given would let a list that was read before an upload change
 * under the caller's feet, and a bug that loses a note in the browser would
 * stay invisible in the test.
 */
function createStorageMock(initial = {}) {
  const values = { ...initial };
  const copy = (value) => structuredClone(value);
  return {
    async get(keys) {
      if (keys === null) return copy(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) result[key] = copy(values[key]);
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        values[key] = copy(value);
      }
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
}

/**
 * Loads the real service worker in a sandbox and hands back the helpers it
 * exports for the tests.
 *
 * The worker is the code that runs in the browser, so a test that only reads
 * its source proves nothing about what it does. This harness runs it, with
 * the browser APIs it touches replaced by recorders, and returns both the
 * exported helpers and the recorders, so a test can drive the worker and
 * then look at what it did.
 */
function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  storageMock,
  tabs = {},
  sidePanel = {
    setPanelBehavior() {},
    setOptions: () => Promise.resolve(),
    close: () => Promise.resolve(),
  },
} = {}) {
  const listeners = { addListener() {} };
  const messageListeners = [];
  const tabUpdatedListeners = [];
  const tabActivatedListeners = [];
  const localStorage = { ytd_settings: settings };
  const openedLoginTabs = [];
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    // The service worker builds note ids with crypto.randomUUID(). A bare vm
    // context has no crypto, so the harness provides the real one.
    crypto: globalThis.crypto,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (storageMock) return storageMock.get(key);
            if (key === null) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, localStorage[item]]));
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => {
            if (storageMock) return storageMock.set(values);
            return Object.assign(localStorage, values);
          },
          remove: async (keys) => {
            if (storageMock) return storageMock.remove(keys);
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel,
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            messageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: {
        // The tab events are recorded instead of dropped: the panel state
        // follows the tab, and a test that cannot fire the event can only
        // read the source and guess what the worker does with it.
        onUpdated: {
          addListener(listener) {
            tabUpdatedListeners.push(listener);
          },
        },
        onActivated: {
          addListener(listener) {
            tabActivatedListeners.push(listener);
          },
        },
        // Spread first so the recording create() below stays authoritative and
        // every opened login URL can be asserted.
        ...tabs,
        create:
          tabs.create ??
          (async (options) => {
            openedLoginTabs.push(options.url);
            return { id: openedLoginTabs.length, url: options.url };
          }),
      },
    },
    // The real settings module, with only the deployment value redirected.
    // The worker reads its provider registry, its chat endpoint and its
    // canonical URL builder from here, so a hand-written copy of those
    // functions would test a module that no longer exists: a wrong endpoint
    // in settings.js would still leave every test in this file green.
    YTD_SETTINGS: {
      ...require("../../settings.js"),
      SERVER_BASE_URL: "https://sync.test",
    },
  };
  sandbox.globalThis = sandbox;
  // cloud-sync.js is imported by background.js via importScripts; the test
  // sandbox stubs importScripts, so load it explicitly first.
  vm.runInNewContext(read("cloud-sync.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  const helpers = sandbox.__YTD_TRANSLATION_TESTING__;
  helpers.openedLoginTabs = openedLoginTabs;
  helpers.messageListeners = messageListeners;
  helpers.tabUpdatedListeners = tabUpdatedListeners;
  helpers.tabActivatedListeners = tabActivatedListeners;
  return helpers;
}

module.exports = { createStorageMock, loadBackgroundHelpers };
