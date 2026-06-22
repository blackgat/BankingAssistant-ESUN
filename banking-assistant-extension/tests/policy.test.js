import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateJobPolicy,
  evaluateBatchPolicy,
  evaluateVerificationPolicy,
  passesConfidence,
  matchesDisplayName,
  textEquivalent,
} from "../src/core/policy.js";

const config = {
  bankId: "esun",
  sourceAccounts: [
    {
      id: "src",
      label: "低餘額帳戶",
      displayNamePattern: "活期存款*12345",
      accountLast5: "12345",
      currency: "TWD",
      minimumRemainingBalance: 1000,
    },
  ],
  destinationPayees: [
    {
      id: "pay",
      label: "家用",
      displayNamePattern: "張*67890",
      accountLast5: "67890",
      currency: "TWD",
      maxAmountPerTxn: 10000,
      maxAmountPerDay: 10000,
    },
  ],
  globalLimits: { maxJobsPerBatch: 20 },
  behavior: { memoShortMaxLen: 20, memoLongMaxLen: 60 },
};

const okJob = {
  id: "j1",
  sourceAccountId: "src",
  destinationPayeeId: "pay",
  amount: 3000,
  currency: "TWD",
  memoShort: "家用",
  memoLong: "2026-06 家用",
};

test("per-job policy passes for a valid job", () => {
  assert.equal(evaluateJobPolicy(okJob, config).result, "pass");
});

test("amount exceeding maxAmountPerTxn fails", () => {
  const r = evaluateJobPolicy({ ...okJob, amount: 20000 }, config);
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "amount_under_max_per_txn").pass, false);
});

test("payee mismatch fails", () => {
  const r = evaluateJobPolicy({ ...okJob, destinationPayeeId: "ghost" }, config);
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "payee_exists").pass, false);
});

test("source account mismatch fails", () => {
  const r = evaluateJobPolicy({ ...okJob, sourceAccountId: "ghost" }, config);
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "source_exists").pass, false);
});

test("memo too long fails", () => {
  const r = evaluateJobPolicy({ ...okJob, memoShort: "x".repeat(21) }, config);
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "memo_short_length").pass, false);
});

test("batch policy passes with sufficient balance", () => {
  const r = evaluateBatchPolicy({ batchId: "b", jobs: [okJob] }, config, { src: 50000 });
  assert.equal(r.result, "pass");
  assert.equal(r.totalAmount, 3000);
  assert.equal(r.requiredMinimumBalance, 1000);
});

test("insufficient balance fails (total + minRemaining > balance)", () => {
  const r = evaluateBatchPolicy({ batchId: "b", jobs: [okJob] }, config, { src: 3500 });
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "balance_sufficient:src").pass, false);
});

test("missing balance observation fails closed", () => {
  const r = evaluateBatchPolicy({ batchId: "b", jobs: [okJob] }, config, {});
  assert.equal(r.result, "fail");
});

test("balance check can be opted out (bank doesn't expose balance)", () => {
  // No balance provided, but requireBalance:false -> still passes on other checks.
  const r = evaluateBatchPolicy({ batchId: "b", jobs: [okJob] }, config, {}, { requireBalance: false });
  assert.equal(r.result, "pass");
  assert.ok(!r.checks.some((c) => c.name.startsWith("balance_")));
});

test("daily limit across the batch fails", () => {
  const jobs = [
    { ...okJob, id: "a", amount: 6000 },
    { ...okJob, id: "b", amount: 6000 },
  ];
  const r = evaluateBatchPolicy({ batchId: "b", jobs }, config, { src: 100000 });
  assert.equal(r.result, "fail");
  // second job should trip the per-day check
  assert.ok(r.checks.some((c) => c.name.includes("amount_under_max_per_day") && c.pass === false));
});

test("verification policy passes when the page matches the job", () => {
  const summary = {
    sourceAccountLast5: "12345",
    destinationPayeeNameMasked: "張*",
    destinationAccountLast5: "67890",
    amount: 3000,
    currency: "TWD",
    memoShort: "家用",
    memoLong: "2026-06 家用",
    pageState: "verification",
  };
  assert.equal(evaluateVerificationPolicy(okJob, config, summary).result, "pass");
});

test("verification tolerates full-width memos and defers name to a matching last5", () => {
  const summary = {
    sourceAccountLast5: "12345",
    destinationPayeeNameMasked: "陳**", // different surname than pattern 張*67890
    destinationAccountLast5: "67890", // ...but last5 matches -> name deferred
    amount: 3000,
    currency: "TWD",
    memoShort: "家用",
    memoLong: "２０２６－０６　家用", // full-width; equals job "2026-06 家用" after NFKC
    pageState: "verification",
  };
  const r = evaluateVerificationPolicy(okJob, config, summary);
  assert.equal(r.result, "pass");
  assert.equal(r.checks.find((c) => c.name === "destination_name_match").pass, true);
  assert.equal(r.checks.find((c) => c.name === "memo_long_match").pass, true);
});

test("verification still fails when both name and last5 mismatch", () => {
  const summary = {
    destinationPayeeNameMasked: "陳**",
    destinationAccountLast5: "00000", // wrong account
    amount: 3000,
    currency: "TWD",
    pageState: "verification",
  };
  const r = evaluateVerificationPolicy(okJob, config, summary);
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "destination_last5_match").pass, false);
  assert.equal(r.checks.find((c) => c.name === "destination_name_match").pass, false);
});

test("textEquivalent folds full-width and collapses whitespace", () => {
  assert.equal(textEquivalent("2026-06 家用", "２０２６－０６　家用"), true);
  assert.equal(textEquivalent("ABC123", "ＡＢＣ１２３"), true); // full-width letters/digits fold
  assert.equal(textEquivalent("家 用", "家用"), false); // a real internal space still differs
  assert.equal(textEquivalent("家用", "家事"), false); // genuinely different content
});

test("verification policy fails on amount mismatch", () => {
  const summary = {
    destinationPayeeNameMasked: "張*",
    destinationAccountLast5: "67890",
    amount: 9999,
    currency: "TWD",
    pageState: "verification",
  };
  const r = evaluateVerificationPolicy(okJob, config, summary);
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "amount_match").pass, false);
});

test("verification policy fails on destination last5 mismatch", () => {
  const summary = {
    destinationPayeeNameMasked: "張*",
    destinationAccountLast5: "00000",
    amount: 3000,
    currency: "TWD",
    pageState: "verification",
  };
  const r = evaluateVerificationPolicy(okJob, config, summary);
  assert.equal(r.result, "fail");
  assert.equal(r.checks.find((c) => c.name === "destination_last5_match").pass, false);
});

test("verification policy fails when no summary is observed", () => {
  assert.equal(evaluateVerificationPolicy(okJob, config, null).result, "fail");
});

test("passesConfidence enforces the 0.9 threshold", () => {
  assert.equal(passesConfidence({ value: {}, confidence: 0.95, missingFields: [] }), true);
  assert.equal(passesConfidence({ value: {}, confidence: 0.89, missingFields: [] }), false);
  assert.equal(passesConfidence({ value: null, confidence: 1, missingFields: [] }), false);
});

test("matchesDisplayName handles patterns, last5, and masked prefixes", () => {
  assert.equal(matchesDisplayName("活期存款*12345", "活期存款 ****12345"), true);
  assert.equal(matchesDisplayName("張*67890", "張*"), true);
  assert.equal(matchesDisplayName("張*67890", "李*"), false);
});
