// Content-script ESM entry. Loaded by main.js via dynamic import so that core
// modules can use ES module syntax and remain unit-testable. Runs in the content
// script's isolated world, so chrome.runtime / chrome.storage are available.

import { STORAGE_KEYS, DEFAULT_CONFIG, LOGIN_STATES } from "../core/types.js";
import * as Lists from "../core/lists.js";
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

/**
 * Write the outcome back onto the named list so the popup can show whether this
 * list was just run. Best-effort: a failure here must never affect the batch.
 * @param {string|undefined} listId
 * @param {{status: string, completed?: number, total?: number, reason?: string}} run
 */
async function recordListRun(listId, run) {
  if (!listId) return;
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.LISTS))[STORAGE_KEYS.LISTS];
    if (!stored) return;
    const next = Lists.recordRun(Lists.migrateState(stored, null), listId, run);
    await chrome.storage.local.set({ [STORAGE_KEYS.LISTS]: next });
  } catch {
    // Never let bookkeeping break the run.
  }
}

async function startBatch(batch, listId) {
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
    const completed = (result.results || []).filter((r) => r.status === "completed").length;
    await recordListRun(listId, {
      status: result.stopped ? Lists.RUN_STATUS.STOPPED : Lists.RUN_STATUS.COMPLETED,
      completed,
      total: batch.jobs.length,
      reason: result.reason,
    });
    return { ok: !result.stopped, ...result };
  } catch (e) {
    overlay.showError("執行發生未預期錯誤，已停止。");
    await recordListRun(listId, {
      status: Lists.RUN_STATUS.STOPPED,
      total: batch.jobs?.length,
      reason: "unexpected_error",
    });
    return { ok: false, message: e?.message || "unknown error" };
  } finally {
    running = false;
  }
}

// Is this page the logged-in banking app? Until E.SUN's 2026-10-17 redesign
// this also picked the right frame, because the app lived in a same-origin
// iframe and the content script ran in all of them. There are no iframes now,
// so what is left is the part that always mattered: act only on an allowed
// origin, and only when a session is actually signed in.
async function pageIsBankApp() {
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
      // Answer only from an allowed, signed-in page, so the popup does not take
      // silence for readiness.
      pageIsBankApp().then((ok) => {
        if (ok) sendResponse({ ok: true, origin: location.origin });
      });
      return true; // async
    case "START_BATCH":
      // Refuse to start a batch unless the origin is allowed and a session is
      // signed in.
      pageIsBankApp().then((ok) => {
        if (ok) startBatch(msg.batch, msg.listId).then(sendResponse);
      });
      return true; // async
    case "DRY_RUN_FILL":
      // Fills the open form; never advances or confirms.
      pageIsBankApp().then((ok) => {
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
// Announce readiness only on the banking app itself, not on every page the
// host serves.
pageIsBankApp().then((isBankApp) => {
  if (isBankApp) {
    console.info("[BankingAssistant] content script ready. Try: await __bankingAssistant.pageState()");
  }
});
