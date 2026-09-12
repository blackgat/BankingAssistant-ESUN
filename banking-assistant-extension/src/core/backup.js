// Whole-extension backup and restore (pure).
//
// The Options page could already export and import AssistantConfig, but that
// left transferLists with no path in or out at all: the saved transfer lists
// could only be recovered by writing chrome.storage.local from a console. This
// module covers every key the extension owns, so a backup is a backup.
//
// Pure by design, like the rest of core/: it takes and returns plain objects and
// never touches chrome.* itself, which keeps it unit-testable off-browser.

import { isForbiddenKey } from "./sanitizer.js";
import { STORAGE_KEYS } from "./types.js";

export const BACKUP_FORMAT = "banking-assistant-backup";
export const BACKUP_VERSION = 1;

// The legacy single anonymous draft is deliberately absent. transferLists
// supersedes it, and restoring it would resurrect a draft the user has already
// migrated away from.
export const BACKUP_KEYS = Object.freeze([
  STORAGE_KEYS.CONFIG,
  STORAGE_KEYS.LISTS,
  STORAGE_KEYS.AUDIT_LOG,
]);

/**
 * Wrap the storage values in a self-describing envelope.
 * @param {object} storage values keyed as in chrome.storage.local
 * @param {string} [isoNow] timestamp to stamp, injectable for tests
 */
export function buildBackup(storage, isoNow) {
  const data = {};
  for (const key of BACKUP_KEYS) {
    if (storage && storage[key] !== undefined) data[key] = storage[key];
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: isoNow ?? new Date().toISOString(),
    data,
  };
}

// A backup must never carry credentials. The extension does not store any, so
// finding one means the file came from somewhere else and should be refused
// rather than quietly written into storage.
function assertNoForbiddenKeys(value, depth = 0, path = "") {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenKeys(v, depth + 1, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenKey(k)) {
      throw new Error(`不允許的欄位：${path ? `${path}.` : ""}${k}`);
    }
    assertNoForbiddenKeys(v, depth + 1, path ? `${path}.${k}` : k);
  }
}

/**
 * Validate a backup's shape without writing anything. Throws on anything it
 * would refuse to restore, so a bad file fails before storage is touched rather
 * than halfway through.
 *
 * Accepts a bare `{assistantConfig, ...}` object too, so a file written by hand
 * or by an older export still restores.
 *
 * @param {unknown} parsed already JSON.parse'd
 * @returns {{data: object, keys: string[]}}
 */
export function validateBackup(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("不是物件");
  }
  const envelope = parsed.format === BACKUP_FORMAT || parsed.data !== undefined;
  const data = envelope ? parsed.data : parsed;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("找不到 data 內容");
  }

  const keys = BACKUP_KEYS.filter((k) => data[k] !== undefined);
  if (keys.length === 0) {
    throw new Error(`沒有可還原的項目（預期 ${BACKUP_KEYS.join(" / ")} 其中之一）`);
  }

  assertNoForbiddenKeys(data);

  const config = data[STORAGE_KEYS.CONFIG];
  if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) {
    throw new Error("設定必須是物件");
  }
  const lists = data[STORAGE_KEYS.LISTS];
  if (lists !== undefined) {
    if (typeof lists !== "object" || lists === null || !Array.isArray(lists.lists)) {
      throw new Error("轉帳清單必須含有 lists 陣列");
    }
    for (const l of lists.lists) {
      if (!l || typeof l !== "object" || !Array.isArray(l.jobs)) {
        throw new Error("每份清單都必須含有 jobs 陣列");
      }
    }
  }
  const audit = data[STORAGE_KEYS.AUDIT_LOG];
  if (audit !== undefined && !Array.isArray(audit)) {
    throw new Error("稽核紀錄必須是陣列");
  }

  // Return only the keys a restore will actually write. For the bare-object form
  // "data" is the caller's whole file, which may carry keys this module does not
  // own (the legacy pendingBatch, or anything else someone put in the file) - and
  // a restore must write exactly what it says it will, nothing more.
  const picked = {};
  for (const key of keys) picked[key] = data[key];
  return { data: picked, keys };
}

/**
 * Human-readable description of what a validated backup would restore, so the
 * user can see it before confirming rather than after.
 */
export function describeBackup(data) {
  const parts = [];
  const config = data[STORAGE_KEYS.CONFIG];
  if (config) {
    const src = config.sourceAccounts?.length ?? 0;
    const payees = config.destinationPayees?.length ?? 0;
    parts.push(`設定（來源帳戶 ${src} 個、收款人 ${payees} 個）`);
  }
  const lists = data[STORAGE_KEYS.LISTS];
  if (lists) {
    const total = lists.lists.reduce((n, l) => n + l.jobs.length, 0);
    parts.push(`清單 ${lists.lists.length} 份、共 ${total} 筆轉帳`);
  }
  const audit = data[STORAGE_KEYS.AUDIT_LOG];
  if (audit) parts.push(`稽核紀錄 ${audit.length} 筆`);
  return parts.join("；");
}

/** Suggested filename for a downloaded backup. */
export function backupFilename(isoNow) {
  const stamp = (isoNow ?? new Date().toISOString()).slice(0, 10);
  return `banking-assistant-backup-${stamp}.json`;
}
