// Named transfer lists (SPEC section 4.5 extended).
//
// The user keeps several named batches — "每月家用", "房租" — and picks which one
// to run, instead of a single anonymous draft that silently carries over. Every
// function here is pure: it takes the stored state and returns a new state, so
// the popup and the content script share one tested implementation and the
// storage layer stays a thin read/write shell.
//
// State shape (stored under STORAGE_KEYS.LISTS):
//   { version, activeListId, lists: [ { id, name, jobs, createdAt, lastRun } ] }
// lastRun is null, or { at, status, completed, total, reason? }.

import { CURRENCY } from "./types.js";

export const LISTS_VERSION = 1;
export const DEFAULT_LIST_NAME = "預設清單";
export const MAX_NAME_LENGTH = 40;

/** Run outcomes recorded on a list after it is dispatched. */
export const RUN_STATUS = Object.freeze({
  DISPATCHED: "dispatched", // handed to the page; outcome not known yet
  COMPLETED: "completed", // the whole batch finished
  STOPPED: "stopped", // stopped early (policy, cancel, timeout, error)
});

function defaultIdFactory() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `list_${crypto.randomUUID()}`;
  return `list_${Math.abs(Date.now() ^ (LISTS_VERSION * 2654435761))}`;
}

/** Trim a user-supplied list name to something storable; never returns "". */
export function normalizeName(name, fallback = DEFAULT_LIST_NAME) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return n || fallback;
}

function emptyList(id, name, now) {
  return { id, name: normalizeName(name), jobs: [], createdAt: now, lastRun: null };
}

/**
 * Build a fresh state containing one empty list.
 * @param {{now?: string, idFactory?: () => string}} [opts]
 */
export function createInitialState(opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const id = (opts.idFactory ?? defaultIdFactory)();
  return { version: LISTS_VERSION, activeListId: id, lists: [emptyList(id, DEFAULT_LIST_NAME, now)] };
}

/**
 * Normalize whatever is in storage into valid state, carrying over the legacy
 * single `pendingBatch` draft the first time so no queued transfers are lost.
 * @param {object|null} stored state previously written by this module
 * @param {object|null} legacyBatch the old { jobs } draft, if any
 * @param {{now?: string, idFactory?: () => string, legacyName?: string}} [opts]
 */
export function migrateState(stored, legacyBatch, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const idFactory = opts.idFactory ?? defaultIdFactory;

  if (stored && Array.isArray(stored.lists) && stored.lists.length > 0) {
    // Repair anything malformed rather than throwing it away.
    const lists = stored.lists
      .filter((l) => l && typeof l === "object")
      .map((l) => ({
        id: l.id || idFactory(),
        name: normalizeName(l.name),
        jobs: Array.isArray(l.jobs) ? l.jobs : [],
        createdAt: l.createdAt || now,
        lastRun: l.lastRun || null,
      }));
    const activeListId = lists.some((l) => l.id === stored.activeListId)
      ? stored.activeListId
      : lists[0].id;
    return { version: LISTS_VERSION, activeListId, lists };
  }

  const legacyJobs = Array.isArray(legacyBatch?.jobs) ? legacyBatch.jobs : [];
  if (legacyJobs.length > 0) {
    const id = idFactory();
    return {
      version: LISTS_VERSION,
      activeListId: id,
      lists: [{ ...emptyList(id, opts.legacyName ?? "先前的清單", now), jobs: legacyJobs }],
    };
  }
  return createInitialState({ now, idFactory });
}

/** The active list, or the first one if the active id is stale. */
export function getActiveList(state) {
  if (!state || !Array.isArray(state.lists) || state.lists.length === 0) return null;
  return state.lists.find((l) => l.id === state.activeListId) || state.lists[0];
}

export function getList(state, id) {
  return state.lists.find((l) => l.id === id) || null;
}

function replaceList(state, id, updater) {
  return {
    ...state,
    lists: state.lists.map((l) => (l.id === id ? updater(l) : l)),
  };
}

/** Add a new empty list and make it active. */
export function addList(state, name, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const id = (opts.idFactory ?? defaultIdFactory)();
  const list = emptyList(id, name || uniqueName(state, DEFAULT_LIST_NAME), now);
  return { ...state, activeListId: id, lists: [...state.lists, list] };
}

/** "家用" -> "家用 2" when the name is taken, so lists stay distinguishable. */
export function uniqueName(state, name) {
  const base = normalizeName(name);
  const taken = new Set(state.lists.map((l) => l.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 999; n++) {
    const candidate = normalizeName(`${base} ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

export function renameList(state, id, name) {
  return replaceList(state, id, (l) => ({ ...l, name: normalizeName(name, l.name) }));
}

/** Copy a list (jobs included) as a new list, without its run history. */
export function duplicateList(state, id, opts = {}) {
  const src = getList(state, id);
  if (!src) return state;
  const now = opts.now ?? new Date().toISOString();
  const newId = (opts.idFactory ?? defaultIdFactory)();
  const copy = {
    id: newId,
    name: uniqueName(state, `${src.name} 複本`),
    jobs: src.jobs.map((j) => ({ ...j })),
    createdAt: now,
    lastRun: null,
  };
  return { ...state, activeListId: newId, lists: [...state.lists, copy] };
}

/** Delete a list. The last remaining list is emptied instead of removed. */
export function deleteList(state, id, opts = {}) {
  if (state.lists.length <= 1) {
    const now = opts.now ?? new Date().toISOString();
    const only = state.lists[0];
    return {
      ...state,
      activeListId: only.id,
      lists: [{ ...only, jobs: [], lastRun: null, name: DEFAULT_LIST_NAME, createdAt: now }],
    };
  }
  const lists = state.lists.filter((l) => l.id !== id);
  const activeListId = lists.some((l) => l.id === state.activeListId) ? state.activeListId : lists[0].id;
  return { ...state, activeListId, lists };
}

export function setActiveList(state, id) {
  return getList(state, id) ? { ...state, activeListId: id } : state;
}

/** Replace a list's jobs (the popup edits the whole array). */
export function setJobs(state, id, jobs) {
  return replaceList(state, id, (l) => ({ ...l, jobs: Array.isArray(jobs) ? jobs : [] }));
}

export function addJob(state, id, job) {
  return replaceList(state, id, (l) => ({ ...l, jobs: [...l.jobs, job] }));
}

export function removeJobAt(state, id, index) {
  return replaceList(state, id, (l) => ({ ...l, jobs: l.jobs.filter((_, i) => i !== index) }));
}

export function clearJobs(state, id) {
  return replaceList(state, id, (l) => ({ ...l, jobs: [] }));
}

/**
 * Record a run against a list so the user can see whether it was just sent.
 * @param {object} state
 * @param {string} id
 * @param {{status: string, at?: string, completed?: number, total?: number, reason?: string}} run
 */
export function recordRun(state, id, run) {
  const at = run.at ?? new Date().toISOString();
  const entry = { at, status: run.status };
  if (typeof run.completed === "number") entry.completed = run.completed;
  if (typeof run.total === "number") entry.total = run.total;
  if (run.reason) entry.reason = run.reason;
  return replaceList(state, id, (l) => ({ ...l, lastRun: entry }));
}

/** Count and total amount of a list — what the pre-dispatch review shows. */
export function summarize(list) {
  const jobs = list?.jobs ?? [];
  const total = jobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);
  return { count: jobs.length, total, currency: CURRENCY };
}

/** Turn a list into a TransferBatch for the runner. */
export function toBatch(list, opts = {}) {
  return {
    batchId: opts.batchId ?? `batch_${(opts.idFactory ?? defaultIdFactory)()}`,
    createdAt: opts.now ?? new Date().toISOString(),
    jobs: (list?.jobs ?? []).map((j) => ({ ...j })),
  };
}
