// End-to-end flow test (SPEC section 20 acceptance criteria). Drives the real
// TransferRunner against the real adapter + real fixtures, swapping the page as
// a user would. A scripted waiter simulates the user authorizing on the bank
// page by surfacing the completion page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDom, bodyInner } from "./dom-helper.js";
import { EsunAdapter } from "../src/content/extractors/bank-adapter.esun.js";
import { TransferRunner } from "../src/content/runner.js";
import { Overlay } from "../src/content/overlay.js";
import { AuditLogger } from "../src/core/logger.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";

function makeJob(id) {
  return {
    id,
    sourceAccountId: "low_balance_transfer_account",
    destinationPayeeId: "family_support",
    amount: 3000,
    currency: "TWD",
    memoShort: "家用",
    memoLong: "2026-06 家用",
  };
}

test("runs a 2-job batch to completion and never advances without a completion page", async () => {
  const doc = loadDom("<!DOCTYPE html><html><body></body></html>");
  const setPage = (name) => {
    doc.body.innerHTML = bodyInner(name);
  };
  setPage("bank-home.html");

  // Adapter whose navigation actions drive page transitions, mirroring an SPA.
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

  // Scripted waiter: when the runner waits for the completion page, simulate the
  // user finishing the bank's verification by switching to the completion page.
  const waiter = {
    async wait({ accept }) {
      if (accept.includes("completion")) setPage("completion.html");
      const state = adapter.detectPageState();
      return accept.includes(state)
        ? { outcome: "accepted", state }
        : { outcome: "timeout", state };
    },
  };

  const overlay = new Overlay({ mountTo: doc.body });
  const logger = new AuditLogger(); // in-memory (no chrome present)
  const runner = new TransferRunner({
    adapter,
    overlay,
    logger,
    config: DEFAULT_CONFIG,
    waiter,
  });

  const batch = { batchId: "b1", createdAt: "2026-06-21T00:00:00Z", jobs: [makeJob("j1"), makeJob("j2")] };
  const result = await runner.run(batch);

  assert.equal(result.stopped, false, "batch should complete");
  assert.equal(result.results.length, 2);
  for (const r of result.results) {
    assert.equal(r.status, "completed");
    assert.equal(r.bankReferenceMasked, "ESN****789");
  }

  const log = await logger.getAll();
  const types = log.map((e) => e.eventType);
  // Each job stopped and waited for the user, then a completion page was observed.
  assert.equal(types.filter((t) => t === "waiting_user_verification").length, 2);
  assert.equal(types.filter((t) => t === "completion_detected").length, 2);
  assert.ok(types.includes("batch_completed"));
  assert.ok(types.includes("logout_clicked"));

  // Audit log must not contain the raw reference, full account, or any 6+ digit run.
  const serialized = JSON.stringify(log);
  assert.ok(!serialized.includes("ESN20260621ABC789"), "raw reference leaked");
  assert.ok(!/\d{6,}/.test(serialized), "a 6+ digit run leaked into the audit log");
});

test("stops the batch when the verification page does not match the job", async () => {
  const doc = loadDom("<!DOCTYPE html><html><body></body></html>");
  const setPage = (name) => {
    doc.body.innerHTML = bodyInner(name);
  };
  setPage("bank-home.html");

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
  }
  const adapter = new HarnessAdapter();
  const waiter = {
    async wait({ accept }) {
      const state = adapter.detectPageState();
      return accept.includes(state) ? { outcome: "accepted", state } : { outcome: "timeout", state };
    },
  };
  const overlay = new Overlay({ mountTo: doc.body });
  const logger = new AuditLogger();
  const runner = new TransferRunner({ adapter, overlay, logger, config: DEFAULT_CONFIG, waiter });

  // The verification fixture shows NT$ 3,000; this job expects 5,000 -> mismatch.
  const batch = { batchId: "b2", createdAt: "t", jobs: [{ ...makeJob("j1"), amount: 5000 }] };
  const result = await runner.run(batch);

  assert.equal(result.stopped, true);
  assert.equal(result.reason, "verification_mismatch");
  const log = await logger.getAll();
  assert.ok(log.some((e) => e.eventType === "job_failed"));
  // It never reached a completion for this job.
  assert.ok(!log.some((e) => e.eventType === "completion_detected"));
});
