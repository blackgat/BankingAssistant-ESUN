import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { loadDom } from "./dom-helper.js";
import { Overlay } from "../src/content/overlay.js";

const hostEl = (doc) => doc.getElementById("banking-assistant-overlay");

test("stop button fires the cancel action and auto-dismisses after 3s", () => {
  const doc = loadDom("<!DOCTYPE html><html><body></body></html>");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const overlay = new Overlay({ mountTo: doc.body });
    let cancelled = 0;
    overlay.setOnCancel(() => cancelled++);
    overlay.showError("stopping"); // mounts and renders a status

    assert.ok(hostEl(doc), "overlay is mounted");
    const btn = overlay.shadow.querySelector("button.danger");
    assert.ok(btn, "stop button exists");

    btn.click();
    assert.equal(cancelled, 1, "cancel action fired on click");
    assert.ok(hostEl(doc), "overlay still visible immediately after click");

    mock.timers.tick(2999);
    assert.ok(hostEl(doc), "overlay still visible just before 3s");

    mock.timers.tick(1);
    assert.equal(hostEl(doc), null, "overlay removed after 3s");
  } finally {
    mock.timers.reset();
  }
});

test("auto-dismiss delay is configurable and 0 disables it", () => {
  const doc = loadDom("<!DOCTYPE html><html><body></body></html>");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const o1 = new Overlay({ mountTo: doc.body, dismissMs: 1000 });
    o1.setOnCancel(() => {});
    o1.showError("x");
    o1.shadow.querySelector("button.danger").click();
    mock.timers.tick(1000);
    assert.equal(hostEl(doc), null, "closed at the custom 1s delay");

    const o2 = new Overlay({ mountTo: doc.body, dismissMs: 0 });
    o2.setOnCancel(() => {});
    o2.showError("y");
    o2.shadow.querySelector("button.danger").click();
    mock.timers.tick(60000);
    assert.ok(hostEl(doc), "stays open when dismissMs is 0");
  } finally {
    mock.timers.reset();
  }
});

test("scheduleDismiss closes the overlay after a completed batch too", () => {
  const doc = loadDom("<!DOCTYPE html><html><body></body></html>");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const o = new Overlay({ mountTo: doc.body, dismissMs: 3000 });
    o.showBatchCompleted(null, [{ jobId: "j1", status: "completed" }]);
    assert.ok(hostEl(doc), "visible while showing the completed status");
    o.scheduleDismiss(); // what the runner calls at the end of a batch
    mock.timers.tick(2999);
    assert.ok(hostEl(doc), "still visible just before the delay elapses");
    mock.timers.tick(1);
    assert.equal(hostEl(doc), null, "closed after the delay");
  } finally {
    mock.timers.reset();
  }
});

test("a destroyed overlay does not resurrect itself on a late render", () => {
  const doc = loadDom("<!DOCTYPE html><html><body></body></html>");
  const overlay = new Overlay({ mountTo: doc.body });
  overlay.showError("x");
  overlay.destroy();
  assert.equal(hostEl(doc), null, "removed by destroy");
  overlay.showBatchCompleted(null, []); // a late runner render must be a no-op
  assert.equal(hostEl(doc), null, "stayed removed (no resurrection)");
});
