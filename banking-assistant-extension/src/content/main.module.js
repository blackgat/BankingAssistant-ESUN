// Content-script ESM entry. Loaded by main.js via dynamic import so that core
// modules can use ES module syntax and remain unit-testable. Runs in the content
// script's isolated world, so chrome.runtime / chrome.storage are available.

import { STORAGE_KEYS, DEFAULT_CONFIG, LOGIN_STATES } from "../core/types.js";
import { isOriginAllowed } from "../core/allowlist.js";
import { AuditLogger } from "../core/logger.js";
import { createAdapter } from "./extractors/bank-adapter.esun.js";
import { Overlay } from "./overlay.js";
import { TransferRunner, RunnerControl, createPollingWaiter } from "./runner.js";

let running = false;

async function loadConfig() {
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.CONFIG))[STORAGE_KEYS.CONFIG];
  return stored || DEFAULT_CONFIG;
}

async function startBatch(batch) {
  if (running) return { ok: false, message: "另一個批次正在執行中" };
  const config = await loadConfig();

  if (!isOriginAllowed(location.origin, config)) {
    return { ok: false, message: `origin not allowed: ${location.origin}` };
  }

  running = true;
  const control = new RunnerControl();
  const overlay = new Overlay({ dismissMs: config.behavior?.overlayDismissMs ?? 3000 });
  overlay.mount();
  overlay.setOnCancel(() => control.abort("user_cancelled"));

  const adapter = createAdapter(config, document);
  const logger = new AuditLogger();
  const waiter = createPollingWaiter(adapter, control);
  const runner = new TransferRunner({ adapter, overlay, logger, config, waiter, control });

  try {
    const result = await runner.run(batch);
    return { ok: !result.stopped, ...result };
  } catch (e) {
    overlay.showError("執行發生未預期錯誤，已停止。");
    return { ok: false, message: e?.message || "unknown error" };
  } finally {
    running = false;
  }
}

// Is THIS frame the one hosting the logged-in banking app? With all_frames
// enabled the content script runs in every frame (the bank serves its UI inside
// a same-origin iframe), so we use this to let only the right frame act.
async function thisFrameIsBankApp() {
  const config = await loadConfig();
  if (!isOriginAllowed(location.origin, config)) return false;
  return createAdapter(config, document).detectLoginState() === LOGIN_STATES.LOGGED_IN;
}

// Fill-only test: populate the open transfer form using the adapter, but never
// advance, submit, or confirm. Used by the popup "test fill" button and the
// console diagnostic. Moves no money.
async function runDryRunFill(opts = {}) {
  const config = await loadConfig();
  const adapter = createAdapter(config, document);
  const src = config.sourceAccounts[opts.sourceIndex ?? 0];
  const payee = config.destinationPayees[opts.payeeIndex ?? 0];
  const out = {
    pageState: adapter.detectPageState(),
    source: src ? await adapter.selectSourceAccount(src) : "no source configured",
    payee: payee ? await adapter.selectDestinationPayee(payee) : "no payee configured",
    amount: await adapter.fillAmount(opts.amount ?? 1),
    memoShort: await adapter.fillMemoShort(opts.memoShort ?? "測試"),
    memoLong: await adapter.fillMemoLong(opts.memoLong ?? "測試"),
  };
  if (src) {
    // Balance is summarized (confidence only) so the popup never shows the amount.
    const b = await adapter.readBalance(src);
    out.balance = { confidence: b.confidence, ok: b.confidence >= 0.9 };
  }
  return out;
}

// Message API from the popup / service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "PING":
      // Only the banking-app frame claims the PING so the popup learns the right
      // frame is ready; other frames stay silent.
      thisFrameIsBankApp().then((ok) => {
        if (ok) sendResponse({ ok: true, origin: location.origin });
      });
      return true; // async
    case "START_BATCH":
      // Every frame receives this; only the banking-app frame handles it so the
      // empty top frame never answers with a misleading "not logged in".
      thisFrameIsBankApp().then((ok) => {
        if (ok) startBatch(msg.batch).then(sendResponse);
      });
      return true; // async
    case "DRY_RUN_FILL":
      // Only the banking-app frame fills the form; it never advances/confirms.
      thisFrameIsBankApp().then((ok) => {
        if (ok) runDryRunFill(msg.opts || {}).then(sendResponse);
      });
      return true; // async
    default:
      return;
  }
});

// ---------------------------------------------------------------------------
// Dev diagnostics (READ-ONLY). Lives only in the content script's isolated
// world; the bank page's own scripts cannot reach it. Use it to develop and
// verify the bank selectors from DevTools: open the bank page, F12, switch the
// Console "context" dropdown to this extension, then e.g.
//   await __bankingAssistant.pageState()
//   await __bankingAssistant.balance()      // check .confidence (must be >= 0.9)
//   await __bankingAssistant.payees()
// None of these fill, submit, or confirm anything. Remove this block for a
// production build if you prefer no diagnostics surface.
globalThis.__bankingAssistant = {
  version: "0.1.0",
  loadConfig,
  async adapter() {
    return createAdapter(await loadConfig(), document);
  },
  async pageState() {
    return (await this.adapter()).detectPageState();
  },
  async pageStateDetailed() {
    return (await this.adapter()).detectPageStateDetailed();
  },
  async loginState() {
    return (await this.adapter()).detectLoginState();
  },
  async sourceAccounts() {
    return (await this.adapter()).readSourceAccounts();
  },
  async balance(index = 0) {
    const config = await loadConfig();
    return createAdapter(config, document).readBalance(config.sourceAccounts[index]);
  },
  async payees() {
    return (await this.adapter()).readDestinationPayees();
  },
  async verification() {
    return (await this.adapter()).readVerificationSummary();
  },
  async completion() {
    return (await this.adapter()).readCompletion();
  },
  // The ONE non-read diagnostic: fills the currently-open transfer form using
  // the adapter (source/payee/amount/memos) so you can verify the field mapping
  // on the real page. It deliberately does NOT click 下一步, submit, or confirm,
  // and moves no money. Configure a real source/payee in Options first, then
  // press 重設 on the bank form afterwards. Returns each step's ActionResult.
  async dryRunFill(opts = {}) {
    return runDryRunFill(opts);
  },
};
console.info("[BankingAssistant] content script ready. Try: await __bankingAssistant.pageState()");
