const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

class FakeElement {
  constructor({
    id = "",
    width = 100,
    height = 36,
    inMetadata = false,
    inPrimary = false,
  } = {}) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.inMetadata = inMetadata;
    this.inPrimary = inPrimary;
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.attributes = {};
    this.disabled = false;
    this._text = "";
    this._html = null;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this._html = null;
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children.map((child) => child.textContent || "").join("");
  }

  set innerHTML(value) {
    this._html = String(value ?? "");
    this._text = "";
    this.children = [];
  }

  get innerHTML() {
    if (this._html !== null) return this._html;
    return this._text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }

  closest(selector) {
    if (selector === "ytd-watch-metadata" && this.inMetadata) return this;
    if (selector === "#primary" && this.inPrimary) return this;
    return null;
  }

  querySelector() {
    // The harness does not parse markup, so every query returns a stub that
    // accepts the calls the content script makes on it.
    return new FakeElement();
  }

  querySelectorAll(selector) {
    const matches = [];

    for (const child of this.children) {
      if (
        selector === "#top-level-buttons-computed" &&
        child.id === selector.slice(1)
      ) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }

    return matches;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    this[name] = value;
  }

  getAttribute(name) {
    if (Object.hasOwn(this.attributes, name)) return this.attributes[name];
    return null;
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }
}

function createHarness({ sendMessage } = {}) {
  const actionRows = [];
  const fallbackRows = [];
  const elements = [];
  const documentListeners = {};
  const windowListeners = {};
  const observers = [];
  const timers = new Map();
  let nextTimerId = 1;

  const document = {
    readyState: "loading",
    body: new FakeElement(),
    head: new FakeElement(),
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-watch-metadata #actions-inner") return actionRows;
      if (selector === "#ytd-digest-button") {
        return elements.filter(
          (element) => element.id === "ytd-digest-button" && element.isConnected,
        );
      }
      if (selector.includes("top-level-buttons-computed")) return fallbackRows;
      return [];
    },
    querySelector() {
      return null;
    },
    getElementById(id) {
      return elements.find((element) => element.id === id && element.isConnected);
    },
    createElement() {
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
  };

  const context = vm.createContext({
    console,
    document,
    window: {
      location: { pathname: "/watch" },
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      },
      getComputedStyle(element) {
        return {
          display: element.display || "flex",
          visibility: element.visibility || "visible",
        };
      },
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          if (sendMessage) return sendMessage(message);
          return { success: true };
        },
      },
    },
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
    clearInterval() {},
  });

  vm.runInContext(contentScript, context);

  return {
    context,
    actionRows,
    fallbackRows,
    elements,
    documentListeners,
    windowListeners,
    observers,
    flushTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function createActionRow({ width, height }) {
  const row = new FakeElement({
    id: "actions-inner",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  const buttonGroup = new FakeElement({
    id: "top-level-buttons-computed",
    width,
    height,
    inMetadata: true,
    inPrimary: true,
  });
  row.appendChild(buttonGroup);
  return { row, buttonGroup };
}

test("Digest button skips a hidden responsive toolbar", () => {
  const harness = createHarness();
  const { row: hiddenRow, buttonGroup: hiddenGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 389,
    height: 36,
  });
  const nativeButton = new FakeElement();
  visibleGroup.appendChild(nativeButton);
  harness.actionRows.push(hiddenRow, visibleRow);

  assert.equal(harness.context.findDigestButtonHost(), visibleGroup);
  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(hiddenGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
  assert.equal(visibleGroup.children[1], nativeButton);
  assert.match(visibleGroup.children[0].style.cssText, /flex:\s*0 0 auto/);
  assert.match(visibleGroup.children[0].style.cssText, /width:\s*max-content/);
  assert.doesNotMatch(visibleGroup.children[0].style.cssText, /box-shadow/);
});

test("Digest button replaces stale instances and removes duplicates", () => {
  const harness = createHarness();
  const { row: staleRow, buttonGroup: staleGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  const { row: visibleRow, buttonGroup: visibleGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  harness.actionRows.push(staleRow, visibleRow);

  const staleButton = new FakeElement();
  staleButton.id = "ytd-digest-button";
  const duplicateButton = new FakeElement();
  duplicateButton.id = "ytd-digest-button";
  harness.elements.push(staleButton, duplicateButton);
  staleGroup.appendChild(staleButton);
  staleGroup.appendChild(duplicateButton);

  assert.equal(harness.context.injectDigestButton(), true);
  assert.equal(staleGroup.children.length, 0);
  assert.equal(visibleRow.children.length, 1);
  assert.equal(visibleGroup.children.length, 1);
  assert.notEqual(visibleGroup.children[0], staleButton);
  assert.equal(visibleGroup.children[0].id, "ytd-digest-button");
  assert.equal(staleButton.isConnected, false);
  assert.equal(duplicateButton.isConnected, false);
});

test("resize reconciliation follows YouTube to the newly visible toolbar", () => {
  const harness = createHarness();
  const { row: firstRow, buttonGroup: firstGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: secondRow, buttonGroup: secondGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(firstRow, secondRow);

  harness.context.injectDigestButton();
  harness.context.setupDigestButtonResizeListener();
  firstRow.width = 0;
  firstRow.height = 0;
  firstGroup.width = 0;
  firstGroup.height = 0;
  secondRow.width = 389;
  secondRow.height = 36;
  secondGroup.width = 389;
  secondGroup.height = 36;

  harness.windowListeners.resize();
  harness.flushTimers();

  assert.equal(firstGroup.children.length, 0);
  assert.equal(secondRow.children.length, 1);
  assert.equal(secondGroup.children.length, 1);
  assert.equal(secondGroup.children[0].id, "ytd-digest-button");
});

test("DOM mutation reconciliation repairs a replaced toolbar", () => {
  const harness = createHarness();
  const { row: oldRow, buttonGroup: oldGroup } = createActionRow({
    width: 500,
    height: 36,
  });
  const { row: newRow, buttonGroup: newGroup } = createActionRow({
    width: 0,
    height: 0,
  });
  harness.actionRows.push(oldRow, newRow);

  harness.context.injectDigestButton();
  harness.context.setupButtonObserver();
  oldRow.width = 0;
  oldRow.height = 0;
  oldGroup.width = 0;
  oldGroup.height = 0;
  newRow.width = 500;
  newRow.height = 36;
  newGroup.width = 500;
  newGroup.height = 36;

  harness.observers[0].callback([]);
  harness.flushTimers();

  assert.equal(oldGroup.children.length, 0);
  assert.equal(newRow.children.length, 1);
  assert.equal(newGroup.children.length, 1);
});

// ============================================================
// The Digest button must show what it is doing
// ============================================================

function digestButtonHarness(sendMessage) {
  const harness = createHarness({ sendMessage });
  const { row } = createActionRow({ width: 500, height: 36 });
  harness.actionRows.push(row);
  harness.context.injectDigestButton();
  const button = harness.elements.find(
    (element) => element.id === "ytd-digest-button",
  );
  return { harness, button };
}

function clickEvent() {
  return { preventDefault() {}, stopPropagation() {} };
}

test("the Digest button says it is opening and blocks double clicks", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { button } = digestButtonHarness(async () => pending);

  const click = button.listeners.click(clickEvent());

  assert.equal(button.children[0].textContent, "Opening…");
  assert.equal(button.disabled, true);

  release({ success: true });
  await click;

  assert.equal(button.children[0].textContent, "Digest");
  assert.equal(button.disabled, false);
});

test("a failed panel open tells the user what to do instead of doing nothing", async () => {
  const { harness, button } = digestButtonHarness(async () => {
    throw new Error("Could not open the side panel.");
  });

  await button.listeners.click(clickEvent());

  assert.equal(button.children[0].textContent, "Digest");
  assert.equal(button.disabled, false);

  const toast = harness.elements.find(
    (element) => element.id === "ytd-toast" && element.isConnected,
  );
  assert.ok(toast, "the failure must be visible on the page");
  assert.match(toast.innerHTML, /Chrome toolbar/);
});

test("a refused panel open is reported back to the page", async () => {
  const { harness, button } = digestButtonHarness(async () => ({
    success: false,
    error: "No active tab to open.",
  }));

  await button.listeners.click(clickEvent());

  assert.equal(button.children[0].textContent, "Digest");
  assert.equal(button.disabled, false);
  const toast = harness.elements.find(
    (element) => element.id === "ytd-toast" && element.isConnected,
  );
  assert.ok(toast, "the failure must be visible on the page");
});

test("the Digest button announces its state to screen readers", () => {
  const { button } = digestButtonHarness(async () => ({ success: true }));
  assert.equal(button.getAttribute("aria-live"), "polite");
});
