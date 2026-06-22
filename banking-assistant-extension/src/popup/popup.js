// Popup: build a TransferBatch and hand it to the content script to run.
// The popup never sees passwords/OTP; it only assembles job parameters from the
// user's own configured accounts and payees.

import { STORAGE_KEYS, DEFAULT_CONFIG, CURRENCY } from "../core/types.js";
import { isOriginAllowed } from "../core/allowlist.js";

const $ = (id) => document.getElementById(id);
const fmtTWD = (n) => "NT$ " + Number(n || 0).toLocaleString("en-US");

let config = DEFAULT_CONFIG;
let jobs = [];
let activeTabId = null;
let originAllowed = false;

async function loadConfig() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  config = r[STORAGE_KEYS.CONFIG] || DEFAULT_CONFIG;
}

async function loadPendingJobs() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.BATCH);
  const b = r[STORAGE_KEYS.BATCH];
  jobs = Array.isArray(b?.jobs) ? b.jobs : [];
}

async function savePendingJobs() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.BATCH]: { batchId: "draft", createdAt: new Date().toISOString(), jobs },
  });
}

function fillSelects() {
  const s = $("sourceSelect");
  const p = $("payeeSelect");
  s.innerHTML = "";
  p.innerHTML = "";
  for (const a of config.sourceAccounts || []) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = `${a.label}${a.accountLast5 ? " ****" + a.accountLast5 : ""}`;
    s.appendChild(o);
  }
  for (const a of config.destinationPayees || []) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = `${a.label}${a.accountLast5 ? " ****" + a.accountLast5 : ""}`;
    p.appendChild(o);
  }
  $("memoShort").maxLength = config.behavior?.memoShortMaxLen ?? 20;
  $("memoLong").maxLength = config.behavior?.memoLongMaxLen ?? 60;
}

function labelFor(list, id) {
  const f = (list || []).find((x) => x.id === id);
  return f ? `${f.label}${f.accountLast5 ? " ****" + f.accountLast5 : ""}` : id;
}

function renderJobs() {
  const ol = $("jobList");
  ol.innerHTML = "";
  let total = 0;
  jobs.forEach((j, idx) => {
    total += Number(j.amount) || 0;
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "ji";
    const left = document.createElement("span");
    left.textContent = `${labelFor(config.sourceAccounts, j.sourceAccountId)} → ${labelFor(config.destinationPayees, j.destinationPayeeId)}`;
    const right = document.createElement("strong");
    right.textContent = fmtTWD(j.amount);
    top.append(left, right);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [j.memoShort, j.memoLong].filter(Boolean).join(" / ");
    const rm = document.createElement("button");
    rm.className = "rm ghost";
    rm.textContent = "移除";
    rm.addEventListener("click", async () => {
      jobs.splice(idx, 1);
      await savePendingJobs();
      renderJobs();
    });
    li.append(top, meta, rm);
    ol.appendChild(li);
  });
  $("jobCount").textContent = String(jobs.length);
  $("jobTotal").textContent = fmtTWD(total);
  $("startBatch").disabled = jobs.length === 0 || !originAllowed;
}

function showAddError(msg) {
  const e = $("addError");
  if (!msg) {
    e.hidden = true;
    return;
  }
  e.textContent = msg;
  e.hidden = false;
}

async function addJob() {
  showAddError("");
  const sourceAccountId = $("sourceSelect").value;
  const destinationPayeeId = $("payeeSelect").value;
  const amount = Math.floor(Number($("amount").value));
  const memoShort = $("memoShort").value.trim();
  const memoLong = $("memoLong").value.trim();
  const expectedDate = $("expectedDate").value || undefined;

  if (!sourceAccountId || !destinationPayeeId) return showAddError("請選擇來源與目的帳戶。");
  if (!Number.isFinite(amount) || amount <= 0) return showAddError("金額必須為正整數。");
  const sMax = config.behavior?.memoShortMaxLen ?? 20;
  const lMax = config.behavior?.memoLongMaxLen ?? 60;
  if (memoShort.length > sMax) return showAddError(`備註給自己不可超過 ${sMax} 字。`);
  if (memoLong.length > lMax) return showAddError(`備註給對方不可超過 ${lMax} 字。`);

  jobs.push({
    id: crypto.randomUUID(),
    sourceAccountId,
    destinationPayeeId,
    amount,
    currency: CURRENCY,
    memoShort,
    memoLong,
    expectedDate,
  });
  $("amount").value = "";
  $("memoShort").value = "";
  $("memoLong").value = "";
  await savePendingJobs();
  renderJobs();
}

async function checkActiveTab() {
  const status = $("bankStatus");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    const origin = tab?.url ? new URL(tab.url).origin : "";
    originAllowed = origin ? isOriginAllowed(origin, config) : false;
    if (originAllowed) {
      status.textContent = `已在銀行網站：${origin}`;
      status.className = "status ok";
    } else {
      status.textContent = "目前分頁不是設定的銀行網站，無法開始批次。";
      status.className = "status err";
    }
  } catch {
    originAllowed = false;
    status.textContent = "無法讀取目前分頁。";
    status.className = "status err";
  }
}

async function startBatch() {
  const run = $("runStatus");
  run.hidden = false;
  run.className = "status";
  run.textContent = "傳送批次到分頁…";
  if (!activeTabId || !originAllowed) {
    run.textContent = "請先在銀行網站分頁開啟此 popup。";
    run.className = "status err";
    return;
  }
  const batch = { batchId: crypto.randomUUID(), createdAt: new Date().toISOString(), jobs };
  // Confirm the page script is alive, then fire the batch and close the popup so
  // it doesn't block the bank page. We do NOT wait for the batch to finish (it
  // pauses for the user on the verification page); progress is shown by the
  // in-page overlay from here on.
  chrome.tabs.sendMessage(activeTabId, { type: "PING" }, (pong) => {
    if (chrome.runtime.lastError || !pong?.ok) {
      run.textContent = "找不到頁面腳本，請在銀行（轉帳表單）頁重新整理後再試。";
      run.className = "status err";
      return;
    }
    chrome.tabs.sendMessage(activeTabId, { type: "START_BATCH", batch }, () => void chrome.runtime.lastError);
    run.textContent = "批次已開始，正在收起此視窗…";
    run.className = "status ok";
    setTimeout(() => window.close(), 500);
  });
}

function testFill() {
  const out = $("testFillResult");
  out.hidden = false;
  out.className = "status";
  out.textContent = "送出測試填表…";
  if (!activeTabId) {
    out.textContent = "找不到目前分頁。";
    out.className = "status err";
    return;
  }
  chrome.tabs.sendMessage(activeTabId, { type: "DRY_RUN_FILL" }, (resp) => {
    if (chrome.runtime.lastError) {
      out.textContent = "無法連線到頁面腳本,請在銀行轉帳頁重新整理後再試。";
      out.className = "status err";
      return;
    }
    if (!resp) {
      out.textContent = "沒有銀行分頁回應。請確認你在已登入的轉帳「資料編輯」表單頁。";
      out.className = "status err";
      return;
    }
    out.textContent = JSON.stringify(resp, null, 2);
    out.className = "status ok";
  });
}

function importJson() {
  const e = $("jsonError");
  e.hidden = true;
  try {
    const parsed = JSON.parse($("jsonArea").value);
    const incoming = Array.isArray(parsed) ? parsed : parsed.jobs;
    if (!Array.isArray(incoming)) throw new Error("找不到 jobs 陣列");
    jobs = incoming.map((j) => ({
      id: j.id || crypto.randomUUID(),
      sourceAccountId: j.sourceAccountId,
      destinationPayeeId: j.destinationPayeeId,
      amount: Math.floor(Number(j.amount)),
      currency: CURRENCY,
      memoShort: j.memoShort || "",
      memoLong: j.memoLong || "",
      expectedDate: j.expectedDate,
    }));
    savePendingJobs();
    renderJobs();
  } catch (err) {
    e.textContent = `JSON 解析失敗：${err.message}`;
    e.hidden = false;
  }
}

function exportJson() {
  const batch = { batchId: crypto.randomUUID(), createdAt: new Date().toISOString(), jobs };
  $("jsonArea").value = JSON.stringify(batch, null, 2);
}

async function init() {
  await loadConfig();
  await loadPendingJobs();
  fillSelects();
  renderJobs();
  await checkActiveTab();
  renderJobs();

  $("addJob").addEventListener("click", addJob);
  $("startBatch").addEventListener("click", startBatch);
  $("clearJobs").addEventListener("click", async () => {
    jobs = [];
    await savePendingJobs();
    renderJobs();
  });
  $("importJson").addEventListener("click", importJson);
  $("exportJson").addEventListener("click", exportJson);
  $("testFill").addEventListener("click", testFill);
  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

init();
