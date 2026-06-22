// Test helper: load an HTML fixture into a jsdom document and expose the jsdom
// window globals (Event, Node, MutationObserver, ...) so that DOM-touching code
// paths work under the Node test runner. Not a test file (no ".test." in name)
// so the runner won't execute it directly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name) {
  return join(here, "fixtures", name);
}

export function fixtureHtml(name) {
  return readFileSync(fixturePath(name), "utf8");
}

/**
 * Build a jsdom document from HTML and install its window globals.
 * @param {string} html
 * @returns {Document}
 */
export function loadDom(html) {
  const dom = new JSDOM(html, { url: "https://ebank.esunbank.com.tw/transfer" });
  const w = dom.window;
  global.window = w;
  global.document = w.document;
  global.Event = w.Event;
  global.Node = w.Node;
  global.HTMLElement = w.HTMLElement;
  global.MutationObserver = w.MutationObserver;
  return w.document;
}

export function loadFixtureDom(name) {
  return loadDom(fixtureHtml(name));
}

/** Extract the inner <body> HTML from a fixture, for swapping page content. */
export function bodyInner(name) {
  const dom = new JSDOM(fixtureHtml(name));
  return dom.window.document.body.innerHTML;
}
