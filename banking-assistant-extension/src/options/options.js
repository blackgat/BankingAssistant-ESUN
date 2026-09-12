// Options page: edit the AssistantConfig (SPEC section 14). Never stores bank
// passwords, OTP seeds, or full account numbers - accounts are identified by a
// display-name pattern and the masked last 5 digits only.

import { STORAGE_KEYS, DEFAULT_CONFIG, CURRENCY } from "../core/types.js";
import {
  BACKUP_KEYS,
  buildBackup,
  validateBackup,
  describeBackup,
  backupFilename,
} from "../core/backup.js";

const $ = (id) => document.getElementById(id);
let config = structuredClone(DEFAULT_CONFIG);

function field(labelText, value, attrs = {}) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.value = value ?? "";
  for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
  label.appendChild(input);
  return { label, input };
}

function makeSourceRow(acct = {}) {
  const row = document.createElement("div");
  row.className = "itemrow";
  const label = field("名稱 label", acct.label);
  const pattern = field("顯示名稱樣式 displayNamePattern", acct.displayNamePattern, { placeholder: "活期存款*12345" });
  const last5 = field("末 5 碼 accountLast5", acct.accountLast5, { maxlength: "5", inputmode: "numeric" });
  const minBal = field("最低保留餘額 minimumRemainingBalance", acct.minimumRemainingBalance ?? 0, { type: "number", min: "0" });
  const id = field("id（留空自動產生）", acct.id);
  id.label.classList.add("full");
  pattern.label.classList.add("full");
  const rm = document.createElement("button");
  rm.className = "rm";
  rm.textContent = "刪除";
  rm.addEventListener("click", () => row.remove());
  row.append(label.label, last5.label, pattern.label, minBal.label, id.label, rm);
  row._read = () => ({
    id: id.input.value.trim() || slug(label.input.value),
    label: label.input.value.trim(),
    displayNamePattern: pattern.input.value.trim(),
    accountLast5: last5.input.value.trim() || undefined,
    currency: CURRENCY,
    minimumRemainingBalance: Number(minBal.input.value) || 0,
  });
  return row;
}

function makePayeeRow(p = {}) {
  const row = document.createElement("div");
  row.className = "itemrow";
  const label = field("名稱 label", p.label);
  const pattern = field("顯示名稱樣式 displayNamePattern", p.displayNamePattern, { placeholder: "張*67890" });
  const last5 = field("末 5 碼 accountLast5", p.accountLast5, { maxlength: "5", inputmode: "numeric" });
  const perTxn = field("單筆上限 maxAmountPerTxn", p.maxAmountPerTxn ?? 0, { type: "number", min: "0" });
  const perDay = field("單日上限 maxAmountPerDay（選填）", p.maxAmountPerDay ?? "", { type: "number", min: "0" });
  const id = field("id（留空自動產生）", p.id);
  id.label.classList.add("full");
  pattern.label.classList.add("full");
  const rm = document.createElement("button");
  rm.className = "rm";
  rm.textContent = "刪除";
  rm.addEventListener("click", () => row.remove());
  row.append(label.label, last5.label, pattern.label, perTxn.label, perDay.label, id.label, rm);
  row._read = () => {
    const out = {
      id: id.input.value.trim() || slug(label.input.value),
      label: label.input.value.trim(),
      displayNamePattern: pattern.input.value.trim(),
      accountLast5: last5.input.value.trim() || undefined,
      currency: CURRENCY,
      maxAmountPerTxn: Number(perTxn.input.value) || 0,
    };
    if (perDay.input.value !== "") out.maxAmountPerDay = Number(perDay.input.value);
    return out;
  };
  return row;
}

function slug(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || `id_${Math.abs(hash(String(s)))}`
  );
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function render() {
  $("bankId").value = config.bankId || "";
  $("bankOrigin").value = config.bankOrigin || "";
  $("allowedHostSuffixes").value = (config.allowedHostSuffixes || []).join(", ");
  $("verificationTimeoutSec").value = Math.round((config.behavior?.verificationTimeoutMs ?? 30000) / 1000);
  $("completionTimeoutMin").value = Math.round((config.behavior?.completionTimeoutMs ?? 300000) / 60000);
  $("memoShortMaxLen").value = config.behavior?.memoShortMaxLen ?? 20;
  $("memoLongMaxLen").value = config.behavior?.memoLongMaxLen ?? 60;
  $("maxJobsPerBatch").value = config.globalLimits?.maxJobsPerBatch ?? 20;
  $("overlayDismissSec").value = Math.round((config.behavior?.overlayDismissMs ?? 3000) / 1000);
  $("requireBalanceCheck").checked = config.behavior?.requireBalanceCheck !== false;
  $("autoLogout").checked = config.behavior?.autoLogout !== false;

  const sl = $("sourceList");
  const pl = $("payeeList");
  sl.innerHTML = "";
  pl.innerHTML = "";
  for (const a of config.sourceAccounts || []) sl.appendChild(makeSourceRow(a));
  for (const p of config.destinationPayees || []) pl.appendChild(makePayeeRow(p));
}

function gather() {
  const sources = Array.from($("sourceList").children).map((r) => r._read());
  const payees = Array.from($("payeeList").children).map((r) => r._read());
  return {
    bankId: $("bankId").value.trim(),
    bankOrigin: $("bankOrigin").value.trim(),
    allowedHostSuffixes: $("allowedHostSuffixes").value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sourceAccounts: sources,
    destinationPayees: payees,
    globalLimits: { maxJobsPerBatch: Number($("maxJobsPerBatch").value) || 20 },
    behavior: {
      verificationTimeoutMs: (Number($("verificationTimeoutSec").value) || 30) * 1000,
      completionTimeoutMs: (Number($("completionTimeoutMin").value) || 5) * 60000,
      memoShortMaxLen: Number($("memoShortMaxLen").value) || 20,
      memoLongMaxLen: Number($("memoLongMaxLen").value) || 60,
      requireBalanceCheck: $("requireBalanceCheck").checked,
      autoLogout: $("autoLogout").checked,
      overlayDismissMs: (() => {
        const sec = Number($("overlayDismissSec").value);
        return (Number.isFinite(sec) && sec >= 0 ? sec : 3) * 1000;
      })(),
    },
  };
}

async function save() {
  config = gather();
  await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: config });
  const s = $("saveStatus");
  s.textContent = "已儲存。";
  s.className = "status ok";
  setTimeout(() => (s.textContent = ""), 2500);
}

function exportConfig() {
  $("configArea").value = JSON.stringify(gather(), null, 2);
  setIo("已輸出目前設定到下方文字框。", "ok");
}

async function importConfig() {
  try {
    const parsed = JSON.parse($("configArea").value);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    // Defensive: never accept credential-like keys.
    for (const k of Object.keys(parsed)) {
      if (/pass|otp|seed|token/i.test(k)) throw new Error(`不允許的欄位：${k}`);
    }
    config = { ...DEFAULT_CONFIG, ...parsed };
    render();
    setIo("已匯入，請檢查後按「儲存設定」。", "ok");
  } catch (e) {
    setIo(`匯入失敗：${e.message}`, "err");
  }
}

// Whole-extension backup. "匯入設定 JSON" only fills the form and still needs
// "儲存設定" pressed afterwards; these two deliberately do not work that way -
// the restore writes storage itself, because a restore that silently did nothing
// is exactly the trap worth removing.
async function exportAll() {
  const stored = await chrome.storage.local.get([...BACKUP_KEYS]);
  const backup = buildBackup(stored);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFilename();
  a.click();
  URL.revokeObjectURL(url);
  setIo(`已下載備份：${describeBackup(backup.data) || "（儲存區是空的）"}`, "ok");
}

async function importAll() {
  try {
    const { data, keys } = validateBackup(JSON.parse($("configArea").value));
    const ok = confirm(
      `即將還原：${describeBackup(data)}

` +
        "這會覆蓋目前的設定與轉帳清單，且無法復原。要繼續嗎？",
    );
    if (!ok) {
      setIo("已取消，未變更任何資料。", "");
      return;
    }
    await chrome.storage.local.set(data);
    // Report what storage actually holds now, not what we just sent it, so a
    // write that failed cannot read as success.
    const back = await chrome.storage.local.get(keys);
    config = { ...DEFAULT_CONFIG, ...(back[STORAGE_KEYS.CONFIG] ?? {}) };
    render();
    setIo(`已還原並寫入：${describeBackup(back)}`, "ok");
  } catch (err) {
    setIo(`還原失敗：${err.message}`, "err");
  }
}

async function downloadAudit() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.AUDIT_LOG);
  const log = r[STORAGE_KEYS.AUDIT_LOG] || [];
  const jsonl = log.map((e) => JSON.stringify(e)).join("\n");
  const blob = new Blob([jsonl], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `banking-assistant-audit-${Date.now()}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
  setIo(`已下載 ${log.length} 筆稽核紀錄。`, "ok");
}

async function clearAudit() {
  await chrome.storage.local.set({ [STORAGE_KEYS.AUDIT_LOG]: [] });
  setIo("稽核紀錄已清除。", "ok");
}

function setIo(msg, cls) {
  const e = $("ioStatus");
  e.textContent = msg;
  e.className = `status ${cls || ""}`;
}

async function init() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  config = r[STORAGE_KEYS.CONFIG] || structuredClone(DEFAULT_CONFIG);
  render();
  $("addSource").addEventListener("click", () => $("sourceList").appendChild(makeSourceRow()));
  $("addPayee").addEventListener("click", () => $("payeeList").appendChild(makePayeeRow()));
  $("save").addEventListener("click", save);
  $("exportConfig").addEventListener("click", exportConfig);
  $("importConfig").addEventListener("click", importConfig);
  $("exportAll").addEventListener("click", exportAll);
  $("importAll").addEventListener("click", importAll);
  $("downloadAudit").addEventListener("click", downloadAudit);
  $("clearAudit").addEventListener("click", clearAudit);
}

init();
