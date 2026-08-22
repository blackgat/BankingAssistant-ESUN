import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  migrateState,
  getActiveList,
  getList,
  addList,
  renameList,
  duplicateList,
  deleteList,
  setActiveList,
  addJob,
  removeJobAt,
  clearJobs,
  setJobs,
  recordRun,
  summarize,
  toBatch,
  uniqueName,
  normalizeName,
  RUN_STATUS,
  DEFAULT_LIST_NAME,
} from "../src/core/lists.js";

// Deterministic ids/time so assertions don't depend on the clock.
let seq = 0;
const ids = () => `list_${++seq}`;
const NOW = "2026-07-19T00:00:00.000Z";
const opts = { idFactory: ids, now: NOW };
const job = (amount, id = `j${amount}`) => ({
  id,
  sourceAccountId: "src",
  destinationPayeeId: "pay",
  amount,
  currency: "TWD",
  memoShort: "家用",
  memoLong: "2026-07 家用",
});

test("initial state has exactly one active empty list", () => {
  seq = 0;
  const s = createInitialState(opts);
  assert.equal(s.lists.length, 1);
  assert.equal(s.lists[0].name, DEFAULT_LIST_NAME);
  assert.deepEqual(s.lists[0].jobs, []);
  assert.equal(getActiveList(s).id, s.activeListId);
});

test("migration carries the legacy pendingBatch draft into a named list", () => {
  seq = 0;
  const legacy = { batchId: "draft", jobs: [job(3000), job(1500)] };
  const s = migrateState(null, legacy, { ...opts, legacyName: "先前的清單" });
  assert.equal(s.lists.length, 1);
  assert.equal(s.lists[0].name, "先前的清單");
  assert.equal(s.lists[0].jobs.length, 2, "queued transfers must not be lost");
  assert.equal(getActiveList(s).jobs[0].amount, 3000);
});

test("migration with no legacy draft just creates an empty list", () => {
  seq = 0;
  const s = migrateState(null, null, opts);
  assert.equal(s.lists.length, 1);
  assert.equal(s.lists[0].jobs.length, 0);
});

test("migration repairs malformed stored state instead of discarding it", () => {
  seq = 0;
  const stored = {
    activeListId: "gone",
    lists: [{ name: "  家  用  ", jobs: null }, null, { id: "keep", name: "", jobs: [job(100)] }],
  };
  const s = migrateState(stored, null, opts);
  assert.equal(s.lists.length, 2, "null entries dropped, real ones kept");
  assert.equal(s.lists[0].name, "家 用", "whitespace collapsed");
  assert.deepEqual(s.lists[0].jobs, [], "non-array jobs repaired to []");
  assert.ok(s.lists[0].id, "missing id filled in");
  assert.equal(s.lists[1].name, DEFAULT_LIST_NAME, "empty name gets the default");
  assert.equal(s.activeListId, s.lists[0].id, "stale active id falls back to the first list");
});

test("adding a list makes it active and leaves other lists untouched", () => {
  seq = 0;
  let s = createInitialState(opts);
  const firstId = s.activeListId;
  s = addJob(s, firstId, job(3000));
  s = addList(s, "房租", opts);
  assert.equal(s.lists.length, 2);
  assert.equal(getActiveList(s).name, "房租");
  assert.equal(getActiveList(s).jobs.length, 0);
  assert.equal(getList(s, firstId).jobs.length, 1, "the other list keeps its jobs");
});

test("duplicate names are disambiguated", () => {
  seq = 0;
  let s = createInitialState(opts);
  s = renameList(s, s.activeListId, "家用");
  s = addList(s, uniqueName(s, "家用"), opts);
  assert.deepEqual(s.lists.map((l) => l.name), ["家用", "家用 2"]);
});

test("jobs are edited per list and switching preserves each list", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = addJob(s, a, job(3000));
  s = addList(s, "房租", opts);
  const b = s.activeListId;
  s = addJob(s, b, job(12000));
  s = addJob(s, b, job(500));

  s = setActiveList(s, a);
  assert.equal(getActiveList(s).jobs.length, 1);
  s = setActiveList(s, b);
  assert.equal(getActiveList(s).jobs.length, 2);

  s = removeJobAt(s, b, 0);
  assert.deepEqual(getList(s, b).jobs.map((j) => j.amount), [500]);
  assert.equal(getList(s, a).jobs.length, 1, "editing one list must not touch another");

  s = clearJobs(s, b);
  assert.equal(getList(s, b).jobs.length, 0);
  assert.equal(getList(s, a).jobs.length, 1);
});

test("duplicating copies jobs but not the run history", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = addJob(s, a, job(3000));
  s = recordRun(s, a, { status: RUN_STATUS.COMPLETED, at: NOW, completed: 1, total: 1 });
  s = duplicateList(s, a, opts);
  const copy = getActiveList(s);
  assert.equal(copy.jobs.length, 1);
  assert.equal(copy.lastRun, null, "a copy has not been run");
  assert.match(copy.name, /複本/);
  copy.jobs[0].amount = 99;
  assert.equal(getList(s, a).jobs[0].amount, 3000, "the copy's jobs are not shared references");
});

test("deleting the last list empties it instead of leaving no list", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = addJob(s, a, job(3000));
  s = deleteList(s, a, opts);
  assert.equal(s.lists.length, 1, "there is always at least one list");
  assert.equal(s.lists[0].jobs.length, 0);
  assert.ok(getActiveList(s), "active list still resolves");
});

test("deleting the active list moves the selection to a surviving list", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = addList(s, "房租", opts);
  const b = s.activeListId;
  s = deleteList(s, b, opts);
  assert.equal(s.lists.length, 1);
  assert.equal(s.activeListId, a);
});

test("recordRun stores what the popup shows before a re-run", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = recordRun(s, a, { status: RUN_STATUS.DISPATCHED, at: NOW });
  assert.equal(getList(s, a).lastRun.status, "dispatched");
  s = recordRun(s, a, { status: RUN_STATUS.STOPPED, at: NOW, completed: 1, total: 3, reason: "verification_mismatch" });
  const run = getList(s, a).lastRun;
  assert.deepEqual(run, { at: NOW, status: "stopped", completed: 1, total: 3, reason: "verification_mismatch" });
});

test("summarize gives the count and total the review screen needs", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = addJob(s, a, job(3000));
  s = addJob(s, a, job(1500));
  assert.deepEqual(summarize(getActiveList(s)), { count: 2, total: 4500, currency: "TWD" });
  assert.deepEqual(summarize(null), { count: 0, total: 0, currency: "TWD" });
});

test("toBatch produces a runner batch that is decoupled from the stored list", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = addJob(s, a, job(3000));
  const batch = toBatch(getActiveList(s), { batchId: "b1", now: NOW });
  assert.equal(batch.batchId, "b1");
  assert.equal(batch.jobs.length, 1);
  batch.jobs[0].amount = 99;
  assert.equal(getList(s, a).jobs[0].amount, 3000, "mutating the batch must not touch storage");
});

test("names are trimmed, collapsed, and length-capped", () => {
  // \s matches the ideographic space too, so a full-width gap normalizes to a
  // plain one — names stay comparable however they were typed.
  assert.equal(normalizeName("  每月　家用 "), "每月 家用");
  assert.equal(normalizeName("房租\n\t 一月"), "房租 一月");
  assert.equal(normalizeName(""), DEFAULT_LIST_NAME);
  assert.equal(normalizeName("x".repeat(80)).length, 40);
});

test("setJobs replaces the whole array (used by JSON import)", () => {
  seq = 0;
  let s = createInitialState(opts);
  const a = s.activeListId;
  s = setJobs(s, a, [job(1), job(2)]);
  assert.equal(getList(s, a).jobs.length, 2);
  s = setJobs(s, a, "not an array");
  assert.deepEqual(getList(s, a).jobs, [], "malformed input is repaired, not stored");
});
