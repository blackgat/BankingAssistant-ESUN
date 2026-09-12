// Offline harness for the options page. Stubs the chrome.* APIs it uses, injects
// the real options.html markup, then loads the real options.js - so backup,
// restore, and the config editor can be exercised with no extension installed.
//
// Downloads are intercepted and logged rather than written to disk, and storage
// is a plain in-memory object, so nothing here touches a real profile.

import { DEFAULT_CONFIG, STORAGE_KEYS } from "../src/core/types.js";
import { buildBackup } from "../src/core/backup.js";

const logEl = document.getElementById("log");
const lines = [];
function log(msg, data) {
  const stamp = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  lines.push(`[${stamp}] ${msg}${data !== undefined ? "\n" + JSON.stringify(data, null, 2) : ""}`);
  logEl.textContent = lines.slice(-60).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

let store = {};

function seedEmpty() {
  store = { [STORAGE_KEYS.CONFIG]: structuredClone(DEFAULT_CONFIG) };
  log("storage 重設為全新安裝");
}

function seedFull() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  store = {
    [STORAGE_KEYS.CONFIG]: cfg,
    [STORAGE_KEYS.LISTS]: {
      version: 1,
      activeListId: "l1",
      lists: [
        {
          id: "l1",
          name: "每月固定轉帳",
          createdAt: Date.now(),
          lastRun: null,
          jobs: [1, 2, 3, 4].map((n) => ({
            id: `j${n}`,
            sourceAccountId: cfg.sourceAccounts[0].id,
            destinationPayeeId: cfg.destinationPayees[0].id,
            amount: n * 1000,
            currency: "TWD",
            memoShort: `測試${n}`,
            memoLong: `第 ${n} 筆`,
          })),
        },
      ],
    },
    [STORAGE_KEYS.AUDIT_LOG]: [{ eventId: "e1", eventType: "batch_started", timestamp: Date.now() }],
  };
  log("storage 重設為：設定 + 1 份清單(4 筆) + 稽核 1 筆");
}

const asArray = (keys) => (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]);

globalThis.chrome = {
  runtime: { lastError: undefined, getURL: (p) => new URL("../" + p, import.meta.url).href },
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const k of asArray(keys)) if (k in store) out[k] = structuredClone(store[k]);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
        log(`storage.set 寫入：${Object.keys(obj).join("、")}`);
      },
    },
  },
};

// Intercept the download an export triggers: report what it would contain
// instead of saving a file.
const realClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download && this.href.startsWith("blob:")) {
    fetch(this.href)
      .then((r) => r.text())
      .then((text) => log(`攔截下載 ${this.download}（${text.length} bytes）`, JSON.parse(text)))
      .catch(() => log(`攔截下載 ${this.download}（非 JSON）`));
    return;
  }
  return realClick.call(this);
};

async function mountOptions() {
  const html = await (await fetch("../src/options/options.html")).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script").forEach((s) => s.remove());
  document.getElementById("options-root").innerHTML = doc.body.innerHTML;
  await import("../src/options/options.js?" + Date.now());
  log("options 已載入");
}

document.getElementById("seedFull").addEventListener("click", () => { seedFull(); location.reload(); });
document.getElementById("seedEmpty").addEventListener("click", () => { seedEmpty(); location.reload(); });
document.getElementById("dumpState").addEventListener("click", () => log("storage 內容", store));
document.getElementById("fillBackup").addEventListener("click", () => {
  document.getElementById("configArea").value = JSON.stringify(buildBackup(store), null, 2);
  log("已把目前 storage 包成備份貼進文字框，可按「還原備份」測試往返");
});

const saved = sessionStorage.getItem("options-harness-store");
if (saved) store = JSON.parse(saved);
else seedFull();
addEventListener("beforeunload", () => sessionStorage.setItem("options-harness-store", JSON.stringify(store)));

mountOptions();
