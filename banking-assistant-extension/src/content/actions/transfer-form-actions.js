// Low-level DOM action helpers shared by bank adapters, plus the action
// allow/deny boundary (SPEC sections 1.2 / 18 / 19.5).
//
// The set of actions the extension may ever perform is closed and explicit.
// Anything resembling pressing the final confirm button, entering an OTP, or
// approving a push is in FORBIDDEN_ACTIONS and assertActionAllowed() throws for
// it. No adapter implements these, and tests verify they stay unimplemented.

export const ALLOWED_ACTIONS = Object.freeze([
  "navigateToTransferForm",
  "selectSourceAccount",
  "selectDestinationPayee",
  "fillAmount",
  "fillMemoShort",
  "fillMemoLong",
  "submitFormToVerificationPage",
  "navigateToNextTransfer",
  "readFinalBalance",
  "logout",
]);

// Actions that must never exist. Listed only to be explicitly rejected.
export const FORBIDDEN_ACTIONS = Object.freeze([
  "clickFinalConfirm",
  "confirmTransfer",
  "submitFinalTransfer",
  "fillOtp",
  "enterOtp",
  "approvePush",
  "bypassVerification",
  "confirmLogout",
]);

const ALLOWED_SET = new Set(ALLOWED_ACTIONS);
const FORBIDDEN_SET = new Set(FORBIDDEN_ACTIONS);

/**
 * Throw if an action name is not on the allow list. Fail closed: unknown names
 * are rejected too, not just explicitly-forbidden ones.
 * @param {string} name
 */
export function assertActionAllowed(name) {
  if (FORBIDDEN_SET.has(name)) {
    throw new Error(`forbidden action: ${name} (extension must never perform this)`);
  }
  if (!ALLOWED_SET.has(name)) {
    throw new Error(`unknown action: ${name}`);
  }
  return true;
}

/**
 * Set an input/textarea/select value in a way that frameworks (React/Vue) and
 * the bank's own listeners will observe: use the native value setter, then
 * dispatch input + change events.
 * @param {HTMLElement} el
 * @param {string|number} value
 */
export function setNativeValue(el, value) {
  if (!el) return false;
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  const tag = (el.tagName || "").toLowerCase();
  if (desc && desc.set) {
    desc.set.call(el, String(value));
  } else {
    el.value = String(value);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (tag === "select") el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Select an <option> by predicate and fire change events.
 * @param {HTMLSelectElement} select
 * @param {(opt: HTMLOptionElement) => boolean} predicate
 * @returns {boolean} whether a matching option was selected
 */
export function selectOptionBy(select, predicate) {
  if (!select || !select.options) return false;
  const options = Array.from(select.options);
  const match = options.find((opt) => {
    try {
      return predicate(opt);
    } catch {
      return false;
    }
  });
  if (!match) return false;
  select.value = match.value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Click an element, guarding against null. Returns whether a click happened.
 * @param {HTMLElement|null} el
 */
export function safeClick(el) {
  if (!el) return false;
  el.click();
  return true;
}
