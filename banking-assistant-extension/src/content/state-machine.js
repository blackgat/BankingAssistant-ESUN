// Batch- and job-level state machines (SPEC section 5).
//
// The transition tables are explicit and exhaustive. The single most important
// safety property is encoded structurally: there is NO event anywhere that lets
// the extension advance a job by pressing the bank's final confirm button. A
// job can only reach COMPLETION_DETECTED via the COMPLETION_PAGE_DETECTED event,
// which the runner emits exclusively after observing the bank's completion page.

import { BATCH_STATES, JOB_STATES } from "../core/types.js";

// --- Events -----------------------------------------------------------------

export const BATCH_EVENTS = Object.freeze({
  USER_LOGGED_IN: "USER_LOGGED_IN",
  BALANCE_CHECKED: "BALANCE_CHECKED",
  START_BATCH: "START_BATCH",
  BATCH_DONE: "BATCH_DONE",
  FINAL_BALANCE_SHOWN: "FINAL_BALANCE_SHOWN",
  LOGOUT_REQUESTED: "LOGOUT_REQUESTED",
  STOP: "STOP",
});

export const JOB_EVENTS = Object.freeze({
  BEGIN: "BEGIN",
  SOURCE_SELECTED: "SOURCE_SELECTED",
  DESTINATION_SELECTED: "DESTINATION_SELECTED",
  AMOUNT_FILLED: "AMOUNT_FILLED",
  MEMO_SHORT_FILLED: "MEMO_SHORT_FILLED",
  MEMO_LONG_FILLED: "MEMO_LONG_FILLED",
  FORM_READY: "FORM_READY",
  // Emitted only after the bank verification page is observed.
  VERIFICATION_PAGE_DETECTED: "VERIFICATION_PAGE_DETECTED",
  // Emitted only after the bank completion page is observed. This is the ONLY
  // path to COMPLETION_DETECTED.
  COMPLETION_PAGE_DETECTED: "COMPLETION_PAGE_DETECTED",
  COMPLETE: "COMPLETE",
  // Interruptions.
  SKIP: "SKIP",
  BLOCK: "BLOCK",
  FAIL: "FAIL",
  CANCEL: "CANCEL",
  AMBIGUOUS: "AMBIGUOUS",
});

// --- Transition tables ------------------------------------------------------

const B = BATCH_STATES;
const BE = BATCH_EVENTS;

export const BATCH_TRANSITIONS = Object.freeze({
  [B.IDLE]: {
    [BE.USER_LOGGED_IN]: B.USER_LOGGED_IN_DETECTED,
    [BE.STOP]: B.BATCH_STOPPED,
  },
  [B.USER_LOGGED_IN_DETECTED]: {
    [BE.BALANCE_CHECKED]: B.BALANCE_CHECKED,
    [BE.STOP]: B.BATCH_STOPPED,
  },
  [B.BALANCE_CHECKED]: {
    [BE.START_BATCH]: B.BATCH_RUNNING,
    [BE.STOP]: B.BATCH_STOPPED,
  },
  [B.BATCH_RUNNING]: {
    [BE.BATCH_DONE]: B.BATCH_COMPLETED,
    [BE.STOP]: B.BATCH_STOPPED,
  },
  [B.BATCH_COMPLETED]: {
    [BE.FINAL_BALANCE_SHOWN]: B.FINAL_BALANCE_DISPLAYED,
    [BE.STOP]: B.BATCH_STOPPED,
  },
  [B.FINAL_BALANCE_DISPLAYED]: {
    [BE.LOGOUT_REQUESTED]: B.LOGGED_OUT_OR_LOGOUT_REQUESTED,
    [BE.STOP]: B.BATCH_STOPPED,
  },
  [B.LOGGED_OUT_OR_LOGOUT_REQUESTED]: {},
  [B.BATCH_STOPPED]: {},
});

const J = JOB_STATES;
const JE = JOB_EVENTS;

// Terminal interruption transitions available from any "active" job state.
const INTERRUPTS = {
  [JE.FAIL]: J.JOB_FAILED,
  [JE.CANCEL]: J.USER_CANCELLED,
  [JE.AMBIGUOUS]: J.AMBIGUOUS_PAGE_STATE,
};

export const JOB_TRANSITIONS = Object.freeze({
  [J.JOB_PENDING]: {
    [JE.BEGIN]: J.JOB_STARTED,
    [JE.SKIP]: J.JOB_SKIPPED,
    [JE.BLOCK]: J.POLICY_BLOCKED,
  },
  [J.JOB_STARTED]: { [JE.SOURCE_SELECTED]: J.SOURCE_SELECTED, ...INTERRUPTS },
  [J.SOURCE_SELECTED]: { [JE.DESTINATION_SELECTED]: J.DESTINATION_SELECTED, ...INTERRUPTS },
  [J.DESTINATION_SELECTED]: { [JE.AMOUNT_FILLED]: J.AMOUNT_FILLED, ...INTERRUPTS },
  [J.AMOUNT_FILLED]: { [JE.MEMO_SHORT_FILLED]: J.MEMO_SHORT_FILLED, ...INTERRUPTS },
  [J.MEMO_SHORT_FILLED]: { [JE.MEMO_LONG_FILLED]: J.MEMO_LONG_FILLED, ...INTERRUPTS },
  [J.MEMO_LONG_FILLED]: { [JE.FORM_READY]: J.FORM_READY_FOR_USER_REVIEW, ...INTERRUPTS },
  // After the form is ready, the ONLY forward edge is observing the bank's
  // verification page. There is no edge representing the extension confirming.
  [J.FORM_READY_FOR_USER_REVIEW]: {
    [JE.VERIFICATION_PAGE_DETECTED]: J.WAITING_USER_VERIFICATION,
    ...INTERRUPTS,
  },
  // While waiting, the ONLY forward edge is observing the completion page.
  [J.WAITING_USER_VERIFICATION]: {
    [JE.COMPLETION_PAGE_DETECTED]: J.COMPLETION_DETECTED,
    ...INTERRUPTS,
  },
  [J.COMPLETION_DETECTED]: { [JE.COMPLETE]: J.JOB_COMPLETED },
  // Terminal states.
  [J.JOB_COMPLETED]: {},
  [J.JOB_FAILED]: {},
  [J.JOB_SKIPPED]: {},
  [J.USER_CANCELLED]: {},
  [J.AMBIGUOUS_PAGE_STATE]: {},
  [J.POLICY_BLOCKED]: {},
});

// Explicitly documented forbidden transitions (SPEC section 5.3). These are
// asserted in tests to remain unreachable.
export const FORBIDDEN_JOB_TRANSITIONS = Object.freeze([
  // The extension pressing final confirm has no representation at all.
  { from: J.WAITING_USER_VERIFICATION, event: "EXTENSION_CLICK_FINAL_CONFIRM" },
  // Cannot assume completion straight from a ready form.
  { from: J.FORM_READY_FOR_USER_REVIEW, event: JE.COMPLETE },
  // Cannot detect completion without first reaching the verification wait.
  { from: J.JOB_STARTED, event: JE.COMPLETION_PAGE_DETECTED },
]);

// --- Generic machine --------------------------------------------------------

export class StateMachine {
  /**
   * @param {string} initial
   * @param {Record<string, Record<string, string>>} table
   * @param {(from:string, event:string, to:string) => void} [onTransition]
   */
  constructor(initial, table, onTransition) {
    this.state = initial;
    this.table = table;
    this.onTransition = onTransition;
    this.history = [initial];
  }

  /** @returns {boolean} whether `event` is valid from the current state. */
  can(event) {
    const row = this.table[this.state] || {};
    return Object.prototype.hasOwnProperty.call(row, event);
  }

  /** Apply an event, returning the new state. Throws on an illegal transition. */
  send(event) {
    const row = this.table[this.state] || {};
    if (!Object.prototype.hasOwnProperty.call(row, event)) {
      throw new Error(`illegal transition: ${this.state} --(${event})-->`);
    }
    const from = this.state;
    const to = row[event];
    this.state = to;
    this.history.push(to);
    if (this.onTransition) this.onTransition(from, event, to);
    return to;
  }

  isTerminal() {
    const row = this.table[this.state] || {};
    return Object.keys(row).length === 0;
  }
}

export function createBatchMachine(onTransition) {
  return new StateMachine(BATCH_STATES.IDLE, BATCH_TRANSITIONS, onTransition);
}

export function createJobMachine(onTransition) {
  return new StateMachine(JOB_STATES.JOB_PENDING, JOB_TRANSITIONS, onTransition);
}

/**
 * Returns true if a given (state, event) pair is allowed by the job table.
 * Used by tests to assert forbidden transitions remain unreachable.
 */
export function jobCan(state, event) {
  const row = JOB_TRANSITIONS[state] || {};
  return Object.prototype.hasOwnProperty.call(row, event);
}
