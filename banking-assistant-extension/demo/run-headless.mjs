// Headless end-to-end demo. Drives the REAL TransferRunner + EsunAdapter +
// Overlay + AuditLogger through a full 2-job batch against the real fixtures,
// printing every overlay update and the final sanitized audit log. Unlike the
// browser harness, this is deterministic and needs no clicking.
//
//   node demo/run-headless.mjs
//
// The "user authorization" step (pressing the bank's confirm button) is the only
// thing automated here; everything else is the production code path.

import { loadDom, bodyInner } from "../tests/dom-helper.js";
import { EsunAdapter } from "../src/content/extractors/bank-adapter.esun.js";
import { TransferRunner } from "../src/content/runner.js";
import { Overlay } from "../src/content/overlay.js";
import { AuditLogger } from "../src/core/logger.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";

const doc = loadDom("<!DOCTYPE html><html><body></body></html>");
const setPage = (name) => {
  doc.body.innerHTML = bodyInner(name);
};
setPage("bank-home.html");

// Overlay subclass that echoes every rendered (sanitized) update to the console.
class TracingOverlay extends Overlay {
  _render(nodes, phase) {
    super._render(nodes, phase);
    const txt = this.body ? this.body.textContent.replace(/\s+/g, " ").trim() : "";
    console.log(`   overlay [${phase}] ${txt}`);
  }
}

// Adapter whose navigation drives the simulated SPA.
class HarnessAdapter extends EsunAdapter {
  constructor() {
    super({ root: doc, config: DEFAULT_CONFIG });
  }
  async navigateToTransferForm() {
    setPage("transfer-form.html");
    return super.navigateToTransferForm();
  }
  async submitFormToVerificationPage() {
    const r = await super.submitFormToVerificationPage();
    setPage("verification.html");
    return r;
  }
  async navigateToNextTransfer() {
    setPage("transfer-form.html");
    return { ok: true, message: "next" };
  }
  async readFinalBalance(src) {
    setPage("bank-home.html");
    return super.readFinalBalance(src);
  }
}

const adapter = new HarnessAdapter();

// Scripted waiter: prints what the extension is waiting for, and simulates the
// human authorizing by surfacing the completion page.
const waiter = {
  async wait({ accept }) {
    if (accept.includes("transfer_form")) {
      console.log("   runner -> navigated to transfer form, waiting for it");
    } else if (accept.includes("verification")) {
      console.log("   runner -> submitted to verification page (NOT final confirm)");
    } else if (accept.includes("completion")) {
      console.log("   >> PAUSE: extension stops and waits for YOU to authorize on the bank page");
      console.log("   >> (headless demo auto-presses the bank's 確認轉出 for you)");
      setPage("completion.html");
    }
    const state = adapter.detectPageState();
    return accept.includes(state)
      ? { outcome: "accepted", state }
      : { outcome: "timeout", state };
  },
};

const job = (id) => ({
  id,
  sourceAccountId: "low_balance_transfer_account",
  destinationPayeeId: "family_support",
  amount: 3000,
  currency: "TWD",
  memoShort: "家用",
  memoLong: "2026-06 家用",
});

const batch = { batchId: "demo-batch", createdAt: "2026-06-21T00:00:00Z", jobs: [job("j1"), job("j2")] };

const overlay = new TracingOverlay({ mountTo: doc.body });
const logger = new AuditLogger();
const runner = new TransferRunner({ adapter, overlay, logger, config: DEFAULT_CONFIG, waiter });

console.log("=== Banking Transfer Assistant — headless run (2 jobs) ===\n");
const result = await runner.run(batch);

console.log("\n=== Result ===");
console.log(`stopped: ${result.stopped}`);
for (const r of result.results) {
  console.log(`  job ${r.jobId}: ${r.status}  ref=${r.bankReferenceMasked || "-"}`);
}

const log = await logger.getAll();
console.log(`\n=== Audit log (${log.length} entries, sanitized JSONL) ===`);
for (const e of log) console.log(JSON.stringify(e));

const serialized = JSON.stringify(log);
console.log("\n=== Leakage checks ===");
console.log(`  raw reference present?      ${serialized.includes("ESN20260621ABC789")}`);
console.log(`  any 6+ digit run present?   ${/\d{6,}/.test(serialized)}`);
console.log(`  'password'/'otp' present?   ${/password|"otp"/i.test(serialized)}`);
