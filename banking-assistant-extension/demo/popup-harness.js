// Offline harness for the popup UI. Stubs the chrome.* APIs the popup uses,
// injects the real popup.html markup, then loads the real popup.js — so the
// transfer-list UI (create / switch / rename / review / last-run) can be
// exercised with no extension installed and no bank involved.
//
// "開始批次" is intercepted: the batch that WOULD be dispatched is logged instead
// of being sent anywhere. Nothing here can move money.

import { DEFAULT_CONFIG, STORAGE_KEYS } from "../src/core/types.js";

const logEl = document.getElementById("log");
const lines = [];
function log(msg, data) {
  const stamp = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  lines.push(`[${stamp}] ${msg}${data !== undefined ? "\n" + JSON.stringify(data, null, 2) : ""}`);
  logEl.textContent = lines.slice(-40).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

// --- in-memory chrome.storage.local ----------------------------------------
let store = {};

function seedEmpty() {
  store = { [STORAGE_KEYS.CONFIG]: structuredClone(DEFAULT_CONFIG) };
  log("storage 重設為全新安裝");
}

function seedLegacy() {
  // The pre-named-lists shape: one anonymous draft that accumulated jobs.
  const job = (n) => ({
    id: `legacy-${n}`,
    sourceAccountId: DEFAULT_CONFIG.sourceAccounts[0].id,
    destinationPayeeId: DEFAULT_CONFIG.destinationPayees[0].id,
    amount: n * 1000,
    currency: "TWD",
    memoShort: `測試 ${n}`,
    memoLong: `舊草稿第 ${n} 筆`,
  });
  store = {
    [STORAGE_KEYS.CONFIG]: structuredClone(DEFAULT_CONFIG),
    [STORAGE_KEYS.BATCH]: {
      batchId: "draft",
      createdAt: new Date().toISOString(),
      jobs: [job(1), job(2), job(3), job(4)],
    },
  };
  log("storage 重設為舊版 4 筆匿名草稿（重新載入後應遷移成一份具名清單）");
}

const asArray = (keys) => (Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : [keys]);

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    openOptionsPage: () => log("openOptionsPage()（harness 不開啟）"),
    getURL: (p) => new URL("../" + p, import.meta.url).href,
  },
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const k of asArray(keys)) if (k in store) out[k] = structuredClone(store[k]);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
        const lists = store[STORAGE_KEYS.LISTS];
        if (lists) {
          log(
            "storage 已更新：清單 " +
              lists.lists.map((l) => `${l.name}(${l.jobs.length})`).join("、") +
              ` · 目前：${lists.lists.find((l) => l.id === lists.activeListId)?.name}`,
          );
        }
      },
    },
  },
  tabs: {
    // Pretend the active tab is the bank, so the popup enables dispatch.
    async query() {
      return [{ id: 1, url: "https://ebank.esunbank.com.tw/index.jsp" }];
    },
    sendMessage(tabId, msg, cb) {
      chrome.runtime.lastError = undefined;
      if (msg.type === "PING") {
        cb && cb({ ok: true, origin: "https://ebank.esunbank.com.tw" });
        return;
      }
      if (msg.type === "START_BATCH") {
        // This is where a real dispatch would happen. Log it instead.
        log(`攔截 START_BATCH（不會真的轉帳）— listId=${msg.listId}`, {
          batchId: msg.batch.batchId,
          jobs: msg.batch.jobs.map((j) => ({ amount: j.amount, memoShort: j.memoShort })),
        });
        cb && cb({ ok: true, results: [], stopped: false });
        return;
      }
      if (msg.type === "DRY_RUN_FILL") {
        log("攔截 DRY_RUN_FILL（harness 沒有銀行頁面）");
        cb && cb({ pageState: "harness", note: "no bank page in harness" });
        return;
      }
      cb && cb(undefined);
    },
  },
};

// --- mount the real popup ---------------------------------------------------
async function mountPopup() {
  const html = await (await fetch("../src/popup/popup.html")).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Drop the <script> tag; we import the module ourselves after the shim exists.
  doc.querySelectorAll("script").forEach((s) => s.remove());
  document.getElementById("popup-root").innerHTML = doc.body.innerHTML;
  await import("../src/popup/popup.js?" + Date.now());
  log("popup 已載入");
}

document.getElementById("seedLegacy").addEventListener("click", async () => {
  seedLegacy();
  location.reload();
});
document.getElementById("seedEmpty").addEventListener("click", async () => {
  seedEmpty();
  location.reload();
});
document.getElementById("dumpState").addEventListener("click", () =>
  log("storage 內容", store[STORAGE_KEYS.LISTS] ?? "(尚無 transferLists)"),
);

// Seed from sessionStorage so a reload keeps whatever the buttons set up.
const saved = sessionStorage.getItem("harness-store");
if (saved) {
  store = JSON.parse(saved);
} else {
  seedLegacy();
}
addEventListener("beforeunload", () => sessionStorage.setItem("harness-store", JSON.stringify(store)));

mountPopup();
