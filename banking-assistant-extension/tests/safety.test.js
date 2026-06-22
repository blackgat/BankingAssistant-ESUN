import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ACTIONS,
  FORBIDDEN_ACTIONS,
  assertActionAllowed,
} from "../src/content/actions/transfer-form-actions.js";
import { EsunAdapter } from "../src/content/extractors/bank-adapter.esun.js";

test("forbidden actions are rejected", () => {
  for (const name of FORBIDDEN_ACTIONS) {
    assert.throws(() => assertActionAllowed(name), /forbidden action/, name);
  }
});

test("unknown actions are rejected (fail closed)", () => {
  assert.throws(() => assertActionAllowed("doSomethingElse"), /unknown action/);
});

test("allowed actions pass", () => {
  for (const name of ALLOWED_ACTIONS) assert.equal(assertActionAllowed(name), true);
});

// Matches names that press a final confirm, submit a final transfer, or touch an
// OTP. Deliberately precise so safe reads like "readFinalBalance" don't trip it.
const DANGEROUS_NAME =
  /(final[_-]?confirm|confirm[_-]?(transfer|final|payment|txn)|submit[_-]?final|click[_-]?confirm|fill[_-]?otp|enter[_-]?otp|approve[_-]?push|bypass)/i;

test("the allow list contains no final-confirm / OTP action", () => {
  for (const name of ALLOWED_ACTIONS) {
    assert.ok(!DANGEROUS_NAME.test(name), `allowed action looks dangerous: ${name}`);
  }
});

test("submit action only advances to the verification page", () => {
  assert.ok(ALLOWED_ACTIONS.includes("submitFormToVerificationPage"));
  assert.ok(!ALLOWED_ACTIONS.includes("submitFinalTransfer"));
});

test("the adapter exposes no method that could press final confirm or enter an OTP", () => {
  const adapter = new EsunAdapter({ root: null, config: {} });
  const methods = new Set();
  let proto = Object.getPrototypeOf(adapter);
  while (proto && proto !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(proto)) methods.add(n);
    proto = Object.getPrototypeOf(proto);
  }
  for (const m of methods) {
    assert.ok(!DANGEROUS_NAME.test(m), `adapter has a dangerous-looking method: ${m}`);
  }
  // And the explicitly forbidden names are simply not present.
  for (const f of FORBIDDEN_ACTIONS) {
    assert.equal(typeof adapter[f], "undefined", `adapter must not implement ${f}`);
  }
});
