// Background service worker (ES module). Minimal by design: seeds the default
// config on install and exposes a couple of storage helpers. It never touches
// the bank page and holds no credentials.

import { STORAGE_KEYS, DEFAULT_CONFIG } from "../core/types.js";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = (await chrome.storage.local.get(STORAGE_KEYS.CONFIG))[STORAGE_KEYS.CONFIG];
  if (!existing) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: DEFAULT_CONFIG });
  }
  if (!(await chrome.storage.local.get(STORAGE_KEYS.AUDIT_LOG))[STORAGE_KEYS.AUDIT_LOG]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.AUDIT_LOG]: [] });
  }
});

// Lightweight storage helpers usable by popup/options if they prefer messaging
// over direct chrome.storage access.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "GET_CONFIG":
      chrome.storage.local.get(STORAGE_KEYS.CONFIG).then((r) =>
        sendResponse({ ok: true, config: r[STORAGE_KEYS.CONFIG] || DEFAULT_CONFIG }),
      );
      return true;
    case "GET_AUDIT_LOG":
      chrome.storage.local.get(STORAGE_KEYS.AUDIT_LOG).then((r) =>
        sendResponse({ ok: true, log: r[STORAGE_KEYS.AUDIT_LOG] || [] }),
      );
      return true;
    case "CLEAR_AUDIT_LOG":
      chrome.storage.local.set({ [STORAGE_KEYS.AUDIT_LOG]: [] }).then(() =>
        sendResponse({ ok: true }),
      );
      return true;
    default:
      return;
  }
});
