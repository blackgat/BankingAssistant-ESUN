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
    // The payee dialog opens on 常用帳號, which holds a different and much
    // shorter list than the designated accounts a batch transfers to.
    tab: "[role='tab']",
    tabSelected: "selected",
    payeeTabText: /約定帳號/,
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

  // Observed on a real transfer, 2026-10-17.
  completionStep: {
    successText: /(交易成功|交易完成|轉帳成功)/,
    // The labelled rows the page actually carries. No serial among them.
    fields: [/轉帳金額/, /轉入對象/, /轉出帳號/, /轉帳日期/],
    nextTransferText: /再轉一筆/,
  },

  confirmStep: {
    labelCell: ".info-header",
    // Each field is a .txn-data-item holding the label and, usually, its value.
    item: ".txn-data-item",
    // Exact text, because 轉入對象別名 contains 轉入對象 and holds the nickname
    // rather than the account — matching loosely picks the wrong row and loses
    // the digits the policy compares.
    labels: {
      source: "轉出帳號",
      payee: "轉入對象",
      payeeAlias: "轉入對象別名",
      amount: "轉帳金額",
      memoSelf: "備註給自己",
      memoOther: "備註給對方",
    },
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

  /**
   * Rows, once the list has stopped changing.
   *
   * Switching tabs re-renders the list, and the outgoing tab's rows are still
   * present for a moment. Matching against those would pick from the wrong
   * list, so wait for two consecutive reads to agree before believing them.
   */
  async _settledRows() {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const open = this._openModal();
      const rows = open ? Array.from(open.querySelectorAll(this.selectors.combo.row)) : [];
      if (rows.length > 0 && rows.length === last) return rows;
      last = rows.length;
      await new Promise((r) => setTimeout(r, 120));
    }
    const open = this._openModal();
    return open ? Array.from(open.querySelectorAll(this.selectors.combo.row)) : [];
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
  async _pickFromCombo(placeholderRe, matches, { tabText } = {}) {
    const first = this._comboTrigger(placeholderRe);
    if (!first) return false;
    const before = first.value || "";

    // Open with retries rather than one click.
    //
    // Measured on the live site: selecting the designated-payee radio leaves
    // the component re-initialising, and a click landing in that window is
    // swallowed — the element is the same node, it simply does nothing, and
    // waiting six seconds does not help. A second click 600ms later opens the
    // dialog immediately. So re-query the trigger and try again rather than
    // treating one dead click as "there is no picker".
    let modal = null;
    for (let attempt = 0; attempt < 3 && !modal; attempt++) {
      const trigger = this._comboTrigger(placeholderRe);
      if (!trigger) break;
      this._click(trigger);
      modal = await this._poll(() => this._openModal(), { timeoutMs: 2500 });
    }
    if (!modal) return false;

    if (tabText) {
      const tab = await this._poll(
        () => {
          const open = this._openModal();
          return open
            ? Array.from(open.querySelectorAll(this.selectors.combo.tab))
                .find((t) => tabText.test(this._textOf(t))) || null
            : null;
        },
        { timeoutMs: 4000 },
      );
      if (!tab) {
        await this._closePicker();
        return false;
      }
      if (!String(tab.className).includes(this.selectors.combo.tabSelected)) {
        this._click(tab);
        await this._poll(() => {
          const open = this._openModal();
          if (!open) return null;
          const now = Array.from(open.querySelectorAll(this.selectors.combo.tab))
            .find((t) => tabText.test(this._textOf(t)));
          return now && String(now.className).includes(this.selectors.combo.tabSelected) ? true : null;
        }, { timeoutMs: 3000 });
      }
    }

    const rows = await this._settledRows();
    if (!rows.length) {
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

    // Settle on the field holding what we asked for, not merely on it changing.
    //
    // The runner calls selectSourceAccount after readBalance has already
    // selected that same account to attribute the balance, so a correct pick
    // leaves the trigger's value byte-identical. Asserting "the value changed"
    // failed every batch at the first fill step while the form was in fact
    // right. Either signal is enough: the field shows the target, or it moved
    // off whatever it held before. The dialog must be closed in both cases,
    // because either can be true while the other has not happened yet.
    const settled = await this._poll(
      () => {
        const t = this._comboTrigger(placeholderRe);
        if (!t || this._openModal()) return null;
        const now = t.value || "";
        return matches(now) || now !== before ? true : null;
      },
      { timeoutMs: 5000 },
    );
    if (!settled) await this._closePicker();
    return !!settled;
  }

  /**
   * Match a picker row against a configured account.
   *
   * Source rows read "<account digits> <nickname>", so either key works. Rows
   * on the designated-payee tab read "<bank name> <account digits>" with no
   * nickname at all, which leaves the last-5 as the only thing that can match
   * there — a payee configured without one will not be found.
   */
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
    // The radio is not enough: the dialog still opens on 常用帳號.
    return this._pickFromCombo(this.selectors.placeholders.payee, this._rowMatcher(payee), {
      tabText: this.selectors.combo.payeeTabText,
    });
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

  /**
   * Value for a labelled row on the confirm or result step.
   *
   * Rows are .txn-data-item holding the label and its value — except 轉帳金額,
   * whose item contains only the label, with the amount rendered as the item's
   * next sibling. Both shapes are handled; taking only the first would leave
   * the amount undefined, and the policy compares it on every job.
   *
   * The label is matched exactly: 轉入對象別名 contains 轉入對象 and carries the
   * nickname instead of the account, so a loose match silently drops the digits.
   */
  _confirmValue(labelText) {
    const c = this.selectors.confirmStep;
    const label = this._all(c.labelCell).find((e) => this._textOf(e) === labelText);
    if (!label) return "";

    const item = label.closest(c.item) || label.parentElement;
    let v = item
      ? Array.from(item.children).find((x) => x !== label && !x.contains(label))
      : label.nextElementSibling;
    if (!v && item) v = item.nextElementSibling; // the 轉帳金額 shape

    const text = this._textOf(v);
    return text === c.emptyValue ? "" : text;
  }

  readVerificationSummary() {
    if (!this._isEsunApp()) return super.readVerificationSummary();
    if (!this.selectors.routes.verification.test(this._path())) {
      return super.readVerificationSummary();
    }
    const L = this.selectors.confirmStep.labels;
    const srcVal = this._confirmValue(L.source);
    const payVal = this._confirmValue(L.payee);
    const amtVal = this._confirmValue(L.amount);
    const memoSelf = this._confirmValue(L.memoSelf);
    const memoOther = this._confirmValue(L.memoOther);
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

  /**
   * Available balance for a specific account.
   *
   * The figure on screen belongs to whichever account the form currently has
   * selected, and nothing in the markup ties the two together. An earlier
   * version returned the first number it saw: during a real batch it answered
   * 238ms after the batch began — before the source had been chosen — and
   * reported a balance that was not this account's. A wrong balance is not a
   * cosmetic error, it is the input to the check that decides whether the
   * batch may proceed.
   *
   * So the account is confirmed selected before the number is believed, and
   * confirmed still selected after reading it.
   */
  async readBalance(sourceAccount) {
    if (!this._isEsunApp()) return super.readBalance(sourceAccount);

    const readNumber = () => {
      // On the result step the account number and the balance share one text
      // node — "零用金 <13 digits> 可用餘額 TWD 12,345" — so the first number in
      // the cell is the account. Read only what follows the label.
      const label = this._leafByText(this.selectors.balance.label, 40);
      if (!label) return null;
      const whole = this._textOf(label.parentElement || label);
      const after = whole.slice(whole.search(this.selectors.balance.label));
      const m = after.match(/[\d,]+(?:\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0].replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    // Is the form showing the account we were asked about?
    const selected = () => {
      if (!sourceAccount) return false;
      const t = this._comboTrigger(this.selectors.placeholders.source);
      return !!(t && t.value && this._rowMatcher(sourceAccount)(t.value));
    };

    const fail = (why) => ({ value: null, confidence: 0, missingFields: [why] });

    if (!this.selectors.routes.transferForm.test(this._path())) {
      if (!(await this.navigateToTransferForm())) return super.readBalance(sourceAccount);
    }

    if (!selected()) {
      if (!sourceAccount) return super.readBalance(sourceAccount);
      if (!(await this.selectSourceAccount(sourceAccount))) return fail("source_not_selectable");
      if (!(await this._poll(() => (selected() ? true : null), { timeoutMs: 6000 }))) {
        return fail("source_selection_unconfirmed");
      }
    }

    // Only now is a number on screen attributable to this account.
    const value = await this._poll(() => readNumber(), { timeoutMs: 8000 });
    if (value == null) return fail("balance_not_displayed");

    // The selection must still hold: a re-render could have swapped accounts
    // between the wait and the read.
    if (!selected()) return fail("source_changed_while_reading");

    // Shape fixed by the base adapter and consumed by the runner as
    // reading.value.balance keyed on sourceAccountId. Do not rename these.
    return {
      value: {
        sourceAccountId: sourceAccount.id,
        displayName: sourceAccount.label,
        accountLast5: sourceAccount.accountLast5,
        balance: value,
        currency: CURRENCY,
        observedAt: new Date().toISOString(),
      },
      confidence: 0.95,
      missingFields: [],
    };
  }

  /**
   * Verified against a real transfer on 2026-10-17.
   *
   * The redesigned result page carries no transaction serial. The old site did
   * — the audit log still holds one from August — but the labelled rows here
   * are only 轉帳金額, 轉入對象, 轉出帳號, 轉帳日期 and the two memos. The long
   * digit runs on the page are the two account numbers and some header chrome,
   * so scanning the body and calling the first hit a reference would file an
   * account number as proof of a transfer. It is left undefined instead. A
   * serial is reachable behind the 交易明細 button, which navigates out of the
   * flow and is not worth taking mid-batch.
   *
   * Proof of completion is therefore the result route, the success wording, and
   * the result rows actually being there — any one alone is too weak.
   */
  readCompletion() {
    if (!this._isEsunApp()) return super.readCompletion();
    if (!this.selectors.routes.completion.test(this._path())) return super.readCompletion();

    const c = this.selectors.completionStep;
    if (!c.successText.test(this._textOf(this._doc.body))) {
      return { value: null, confidence: 0, missingFields: ["completion_text"] };
    }

    const cells = this._all(this.selectors.confirmStep.labelCell);
    const present = c.fields.filter((re) => cells.some((e) => re.test(this._textOf(e)))).length;
    if (present < 2) {
      // Success wording with no result rows is not a completed transfer.
      return { value: null, confidence: 0.4, missingFields: ["completion_fields"] };
    }

    return {
      value: {
        completed: true,
        bankReferenceMasked: undefined, // the page does not carry one
        pageState: PAGE_STATES.COMPLETION,
      },
      confidence: 0.95,
      missingFields: [],
    };
  }

  /** 再轉一筆 returns to the form for the next job in a batch. */
  async navigateToNextTransfer() {
    assertActionAllowed("navigateToNextTransfer");
    if (!this._isEsunApp()) return super.navigateToNextTransfer();
    const btn = this._all("button,a[role='button']").find(
      (e) => this._visible(e) && this.selectors.completionStep.nextTransferText.test(this._textOf(e)),
    );
    if (!btn) return super.navigateToNextTransfer();
    this._click(btn);
    return !!(await this._poll(
      () => (this.selectors.routes.transferForm.test(this._path()) ? true : null),
      { timeoutMs: 15000 },
    ));
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
