// Sanitizer. Every value that flows to the overlay, audit log, console, or any
// external surface (e.g. an optional Hermes summary) must pass through here.
// SPEC section 12.
//
// Rules:
//  - Full account numbers keep only the last 5 digits.
//  - Card numbers / national ID numbers are never stored.
//  - Raw DOM and hidden input values are never stored.

// Keys that must never be persisted/output, regardless of value.
const FORBIDDEN_KEYS = [
  "password",
  "passwd",
  "pwd",
  "otp",
  "otpcode",
  "smscode",
  "pin",
  "cvv",
  "cvc",
  "seed",
  "token",
  "accesstoken",
  "sessiontoken",
  "csrf",
  "csrftoken",
  "idnumber",
  "nationalid",
  "ssn",
  "cardnumber",
  "creditcard",
  "fullaccount",
  "accountnumber",
  "rawdom",
  "rawhtml",
  "outerhtml",
  "innerhtml",
  "html",
];

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_KEYS);

/**
 * Mask an account-like string, keeping only the trailing 5 digits.
 * Matches the reference implementation in SPEC section 12.1.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeAccount(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length <= 5 ? digits : `****${digits.slice(-5)}`;
}

/**
 * Return only the last 5 digits (no mask prefix). Useful for comparisons.
 * @param {string} value
 * @returns {string}
 */
export function last5(value) {
  return String(value ?? "").replace(/\D/g, "").slice(-5);
}

/**
 * Mask a payee name: keep the first visible character, replace the rest with *.
 * Works for CJK and latin names. Empty input returns empty string.
 * @param {string} name
 * @returns {string}
 */
export function maskName(name) {
  const chars = Array.from(String(name ?? "").trim());
  if (chars.length === 0) return "";
  if (chars.length === 1) return chars[0];
  return chars[0] + "*".repeat(chars.length - 1);
}

/**
 * Mask a bank reference / transaction id, keeping head and tail context only.
 * e.g. "ABC123456789" -> "ABC****789".
 * @param {string} ref
 * @returns {string}
 */
export function maskReference(ref) {
  const s = String(ref ?? "").trim();
  if (!s) return "";
  if (s.length <= 6) return s.replace(/.(?=.)/g, "*");
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
}

const NATIONAL_ID_RE = /\b[A-Z][12]\d{8}\b/g;
const LONG_DIGITS_RE = /\d{6,}/g;

/**
 * Redact free text before it is logged or shown: strips national IDs and any
 * run of 6+ digits (account / card numbers) down to a masked last-5 form.
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  return String(text ?? "")
    .replace(NATIONAL_ID_RE, "[ID]")
    .replace(LONG_DIGITS_RE, (m) => `****${m.slice(-5)}`);
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isForbiddenKey(key) {
  return FORBIDDEN_KEY_SET.has(String(key).toLowerCase().replace(/[^a-z]/g, ""));
}

// Field names whose values are account-like and should be masked (not dropped).
const ACCOUNT_FIELD_RE = /(account|payee|source|destination).*(no|num|number|account)?$/i;

/**
 * Recursively sanitize an object graph for safe persistence/output.
 *  - Forbidden keys are dropped entirely.
 *  - Account-like fields are masked to last 5.
 *  - Strings are run through redactText.
 *  - Functions / DOM nodes are dropped.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeDeep(value, depth = 0) {
  if (depth > 6) return undefined; // guard against cycles / huge graphs
  if (value == null) return value;

  const t = typeof value;
  if (t === "string") return redactText(value);
  if (t === "number" || t === "boolean") return value;
  if (t === "function" || t === "symbol" || t === "bigint") return undefined;

  // Drop anything that looks like a DOM node / element.
  if (typeof Node !== "undefined" && value instanceof Node) return undefined;
  if (value && typeof value === "object" && "nodeType" in value && "querySelector" in value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenKey(k)) continue;
    if (typeof v === "string" && ACCOUNT_FIELD_RE.test(k) && /\d/.test(v)) {
      out[k] = sanitizeAccount(v);
      continue;
    }
    const cleaned = sanitizeDeep(v, depth + 1);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}

/**
 * Sanitize an audit log entry prior to persistence. Thin wrapper over
 * sanitizeDeep that also guarantees the message string is redacted.
 * @param {object} entry
 * @returns {object}
 */
export function sanitizeLogEntry(entry) {
  const clean = sanitizeDeep(entry) || {};
  if (typeof clean.message === "string") clean.message = redactText(clean.message);
  return clean;
}
