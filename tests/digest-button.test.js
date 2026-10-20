const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FakeElement,
  createHarness,
  createActionRow,
} = require("./helpers/content-harness.js");

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
  assert.equal(newGroup.children[0].id, "ytd-digest-button");
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
