import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJobMachine,
  createBatchMachine,
  jobCan,
  JOB_EVENTS,
  JOB_TRANSITIONS,
  FORBIDDEN_JOB_TRANSITIONS,
} from "../src/content/state-machine.js";
import { JOB_STATES, BATCH_STATES } from "../src/core/types.js";

test("happy path job lifecycle reaches JOB_COMPLETED", () => {
  const m = createJobMachine();
  m.send(JOB_EVENTS.BEGIN);
  m.send(JOB_EVENTS.SOURCE_SELECTED);
  m.send(JOB_EVENTS.DESTINATION_SELECTED);
  m.send(JOB_EVENTS.AMOUNT_FILLED);
  m.send(JOB_EVENTS.MEMO_SHORT_FILLED);
  m.send(JOB_EVENTS.MEMO_LONG_FILLED);
  m.send(JOB_EVENTS.FORM_READY);
  m.send(JOB_EVENTS.VERIFICATION_PAGE_DETECTED);
  m.send(JOB_EVENTS.COMPLETION_PAGE_DETECTED);
  m.send(JOB_EVENTS.COMPLETE);
  assert.equal(m.state, JOB_STATES.JOB_COMPLETED);
  assert.ok(m.isTerminal());
});

test("the extension cannot confirm: no event advances WAITING_USER_VERIFICATION except observing completion", () => {
  const row = JOB_TRANSITIONS[JOB_STATES.WAITING_USER_VERIFICATION];
  // The only forward (non-interrupt) edge is COMPLETION_PAGE_DETECTED.
  assert.equal(row[JOB_EVENTS.COMPLETION_PAGE_DETECTED], JOB_STATES.COMPLETION_DETECTED);
  // There is no edge representing the extension pressing the final confirm.
  assert.equal(jobCan(JOB_STATES.WAITING_USER_VERIFICATION, "EXTENSION_CLICK_FINAL_CONFIRM"), false);
  assert.equal(jobCan(JOB_STATES.WAITING_USER_VERIFICATION, "CONFIRM"), false);
  assert.equal(jobCan(JOB_STATES.WAITING_USER_VERIFICATION, JOB_EVENTS.COMPLETE), false);
});

test("cannot assume completion from a ready form", () => {
  assert.equal(jobCan(JOB_STATES.FORM_READY_FOR_USER_REVIEW, JOB_EVENTS.COMPLETE), false);
  assert.equal(jobCan(JOB_STATES.FORM_READY_FOR_USER_REVIEW, JOB_EVENTS.COMPLETION_PAGE_DETECTED), false);
});

test("cannot detect completion before reaching the verification wait", () => {
  assert.equal(jobCan(JOB_STATES.JOB_STARTED, JOB_EVENTS.COMPLETION_PAGE_DETECTED), false);
});

test("all documented forbidden transitions are unreachable", () => {
  for (const { from, event } of FORBIDDEN_JOB_TRANSITIONS) {
    assert.equal(jobCan(from, event), false, `${from} --(${event})--> should be forbidden`);
  }
});

test("no job transition leads to completion except COMPLETION_PAGE_DETECTED", () => {
  for (const [state, row] of Object.entries(JOB_TRANSITIONS)) {
    for (const [event, target] of Object.entries(row)) {
      if (target === JOB_STATES.COMPLETION_DETECTED) {
        assert.equal(event, JOB_EVENTS.COMPLETION_PAGE_DETECTED, `${state} reached completion via ${event}`);
      }
    }
  }
});

test("illegal transitions throw", () => {
  const m = createJobMachine();
  assert.throws(() => m.send(JOB_EVENTS.COMPLETE));
});

test("a cancelled wait is a legal interrupt", () => {
  const m = createJobMachine();
  m.send(JOB_EVENTS.BEGIN);
  m.send(JOB_EVENTS.SOURCE_SELECTED);
  m.send(JOB_EVENTS.DESTINATION_SELECTED);
  m.send(JOB_EVENTS.AMOUNT_FILLED);
  m.send(JOB_EVENTS.MEMO_SHORT_FILLED);
  m.send(JOB_EVENTS.MEMO_LONG_FILLED);
  m.send(JOB_EVENTS.FORM_READY);
  m.send(JOB_EVENTS.VERIFICATION_PAGE_DETECTED);
  m.send(JOB_EVENTS.CANCEL);
  assert.equal(m.state, JOB_STATES.USER_CANCELLED);
});

test("batch machine happy path", () => {
  const m = createBatchMachine();
  assert.equal(m.state, BATCH_STATES.IDLE);
  m.send("USER_LOGGED_IN");
  m.send("BALANCE_CHECKED");
  m.send("START_BATCH");
  m.send("BATCH_DONE");
  m.send("FINAL_BALANCE_SHOWN");
  m.send("LOGOUT_REQUESTED");
  assert.equal(m.state, BATCH_STATES.LOGGED_OUT_OR_LOGOUT_REQUESTED);
});
