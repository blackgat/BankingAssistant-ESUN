// E.SUN (玉山銀行) adapter.
//
// =====================================================================
//  These selectors were checked against the real E.SUN online banking DOM
//  (2026-07-19) — login marker, wizard steps, transfer-form labels, mode
//  radios, 可用餘額, the 資料確認 table, and the 交易結果 serial. The DOM notes
//  and re-inspection snippets live in docs/ESUN-INTEGRATION-NOTES.md.
//
//  The `pages`/`accounts` groups still describe the demo fixtures
//  (tests/fixtures/*.html): they only serve as the fallback scorer for pages
//  without a wizard step. If E.SUN redesigns, re-inspect each page, update the
//  right-hand strings here, update the fixtures to match, and run `npm test`.
//  See README "替換銀行 selector".
// =====================================================================

import { PAGE_STATES, CURRENCY } from "../../core/types.js";
import { last5 as toLast5, maskName, maskReference } from "../../core/sanitizer.js";
import { BaseBankAdapter, parseAmount } from "./bank-adapter.example.js";
import {
  assertActionAllowed,
  selectOptionBy,
  setNativeValue,
  safeClick,
} from "../actions/transfer-form-actions.js";

export const ESUN_SELECTORS = Object.freeze({
  bankId: "esun",
  login: {
    // Verified on the real E.SUN banking iframe: the logout control is
    // <a class="log_out">. The data-action/.ba-logout entries keep the demo
    // fixtures working.
    loggedInMarkers: ["a.log_out", ".log_out", "[data-action='logout']", ".ba-logout"],
    loginFormMarkers: ["input[type='password']", ".login-form", "#loginForm"],
  },
  pages: {
    [PAGE_STATES.HOME]: {
      require: [".account-row", "[data-nav='transfer']"],
      forbid: ["form.transfer-form", ".verification-summary"],
      text: null,
    },
    [PAGE_STATES.TRANSFER_FORM]: {
      // E.SUN: 轉帳 form with 轉出帳號 / 轉入帳號 / 金額.
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
  accounts: {
    rowSelector: ".account-row",
    nameSelector: ".account-name",
    balanceSelector: ".account-balance",
    last5Attr: "data-account-last5",
  },
  payees: {
    selectSelector: "select.ba-payee",
    optionLast5Attr: "data-last5",
    optionNameAttr: "data-name",
  },
  form: {
    navToTransfer: "[data-nav='transfer']",
    // Real E.SUN: the transfer entry is a left-menu item that loads a widget via
    // _leftMenuLoadWidget(); it has no href/id, so match it by visible text.
    navToTransferText: /即時.*預約.*轉帳|預約轉帳|即時轉帳/,
    sourceSelect: "select.ba-source", // 轉出帳號
    sourceOptionLast5Attr: "data-last5",
    payeeSelect: "select.ba-payee", // 轉入帳號（約定）
    amountInput: ".ba-amount", // 金額
    memoShortInput: ".ba-memo-short", // 摘要
    memoLongInput: ".ba-memo-long", // 附言
    submitToVerification: ".ba-next", // 下一步 -> 驗證頁（非最終確認）
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
    // Verified: <a class="log_out"> in the banking iframe.
    trigger: "a.log_out, [data-action='logout']",
  },
  // Real E.SUN: the transfer flow is a 3-step wizard inside one widget. The step
  // indicator (<div class="step"> ... <dt class="current">資料編輯/資料確認/交易結果</dt>)
  // is the reliable page-state signal, mapping onto our page states.
  wizard: {
    stepCurrent: ".step .current, .step dt.current, dt.current",
    formStepText: /資料編輯/,
    verifyStepText: /資料確認/,
    completeStepText: /交易結果/,
  },
  // Real E.SUN form controls carry no stable id/class, so locate each by the
  // visible label text of its row/section (verified on the live transfer form).
  labels: {
    source: /轉出帳號/,
    payee: /轉入帳號/,
    amount: /轉帳金額|金額/,
    memoSelf: /給自己|摘要/, // -> memoShort (撰寫備註給自己)
    memoOther: /給對方|附言/, // -> memoLong (撰寫備註給對方)
    nextLinkText: /下一步/, // advance to 資料確認 (NEVER the final 確認/送出)
  },
  // Transfer-form mode radios (verified labels). Selected before filling so the
  // designated-payee dropdown is enabled and the transfer is a single immediate one.
  modes: {
    designated: /約定/, // 轉入帳號: 約定常用帳號
    instant: /即時/, // 轉帳方式: 即時預約單日
  },
});

export class EsunAdapter extends BaseBankAdapter {
  /**
   * @param {{ root?: Document|HTMLElement, config: object }} opts
   */
  constructor({ root, config } = {}) {
    super({ root, config, selectors: ESUN_SELECTORS });
  }

  /**
   * E.SUN drives the transfer as a 3-step wizard inside one widget, so the page
   * state comes from the step indicator rather than separate URLs. Falls back to
   * the generic selector scoring (used by the demo fixtures and unit tests) when
   * no wizard step is present. Overriding the *Detailed variant means the plain
   * detectPageState() inherits the same logic.
   * @returns {{state: string, confidence: number}}
   */
  detectPageStateDetailed() {
    const w = this.selectors.wizard;
    const cur = w && this._q(w.stepCurrent);
    const t = cur ? cur.textContent || "" : "";
    if (t) {
      if (w.verifyStepText.test(t)) return { state: PAGE_STATES.VERIFICATION, confidence: 0.99 };
      if (w.completeStepText.test(t)) return { state: PAGE_STATES.COMPLETION, confidence: 0.99 };
      if (w.formStepText.test(t)) return { state: PAGE_STATES.TRANSFER_FORM, confidence: 0.99 };
    }
    return super.detectPageStateDetailed();
  }

  /**
   * The transfer entry is a left-menu link that loads a widget via JS; match it
   * by visible text and click it. Falls back to the generic selector.
   */
  async navigateToTransferForm() {
    assertActionAllowed("navigateToTransferForm");
    if (this.detectPageState() === PAGE_STATES.TRANSFER_FORM) {
      return { ok: true, message: "already on transfer form" };
    }
    const re = this.selectors.form.navToTransferText;
    const link = re && this._qa("a").find((a) => re.test((a.textContent || "").trim()));
    if (link) {
      link.click();
      return { ok: true, message: "clicked transfer menu" };
    }
    return super.navigateToTransferForm();
  }

  // --- Label-based form fill (E.SUN fields have no stable id/class) ----------
  // Each override tries the real E.SUN label-based path; if the labelled control
  // is not found (e.g. the demo fixtures / unit tests) it falls back to the
  // generic selector behaviour in BaseBankAdapter.

  _transferForm() {
    return this._qa("form").find((f) => /轉出帳號|轉入帳號|轉帳金額/.test(f.textContent || "")) || null;
  }

  /** Visible label text associated with a form control (matches the verified probe). */
  _labelTextFor(el) {
    const box = el.closest("dd,td,li,p,div");
    const prev = box && box.previousElementSibling;
    const dl = el.closest("tr,dl");
    const lab = dl && dl.querySelector("dt,th,label");
    return (
      el.getAttribute("aria-label") ||
      (prev && prev.textContent) ||
      (lab && lab.textContent) ||
      ""
    ).trim();
  }

  _controlByLabel(labelRe, tag) {
    const form = this._transferForm();
    if (!form || !labelRe) return null;
    return [...form.querySelectorAll(tag)].find((el) => labelRe.test(this._labelTextFor(el))) || null;
  }

  _optionMatchesAccount(opt, acct) {
    const l5 = toLast5(opt.textContent);
    if (acct.accountLast5 && l5 === acct.accountLast5) return true;
    return this._matchesAccount(acct, { displayName: (opt.textContent || "").trim(), accountLast5: l5 });
  }

  /** Text label associated with a radio (its <label for>, trailing text, or parent). */
  _radioLabelText(r) {
    if (r.id) {
      const L = [...this.root.querySelectorAll("label")].find((l) => l.htmlFor === r.id);
      if (L && (L.textContent || "").trim()) return L.textContent.trim();
    }
    let n = r.nextSibling,
      s = "",
      g = 0;
    while (n && g < 4 && s.length < 14) {
      s += n.textContent || n.nodeValue || "";
      n = n.nextSibling;
      g++;
    }
    if (s.trim()) return s.trim();
    return r.parentElement ? (r.parentElement.textContent || "").trim() : "";
  }

  /** Click the transfer-form radio whose label matches re (idempotent, best-effort). */
  _selectRadioByText(re) {
    const form = this._transferForm();
    if (!form || !re) return false;
    const target = [...form.querySelectorAll("input[type=radio]")].find((r) =>
      re.test(this._radioLabelText(r)),
    );
    if (!target) return false;
    if (!target.checked) target.click();
    return true;
  }

  async selectSourceAccount(sourceAccount) {
    assertActionAllowed("selectSourceAccount");
    this._selectRadioByText(this.selectors.modes.instant); // E.SUN: ensure 即時 (single transfer)
    const select = this._controlByLabel(this.selectors.labels.source, "select");
    if (select) {
      const ok = selectOptionBy(select, (opt) => this._optionMatchesAccount(opt, sourceAccount));
      return { ok, message: ok ? "source selected (by label)" : "source option not matched" };
    }
    return super.selectSourceAccount(sourceAccount);
  }

  async selectDestinationPayee(payee) {
    assertActionAllowed("selectDestinationPayee");
    // Always put the form in 約定 mode first (the 約定常用帳號 radio) so the
    // designated-payee dropdown is the active 轉入帳號 input, then pick the payee.
    // The dropdown may re-render via AJAX after the radio click, so retry briefly.
    const clicked = this._selectRadioByText(this.selectors.modes.designated);
    if (this._trySelectPayee(payee)) return { ok: true, message: "payee selected (約定)" };
    if (clicked) {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 120));
        if (this._trySelectPayee(payee)) return { ok: true, message: "payee selected (約定, after wait)" };
      }
    }
    return super.selectDestinationPayee(payee);
  }

  _trySelectPayee(payee) {
    const form = this._transferForm();
    if (!form) return false;
    const selects = [...form.querySelectorAll("select")].filter((s) =>
      this.selectors.labels.payee.test(this._labelTextFor(s)),
    );
    for (const select of selects) {
      if (selectOptionBy(select, (opt) => this._optionMatchesAccount(opt, payee))) return true;
    }
    return false;
  }

  async fillAmount(amount) {
    assertActionAllowed("fillAmount");
    const input = this._controlByLabel(this.selectors.labels.amount, "input");
    if (input) {
      setNativeValue(input, amount);
      return { ok: true, message: "amount filled (by label)" };
    }
    return super.fillAmount(amount);
  }

  async fillMemoShort(memo) {
    assertActionAllowed("fillMemoShort");
    const input = this._controlByLabel(this.selectors.labels.memoSelf, "input");
    if (input) {
      setNativeValue(input, memo ?? "");
      return { ok: true, message: "memo-to-self filled (by label)" };
    }
    return super.fillMemoShort(memo);
  }

  async fillMemoLong(memo) {
    assertActionAllowed("fillMemoLong");
    const input = this._controlByLabel(this.selectors.labels.memoOther, "input");
    if (input) {
      setNativeValue(input, memo ?? "");
      return { ok: true, message: "memo-to-recipient filled (by label)" };
    }
    return super.fillMemoLong(memo);
  }

  async submitFormToVerificationPage() {
    assertActionAllowed("submitFormToVerificationPage");
    // E.SUN advances 資料編輯 -> 資料確認 via a "下一步" link. This is NOT the
    // final transfer confirmation; the 確認/送出 button lives on the 資料確認 step
    // and is deliberately left for the user.
    const form = this._transferForm();
    const re = this.selectors.labels.nextLinkText;
    const link =
      form &&
      [...form.querySelectorAll("a, button, input[type=submit], input[type=button]")].find((el) =>
        re.test((el.textContent || el.value || "").trim()),
      );
    if (link) {
      safeClick(link);
      return { ok: true, message: "clicked 下一步 to 資料確認" };
    }
    return super.submitFormToVerificationPage();
  }

  // --- 資料確認 / 交易結果 extraction (verified table layout, no stable ids) ---

  /** Current wizard step text (empty when no wizard, e.g. demo fixtures/tests). */
  _wizardStep() {
    const cur = this._q(this.selectors.wizard.stepCurrent);
    return cur ? cur.textContent || "" : "";
  }

  /** Value text of the cell adjacent to a label cell matching labelRe. */
  _confirmCellValue(labelRe) {
    const cells = [...this.root.querySelectorAll("th,td,dt,dd")];
    const lab = cells.find((c) => c.childElementCount === 0 && labelRe.test((c.textContent || "").trim()));
    if (!lab) return "";
    let v = lab.nextElementSibling;
    if (!v) {
      const row = lab.closest("tr,dl");
      v = row && [...row.children].find((c) => c !== lab && (c.textContent || "").trim());
    }
    return v ? (v.textContent || "").trim() : "";
  }

  readVerificationSummary() {
    if (!this.selectors.wizard.verifyStepText.test(this._wizardStep())) {
      return super.readVerificationSummary();
    }
    const srcVal = this._confirmCellValue(/轉出帳號/);
    const payVal = this._confirmCellValue(/轉入帳號|收款/);
    const amtVal = this._confirmCellValue(/轉帳金額|金額/);
    const memoSelf = this._confirmCellValue(/給自己|摘要/);
    const memoOther = this._confirmCellValue(/給對方|附言/);
    // Fall back to the generic reader (demo fixtures) if this isn't the E.SUN table.
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

  /** Read 可用餘額 from the current DOM (the label/value are split across nodes). */
  _readBalanceFromDom(sourceAccount) {
    const directText = (el) =>
      [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    const el = [...this.root.querySelectorAll("span,div,td,dd,p,li")].find((e) =>
      /可用餘額/.test(directText(e)),
    );
    if (el) {
      const m = (el.textContent || "").match(/[\d,]+(?:\.\d+)?/);
      const balance = m ? Number(m[0].replace(/,/g, "")) : NaN;
      if (!Number.isNaN(balance)) {
        return {
          value: {
            sourceAccountId: sourceAccount.id,
            displayName: sourceAccount.label,
            accountLast5: sourceAccount.accountLast5,
            balance,
            currency: CURRENCY,
            observedAt: new Date().toISOString(),
          },
          confidence: 0.95,
          missingFields: [],
        };
      }
    }
    return { value: null, confidence: 0, missingFields: ["balance_not_shown"] };
  }

  /** Select the source account and poll for the AJAX-rendered 可用餘額. */
  async _selectSourceAndAwaitBalance(select, sourceAccount) {
    this._selectRadioByText(this.selectors.modes.instant);
    selectOptionBy(select, (opt) => this._optionMatchesAccount(opt, sourceAccount));
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const result = this._readBalanceFromDom(sourceAccount);
      if (result.confidence >= 0.9) return result;
    }
    return null;
  }

  async readBalance(sourceAccount) {
    // E.SUN renders 可用餘額 only on the transfer form, and only AFTER a 轉出帳號 is
    // selected. So: read it; else select the source ourselves and wait for the
    // AJAX value; else navigate to the transfer form first and try again. This
    // lets a batch start from any page (e.g. the account dashboard) instead of
    // failing with account_not_found.
    const direct = this._readBalanceFromDom(sourceAccount);
    if (direct.confidence >= 0.9) return direct;

    let select = this._controlByLabel(this.selectors.labels.source, "select");
    if (select) {
      const afterSelect = await this._selectSourceAndAwaitBalance(select, sourceAccount);
      if (afterSelect) return afterSelect;
    }

    // Try the generic account-row reader before navigating anywhere: a page that
    // lists balances directly (demo fixtures, other banks) must not be navigated
    // away from, or we'd destroy the very rows we can read.
    const generic = await super.readBalance(sourceAccount);
    if (generic.confidence >= 0.9) return generic;

    // Still nothing and no source <select> here: we're off the transfer form
    // (e.g. the account dashboard). Open it, wait for the form, then read.
    if (!select) {
      await this.navigateToTransferForm();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        select = this._controlByLabel(this.selectors.labels.source, "select");
        if (select) break;
      }
      if (select) {
        const afterNav = await this._selectSourceAndAwaitBalance(select, sourceAccount);
        if (afterNav) return afterNav;
      }
    }
    return generic;
  }

  readCompletion() {
    if (!this.selectors.wizard.completeStepText.test(this._wizardStep())) {
      return super.readCompletion();
    }
    // 交易結果 step. The step itself is the reliable completion signal; the
    // reference number is best-effort until verified on a real completed transfer.
    // Prefer specific transaction-serial labels; avoid the bare 代號 (it also
    // matches 使用者代號). Verified 2026-07-19 on a real transfer -> a date-prefixed
    // serial (masked e.g. 202****388).
    const refVal = this._confirmCellValue(/交易序號|轉帳序號|交易編號|序號/) || "";
    return {
      value: {
        pageState: PAGE_STATES.COMPLETION,
        bankReferenceMasked: refVal ? maskReference(refVal) : undefined,
        completionText: "交易結果",
        completedAt: new Date().toISOString(),
      },
      confidence: 0.9,
      missingFields: refVal ? [] : ["bankReference"],
    };
  }
}

// Adapter registry. Add new banks here keyed by bankId.
export const ADAPTERS = Object.freeze({
  esun: EsunAdapter,
});

/**
 * Build the adapter for a config's bankId.
 * @param {{bankId:string}} config
 * @param {Document|HTMLElement} [root]
 */
export function createAdapter(config, root) {
  const Cls = ADAPTERS[config.bankId] || EsunAdapter;
  return new Cls({ root, config });
}
