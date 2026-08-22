// Shared constants and JSDoc typedefs for the banking assistant.
// This module is pure (no chrome.* / DOM access at import time) so it can be
// imported directly by the Node test runner and by the extension alike.

export const CURRENCY = "TWD";

// Selector extraction confidence threshold. Anything below this must fail closed
// and require manual handling (SPEC section 11).
export const CONFIDENCE_THRESHOLD = 0.9;

// Default behavior values; all overridable from the Options page (SPEC section 10/14).
export const DEFAULTS = Object.freeze({
  verificationTimeoutMs: 30_000, // wait for verification page after submit
  completionTimeoutMs: 300_000, // wait for the user to authorize on the bank page
  memoShortMaxLen: 20,
  memoLongMaxLen: 60,
});

// Batch-level states (SPEC section 5.1).
export const BATCH_STATES = Object.freeze({
  IDLE: "IDLE",
  USER_LOGGED_IN_DETECTED: "USER_LOGGED_IN_DETECTED",
  BALANCE_CHECKED: "BALANCE_CHECKED",
  BATCH_RUNNING: "BATCH_RUNNING",
  BATCH_COMPLETED: "BATCH_COMPLETED",
  FINAL_BALANCE_DISPLAYED: "FINAL_BALANCE_DISPLAYED",
  LOGGED_OUT_OR_LOGOUT_REQUESTED: "LOGGED_OUT_OR_LOGOUT_REQUESTED",
  BATCH_STOPPED: "BATCH_STOPPED",
});

// Job-level states (SPEC section 5.2).
export const JOB_STATES = Object.freeze({
  JOB_PENDING: "JOB_PENDING",
  JOB_STARTED: "JOB_STARTED",
  SOURCE_SELECTED: "SOURCE_SELECTED",
  DESTINATION_SELECTED: "DESTINATION_SELECTED",
  AMOUNT_FILLED: "AMOUNT_FILLED",
  MEMO_SHORT_FILLED: "MEMO_SHORT_FILLED",
  MEMO_LONG_FILLED: "MEMO_LONG_FILLED",
  FORM_READY_FOR_USER_REVIEW: "FORM_READY_FOR_USER_REVIEW",
  WAITING_USER_VERIFICATION: "WAITING_USER_VERIFICATION",
  COMPLETION_DETECTED: "COMPLETION_DETECTED",
  JOB_COMPLETED: "JOB_COMPLETED",
  // Failure / interruption states.
  JOB_FAILED: "JOB_FAILED",
  JOB_SKIPPED: "JOB_SKIPPED",
  USER_CANCELLED: "USER_CANCELLED",
  AMBIGUOUS_PAGE_STATE: "AMBIGUOUS_PAGE_STATE",
  POLICY_BLOCKED: "POLICY_BLOCKED",
});

// Audit log event types (SPEC section 4.7).
export const AUDIT_EVENT_TYPES = Object.freeze({
  BATCH_STARTED: "batch_started",
  BALANCE_CHECKED: "balance_checked",
  BATCH_BLOCKED: "batch_blocked",
  JOB_STARTED: "job_started",
  JOB_SKIPPED: "job_skipped",
  FORM_FILLED: "form_filled",
  WAITING_USER_VERIFICATION: "waiting_user_verification",
  COMPLETION_DETECTED: "completion_detected",
  JOB_COMPLETED: "job_completed",
  JOB_FAILED: "job_failed",
  JOB_CANCELLED_OR_TIMEOUT: "job_cancelled_or_timeout",
  BATCH_COMPLETED: "batch_completed",
  LOGOUT_CLICKED: "logout_clicked",
});

// Page states a bank adapter must distinguish (SPEC section 6).
export const PAGE_STATES = Object.freeze({
  HOME: "home",
  TRANSFER_FORM: "transfer_form",
  VERIFICATION: "verification",
  COMPLETION: "completion",
  LOGOUT_CONFIRM: "logout_confirm",
  UNKNOWN: "unknown",
});

export const LOGIN_STATES = Object.freeze({
  LOGGED_IN: "logged_in",
  LOGGED_OUT: "logged_out",
  UNKNOWN: "unknown",
});

// Storage keys used in chrome.storage.local.
export const STORAGE_KEYS = Object.freeze({
  CONFIG: "assistantConfig",
  AUDIT_LOG: "auditLog",
  // Legacy single anonymous draft. Read once on upgrade so queued transfers
  // migrate into a named list, then superseded by LISTS.
  BATCH: "pendingBatch",
  LISTS: "transferLists",
});

// Default configuration seeded on install. Uses the SPEC example accounts/payees
// so the extension is demonstrable out of the box. The user replaces these and
// the bank domain from the Options page.
export const DEFAULT_CONFIG = Object.freeze({
  bankId: "esun",
  bankOrigin: "https://ebank.esunbank.com.tw",
  allowedHostSuffixes: ["esunbank.com.tw"],
  sourceAccounts: [
    {
      id: "low_balance_transfer_account",
      label: "低餘額轉帳專用帳戶",
      displayNamePattern: "活期存款*12345",
      accountLast5: "12345",
      currency: CURRENCY,
      minimumRemainingBalance: 1000,
    },
  ],
  destinationPayees: [
    {
      id: "family_support",
      label: "家用",
      displayNamePattern: "張*67890",
      accountLast5: "67890",
      currency: CURRENCY,
      maxAmountPerTxn: 10000,
      maxAmountPerDay: 10000,
    },
  ],
  globalLimits: {
    maxJobsPerBatch: 20,
  },
  behavior: {
    verificationTimeoutMs: DEFAULTS.verificationTimeoutMs,
    completionTimeoutMs: DEFAULTS.completionTimeoutMs,
    memoShortMaxLen: DEFAULTS.memoShortMaxLen,
    memoLongMaxLen: DEFAULTS.memoLongMaxLen,
    // Whether to require an observed source balance before running a batch.
    // E.SUN shows the available balance ("可用餘額") on the transfer form once the
    // source account is selected. The E.SUN adapter selects the source itself and
    // waits for the balance, so just be on the transfer form. May be turned off in
    // Options for flows that never surface a balance; per-transaction limits and the
    // user's authorization still apply.
    requireBalanceCheck: true,
    // How long the overlay stays visible after the batch completes or "停止批次"
    // before auto-closing. 0 disables auto-close (it stays until the page
    // navigates/reloads).
    overlayDismissMs: 3000,
    // Click logout automatically after the whole batch completes (SPEC section 2).
    // Turn off to keep the session open (e.g. to review the 交易結果 page).
    autoLogout: true,
  },
});

/**
 * @typedef {Object} SourceAccount
 * @property {string} id
 * @property {string} label
 * @property {string} displayNamePattern
 * @property {string} [accountLast5]
 * @property {"TWD"} currency
 * @property {number} minimumRemainingBalance
 */

/**
 * @typedef {Object} DestinationPayee
 * @property {string} id
 * @property {string} label
 * @property {string} displayNamePattern
 * @property {string} [accountLast5]
 * @property {"TWD"} currency
 * @property {number} maxAmountPerTxn
 * @property {number} [maxAmountPerDay]
 */

/**
 * @typedef {Object} TransferJob
 * @property {string} id
 * @property {string} sourceAccountId
 * @property {string} destinationPayeeId
 * @property {number} amount
 * @property {"TWD"} currency
 * @property {string} memoShort
 * @property {string} memoLong
 * @property {string} [expectedDate]
 */

/**
 * @typedef {Object} TransferBatch
 * @property {string} batchId
 * @property {string} createdAt
 * @property {TransferJob[]} jobs
 */

/**
 * @typedef {Object} BalanceObservation
 * @property {string} [sourceAccountId]
 * @property {string} displayName
 * @property {string} [accountLast5]
 * @property {number} balance
 * @property {"TWD"} currency
 * @property {string} observedAt
 */

/**
 * @typedef {Object} VerificationSummary
 * @property {string} [sourceAccountLast5]
 * @property {string} destinationPayeeNameMasked
 * @property {string} [destinationAccountLast5]
 * @property {number} amount
 * @property {"TWD"} currency
 * @property {string} [memoShort]
 * @property {string} [memoLong]
 * @property {"verification"} pageState
 */

/**
 * @typedef {Object} CompletionResult
 * @property {"completion"} pageState
 * @property {string} [bankReferenceMasked]
 * @property {string} completionText
 * @property {string} completedAt
 */

/**
 * @typedef {Object} ActionResult
 * @property {boolean} ok
 * @property {string} message
 * @property {boolean} [requiresUserConfirm]
 */

/**
 * @template T
 * @typedef {Object} ExtractionResult
 * @property {T | null} value
 * @property {number} confidence
 * @property {string[]} missingFields
 */

/**
 * @typedef {Object} PolicyCheck
 * @property {string} name
 * @property {boolean} pass
 * @property {string} detail
 */
