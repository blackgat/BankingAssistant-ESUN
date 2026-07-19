// Transfer batch runner (SPEC section 9). Environment-agnostic: it depends only
// on an adapter, an overlay, a logger, and a "page waiter" that resolves when
// the observed bank page reaches a target state. The content script injects a
// polling waiter against the live page; the demo harness injects a manual one.
//
// Safety invariants enforced here:
//  - A job only advances past WAITING_USER_VERIFICATION when the completion page
//    is actually observed (never on a timer, never by clicking confirm).
//  - Every extraction is confidence-gated; below threshold the batch stops.
//  - Any policy mismatch stops the batch and does not advance.

import { AUDIT_EVENT_TYPES, BATCH_STATES, JOB_STATES, PAGE_STATES, LOGIN_STATES } from "../core/types.js";
import {
  evaluateBatchPolicy,
  evaluateJobPolicy,
  evaluateVerificationPolicy,
  passesConfidence,
  findSourceAccount,
  findPayee,
} from "../core/policy.js";
import {
  createBatchMachine,
  createJobMachine,
  BATCH_EVENTS,
  JOB_EVENTS,
} from "./state-machine.js";

const A = AUDIT_EVENT_TYPES;

/** Shared cancellation signal the overlay can trigger. */
export class RunnerControl {
  constructor() {
    this.aborted = false;
    this.reason = null;
    this._cbs = [];
  }
  abort(reason = "user_cancelled") {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const cb of this._cbs) cb(reason);
  }
  onAbort(cb) {
    this._cbs.push(cb);
  }
}

/**
 * Default page waiter for the live page: polls adapter.detectPageState() and
 * also reacts to DOM mutations. Resolves with an outcome object.
 * @param {object} adapter
 * @param {RunnerControl} control
 * @param {{intervalMs?: number}} [opts]
 */
export function createPollingWaiter(adapter, control, opts = {}) {
  const intervalMs = opts.intervalMs ?? 400;
  return {
    wait({ accept, stop = [], timeoutMs }) {
      return new Promise((resolve) => {
        let settled = false;
        let observer = null;
        const acceptSet = new Set(accept);
        const stopSet = new Set(stop);

        const finish = (outcome, state) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          clearTimeout(deadline);
          if (observer) observer.disconnect();
          control._cbs = control._cbs.filter((c) => c !== onAbort);
          resolve({ outcome, state });
        };

        const probe = () => {
          if (control.aborted) return finish("cancelled", null);
          const state = adapter.detectPageState();
          if (acceptSet.has(state)) return finish("accepted", state);
          if (stopSet.has(state)) return finish("stopped", state);
        };

        const onAbort = () => finish("cancelled", null);
        control.onAbort(onAbort);

        const timer = setInterval(probe, intervalMs);
        const deadline = setTimeout(() => finish("timeout", null), timeoutMs);

        // React quickly to DOM changes when running in a real document.
        const docRoot =
          adapter.root && adapter.root.nodeType === 9
            ? adapter.root.body || adapter.root.documentElement
            : adapter.root;
        if (docRoot && typeof MutationObserver !== "undefined") {
          observer = new MutationObserver(probe);
          try {
            observer.observe(docRoot, { childList: true, subtree: true, characterData: true });
          } catch {
            observer = null;
          }
        }
        probe();
      });
    },
  };
}

export class TransferRunner {
  /**
   * @param {{
   *   adapter: object,
   *   overlay: object,
   *   logger: object,
   *   config: object,
   *   waiter: { wait: (o:object)=>Promise<{outcome:string,state:string|null}> },
   *   control?: RunnerControl,
   * }} deps
   */
  constructor({ adapter, overlay, logger, config, waiter, control }) {
    this.adapter = adapter;
    this.overlay = overlay;
    this.logger = logger;
    this.config = config;
    this.waiter = waiter;
    this.control = control || new RunnerControl();
    this.batchMachine = createBatchMachine();
  }

  async _audit(eventType, fields) {
    try {
      await this.logger.log(eventType, fields);
    } catch {
      // Never let logging failure break the flow; never log raw errors verbatim.
    }
  }

  _stop(reason) {
    this.batchMachine.send(BATCH_EVENTS.STOP);
    return { results: this.results, stopped: true, reason };
  }

  /**
   * @param {object} batch TransferBatch
   * @returns {Promise<{results: object[], stopped: boolean, reason?: string}>}
   */
  async run(batch) {
    this.results = [];
    const { adapter, overlay, config } = this;

    // 1. Require the user to be logged in (SPEC section 9 assertUserLoggedIn).
    if (adapter.detectLoginState() !== LOGIN_STATES.LOGGED_IN) {
      overlay.showError("尚未偵測到登入狀態，請先登入銀行網站。");
      await this._audit(A.JOB_FAILED, { message: "not logged in" });
      return this._stop("not_logged_in");
    }
    this.batchMachine.send(BATCH_EVENTS.USER_LOGGED_IN);
    await this._audit(A.BATCH_STARTED, { message: `batch ${batch.batchId}`, jobCount: batch.jobs.length });

    // 2. Read balances for every source account used (confidence-gated). Some
    // banks (e.g. E.SUN) don't surface the available balance on the transfer
    // flow; in that case the check is opted out in config and skipped here.
    const requireBalance = config.behavior?.requireBalanceCheck !== false;
    const sourceIds = [...new Set(batch.jobs.map((j) => j.sourceAccountId))];
    const balanceByAccountId = {};
    let primaryBalance = null;
    for (const id of sourceIds) {
      const src = findSourceAccount(config, id);
      if (!src) {
        overlay.showError(`設定中找不到來源帳戶：${id}`);
        await this._audit(A.JOB_FAILED, { sourceAccountId: id, message: "source not in config" });
        return this._stop("source_not_configured");
      }
      if (!requireBalance) continue;
      const reading = await adapter.readBalance(src);
      if (!passesConfidence(reading)) {
        overlay.showError(
          `無法可靠讀取來源帳戶餘額（${src.label}），已停止。原因：confidence ${reading.confidence?.toFixed?.(2)} / 缺少 ${reading.missingFields.join(",")}`,
        );
        await this._audit(A.JOB_FAILED, {
          sourceAccountId: id,
          message: `balance read low confidence ${reading.confidence}`,
        });
        return this._stop("balance_read_failed");
      }
      balanceByAccountId[id] = reading.value.balance;
      if (!primaryBalance) primaryBalance = reading.value;
      await this._audit(A.BALANCE_CHECKED, {
        sourceAccountId: id,
        message: `balance observed for ${src.label}`,
        amount: reading.value.balance,
        currency: reading.value.currency,
      });
    }
    if (!requireBalance) {
      await this._audit(A.BALANCE_CHECKED, { message: "balance sufficiency check skipped (config)" });
    }

    // 3. Batch pre-check (deterministic).
    const precheck = evaluateBatchPolicy(batch, config, balanceByAccountId, { requireBalance });
    if (precheck.result !== "pass") {
      overlay.showPolicyFailure("批次前置檢查未通過，已停止。", precheck.checks);
      await this._audit(A.BATCH_BLOCKED, {
        message: "batch precheck failed",
        totalAmount: precheck.totalAmount,
      });
      return this._stop("batch_precheck_failed");
    }
    this.batchMachine.send(BATCH_EVENTS.BALANCE_CHECKED);
    overlay.showBalanceChecked(primaryBalance, precheck);

    // 4. Enter the loop.
    this.batchMachine.send(BATCH_EVENTS.START_BATCH);
    const dailyTotals = {};
    const total = batch.jobs.length;

    for (let i = 0; i < batch.jobs.length; i++) {
      const job = batch.jobs[i];
      const stepNo = i + 1;
      const jobMachine = createJobMachine();

      if (this.control.aborted) {
        overlay.showUserCancelledOrTimeout(stepNo, total);
        return this._stop("user_cancelled");
      }

      // Per-job policy.
      const jobPolicy = evaluateJobPolicy(job, config, { dailyTotals });
      if (jobPolicy.result !== "pass") {
        jobMachine.send(JOB_EVENTS.SKIP);
        overlay.showJobSkipped(stepNo, total, jobPolicy.checks);
        await this._audit(A.JOB_SKIPPED, { jobId: job.id, message: "per-job policy failed" });
        this.results.push({ jobId: job.id, status: "skipped" });
        continue;
      }

      jobMachine.send(JOB_EVENTS.BEGIN);
      const payee = findPayee(config, job.destinationPayeeId);
      const src = findSourceAccount(config, job.sourceAccountId);
      overlay.showJobProgress(stepNo, total, { job, src, payee });
      await this._audit(A.JOB_STARTED, {
        jobId: job.id,
        sourceAccountId: job.sourceAccountId,
        destinationPayeeId: job.destinationPayeeId,
        amount: job.amount,
        currency: job.currency,
        message: `job ${stepNo}/${total} started`,
      });

      // Navigate to the transfer form and confirm we are on it.
      await adapter.navigateToTransferForm();
      // Do NOT treat "unknown" as a hard stop: an SPA widget load transiently
      // reports unknown between the old and new page. Poll until the form appears
      // or we time out.
      const onForm = await this.waiter.wait({
        accept: [PAGE_STATES.TRANSFER_FORM],
        timeoutMs: config.behavior.verificationTimeoutMs,
      });
      if (onForm.outcome !== "accepted") {
        return this._failJob(jobMachine, stepNo, total, job, "無法進入轉帳表單頁。", onForm.outcome);
      }

      // Fill the form, advancing the job state machine step by step.
      const steps = [
        ["selectSourceAccount", src, JOB_EVENTS.SOURCE_SELECTED],
        ["selectDestinationPayee", payee, JOB_EVENTS.DESTINATION_SELECTED],
        ["fillAmount", job.amount, JOB_EVENTS.AMOUNT_FILLED],
        ["fillMemoShort", job.memoShort, JOB_EVENTS.MEMO_SHORT_FILLED],
        ["fillMemoLong", job.memoLong, JOB_EVENTS.MEMO_LONG_FILLED],
      ];
      let fillOk = true;
      for (const [method, arg, event] of steps) {
        const res = await adapter[method](arg);
        if (!res || res.ok === false) {
          fillOk = false;
          this._failJob(jobMachine, stepNo, total, job, `表單欄位填寫失敗：${method}`, "fill_failed");
          break;
        }
        jobMachine.send(event);
      }
      if (!fillOk) return { results: this.results, stopped: true, reason: "fill_failed" };

      jobMachine.send(JOB_EVENTS.FORM_READY);
      await this._audit(A.FORM_FILLED, { jobId: job.id, message: "form filled, ready for user review" });

      // Submit to the verification page (NOT final confirm).
      await adapter.submitFormToVerificationPage();
      const verifWait = await this.waiter.wait({
        accept: [PAGE_STATES.VERIFICATION],
        timeoutMs: config.behavior.verificationTimeoutMs,
      });
      if (verifWait.outcome !== "accepted") {
        return this._failJob(
          jobMachine,
          stepNo,
          total,
          job,
          "送出後未在時限內進入驗證頁。",
          verifWait.outcome,
        );
      }

      // Verification-page policy.
      const summary = adapter.readVerificationSummary();
      if (!passesConfidence(summary)) {
        return this._failJob(jobMachine, stepNo, total, job, "驗證頁資料讀取信心不足。", "low_confidence");
      }
      const vPolicy = evaluateVerificationPolicy(job, config, summary.value);
      if (vPolicy.result !== "pass") {
        jobMachine.send(JOB_EVENTS.FAIL);
        overlay.showPolicyFailure("驗證頁資料與預期不符，已停止批次。", vPolicy.checks);
        await this._audit(A.JOB_FAILED, { jobId: job.id, message: "verification policy mismatch" });
        this.results.push({ jobId: job.id, status: "failed", error: "verification_mismatch" });
        return this._stop("verification_mismatch");
      }

      // Stop and wait for the user to authorize on the bank page.
      jobMachine.send(JOB_EVENTS.VERIFICATION_PAGE_DETECTED);
      overlay.showWaitingUserVerification(stepNo, total, { job, src, payee, summary: summary.value });
      await this._audit(A.WAITING_USER_VERIFICATION, { jobId: job.id, message: "waiting for user" });

      const completeWait = await this.waiter.wait({
        accept: [PAGE_STATES.COMPLETION],
        timeoutMs: config.behavior.completionTimeoutMs,
      });
      if (completeWait.outcome !== "accepted") {
        jobMachine.send(completeWait.outcome === "cancelled" ? JOB_EVENTS.CANCEL : JOB_EVENTS.FAIL);
        overlay.showUserCancelledOrTimeout(stepNo, total, completeWait.outcome);
        await this._audit(A.JOB_CANCELLED_OR_TIMEOUT, {
          jobId: job.id,
          message: `completion wait ended: ${completeWait.outcome}`,
        });
        this.results.push({ jobId: job.id, status: completeWait.outcome === "cancelled" ? "user_cancelled" : "failed" });
        return this._stop(completeWait.outcome);
      }

      // Completion observed.
      const completion = adapter.readCompletion();
      if (!passesConfidence(completion)) {
        return this._failJob(jobMachine, stepNo, total, job, "完成頁偵測不明確。", "low_confidence");
      }
      jobMachine.send(JOB_EVENTS.COMPLETION_PAGE_DETECTED);
      await this._audit(A.COMPLETION_DETECTED, {
        jobId: job.id,
        message: "completion page detected",
        bankReferenceMasked: completion.value.bankReferenceMasked,
      });
      jobMachine.send(JOB_EVENTS.COMPLETE);
      overlay.showJobCompleted(stepNo, total, completion.value);
      await this._audit(A.JOB_COMPLETED, { jobId: job.id, message: "job completed" });
      this.results.push({
        jobId: job.id,
        status: "completed",
        completedAt: completion.value.completedAt,
        bankReferenceMasked: completion.value.bankReferenceMasked,
        observedCompletionText: completion.value.completionText,
      });

      // Accumulate daily totals only after a confirmed completion.
      if (payee) dailyTotals[payee.id] = (dailyTotals[payee.id] || 0) + job.amount;

      // Advance to the next transfer if any remain.
      if (i < batch.jobs.length - 1) {
        await adapter.navigateToNextTransfer();
      }
    }

    // 5. Batch complete -> final balance -> logout.
    this.batchMachine.send(BATCH_EVENTS.BATCH_DONE);
    const primarySource = findSourceAccount(config, sourceIds[0]);
    const finalBalance =
      requireBalance && primarySource ? await adapter.readFinalBalance(primarySource) : null;
    this.batchMachine.send(BATCH_EVENTS.FINAL_BALANCE_SHOWN);
    overlay.showBatchCompleted(finalBalance, this.results);
    await this._audit(A.BATCH_COMPLETED, {
      message: "batch completed",
      amount: finalBalance?.balance,
      currency: finalBalance?.currency,
    });

    // Assist logout if enabled; otherwise leave the session open for the user
    // (e.g. to review the completion page). SPEC section 2 lists logout as the
    // final step, so this defaults on.
    this.batchMachine.send(BATCH_EVENTS.LOGOUT_REQUESTED);
    if (config.behavior?.autoLogout !== false) {
      const logout = await adapter.logout();
      overlay.showLogout(logout);
      await this._audit(A.LOGOUT_CLICKED, { message: logout.message });
    } else {
      overlay.showLogout({ ok: true, skipped: true, message: "auto-logout off" });
      await this._audit(A.LOGOUT_CLICKED, { message: "auto-logout disabled; session left to user" });
    }

    return { results: this.results, stopped: false };
  }

  _failJob(jobMachine, stepNo, total, job, message, outcome) {
    if (jobMachine.state !== JOB_STATES.JOB_FAILED && jobMachine.can(JOB_EVENTS.FAIL)) {
      jobMachine.send(JOB_EVENTS.FAIL);
    }
    this.overlay.showError(`${message}（${outcome}）`);
    this.results.push({ jobId: job.id, status: "failed", error: outcome });
    // Audit then stop the batch.
    this._audit(A.JOB_FAILED, { jobId: job.id, message: `${message} (${outcome})` });
    return this._stop(outcome);
  }
}
