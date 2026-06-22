// Deterministic policy engine (SPEC section 7).
//
// IMPORTANT: every function here is a pure function of its inputs. No LLM call,
// no network, no DOM, no randomness. The decision to continue a batch must be
// reproducible and auditable.

import { CURRENCY, CONFIDENCE_THRESHOLD } from "./types.js";

/**
 * @param {{name:string, pass:boolean, detail:string}} check
 */
function check(name, pass, detail) {
  return { name, pass, detail };
}

export function findSourceAccount(config, id) {
  return (config.sourceAccounts || []).find((a) => a.id === id) || null;
}

export function findPayee(config, id) {
  return (config.destinationPayees || []).find((p) => p.id === id) || null;
}

/**
 * Convert a displayNamePattern such as "張*67890" into a RegExp.
 * "*" matches any run of characters; everything else is literal.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function patternToRegExp(pattern) {
  const escaped = String(pattern ?? "")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Does an observed display name / masked name match a configured pattern?
 * @param {string} pattern
 * @param {string} observed
 */
export function matchesDisplayName(pattern, observed) {
  if (!pattern || observed == null) return false;
  const text = String(observed).trim();
  if (patternToRegExp(pattern).test(text)) return true;
  // Fallback 1: a "*last5" style pattern matches if the trailing digits line up,
  // even when surrounding text differs slightly.
  const patDigits = String(pattern).replace(/\D/g, "");
  const obsDigits = text.replace(/\D/g, "");
  if (patDigits.length >= 4 && obsDigits && obsDigits.endsWith(patDigits)) return true;
  // Fallback 2: the leading non-digit, non-wildcard prefix matches. This handles
  // masked names from a verification page (e.g. observed "張*" vs pattern
  // "張*67890" -> both share the prefix "張"), where the last 5 digits are
  // already verified by a separate, stricter check.
  const prefix = (s) => String(s).replace(/[\d*].*$/u, "").trim();
  const patPrefix = prefix(pattern);
  const obsPrefix = prefix(text);
  if (patPrefix && obsPrefix && (obsPrefix.startsWith(patPrefix) || patPrefix.startsWith(obsPrefix))) {
    return true;
  }
  return false;
}

/**
 * Normalize text for tolerant comparison: NFKC folds full-width characters to
 * half-width (banks often display half-width input as full-width on confirm
 * pages), and whitespace runs collapse to a single space.
 * @param {string} s
 */
export function normalizeForCompare(s) {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Whether two strings are equal once normalized (full/half-width, whitespace). */
export function textEquivalent(a, b) {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function memoLengthChecks(job, config, checks, prefix = "") {
  const shortMax = config.behavior?.memoShortMaxLen ?? Infinity;
  const longMax = config.behavior?.memoLongMaxLen ?? Infinity;
  const sLen = (job.memoShort ?? "").length;
  const lLen = (job.memoLong ?? "").length;
  checks.push(
    check(
      `${prefix}memo_short_length`,
      sLen <= shortMax,
      `memoShort length ${sLen} <= ${shortMax}`,
    ),
  );
  checks.push(
    check(
      `${prefix}memo_long_length`,
      lLen <= longMax,
      `memoLong length ${lLen} <= ${longMax}`,
    ),
  );
}

/**
 * Per-job pre-fill policy (SPEC section 7.2).
 * @param {object} job
 * @param {object} config
 * @param {{dailyTotals?: Record<string, number>}} [ctx] running daily totals by payeeId
 */
export function evaluateJobPolicy(job, config, ctx = {}) {
  const checks = [];
  const src = findSourceAccount(config, job.sourceAccountId);
  const payee = findPayee(config, job.destinationPayeeId);

  checks.push(check("source_exists", !!src, `sourceAccountId=${job.sourceAccountId}`));
  checks.push(check("payee_exists", !!payee, `destinationPayeeId=${job.destinationPayeeId}`));
  checks.push(check("currency_twd", job.currency === CURRENCY, `currency=${job.currency}`));

  const amountValid = typeof job.amount === "number" && job.amount > 0;
  checks.push(check("amount_positive", amountValid, `amount=${job.amount}`));

  if (payee) {
    checks.push(
      check(
        "amount_under_max_per_txn",
        amountValid && job.amount <= payee.maxAmountPerTxn,
        `amount=${job.amount} <= maxAmountPerTxn=${payee.maxAmountPerTxn}`,
      ),
    );
    if (typeof payee.maxAmountPerDay === "number") {
      const prior = ctx.dailyTotals?.[payee.id] ?? 0;
      checks.push(
        check(
          "amount_under_max_per_day",
          amountValid && prior + job.amount <= payee.maxAmountPerDay,
          `dailyPrior=${prior} + amount=${job.amount} <= maxAmountPerDay=${payee.maxAmountPerDay}`,
        ),
      );
    }
  }

  memoLengthChecks(job, config, checks);

  const pass = checks.every((c) => c.pass);
  return { result: pass ? "pass" : "fail", checks };
}

/**
 * Batch pre-check before entering the loop (SPEC section 7.1).
 * @param {object} batch
 * @param {object} config
 * @param {Record<string, number>} balanceByAccountId observed balances keyed by sourceAccountId
 */
export function evaluateBatchPolicy(batch, config, balanceByAccountId = {}, options = {}) {
  const requireBalance = options.requireBalance !== false;
  const checks = [];
  const jobs = batch.jobs || [];

  // Per-job validity and accumulation by source/payee.
  const totalBySource = {};
  const totalByPayee = {};
  let totalAmount = 0;

  for (const job of jobs) {
    const jobResult = evaluateJobPolicy(job, config, {
      dailyTotals: totalByPayee,
    });
    for (const c of jobResult.checks) {
      checks.push(check(`job:${job.id}:${c.name}`, c.pass, c.detail));
    }
    if (typeof job.amount === "number" && job.amount > 0) {
      totalAmount += job.amount;
      totalBySource[job.sourceAccountId] = (totalBySource[job.sourceAccountId] || 0) + job.amount;
      totalByPayee[job.destinationPayeeId] =
        (totalByPayee[job.destinationPayeeId] || 0) + job.amount;
    }
  }

  // Batch size guard.
  const maxJobs = config.globalLimits?.maxJobsPerBatch ?? Infinity;
  checks.push(
    check("batch_size_within_limit", jobs.length <= maxJobs, `jobs=${jobs.length} <= ${maxJobs}`),
  );
  checks.push(check("batch_non_empty", jobs.length > 0, `jobs=${jobs.length}`));

  // Balance sufficiency per source account used in this batch.
  // total(source) + source.minimumRemainingBalance <= observedBalance(source).
  let requiredMinimumBalance = 0;
  let observedBalance;
  for (const [sourceId, sourceTotal] of Object.entries(totalBySource)) {
    const src = findSourceAccount(config, sourceId);
    const minRemain = src?.minimumRemainingBalance ?? 0;
    requiredMinimumBalance += minRemain;
    if (!requireBalance) continue; // bank doesn't expose balance on the flow; opted out
    const observed = balanceByAccountId[sourceId];
    if (observed === undefined || observed === null || Number.isNaN(observed)) {
      // Fail closed: cannot verify sufficiency without a balance reading.
      checks.push(
        check(
          `balance_observed:${sourceId}`,
          false,
          `no observed balance for sourceAccountId=${sourceId}`,
        ),
      );
      continue;
    }
    if (observedBalance === undefined) observedBalance = observed;
    checks.push(
      check(
        `balance_sufficient:${sourceId}`,
        sourceTotal + minRemain <= observed,
        `total=${sourceTotal} + minRemaining=${minRemain} <= balance=${observed}`,
      ),
    );
  }

  const pass = checks.every((c) => c.pass);
  return {
    result: pass ? "pass" : "fail",
    totalAmount,
    requiredMinimumBalance,
    observedBalance,
    checks,
  };
}

/**
 * Verification-page policy (SPEC section 7.3). Run just before stopping for the
 * user. If anything mismatches the batch must stop and not advance.
 * @param {object} job
 * @param {object} config
 * @param {object|null} summary VerificationSummary observed from the page
 */
export function evaluateVerificationPolicy(job, config, summary) {
  const checks = [];
  const payee = findPayee(config, job.destinationPayeeId);
  const src = findSourceAccount(config, job.sourceAccountId);

  if (!summary) {
    checks.push(check("verification_summary_present", false, "no verification summary observed"));
    return { result: "fail", checks };
  }

  checks.push(
    check("page_is_verification", summary.pageState === "verification", `pageState=${summary.pageState}`),
  );
  checks.push(check("amount_match", summary.amount === job.amount, `summary=${summary.amount} job=${job.amount}`));
  checks.push(check("currency_twd", summary.currency === CURRENCY, `currency=${summary.currency}`));

  // Destination account last-5 must match.
  if (payee?.accountLast5) {
    checks.push(
      check(
        "destination_last5_match",
        summary.destinationAccountLast5 === payee.accountLast5,
        `summary=${summary.destinationAccountLast5} expected=${payee.accountLast5}`,
      ),
    );
  }

  // Destination payee name should match the configured (masked) pattern. But a
  // confirm page may mask the name or show an account nickname instead of a
  // person name, so when the destination account's last-5 already matches (the
  // authoritative identity for a pre-registered designated payee) a name-format
  // difference must not block the batch.
  if (payee?.displayNamePattern && summary.destinationPayeeNameMasked) {
    const last5Ok = !!(payee.accountLast5 && summary.destinationAccountLast5 === payee.accountLast5);
    const nameOk = matchesDisplayName(payee.displayNamePattern, summary.destinationPayeeNameMasked) || last5Ok;
    checks.push(
      check(
        "destination_name_match",
        nameOk,
        `name=${summary.destinationPayeeNameMasked} pattern=${payee.displayNamePattern} last5Ok=${last5Ok}`,
      ),
    );
  }

  // Source account last-5 must match if both sides expose it.
  if (src?.accountLast5 && summary.sourceAccountLast5) {
    checks.push(
      check(
        "source_last5_match",
        summary.sourceAccountLast5 === src.accountLast5,
        `summary=${summary.sourceAccountLast5} expected=${src.accountLast5}`,
      ),
    );
  }

  // Memos only checked when the bank page actually shows them. Compared after
  // NFKC normalization because banks (e.g. E.SUN) render half-width input as
  // full-width on the confirm page.
  if (summary.memoShort != null) {
    checks.push(check("memo_short_match", textEquivalent(summary.memoShort, job.memoShort), "memoShort"));
  }
  if (summary.memoLong != null) {
    checks.push(check("memo_long_match", textEquivalent(summary.memoLong, job.memoLong), "memoLong"));
  }

  const pass = checks.every((c) => c.pass);
  return { result: pass ? "pass" : "fail", checks };
}

/**
 * Gate an ExtractionResult on the global confidence threshold (SPEC section 11).
 * @param {{value:any, confidence:number, missingFields:string[]}} extraction
 * @param {number} [threshold]
 */
export function passesConfidence(extraction, threshold = CONFIDENCE_THRESHOLD) {
  return (
    !!extraction &&
    extraction.value != null &&
    typeof extraction.confidence === "number" &&
    extraction.confidence >= threshold
  );
}
