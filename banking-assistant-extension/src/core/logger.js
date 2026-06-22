// Audit logger (SPEC section 4.7 / 12). Stores sanitized JSONL-friendly entries
// in chrome.storage.local when available, otherwise in memory (tests / demo).
// Nothing here ever writes a full account number, OTP, password, or raw DOM
// because every entry passes through sanitizeLogEntry first.

import { STORAGE_KEYS } from "./types.js";
import { sanitizeLogEntry } from "./sanitizer.js";

let seq = 0;
function nextEventId(nowIso) {
  seq += 1;
  return `evt_${nowIso.replace(/[^0-9]/g, "")}_${seq}`;
}

// In-memory fallback backend (no chrome).
function memoryBackend() {
  let buf = [];
  return {
    async append(entry) {
      buf.push(entry);
    },
    async all() {
      return buf.slice();
    },
    async clear() {
      buf = [];
    },
  };
}

// chrome.storage.local backed array under STORAGE_KEYS.AUDIT_LOG.
function chromeBackend(maxEntries) {
  const key = STORAGE_KEYS.AUDIT_LOG;
  return {
    async append(entry) {
      const cur = (await chrome.storage.local.get(key))[key] || [];
      cur.push(entry);
      // Cap to avoid unbounded growth.
      const trimmed = cur.slice(-maxEntries);
      await chrome.storage.local.set({ [key]: trimmed });
    },
    async all() {
      return (await chrome.storage.local.get(key))[key] || [];
    },
    async clear() {
      await chrome.storage.local.set({ [key]: [] });
    },
  };
}

export class AuditLogger {
  /**
   * @param {{backend?: object, maxEntries?: number, now?: () => Date}} [opts]
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? 1000;
    this.now = opts.now ?? (() => new Date());
    this.backend =
      opts.backend ??
      (typeof chrome !== "undefined" && chrome.storage?.local
        ? chromeBackend(this.maxEntries)
        : memoryBackend());
  }

  /**
   * Append a sanitized audit entry.
   * @param {string} eventType one of AUDIT_EVENT_TYPES
   * @param {object} [fields]
   * @returns {Promise<object>} the stored (sanitized) entry
   */
  async log(eventType, fields = {}) {
    const ts = this.now().toISOString();
    const raw = {
      eventId: nextEventId(ts),
      timestamp: ts,
      eventType,
      ...fields,
    };
    const entry = sanitizeLogEntry(raw);
    await this.backend.append(entry);
    return entry;
  }

  async getAll() {
    return this.backend.all();
  }

  async clear() {
    return this.backend.clear();
  }

  /**
   * Serialize the whole log as JSONL for download/export.
   * @returns {Promise<string>}
   */
  async toJSONL() {
    const all = await this.getAll();
    return all.map((e) => JSON.stringify(e)).join("\n");
  }
}
