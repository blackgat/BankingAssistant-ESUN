// Fixed overlay UI (SPEC section 8). Rendered in an isolated shadow root so the
// bank's own CSS cannot affect it and vice versa. Only sanitized values are ever
// rendered: account/payee identifiers are shown as label + ****last5, free text
// is run through redactText.

import { last5, maskName, redactText } from "../core/sanitizer.js";

function formatTWD(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return "NT$ " + Number(n).toLocaleString("en-US");
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const STYLES = `
:host { all: initial; }
.wrap {
  position: fixed; top: 16px; right: 16px; width: 340px; z-index: 2147483647;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
  font-size: 13px; line-height: 1.5; color: #1a1a1a;
  background: #ffffff; border: 1px solid #d0d5dd; border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.18); overflow: hidden;
}
.hd { display:flex; align-items:center; justify-content:space-between;
  padding: 10px 12px; background:#0b5d3b; color:#fff; font-weight:600; }
.hd .dot { width:8px; height:8px; border-radius:50%; background:#7CFFB2; display:inline-block; margin-right:6px; }
.bd { padding: 12px; max-height: 60vh; overflow:auto; }
.step { font-weight:700; margin-bottom:6px; }
.row { display:flex; justify-content:space-between; gap:8px; padding:2px 0; }
.row .k { color:#667085; }
.row .v { font-weight:600; text-align:right; word-break:break-all; }
.note { margin-top:8px; padding:8px; border-radius:8px; background:#f2f4f7; color:#344054; }
.banner { padding:8px; border-radius:8px; margin-bottom:8px; font-weight:600; }
.banner.wait { background:#FFF6E5; color:#7A4D00; border:1px solid #FFE1A8; }
.banner.ok { background:#E7F6EC; color:#0b5d3b; border:1px solid #B7E4C7; }
.banner.err { background:#FDECEC; color:#8A1C1C; border:1px solid #F5C2C2; }
.checks { margin:6px 0 0; padding:0; list-style:none; font-size:12px; }
.checks li { display:flex; gap:6px; padding:1px 0; }
.checks .pass::before { content:"PASS"; color:#0b5d3b; font-weight:700; }
.checks .fail::before { content:"FAIL"; color:#8A1C1C; font-weight:700; }
.ft { padding:10px 12px; border-top:1px solid #eaecf0; display:flex; gap:8px; justify-content:flex-end; }
button {
  font: inherit; padding:6px 12px; border-radius:8px; border:1px solid #d0d5dd;
  background:#fff; cursor:pointer;
}
button.danger { background:#fff; color:#8A1C1C; border-color:#F5C2C2; }
button.danger:hover { background:#FDECEC; }
`;

export class Overlay {
  /** @param {{ mountTo?: HTMLElement, dismissMs?: number }} [opts] */
  constructor(opts = {}) {
    this.mountTo = opts.mountTo || (typeof document !== "undefined" ? document.body : null);
    this.host = null;
    this.shadow = null;
    this.body = null;
    this._onCancel = null;
    this._destroyTimer = null;
    this._destroyed = false;
    // Auto-close delay after "停止批次" (0 = never auto-close).
    this._dismissMs = opts.dismissMs ?? 3000;
  }

  mount() {
    if (this._destroyed || this.host || !this.mountTo) return;
    this.host = document.createElement("div");
    this.host.id = "banking-assistant-overlay";
    this.shadow = this.host.attachShadow ? this.host.attachShadow({ mode: "open" }) : this.host;
    const style = document.createElement("style");
    style.textContent = STYLES;
    const wrap = el("div", { class: "wrap" });
    const hd = el("div", { class: "hd" });
    hd.appendChild(el("span", {}, el("span", { class: "dot" }), document.createTextNode("轉帳輔助")));
    hd.appendChild(el("span", { class: "muted", id: "ba-phase", text: "待命" }));
    this.body = el("div", { class: "bd" });
    const ft = el("div", { class: "ft" });
    const cancelBtn = el("button", { class: "danger", type: "button", text: "停止批次" });
    cancelBtn.addEventListener("click", () => {
      if (this._onCancel) this._onCancel(); // trigger the stop/abort action
      this.scheduleDismiss(); // keep status visible for the configured delay, then close
    });
    ft.appendChild(cancelBtn);
    wrap.append(hd, this.body, ft);
    this.shadow.append(style, wrap);
    this.mountTo.appendChild(this.host);
  }

  setOnCancel(cb) {
    this._onCancel = cb;
  }

  /** After a stop or completion, leave the status visible briefly, then close. */
  scheduleDismiss(ms) {
    const delay = ms ?? this._dismissMs;
    if (this._destroyTimer || this._destroyed || !(delay > 0)) return;
    this._destroyTimer = setTimeout(() => this.destroy(), delay);
    // Don't let the pending close keep a Node test process alive (no-op in browsers).
    if (this._destroyTimer && typeof this._destroyTimer.unref === "function") {
      this._destroyTimer.unref();
    }
  }

  _phase(text) {
    const p = this.shadow?.getElementById?.("ba-phase");
    if (p) p.textContent = text;
  }

  _render(nodes, phase) {
    if (this._destroyed) return;
    if (!this.body) this.mount();
    if (!this.body) return;
    if (phase) this._phase(phase);
    this.body.replaceChildren(...nodes.filter(Boolean));
  }

  _kv(k, v) {
    return el("div", { class: "row" }, el("span", { class: "k", text: k }), el("span", { class: "v", text: v }));
  }

  _checks(checks = []) {
    const ul = el("ul", { class: "checks" });
    for (const c of checks) {
      ul.appendChild(el("li", { class: c.pass ? "pass" : "fail" }, el("span", { text: " " + c.name })));
    }
    return ul;
  }

  _acct(label, last5Value) {
    const tail = last5Value ? ` ****${last5(last5Value)}` : "";
    return `${label || ""}${tail}`;
  }

  _step(stepNo, total) {
    return el("div", { class: "step", text: `第 ${stepNo} / ${total} 筆` });
  }

  showBalanceChecked(balance, precheck) {
    this._render(
      [
        el("div", { class: "banner ok", text: "餘額檢查通過" }),
        balance ? this._kv("帳戶", this._acct(balance.displayName, balance.accountLast5)) : null,
        balance ? this._kv("目前餘額", formatTWD(balance.balance)) : null,
        this._kv("批次總額", formatTWD(precheck.totalAmount)),
        this._kv("需保留最低餘額", formatTWD(precheck.requiredMinimumBalance)),
      ],
      "餘額已檢查",
    );
  }

  showJobProgress(stepNo, total, { job, src, payee }) {
    this._render(
      [
        this._step(stepNo, total),
        el("div", { class: "banner", text: "填寫表單中…" }),
        this._kv("來源帳戶", this._acct(src?.label, src?.accountLast5)),
        this._kv("目的帳戶", this._acct(payee?.label, payee?.accountLast5)),
        this._kv("金額", formatTWD(job.amount)),
        this._kv("備註給自己", redactText(job.memoShort || "")),
        this._kv("備註給對方", redactText(job.memoLong || "")),
      ],
      `填寫 ${stepNo}/${total}`,
    );
  }

  showWaitingUserVerification(stepNo, total, { job, src, payee, summary }) {
    this._render(
      [
        this._step(stepNo, total),
        el("div", { class: "banner wait", text: "請你在銀行驗證頁完成確認" }),
        this._kv("來源帳戶", this._acct(src?.label, summary?.sourceAccountLast5 || src?.accountLast5)),
        this._kv("目的帳戶", `${payee?.label || ""} ${summary?.destinationPayeeNameMasked || maskName(payee?.label)} ****${last5(summary?.destinationAccountLast5 || payee?.accountLast5)}`),
        this._kv("金額", formatTWD(summary?.amount ?? job.amount)),
        this._kv("備註給自己", redactText(job.memoShort || "")),
        this._kv("備註給對方", redactText(job.memoLong || "")),
        el("div", { class: "note", text: "Extension 正在等待交易完成頁。請完成銀行要求的驗證 / 確認，本工具不會替你按下最終確認。" }),
      ],
      `等待確認 ${stepNo}/${total}`,
    );
  }

  showJobCompleted(stepNo, total, completion) {
    this._render(
      [
        this._step(stepNo, total),
        el("div", { class: "banner ok", text: `第 ${stepNo} / ${total} 筆完成` }),
        completion?.bankReferenceMasked ? this._kv("交易參考", completion.bankReferenceMasked) : null,
        el("div", { class: "note", text: stepNo < total ? "準備進入下一筆…" : "這是最後一筆。" }),
      ],
      `完成 ${stepNo}/${total}`,
    );
  }

  showJobSkipped(stepNo, total, checks) {
    this._render(
      [
        this._step(stepNo, total),
        el("div", { class: "banner err", text: "此筆未通過 per-job 檢查，已略過" }),
        this._checks(checks),
      ],
      `略過 ${stepNo}/${total}`,
    );
  }

  showPolicyFailure(message, checks) {
    this._render(
      [el("div", { class: "banner err", text: message }), this._checks(checks)],
      "已停止",
    );
  }

  showUserCancelledOrTimeout(stepNo, total, outcome) {
    const label = outcome === "timeout" ? "等待逾時" : "已取消";
    this._render(
      [
        this._step(stepNo, total),
        el("div", { class: "banner err", text: `${label}，批次已停止。` }),
        el("div", { class: "note", text: "請不要繼續自動流程。" }),
      ],
      label,
    );
  }

  showBatchCompleted(finalBalance, results) {
    const done = (results || []).filter((r) => r.status === "completed").length;
    this._render(
      [
        el("div", { class: "banner ok", text: "批次完成" }),
        this._kv("完成筆數", String(done)),
        finalBalance ? this._kv("目前餘額", formatTWD(finalBalance.balance)) : null,
        finalBalance ? this._kv("帳戶", this._acct(finalBalance.displayName, finalBalance.accountLast5)) : null,
      ],
      "批次完成",
    );
  }

  showLogout(logout) {
    if (logout?.skipped) {
      this._render(
        [
          el("div", { class: "banner ok", text: "批次完成" }),
          el("div", { class: "note", text: "自動登出已關閉，請自行登出銀行網站。" }),
        ],
        "完成",
      );
      return;
    }
    const nodes = [el("div", { class: "banner ok", text: "已協助點擊登出" })];
    if (logout?.requiresUserConfirm) {
      nodes.push(el("div", { class: "banner wait", text: "登出需要你在銀行頁面再次確認，請手動完成。" }));
    }
    this._render(nodes, "登出");
  }

  showError(message) {
    this._render(
      [
        el("div", { class: "banner err", text: "已停止批次" }),
        el("div", { class: "note", text: redactText(message || "發生未知狀態。") }),
      ],
      "錯誤",
    );
  }

  destroy() {
    this._destroyed = true;
    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = null;
    }
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
    this.host = null;
    this.body = null;
  }
}
