// Origin and payee allowlisting. The extension only ever operates on the
// configured bank origin, and only ever selects payees that already exist in
// the bank's designated-payee list AND in the local config (SPEC sections 1/7).

import { findPayee } from "./policy.js";

/**
 * Is a hostname covered by one of the allowed suffixes?
 * e.g. host "ebank.esunbank.com.tw" matches suffix "esunbank.com.tw".
 * @param {string} hostname
 * @param {string[]} suffixes
 */
export function isHostAllowed(hostname, suffixes = []) {
  const h = String(hostname || "").toLowerCase();
  return suffixes.some((suffix) => {
    const s = String(suffix || "").toLowerCase().replace(/^\./, "");
    return h === s || h.endsWith(`.${s}`);
  });
}

/**
 * Is an origin (scheme + host) allowed by the config? HTTPS is required.
 * @param {string} origin e.g. "https://ebank.esunbank.com.tw"
 * @param {object} config
 */
export function isOriginAllowed(origin, config) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (config.bankOrigin && origin === new URL(config.bankOrigin).origin) return true;
  return isHostAllowed(url.hostname, config.allowedHostSuffixes || []);
}

/**
 * Only payees present in the local config are permitted as transfer targets.
 * @param {string} payeeId
 * @param {object} config
 */
export function isPayeeAllowed(payeeId, config) {
  return !!findPayee(config, payeeId);
}

/**
 * Fail-closed assertion used at runtime entry points.
 * @param {string} origin
 * @param {object} config
 */
export function assertOriginAllowed(origin, config) {
  if (!isOriginAllowed(origin, config)) {
    throw new Error(`origin not allowed: ${origin}`);
  }
}
