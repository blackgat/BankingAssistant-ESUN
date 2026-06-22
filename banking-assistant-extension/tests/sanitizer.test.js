import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeAccount,
  last5,
  maskName,
  maskReference,
  redactText,
  isForbiddenKey,
  sanitizeDeep,
  sanitizeLogEntry,
} from "../src/core/sanitizer.js";

test("sanitizeAccount keeps only the last 5 digits", () => {
  assert.equal(sanitizeAccount("1234567890123"), "****90123");
  assert.equal(sanitizeAccount("0098-7654-3210"), "****43210");
  assert.equal(sanitizeAccount("12345"), "12345"); // <= 5 digits unchanged
  assert.equal(sanitizeAccount(""), "");
});

test("last5 returns trailing digits only", () => {
  assert.equal(last5("活期存款 ****67890"), "67890");
  assert.equal(last5("abc123"), "123");
});

test("maskName keeps first character only", () => {
  assert.equal(maskName("張三"), "張*");
  assert.equal(maskName("王嘉欽"), "王**");
  assert.equal(maskName("A"), "A");
  assert.equal(maskName(""), "");
});

test("maskReference masks the middle", () => {
  assert.equal(maskReference("ESN20260621ABC789"), "ESN****789");
  assert.equal(maskReference("ABC123456789"), "ABC****789");
});

test("redactText strips national IDs and long digit runs", () => {
  assert.equal(redactText("帳號 1234567890 已轉出"), "帳號 ****67890 已轉出");
  assert.equal(redactText("身分證 A123456789"), "身分證 [ID]");
});

test("isForbiddenKey flags credential-like keys", () => {
  for (const k of ["password", "OTP", "otpCode", "sessionToken", "csrfToken", "rawDom", "innerHTML"]) {
    assert.equal(isForbiddenKey(k), true, k);
  }
  assert.equal(isForbiddenKey("amount"), false);
  assert.equal(isForbiddenKey("memoShort"), false);
});

test("sanitizeDeep drops forbidden keys and masks account fields", () => {
  const out = sanitizeDeep({
    amount: 3000,
    password: "secret",
    otp: "123456",
    sourceAccountNumber: "0098765432101",
    nested: { token: "t", memo: "家用 9876543210" },
  });
  assert.equal(out.amount, 3000);
  assert.ok(!("password" in out));
  assert.ok(!("otp" in out));
  assert.equal(out.sourceAccountNumber, "****32101");
  assert.ok(!("token" in out.nested));
  assert.equal(out.nested.memo, "家用 ****43210");
});

test("sanitizeLogEntry redacts the message and never keeps raw DOM", () => {
  const entry = sanitizeLogEntry({
    eventType: "job_started",
    message: "ref ESN 99887766 done",
    rawDom: "<div>secret</div>",
    innerHTML: "<b>x</b>",
  });
  assert.ok(!("rawDom" in entry));
  assert.ok(!("innerHTML" in entry));
  assert.match(entry.message, /\*\*\*\*87766/);
});
