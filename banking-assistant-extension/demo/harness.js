// Demo harness: runs the real TransferRunner + EsunAdapter + Overlay against the
// real fixtures, fully offline. The extension fills the form and stops at the
// verification page; YOU click the bank's red "確認轉出" to authorize, which
// surfaces the completion page and lets the runner advance. Nothing here clicks
// that button for you.

import { EsunAdapter } from "../src/content/extractors/bank-adapter.esun.js";
import { TransferRunner, RunnerControl } from "../src/content/runner.js";
import { Overlay } from "../src/content/overlay.js";
import { AuditLogger } from "../src/core/logger.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";

const bankPage = document.getElementById("bank-page");
const auditEl = document.getElementById("audit");

async function fixtureBody(name) {
  const res = await fetch(`../tests/fixtures/${name}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.innerHTML;
}

async function setPage(name) {
  bankPage.innerHTML = await fixtureBody(name);
}

// Resolver that the user's click on the bank's confirm button fulfils.
let onUserAuthorized = null;

function wireUserAuthorize() {
  const confirmBtn = bankPage.querySelector("#confirmFinal");
  if (!confirmBtn) return;
  confirmBtn.addEventListener("click", async () => {
    await setPage("completion.html");
    if (onUserAuthorized) {
      const r = onUserAuthorized;
      onUserAuthorized = null;
      r();
    }
  });
}

// Adapter whose navigation actions drive the simulated SPA, mirroring real life.
class HarnessAdapter extends EsunAdapter {
  constructor() {
    super({ root: bankPage, config: DEFAULT_CONFIG });
  }
  async navigateToTransferForm() {
    await setPage("transfer-form.html");
    return super.navigateToTransferForm();
  }
  async submitFormToVerificationPage() {
    const r = await super.submitFormToVerificationPage();
    await setPage("verification.html");
    wireUserAuthorize();
    return r;
  }
  async navigateToNextTransfer() {
    await setPage("transfer-form.html");
    return { ok: true, message: "next" };
  }
  async readFinalBalance(src) {
    await setPage("bank-home.html");
    return super.readFinalBalance(src);
  }
}

function makeWaiter(adapter, control) {
  return {
    wait({ accept }) {
      // Waiting for the completion page == waiting for the human to authorize.
      if (accept.includes("completion")) {
        return new Promise((resolve) => {
          onUserAuthorized = () => resolve({ outcome: "accepted", state: "completion" });
          control.onAbort(() => resolve({ outcome: "cancelled", state: null }));
        });
      }
      // Other waits are satisfied by the navigation overrides above.
      const state = adapter.detectPageState();
      return Promise.resolve(
        accept.includes(state) ? { outcome: "accepted", state } : { outcome: "timeout", state },
      );
    },
  };
}

function makeBatch() {
  const job = (id) => ({
    id,
    sourceAccountId: "low_balance_transfer_account",
    destinationPayeeId: "family_support",
    amount: 3000,
    currency: "TWD",
    memoShort: "家用",
    memoLong: "2026-06 家用",
  });
  return { batchId: "demo-batch", createdAt: new Date().toISOString(), jobs: [job("j1"), job("j2")] };
}

let running = false;

async function start() {
  if (running) return;
  running = true;
  await setPage("bank-home.html");

  const control = new RunnerControl();
  const overlay = new Overlay({ mountTo: document.body });
  overlay.mount();
  overlay.setOnCancel(() => control.abort("user_cancelled"));

  const adapter = new HarnessAdapter();
  const logger = new AuditLogger(); // in-memory
  const waiter = makeWaiter(adapter, control);
  const runner = new TransferRunner({ adapter, overlay, logger, config: DEFAULT_CONFIG, waiter, control });

  try {
    await runner.run(makeBatch());
  } finally {
    const log = await logger.getAll();
    auditEl.textContent = log.map((e) => JSON.stringify(e)).join("\n") || "（無紀錄）";
    running = false;
  }
}

document.getElementById("reset").addEventListener("click", () => setPage("bank-home.html"));
document.getElementById("start").addEventListener("click", start);
setPage("bank-home.html");
