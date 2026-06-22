// Base bank adapter + a fully-worked EXAMPLE selector map (SPEC sections 6 / 11 / 19.2).
//
// All bank-specific knowledge lives in a plain `selectors` object. To support a
// new bank, copy EXAMPLE_SELECTORS, point the selectors at the real DOM, and
// construct `new BaseBankAdapter({ root, config, selectors })` (see
// bank-adapter.esun.js). No control-flow logic should need to change per bank.
//
// Every read method returns an ExtractionResult { value, confidence, missingFields }
// so callers can fail closed below the confidence threshold (SPEC section 11).
// Every action method funnels through assertActionAllowed() so the action
// boundary is enforced structurally. There is deliberately no method that
// presses the final confirm button or enters an OTP.

import { CURRENCY, PAGE_STATES, LOGIN_STATES } from "../../core/types.js";
import { last5 as toLast5, maskName, maskReference } from "../../core/sanitizer.js";
import {
  assertActionAllowed,
  setNativeValue,
  selectOptionBy,
  safeClick,
} from "../actions/transfer-form-actions.js";

/** Parse a localized amount string ("NT$ 12,345" / "12,345 元") into a number. */
export function parseAmount(text) {
  if (text == null) return NaN;
  // NFKC folds full-width digits/commas (e.g. "１，０００") to ASCII first.
  const cleaned = String(text).normalize("NFKC").replace(/[^\d.]/g, "");
  if (cleaned === "") return NaN;
  return Number(cleaned);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Example selector map. The structure is the contract; selectors are placeholders
 * matching tests/fixtures/*.html. Replace the right-hand values for a real bank.
 */
export const EXAMPLE_SELECTORS = Object.freeze({
  bankId: "example",
  login: {
    // Presence of any of these => logged in.
    loggedInMarkers: ["[data-action='logout']", ".ba-logout", ".user-greeting"],
    // Presence of any of these => logged out.
    loginFormMarkers: ["input[type='password']", ".login-form", "#login"],
  },
  pages: {
    [PAGE_STATES.HOME]: {
      require: [".account-row", "[data-nav='transfer']"],
      forbid: ["form.transfer-form", ".verification-summary"],
      text: null,
    },
    [PAGE_STATES.TRANSFER_FORM]: {
      require: ["form.transfer-form", ".ba-amount"],
      forbid: [".verification-summary", ".transfer-result"],
      text: null,
    },
    [PAGE_STATES.VERIFICATION]: {
      require: [".verification-summary"],
      forbid: [".transfer-result"],
      text: /(請確認|確認轉帳|交易驗證|驗證資料)/,
    },
    [PAGE_STATES.COMPLETION]: {
      require: [".transfer-result"],
      forbid: [],
      text: /(交易完成|轉帳成功|交易成功)/,
    },
    [PAGE_STATES.LOGOUT_CONFIRM]: {
      require: [".logout-confirm"],
      forbid: [],
      text: /(確定登出|確認登出)/,
    },
  },
  accounts: {
    rowSelector: ".account-row",
    nameSelector: ".account-name",
    balanceSelector: ".account-balance",
    last5Attr: "data-account-last5",
  },
  payees: {
    // The designated-payee <select> on the transfer form.
    selectSelector: "select.ba-payee",
    optionLast5Attr: "data-last5",
    optionNameAttr: "data-name",
  },
  form: {
    navToTransfer: "[data-nav='transfer']",
    sourceSelect: "select.ba-source",
    sourceOptionLast5Attr: "data-last5",
    payeeSelect: "select.ba-payee",
    amountInput: ".ba-amount",
    memoShortInput: ".ba-memo-short",
    memoLongInput: ".ba-memo-long",
    // Advances to the bank verification page. This must NOT be the final
    // confirm button.
    submitToVerification: ".ba-next",
  },
  verification: {
    container: ".verification-summary",
    sourceLast5: "[data-field='source-last5']",
    payeeName: "[data-field='payee-name']",
    destLast5: "[data-field='dest-last5']",
    amount: "[data-field='amount']",
    memoShort: "[data-field='memo-short']",
    memoLong: "[data-field='memo-long']",
  },
  completion: {
    container: ".transfer-result",
    reference: "[data-field='reference']",
    completionText: "[data-field='completion-text']",
    nextTransfer: "[data-action='next-transfer']",
  },
  logout: {
    trigger: "[data-action='logout']",
  },
});

export class BaseBankAdapter {
  /**
   * @param {{ root?: Document|HTMLElement, config: object, selectors: object }} opts
   */
  constructor({ root, config, selectors }) {
    this.root = root || (typeof document !== "undefined" ? document : null);
    this.config = config;
    this.selectors = selectors;
    this.bankId = selectors.bankId;
  }

  // --- DOM helpers ----------------------------------------------------------

  _q(sel) {
    return sel && this.root ? this.root.querySelector(sel) : null;
  }

  _qa(sel) {
    return sel && this.root ? Array.from(this.root.querySelectorAll(sel)) : [];
  }

  _present(sel) {
    return !!this._q(sel);
  }

  _text(el) {
    return (el?.textContent || "").trim();
  }

  _bodyText() {
    if (!this.root) return "";
    const el = this.root.body || this.root.documentElement || this.root;
    return (el.textContent || "").trim();
  }

  // --- Page / login detection ----------------------------------------------

  detectLoginState() {
    const { loggedInMarkers, loginFormMarkers, logoutTextPattern } = this.selectors.login;
    if (loggedInMarkers.some((s) => this._present(s))) return LOGIN_STATES.LOGGED_IN;
    if (loginFormMarkers.some((s) => this._present(s))) return LOGIN_STATES.LOGGED_OUT;
    // Heuristic fallback for when the configured markers don't match: a visible
    // logout control plus no password field implies a logged-in session. Make
    // the markers precise (see ESUN_SELECTORS) so this fallback is rarely needed.
    const pattern = logoutTextPattern || /登出|登出系統|安全登出|logout|sign\s*out/i;
    const hasLogout = this._qa("a, button, [role='button'], input[type='button'], input[type='submit']").some(
      (el) => pattern.test((el.textContent || "") + " " + (el.value || "")),
    );
    if (hasLogout && !this._present("input[type='password']")) return LOGIN_STATES.LOGGED_IN;
    return LOGIN_STATES.UNKNOWN;
  }

  /** Score each page definition and return { state, confidence }. */
  detectPageStateDetailed() {
    const text = this._bodyText();
    const scored = [];
    for (const [state, def] of Object.entries(this.selectors.pages)) {
      const requires = def.require || [];
      const forbids = def.forbid || [];
      if (forbids.some((s) => this._present(s))) continue; // disqualified
      const matched = requires.filter((s) => this._present(s)).length;
      if (requires.length > 0 && matched === 0) continue; // no anchor present
      const structural = requires.length ? matched / requires.length : 0;
      const textOk = def.text ? def.text.test(text) : null;
      // Weight structure 0.7, text 0.3. A page def with no text rule keeps full
      // structural weight.
      let score;
      if (def.text) score = structural * 0.7 + (textOk ? 0.3 : 0);
      else score = structural;
      scored.push({ state, score });
    }
    if (scored.length === 0) return { state: PAGE_STATES.UNKNOWN, confidence: 0 };
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    // Fail closed on weak or ambiguous detection.
    if (best.score < 0.6) return { state: PAGE_STATES.UNKNOWN, confidence: best.score };
    if (second && Math.abs(best.score - second.score) < 0.1) {
      return { state: PAGE_STATES.UNKNOWN, confidence: best.score };
    }
    return { state: best.state, confidence: best.score };
  }

  detectPageState() {
    return this.detectPageStateDetailed().state;
  }

  // --- Reads (return ExtractionResult) -------------------------------------

  readSourceAccounts() {
    const { rowSelector, nameSelector, balanceSelector, last5Attr } = this.selectors.accounts;
    const rows = this._qa(rowSelector);
    const missingFields = [];
    const value = rows.map((row) => {
      const displayName = this._text(row.querySelector(nameSelector));
      const balanceText = this._text(row.querySelector(balanceSelector));
      const attrLast5 = row.getAttribute(last5Attr);
      const accountLast5 = attrLast5 || toLast5(displayName) || undefined;
      const balance = parseAmount(balanceText);
      if (!displayName) missingFields.push("displayName");
      return {
        displayName,
        accountLast5,
        currency: CURRENCY,
        balance: Number.isNaN(balance) ? undefined : balance,
      };
    });
    const confidence = rows.length > 0 && missingFields.length === 0 ? 1 : rows.length ? 0.7 : 0;
    return { value, confidence, missingFields };
  }

  /**
   * @param {object} sourceAccount configured SourceAccount
   * @returns {{value: object|null, confidence: number, missingFields: string[]}}
   */
  readBalance(sourceAccount) {
    const accounts = this.readSourceAccounts().value || [];
    const candidates = accounts.filter((a) => this._matchesAccount(sourceAccount, a));
    if (candidates.length === 0) {
      return { value: null, confidence: 0, missingFields: ["account_not_found"] };
    }
    if (candidates.length > 1) {
      // Ambiguous match => fail closed (SPEC section 16).
      return { value: null, confidence: 0.3, missingFields: ["ambiguous_account_match"] };
    }
    const a = candidates[0];
    if (a.balance == null || Number.isNaN(a.balance)) {
      return { value: null, confidence: 0.4, missingFields: ["balance"] };
    }
    const value = {
      sourceAccountId: sourceAccount.id,
      displayName: a.displayName,
      accountLast5: a.accountLast5,
      balance: a.balance,
      currency: CURRENCY,
      observedAt: nowIso(),
    };
    // High confidence when last-5 corroborates the match.
    const confidence = a.accountLast5 && a.accountLast5 === sourceAccount.accountLast5 ? 0.98 : 0.92;
    return { value, confidence, missingFields: [] };
  }

  readDestinationPayees() {
    const { selectSelector, optionLast5Attr, optionNameAttr } = this.selectors.payees;
    const select = this._q(selectSelector);
    if (!select) return { value: [], confidence: 0, missingFields: ["payee_select"] };
    const value = Array.from(select.options)
      .filter((opt) => opt.value !== "")
      .map((opt) => ({
        displayName: opt.getAttribute(optionNameAttr) || this._text(opt),
        accountLast5: opt.getAttribute(optionLast5Attr) || toLast5(opt.textContent) || undefined,
        currency: CURRENCY,
      }));
    return { value, confidence: value.length ? 1 : 0.5, missingFields: [] };
  }

  readVerificationSummary() {
    const v = this.selectors.verification;
    const container = this._q(v.container);
    if (!container) {
      return { value: null, confidence: 0, missingFields: ["verification_container"] };
    }
    const pick = (sel) => this._text(container.querySelector(sel));
    const amount = parseAmount(pick(v.amount));
    const destLast5Raw = pick(v.destLast5);
    const srcLast5Raw = pick(v.sourceLast5);
    const payeeNameRaw = pick(v.payeeName);
    const memoShortRaw = v.memoShort ? pick(v.memoShort) : "";
    const memoLongRaw = v.memoLong ? pick(v.memoLong) : "";

    const missingFields = [];
    if (Number.isNaN(amount)) missingFields.push("amount");
    if (!destLast5Raw) missingFields.push("destinationAccountLast5");
    if (!payeeNameRaw) missingFields.push("destinationPayeeName");

    const value = {
      sourceAccountLast5: srcLast5Raw ? toLast5(srcLast5Raw) : undefined,
      destinationPayeeNameMasked: maskName(payeeNameRaw),
      destinationAccountLast5: destLast5Raw ? toLast5(destLast5Raw) : undefined,
      amount: Number.isNaN(amount) ? undefined : amount,
      currency: CURRENCY,
      memoShort: memoShortRaw || undefined,
      memoLong: memoLongRaw || undefined,
      pageState: PAGE_STATES.VERIFICATION,
    };
    // Confidence is the fraction of critical fields present.
    const critical = 3; // amount, destLast5, payeeName
    const present = critical - missingFields.filter((f) => f !== "memoShort" && f !== "memoLong").length;
    const confidence = present / critical;
    return { value, confidence, missingFields };
  }

  readCompletion() {
    const c = this.selectors.completion;
    const container = this._q(c.container);
    if (!container) {
      return { value: null, confidence: 0, missingFields: ["completion_container"] };
    }
    const refText = c.reference ? this._text(container.querySelector(c.reference)) : "";
    const completionText = c.completionText
      ? this._text(container.querySelector(c.completionText)) || this._text(container)
      : this._text(container);
    const value = {
      pageState: PAGE_STATES.COMPLETION,
      bankReferenceMasked: refText ? maskReference(refText) : undefined,
      completionText,
      completedAt: nowIso(),
    };
    const confidence = completionText ? (refText ? 0.98 : 0.9) : 0.5;
    return { value, confidence, missingFields: completionText ? [] : ["completion_text"] };
  }

  // --- Spec-named convenience wrappers (value-or-null) ----------------------

  extractSourceAccounts() {
    return this.readSourceAccounts().value;
  }

  async extractCurrentBalance(sourceAccountId) {
    const src = (this.config.sourceAccounts || []).find((s) => s.id === sourceAccountId);
    if (!src) return null;
    return (await this.readBalance(src)).value;
  }

  extractDestinationPayees() {
    return this.readDestinationPayees().value;
  }

  extractVerificationSummary() {
    return this.readVerificationSummary().value;
  }

  extractCompletionResult() {
    return this.readCompletion().value;
  }

  // --- Matching helpers -----------------------------------------------------

  _matchesAccount(configAccount, observed) {
    if (configAccount.accountLast5 && observed.accountLast5) {
      if (configAccount.accountLast5 === observed.accountLast5) return true;
    }
    if (configAccount.displayNamePattern && observed.displayName) {
      const pat = configAccount.displayNamePattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      if (new RegExp(`^${pat}$`).test(observed.displayName)) return true;
    }
    return false;
  }

  // --- Actions (all funnel through assertActionAllowed) ---------------------

  async navigateToTransferForm() {
    assertActionAllowed("navigateToTransferForm");
    if (this.detectPageState() === PAGE_STATES.TRANSFER_FORM) {
      return { ok: true, message: "already on transfer form" };
    }
    const ok = safeClick(this._q(this.selectors.form.navToTransfer));
    return { ok, message: ok ? "navigated to transfer form" : "transfer nav not found" };
  }

  async selectSourceAccount(sourceAccount) {
    assertActionAllowed("selectSourceAccount");
    const select = this._q(this.selectors.form.sourceSelect);
    const attr = this.selectors.form.sourceOptionLast5Attr;
    const ok = selectOptionBy(select, (opt) => {
      const optLast5 = opt.getAttribute(attr) || toLast5(opt.textContent);
      if (sourceAccount.accountLast5 && optLast5 === sourceAccount.accountLast5) return true;
      return this._matchesAccount(sourceAccount, {
        displayName: opt.textContent.trim(),
        accountLast5: optLast5,
      });
    });
    return { ok, message: ok ? "source selected" : "source option not found" };
  }

  async selectDestinationPayee(payee) {
    assertActionAllowed("selectDestinationPayee");
    const select = this._q(this.selectors.form.payeeSelect);
    const attr = this.selectors.payees.optionLast5Attr;
    const ok = selectOptionBy(select, (opt) => {
      const optLast5 = opt.getAttribute(attr) || toLast5(opt.textContent);
      if (payee.accountLast5 && optLast5 === payee.accountLast5) return true;
      return this._matchesAccount(payee, {
        displayName: opt.textContent.trim(),
        accountLast5: optLast5,
      });
    });
    return { ok, message: ok ? "payee selected" : "payee option not found" };
  }

  async fillAmount(amount) {
    assertActionAllowed("fillAmount");
    const ok = setNativeValue(this._q(this.selectors.form.amountInput), amount);
    return { ok, message: ok ? "amount filled" : "amount field not found" };
  }

  async fillMemoShort(memo) {
    assertActionAllowed("fillMemoShort");
    const el = this._q(this.selectors.form.memoShortInput);
    if (!el) return { ok: false, message: "memo short field not found" };
    setNativeValue(el, memo ?? "");
    return { ok: true, message: "memo short filled" };
  }

  async fillMemoLong(memo) {
    assertActionAllowed("fillMemoLong");
    const el = this._q(this.selectors.form.memoLongInput);
    if (!el) return { ok: false, message: "memo long field not found" };
    setNativeValue(el, memo ?? "");
    return { ok: true, message: "memo long filled" };
  }

  async submitFormToVerificationPage() {
    assertActionAllowed("submitFormToVerificationPage");
    // This advances to the bank's verification/confirm page. It is NOT the final
    // transfer confirmation. The user authorizes from there.
    const ok = safeClick(this._q(this.selectors.form.submitToVerification));
    return { ok, message: ok ? "submitted to verification page" : "submit button not found" };
  }

  async navigateToNextTransfer() {
    assertActionAllowed("navigateToNextTransfer");
    const ok = safeClick(this._q(this.selectors.completion.nextTransfer));
    return { ok, message: ok ? "navigating to next transfer" : "next-transfer link not found" };
  }

  async readFinalBalance(sourceAccount) {
    assertActionAllowed("readFinalBalance");
    return (await this.readBalance(sourceAccount)).value;
  }

  async logout() {
    assertActionAllowed("logout");
    // Click logout. If the bank shows a logout confirmation, we stop and let the
    // user confirm it manually (SPEC section 1.1).
    const ok = safeClick(this._q(this.selectors.logout.trigger));
    const requiresUserConfirm = this.detectPageState() === PAGE_STATES.LOGOUT_CONFIRM;
    return {
      ok,
      requiresUserConfirm,
      message: ok
        ? requiresUserConfirm
          ? "logout clicked; user must confirm logout"
          : "logout clicked"
        : "logout trigger not found",
    };
  }
}
