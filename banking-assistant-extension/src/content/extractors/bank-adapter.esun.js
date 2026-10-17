// E.SUN (玉山銀行) adapter.
//
// =====================================================================
//  Rewritten 2026-10-17 for E.SUN's redesign. The bank replaced a JSF
//  widget inside a same-origin iframe with a Vue single-page app at
//  /esb/, so nothing below survives from the previous adapter except the
//  shape of its contract with the runner.
//
//  What the redesign changed, and why this file looks the way it does:
//    - There is no iframe. The app is the top document.
//    - The wizard step is in the URL (/deposit/twd-transfer/edit|confirm),
//      which is a far steadier signal than the step text it replaces.
//    - Source and payee are readOnly combo inputs that open a dialog; their
//      value cannot be set directly.
//    - 下一步 (advance) and 立即交易 (execute the transfer) share the class
//      btn-main-fill, so buttons are matched on text and never on class.
//    - The session logs itself out on a timer and warns with a dialog that
//      can appear mid-batch.
//
//  Verified on the live bank 2026-10-17 by read-only probes: routes, login
//  marker, form controls, both radio groups, the picker dialog, the confirm
//  step and its buttons. NOT verified: the completion step, which needs a
//  real transfer — readCompletion fails closed until it is.
//
//  DOM evidence and re-inspection probes: docs/ESUN-INTEGRATION-NOTES.md §11.
// =====================================================================

import { PAGE_STATES, CURRENCY, LOGIN_STATES } from "../../core/types.js";
import { last5 as toLast5, maskName, maskReference } from "../../core/sanitizer.js";
import { BaseBankAdapter, parseAmount } from "./bank-adapter.example.js";
import { assertActionAllowed, setNativeValue, safeClick } from "../actions/transfer-form-actions.js";

/**
 * Button labels this adapter must never click, whatever the selector that
 * reached them. 立即交易 executes the transfer; 立即登出 ends the session in the
 * middle of a batch. Checked on every click rather than trusted to callers.
 */
const REFUSED_BUTTON_TEXT = /立即交易|立即登出|確認轉帳|確認送出/;

export const ESUN_SELECTORS = Object.freeze({
  bankId: "esun",

  // The step lives in the path now. Matching the route is both cheaper and
  // steadier than reading Chinese step text out of the DOM.
  routes: {
    app: /^\/esb(\/|$)/,
    transferForm: /\/deposit\/twd-transfer\/edit\b/,
    verification: /\/deposit\/twd-transfer\/confirm\b/,
    // Unconfirmed: the third step has not been observed. Kept broad on purpose
    // and corroborated by text before it is believed.
    completion: /\/deposit\/twd-transfer\/(result|finish|success|complete)\b/,
  },

  login: {
    // a.log_out is gone. The header's 登出 control is the marker; match its
    // text, because the control is a div and its classes are generic.
    logoutText: /^登出$/,
    headerScope: "header, [class*='header']",
    countdown: ".countdown-block",
    loggedInMarkers: [".header-option-entry-button", ".ba-logout"],
    loginFormMarkers: ["input[type='password'].login", ".login-form", "#loginForm"],
    logoutTextPattern: /登出|logout|sign\s*out/i,
  },

  // The session expires on a timer and warns first. The dialog sits in the DOM
  // hidden, so presence alone means nothing — it has to be visible.
  session: {
    warningText: /即將被登出/,
    keepAliveText: /繼續使用/,
    logoutNowText: /立即登出/,
  },

  nav: {
    // 臺, not 台. The entry is a button, not a menu link.
    transferButtonText: /臺幣轉帳|台幣轉帳/,
  },

  // Source and payee pickers. The trigger is readOnly; clicking it opens a
  // dialog whose rows read "<account number> <nickname>".
  combo: {
    trigger: "input.combo-input",
    wrapper: "[class*='combo-input-wrapper']",
    openClass: "modal-open",
    modal: ".combo-modal",
    row: "li[role='button']",
    selectedRow: "li.selected",
    closeButton: ".modal-header button[aria-label='關閉']",
  },

  // Placeholders identify the fields more reliably than the surrounding labels,
  // which are shared between the two memo inputs.
  placeholders: {
    source: /請選擇轉出帳號/,
    payee: /請選擇轉入帳號/,
    amount: /請輸入轉帳金額/,
    memo: /個中英數字/,
  },

  labels: {
    source: /轉出帳號/,
    payee: /轉入帳號/,
    amount: /轉帳金額/,
    memoSelf: /備註給自己|給自己/,
    memoOther: /備註給對方|給對方/,
  },

  // Two independent radio groups now, not one choice. Picking across them was
  // what the old single `modes` map did by accident.
  modes: {
    payeeSource: { recent: /最近轉帳/, designated: /常用|約定/, manual: /自行輸入/ },
    timing: { instant: /即時轉帳/, scheduledOnce: /預約單日/, scheduledCycle: /預約週期/ },
  },

  submit: {
    // Text only. btn-main-fill is also the class of 立即交易 on the confirm step.
    nextText: /^下一步$/,
  },

  balance: { label: /可用餘額/ },

  confirmStep: {
    labelCell: ".info-header",
    // An empty memo renders as "-" on the confirm step, not as an empty string.
    emptyValue: "-",
  },

  logout: { triggerText: /^登出$/ },

  // --- generic fallbacks ---------------------------------------------------
  // These describe the offline demo bank in tests/fixtures, not E.SUN. They are
  // not leftovers from the old site: the fixtures exist so the runner can be
  // exercised end to end without a bank at all, which is independent of what
  // E.SUN does to its markup. Every override below delegates to the base
  // adapter when it does not recognise the live site, and these are what the
  // base adapter then reads.
  accounts: { rowSelector: ".account-row", nameSelector: ".account-name", balanceSelector: ".account-balance", last5Attr: "data-account-last5" },
  payees: { selectSelector: "select.ba-payee", optionLast5Attr: "data-last5", optionNameAttr: "data-name" },
  form: {
    navToTransfer: "[data-nav='transfer']",
    sourceSelect: "select.ba-source",
    sourceOptionLast5Attr: "data-last5",
    payeeSelect: "select.ba-payee",
    amountInput: ".ba-amount",
    memoShortInput: ".ba-memo-short",
    memoLongInput: ".ba-memo-long",
    submitToVerification: ".ba-next",
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
      text: /(請確認|確認轉帳|交易驗證|驗證資料|確認交易)/,
    },
    [PAGE_STATES.COMPLETION]: {
      require: [".transfer-result"],
      forbid: [],
      text: /(交易完成|轉帳成功|交易成功|完成)/,
    },
    [PAGE_STATES.LOGOUT_CONFIRM]: {
      require: [".logout-confirm"],
      forbid: [],
      text: /(確定登出|確認登出|是否登出)/,
    },
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
});

export class EsunAdapter extends BaseBankAdapter {
  constructor({ root, config } = {}) {
    super({ root, config, selectors: ESUN_SELECTORS });
  }

  // --- small helpers -------------------------------------------------------

  get _doc() {
    return this.root?.ownerDocument || this.root || document;
  }

  _path() {
    try {
      return this._doc.defaultView?.location?.pathname || "";
    } catch {
      return "";
    }
  }

  /** True when the document actually performs layout (a browser, not jsdom). */
  _hasLayout() {
    return (this._doc.documentElement?.clientHeight || 0) > 0;
  }

  /**
   * Hidden means declared hidden, not merely measuring zero.
   *
   * The session-timeout dialog sits in the DOM hidden, so presence alone cannot
   * be trusted — but geometry cannot be trusted either: under jsdom every
   * element reports no client rects and a null offsetParent, which would mark
   * the whole page invisible. So read the declared style always, and consult
   * geometry only where something is really being laid out.
   */
  _visible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    const cs = this._doc.defaultView?.getComputedStyle?.(el);
    if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")) return false;
    if (this._hasLayout()) return el.offsetParent !== null || el.getClientRects().length > 0;
    return true;
  }

  _textOf(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  /**
   * Poll until `fn` returns something truthy or the deadline passes.
   *
   * Everything that waits on this app goes through here. The picker dialog was
   * observed absent from a querySelector while plainly open on screen — it is
   * re-rendered rather than shown — so a single check can miss a thing that is
   * there. "Not found yet" means keep waiting, never "not there".
   */
  async _poll(fn, { timeoutMs = 6000, everyMs = 120 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        // A mid-render DOM can throw; that is also "not yet".
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  /** Click, refusing the buttons that must never be pressed by this extension. */
  _click(el) {
    if (!el) return false;
    const label = this._textOf(el) || el.getAttribute?.("aria-label") || "";
    if (REFUSED_BUTTON_TEXT.test(label)) {
      throw new Error(`refused to click a forbidden control: ${label.slice(0, 20)}`);
    }
    return safeClick(el);
  }

  /**
   * Whether this document is E.SUN's live app.
   *
   * Everything below delegates to the base adapter when this is false, so the
   * offline fixtures and the demo keep working unchanged — and so none of the
   * live-site polling runs against a page that will never satisfy it.
   */
  _isEsunApp() {
    if (this.selectors.routes.app.test(this._path())) return true;
    return !!this._doc.querySelector(this.selectors.combo.trigger);
  }

  _all(sel) {
    return Array.from(this._doc.querySelectorAll(sel));
  }

  /** Leaf element whose trimmed text matches, searched in document order. */
  _leafByText(re, max = 40) {
    return this._all("*").find(
      (e) => e.children.length === 0 && re.test(this._textOf(e)) && this._textOf(e).length <= max,
    );
  }

  _inputByPlaceholder(re) {
    return this._all("input,textarea").find((i) => re.test(i.placeholder || ""));
  }

  /**
   * The first memo-shaped input that follows a label in document order.
   *
   * Walking up from the input finds the same label for both memo fields, so the
   * two are indistinguishable that way. Going forward from the label is not.
   */
  _inputAfterLabel(labelRe, inputRe) {
    const label = this._leafByText(labelRe);
    if (!label) return null;
    const inputs = this._all("input,textarea").filter((i) => inputRe.test(i.placeholder || ""));
    return (
      inputs.find(
        (i) => label.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING,
      ) || null
    );
  }

  // --- session -------------------------------------------------------------

  /** True when the "about to be logged out" dialog is on screen. */
  sessionWarningOpen() {
    const { warningText } = this.selectors.session;
    const node = this._all("[class*='modal'],[role='dialog']").find(
      (m) => this._visible(m) && warningText.test(this._textOf(m)),
    );
    return !!node;
  }

  // --- login / page state --------------------------------------------------

  detectLoginState() {
    if (!this._isEsunApp()) return super.detectLoginState();
    const { logoutText, headerScope } = this.selectors.login;
    const inHeader = this._all(`${headerScope} *`).some(
      (e) => e.children.length === 0 && logoutText.test(this._textOf(e)),
    );
    if (inHeader) return LOGIN_STATES.LOGGED_IN;
    if (this._all(this.selectors.login.countdown).some((e) => this._visible(e))) {
      return LOGIN_STATES.LOGGED_IN;
    }
    return super.detectLoginState();
  }

  detectPageStateDetailed() {
    if (!this._isEsunApp()) return super.detectPageStateDetailed();
    const { routes } = this.selectors;
    const path = this._path();

    if (routes.verification.test(path)) return { state: PAGE_STATES.VERIFICATION, confidence: 0.99 };
    if (routes.transferForm.test(path)) return { state: PAGE_STATES.TRANSFER_FORM, confidence: 0.99 };
    if (routes.completion.test(path)) {
      // The completion route has never been observed, so corroborate it with
      // text before claiming a transfer finished.
      const looksDone = /(交易完成|交易成功|轉帳成功|交易結果)/.test(this._textOf(this._doc.body));
      return { state: PAGE_STATES.COMPLETION, confidence: looksDone ? 0.95 : 0.5 };
    }
    return super.detectPageStateDetailed();
  }

  // --- navigation ----------------------------------------------------------

  async navigateToTransferForm() {
    assertActionAllowed("navigateToTransferForm");
    if (!this._isEsunApp()) return super.navigateToTransferForm();
    if (this.selectors.routes.transferForm.test(this._path())) return true;

    const { transferButtonText } = this.selectors.nav;
    const entry = this._all("button,a,[role='button']").find(
      (e) => this._visible(e) && transferButtonText.test(this._textOf(e)),
    );
    if (!entry) return super.navigateToTransferForm();
    this._click(entry);

    const arrived = await this._poll(
      () => this.selectors.routes.transferForm.test(this._path()) || null,
      { timeoutMs: 10000 },
    );
    return !!arrived;
  }

  // --- the combo pickers ---------------------------------------------------

  _comboTrigger(placeholderRe) {
    return this._all(this.selectors.combo.trigger).find((i) => placeholderRe.test(i.placeholder || "")) || null;
  }

  _openModal() {
    const m = this._doc.querySelector(this.selectors.combo.modal);
    return m && this._visible(m) ? m : null;
  }

  async _closePicker() {
    const modal = this._openModal();
    if (!modal) return true;
    const close = modal.querySelector(this.selectors.combo.closeButton);
    if (close) this._click(close);
    // Escape does not dismiss this dialog, so there is no key fallback worth
    // trying; the caller re-navigates if this fails.
    return !!(await this._poll(() => (this._openModal() ? null : true), { timeoutMs: 3000 }));
  }

  /**
   * Open the picker, click the row matching `matches`, confirm it took.
   * Leaves the dialog closed on every path, including failure.
   */
  async _pickFromCombo(placeholderRe, matches) {
    const trigger = this._comboTrigger(placeholderRe);
    if (!trigger) return false;

    const before = trigger.value || "";
    this._click(trigger);

    const modal = await this._poll(() => this._openModal(), { timeoutMs: 6000 });
    if (!modal) return false;

    const rows = await this._poll(() => {
      const r = Array.from(modal.querySelectorAll(this.selectors.combo.row));
      return r.length ? r : null;
    }, { timeoutMs: 4000 });
    if (!rows) {
      await this._closePicker();
      return false;
    }

    const hit = rows.find((r) => matches(this._textOf(r)));
    if (!hit) {
      // Never leave the dialog open: it covers the form and the next step would
      // fail for an unrelated reason.
      await this._closePicker();
      return false;
    }
    this._click(hit);

    // Both conditions, because either can be true while the other has not
    // happened yet.
    const settled = await this._poll(
      () => (!this._openModal() && (trigger.value || "") !== before ? true : null),
      { timeoutMs: 5000 },
    );
    if (!settled) await this._closePicker();
    return !!settled;
  }

  /** Match a picker row against a configured account: last-5 and/or nickname. */
  _rowMatcher(acct) {
    const last5 = String(acct?.accountLast5 || "").replace(/\D/g, "");
    const pattern = acct?.displayNamePattern ? new RegExp(acct.displayNamePattern) : null;
    const label = acct?.label || "";
    return (text) => {
      const digits = text.replace(/\D/g, "");
      if (last5 && digits.endsWith(last5)) return true;
      if (pattern && pattern.test(text)) return true;
      return !!label && text.includes(label);
    };
  }

  // --- radios --------------------------------------------------------------

  _radioLabelText(r) {
    const wrap = r.closest("label");
    if (wrap) return this._textOf(wrap);
    if (r.id) {
      const l = this._doc.querySelector(`label[for="${CSS.escape(r.id)}"]`);
      if (l) return this._textOf(l);
    }
    return this._textOf(r.parentElement);
  }

  _selectRadio(re) {
    const r = this._all("input[type='radio']").find((x) => re.test(this._radioLabelText(x)));
    if (!r) return false;
    if (r.checked) return true;
    this._click(r);
    return true;
  }

  // --- fills ---------------------------------------------------------------

  async selectSourceAccount(sourceAccount) {
    assertActionAllowed("selectSourceAccount");
    if (!this._isEsunApp()) return super.selectSourceAccount(sourceAccount);
    const ok = await this._pickFromCombo(this.selectors.placeholders.source, this._rowMatcher(sourceAccount));
    if (ok) this._selectRadio(this.selectors.modes.timing.instant);
    return ok;
  }

  async selectDestinationPayee(payee) {
    assertActionAllowed("selectDestinationPayee");
    if (!this._isEsunApp()) return super.selectDestinationPayee(payee);
    // Choose the designated-payee group first: it decides which rows the picker
    // will offer at all.
    this._selectRadio(this.selectors.modes.payeeSource.designated);
    return this._pickFromCombo(this.selectors.placeholders.payee, this._rowMatcher(payee));
  }

  async fillAmount(amount) {
    assertActionAllowed("fillAmount");
    const el = this._inputByPlaceholder(this.selectors.placeholders.amount);
    if (!el) return super.fillAmount(amount);
    setNativeValue(el, String(amount));
    return true;
  }

  async fillMemoShort(memo) {
    assertActionAllowed("fillMemoShort");
    const el = this._inputAfterLabel(this.selectors.labels.memoSelf, this.selectors.placeholders.memo);
    if (!el) return super.fillMemoShort(memo);
    setNativeValue(el, memo ?? "");
    return true;
  }

  async fillMemoLong(memo) {
    assertActionAllowed("fillMemoLong");
    const el = this._inputAfterLabel(this.selectors.labels.memoOther, this.selectors.placeholders.memo);
    if (!el) return super.fillMemoLong(memo);
    setNativeValue(el, memo ?? "");
    return true;
  }

  async submitFormToVerificationPage() {
    assertActionAllowed("submitFormToVerificationPage");
    if (!this._isEsunApp()) return super.submitFormToVerificationPage();
    const { nextText } = this.selectors.submit;
    // By text. The class btn-main-fill belongs to 立即交易 as well, and matching
    // on it would execute a transfer from the confirm step.
    const next = this._all("button,a[role='button'],input[type='submit']").find(
      (e) => this._visible(e) && nextText.test(this._textOf(e) || e.value || ""),
    );
    if (!next) return super.submitFormToVerificationPage();
    this._click(next);

    const arrived = await this._poll(
      () => (this.selectors.routes.verification.test(this._path()) ? true : null),
      { timeoutMs: 15000 },
    );
    return !!arrived;
  }

  // --- reads ---------------------------------------------------------------

  /** Value cell paired with a label cell on the confirm step. */
  _confirmValue(labelRe) {
    const label = this._all(this.selectors.confirmStep.labelCell).find((e) =>
      labelRe.test(this._textOf(e)),
    );
    if (!label) return "";
    let v = label.nextElementSibling;
    if (!v) {
      const row = label.parentElement;
      v = row ? Array.from(row.children).find((c) => c !== label && !c.contains(label)) : null;
    }
    const text = this._textOf(v);
    return text === this.selectors.confirmStep.emptyValue ? "" : text;
  }

  readVerificationSummary() {
    if (!this._isEsunApp()) return super.readVerificationSummary();
    if (!this.selectors.routes.verification.test(this._path())) {
      return super.readVerificationSummary();
    }
    const srcVal = this._confirmValue(this.selectors.labels.source);
    const payVal = this._confirmValue(this.selectors.labels.payee);
    const amtVal = this._confirmValue(this.selectors.labels.amount);
    const memoSelf = this._confirmValue(this.selectors.labels.memoSelf);
    const memoOther = this._confirmValue(this.selectors.labels.memoOther);
    if (!payVal && !amtVal && !srcVal) return super.readVerificationSummary();

    const payeeName = (payVal.split(/[（(]|約定|玉山銀行|銀行/)[0] || "").trim();
    const amount = parseAmount(amtVal);
    const value = {
      sourceAccountLast5: toLast5(srcVal) || undefined,
      destinationPayeeNameMasked: maskName(payeeName) || payeeName,
      destinationAccountLast5: toLast5(payVal) || undefined,
      amount: Number.isNaN(amount) ? undefined : amount,
      currency: CURRENCY,
      memoShort: memoSelf || undefined,
      memoLong: memoOther || undefined,
      pageState: PAGE_STATES.VERIFICATION,
    };
    const have = [value.amount != null, !!value.destinationAccountLast5, !!payeeName].filter(Boolean).length;
    return { value, confidence: have / 3, missingFields: have === 3 ? [] : ["verification_fields"] };
  }

  async readBalance(sourceAccount) {
    if (!this._isEsunApp()) return super.readBalance(sourceAccount);
    const read = () => {
      const label = this._leafByText(this.selectors.balance.label, 24);
      if (!label) return null;
      const scope = label.parentElement || label;
      const m = this._textOf(scope).match(/[\d,]+(?:\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0].replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    const direct = read();
    if (direct != null) {
      return { value: { accountId: sourceAccount?.id, available: direct, currency: CURRENCY }, confidence: 0.95, missingFields: [] };
    }

    // The figure appears only on the form, and only once a source is chosen.
    if (!this.selectors.routes.transferForm.test(this._path())) {
      const ok = await this.navigateToTransferForm();
      if (!ok) return super.readBalance(sourceAccount);
    }
    if (sourceAccount) await this.selectSourceAccount(sourceAccount);

    const after = await this._poll(() => read(), { timeoutMs: 6000 });
    if (after != null) {
      return { value: { accountId: sourceAccount?.id, available: after, currency: CURRENCY }, confidence: 0.95, missingFields: [] };
    }
    return super.readBalance(sourceAccount);
  }

  /**
   * NOT YET VERIFIED against the live bank — the completion step has never been
   * observed, because reaching it means making a real transfer.
   *
   * It fails closed on purpose. A wrong "completed" reading is the one mistake
   * this extension must not make: the runner treats it as proof a transfer went
   * through, and would move on to the next job. Returning low confidence stops
   * the batch and asks the user, which is the correct behaviour for something
   * unverified.
   */
  readCompletion() {
    if (!this._isEsunApp()) return super.readCompletion();
    const onRoute = this.selectors.routes.completion.test(this._path());
    const generic = super.readCompletion();
    if (!onRoute) return generic;

    const body = this._textOf(this._doc.body);
    const done = /(交易完成|交易成功|轉帳成功)/.test(body);
    const ref = (body.match(/\b\d{6,}\b/) || [])[0];
    if (!done) return generic;

    return {
      value: {
        completed: true,
        bankReferenceMasked: ref ? maskReference(ref) : undefined,
        pageState: PAGE_STATES.COMPLETION,
      },
      // Capped below the runner's threshold until a real transfer confirms the
      // page's shape. Raise it only with evidence in the field notes.
      confidence: 0.5,
      missingFields: ["completion_unverified_after_2026_10_17_redesign"],
    };
  }

  async logout() {
    assertActionAllowed("logout");
    if (!this._isEsunApp()) return super.logout();
    const { triggerText } = this.selectors.logout;
    const el = this._all("a,button,[role='button'],div").find(
      (e) => e.children.length === 0 && this._visible(e) && triggerText.test(this._textOf(e)),
    );
    if (!el) return super.logout();
    this._click(el);
    return true;
  }
}

export function createAdapter(opts) {
  return new EsunAdapter(opts);
}
