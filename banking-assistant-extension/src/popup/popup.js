// Popup: build a TransferBatch and hand it to the content script to run.
// The popup never sees passwords/OTP; it only assembles job parameters from the
// user's own configured accounts and payees.

import { STORAGE_KEYS, DEFAULT_CONFIG, CURRENCY } from "../core/types.js";
import { isOriginAllowed } from "../core/allowlist.js";
import * as Lists from "../core/lists.js";

const $ = (id) => document.getElementById(id);
const fmtTWD = (n) => "NT$ " + Number(n || 0).toLocaleString("en-US");

let config = DEFAULT_CONFIG;
let state = null; // named-lists state; the active list holds the jobs
let activeTabId = null;
let originAllowed = false;

// `jobs` always refers to the active list's jobs.
const activeList = () => Lists.getActiveList(state);
const currentJobs = () => activeList()?.jobs ?? [];

async function loadConfig() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  config = r[STORAGE_KEYS.CONFIG] || DEFAULT_CONFIG;
}

// Load named lists, migrating the legacy single draft on first run so queued
// transfers are never lost.
async function loadLists() {
  const r = await chrome.storage.local.get([STORAGE_KEYS.LISTS, STORAGE_KEYS.BATCH]);
  const migrated = Lists.migrateState(r[STORAGE_KEYS.LISTS], r[STORAGE_KEYS.BATCH]);
  const isNew = !r[STORAGE_KEYS.LISTS];
  state = migrated;
  if (isNew) await saveLists();
}

async function saveLists() {
  await chrome.storage.local.set({ [STORAGE_KEYS.LISTS]: state });
}

/** Apply a pure list operation, persist, and re-render. */
async function update(fn) {
  state = fn(state);
  await saveLists();
  renderLists();
  renderJobs();
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

/** Human-readable summary of a list's last run, or "" when never run. */
function lastRunText(list) {
  const r = list?.lastRun;
  if (!r) return "尚未執行過";
  const when = new Date(r.at).toLocaleString("zh-TW", { hour12: false });
  if (r.status === Lists.RUN_STATUS.COMPLETED) {
    return `上次執行 ${when} · 完成 ${r.completed ?? "?"}/${r.total ?? "?"} 筆`;
  }
  if (r.status === Lists.RUN_STATUS.STOPPED) {
    return `上次執行 ${when} · 中止（完成 ${r.completed ?? 0}/${r.total ?? "?"} 筆）`;
  }
  return `上次送出 ${when} · 結果未回報`;
}

function renderLists() {
  const sel = $("listSelect");
  sel.innerHTML = "";
  for (const l of state.lists) {
    const o = document.createElement("option");
    o.value = l.id;
    const s = Lists.summarize(l);
    o.textContent = `${l.name}（${s.count} 筆 · ${fmtTWD(s.total)}）`;
    if (l.id === state.activeListId) o.selected = true;
    sel.appendChild(o);
  }
  const active = activeList();
  const lr = $("lastRun");
  lr.textContent = lastRunText(active);
  // A list that was just run is the one most at risk of being re-sent by habit.
  lr.className = active?.lastRun ? "status err" : "muted";
}

function renderJobs() {
  const ol = $("jobList");
  ol.innerHTML = "";
  let total = 0;
  const jobs = currentJobs();
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
    rm.addEventListener("click", () => update((s) => Lists.removeJobAt(s, s.activeListId, idx)));
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

  const job = {
    id: crypto.randomUUID(),
    sourceAccountId,
    destinationPayeeId,
    amount,
    currency: CURRENCY,
    memoShort,
    memoLong,
    expectedDate,
  };
  $("amount").value = "";
  $("memoShort").value = "";
  $("memoLong").value = "";
  await update((s) => Lists.addJob(s, s.activeListId, job));
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

/** Step 1 of dispatch: show exactly what is about to be sent. Sends nothing. */
function reviewBatch() {
  const run = $("runStatus");
  run.hidden = true;
  const list = activeList();
  const jobs = currentJobs();
  if (!activeTabId || !originAllowed) {
    run.hidden = false;
    run.textContent = "請先在銀行網站分頁開啟此 popup。";
    run.className = "status err";
    return;
  }
  const ol = $("reviewList");
  ol.innerHTML = "";
  for (const j of jobs) {
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "ji";
    const left = document.createElement("span");
    left.textContent = `${labelFor(config.sourceAccounts, j.sourceAccountId)} → ${labelFor(config.destinationPayees, j.destinationPayeeId)}`;
    const right = document.createElement("strong");
    right.textContent = fmtTWD(j.amount);
    top.append(left, right);
    li.appendChild(top);
    ol.appendChild(li);
  }
  const s = Lists.summarize(list);
  $("reviewCount").textContent = String(s.count);
  $("reviewTotal").textContent = fmtTWD(s.total);

  // Re-running a list that already ran is the case worth naming out loud.
  const warn = $("reviewWarn");
  const r = list?.lastRun;
  if (r) {
    const when = new Date(r.at).toLocaleString("zh-TW", { hour12: false });
    const what =
      r.status === Lists.RUN_STATUS.COMPLETED
        ? `已於 ${when} 執行完成（${r.completed ?? "?"}/${r.total ?? "?"} 筆）`
        : r.status === Lists.RUN_STATUS.STOPPED
          ? `已於 ${when} 執行但中途中止（完成 ${r.completed ?? 0}/${r.total ?? "?"} 筆）`
          : `已於 ${when} 送出，結果尚未回報`;
    warn.hidden = false;
    warn.textContent = `注意：這份清單${what}。再次送出會把上面每一筆重新轉一次。`;
  } else {
    warn.hidden = true;
  }
  $("review").hidden = false;
}

function cancelReview() {
  $("review").hidden = true;
}

/** Step 2: actually dispatch, record the run, and close the popup. */
async function confirmSend() {
  const run = $("runStatus");
  const list = activeList();
  const listId = state.activeListId;
  $("review").hidden = true;
  run.hidden = false;
  run.className = "status";
  run.textContent = "傳送批次到分頁…";

  const batch = Lists.toBatch(list, { batchId: crypto.randomUUID() });
  // Confirm the page script is alive, then fire the batch and close the popup so
  // it doesn't block the bank page. We do NOT wait for the batch to finish (it
  // pauses for the user on the verification page); progress is shown by the
  // in-page overlay from here on, and the content script records the outcome.
  chrome.tabs.sendMessage(activeTabId, { type: "PING" }, async (pong) => {
    if (chrome.runtime.lastError || !pong?.ok) {
      run.textContent = "找不到頁面腳本，請在銀行（轉帳表單）頁重新整理後再試。";
      run.className = "status err";
      return;
    }
    await update((s) => Lists.recordRun(s, listId, { status: Lists.RUN_STATUS.DISPATCHED }));
    chrome.tabs.sendMessage(
      activeTabId,
      { type: "START_BATCH", batch, listId },
      () => void chrome.runtime.lastError,
    );
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
    const imported = incoming.map((j) => ({
      id: j.id || crypto.randomUUID(),
      sourceAccountId: j.sourceAccountId,
      destinationPayeeId: j.destinationPayeeId,
      amount: Math.floor(Number(j.amount)),
      currency: CURRENCY,
      memoShort: j.memoShort || "",
      memoLong: j.memoLong || "",
      expectedDate: j.expectedDate,
    }));
    // Import lands in a new list so it never overwrites one you already keep.
    update((s) => {
      const withList = Lists.addList(s, Lists.uniqueName(s, "匯入的清單"));
      return Lists.setJobs(withList, withList.activeListId, imported);
    });
  } catch (err) {
    e.textContent = `JSON 解析失敗：${err.message}`;
    e.hidden = false;
  }
}

function exportJson() {
  const list = activeList();
  const batch = { ...Lists.toBatch(list), name: list?.name };
  $("jsonArea").value = JSON.stringify(batch, null, 2);
}

function promptName(title, current) {
  const name = window.prompt(title, current ?? "");
  return name === null ? null : name;
}

async function init() {
  await loadConfig();
  await loadLists();
  fillSelects();
  renderLists();
  renderJobs();
  await checkActiveTab();
  renderJobs();

  $("listSelect").addEventListener("change", (e) =>
    update((s) => Lists.setActiveList(s, e.target.value)),
  );
  $("newList").addEventListener("click", () => {
    const name = promptName("新清單的名稱（例如：每月家用）", "");
    if (name === null) return;
    update((s) => Lists.addList(s, Lists.uniqueName(s, name)));
  });
  $("renameList").addEventListener("click", () => {
    const name = promptName("清單名稱", activeList()?.name);
    if (name === null) return;
    update((s) => Lists.renameList(s, s.activeListId, name));
  });
  $("dupList").addEventListener("click", () => update((s) => Lists.duplicateList(s, s.activeListId)));
  $("deleteList").addEventListener("click", () => {
    const list = activeList();
    const s = Lists.summarize(list);
    const msg =
      s.count > 0
        ? `刪除清單「${list.name}」？裡面的 ${s.count} 筆轉帳設定會一併移除。`
        : `刪除清單「${list.name}」？`;
    if (!window.confirm(msg)) return;
    update((st) => Lists.deleteList(st, st.activeListId));
  });

  $("addJob").addEventListener("click", addJob);
  $("startBatch").addEventListener("click", reviewBatch);
  $("confirmSend").addEventListener("click", confirmSend);
  $("cancelSend").addEventListener("click", cancelReview);
  $("clearJobs").addEventListener("click", () => {
    if (currentJobs().length === 0) return;
    if (!window.confirm(`清空清單「${activeList()?.name}」裡的 ${currentJobs().length} 筆轉帳？`)) return;
    update((s) => Lists.clearJobs(s, s.activeListId));
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
