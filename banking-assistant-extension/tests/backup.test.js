import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BACKUP_KEYS,
  buildBackup,
  validateBackup,
  describeBackup,
  backupFilename,
} from "../src/core/backup.js";

const NOW = "2026-09-12T00:00:00.000Z";

const sampleStorage = () => ({
  assistantConfig: {
    bankId: "esun",
    sourceAccounts: [{ id: "allowance_account", label: "零用金", accountLast5: "12345" }],
    destinationPayees: [{ id: "p1", label: "房東", accountLast5: "67890" }],
  },
  transferLists: {
    version: 1,
    activeListId: "l1",
    lists: [{ id: "l1", name: "每月固定轉帳", jobs: [{ id: "j1", amount: 1000 }], createdAt: 1 }],
  },
  auditLog: [{ eventId: "e1", eventType: "batch_started" }],
  // Present in storage but deliberately not carried by a backup.
  pendingBatch: { jobs: [{ id: "old" }] },
});

test("buildBackup wraps the owned keys in a self-describing envelope", () => {
  const b = buildBackup(sampleStorage(), NOW);
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.version, BACKUP_VERSION);
  assert.equal(b.exportedAt, NOW);
  assert.deepEqual(Object.keys(b.data).sort(), [...BACKUP_KEYS].sort());
});

test("buildBackup leaves the superseded legacy draft out", () => {
  const b = buildBackup(sampleStorage(), NOW);
  assert.equal(b.data.pendingBatch, undefined);
});

test("buildBackup omits keys that are absent rather than writing undefined", () => {
  const b = buildBackup({ assistantConfig: { bankId: "esun" } }, NOW);
  assert.deepEqual(Object.keys(b.data), ["assistantConfig"]);
});

test("a built backup validates and round-trips through JSON", () => {
  const b = buildBackup(sampleStorage(), NOW);
  const { data, keys } = validateBackup(JSON.parse(JSON.stringify(b)));
  assert.equal(keys.length, 3);
  assert.equal(data.transferLists.lists[0].name, "每月固定轉帳");
});

test("a bare storage object restores too, so older exports still work", () => {
  const { keys } = validateBackup({ assistantConfig: { bankId: "esun" } });
  assert.deepEqual(keys, ["assistantConfig"]);
});

test("validateBackup rejects non-objects", () => {
  assert.throws(() => validateBackup(null), /不是物件/);
  assert.throws(() => validateBackup([1, 2]), /不是物件/);
  assert.throws(() => validateBackup("nope"), /不是物件/);
});

test("validateBackup rejects a file with nothing it can restore", () => {
  assert.throws(() => validateBackup({ unrelated: 1 }), /沒有可還原的項目/);
});

test("validateBackup refuses credential-like keys anywhere in the tree", () => {
  const withSecret = {
    assistantConfig: { bankId: "esun", nested: { deeper: { password: "hunter2" } } },
  };
  assert.throws(() => validateBackup(withSecret), /不允許的欄位/);
});

test("validateBackup names the path to the offending key", () => {
  const withSecret = { assistantConfig: { creds: { otp: "1" } } };
  assert.throws(() => validateBackup(withSecret), /assistantConfig\.creds\.otp/);
});

test("validateBackup checks the shape of each section", () => {
  assert.throws(() => validateBackup({ assistantConfig: [] }), /沒有可還原的項目|設定必須是物件/);
  assert.throws(() => validateBackup({ transferLists: { lists: "no" } }), /lists 陣列/);
  assert.throws(
    () => validateBackup({ transferLists: { lists: [{ id: "a" }] } }),
    /jobs 陣列/,
  );
  assert.throws(() => validateBackup({ auditLog: {} }), /稽核紀錄必須是陣列/);
});

test("validation happens before anything is written", () => {
  // validateBackup is pure: a rejected backup cannot have mutated its input.
  const input = { transferLists: { lists: [{ id: "a" }] } };
  const before = JSON.stringify(input);
  assert.throws(() => validateBackup(input));
  assert.equal(JSON.stringify(input), before);
});

test("describeBackup reports what a restore would bring back", () => {
  const { data } = validateBackup(buildBackup(sampleStorage(), NOW));
  const text = describeBackup(data);
  assert.match(text, /來源帳戶 1 個/);
  assert.match(text, /收款人 1 個/);
  assert.match(text, /清單 1 份、共 1 筆轉帳/);
  assert.match(text, /稽核紀錄 1 筆/);
});

test("describeBackup handles a partial backup", () => {
  const { data } = validateBackup({ auditLog: [] });
  assert.equal(describeBackup(data), "稽核紀錄 0 筆");
});

test("backupFilename is dated and stable", () => {
  assert.equal(backupFilename(NOW), "banking-assistant-backup-2026-09-12.json");
});

test("a restore writes only the keys it owns, never extras from the file", () => {
  const { data, keys } = validateBackup({
    assistantConfig: { bankId: "esun" },
    pendingBatch: { jobs: [{ id: "legacy" }] },
    somethingElse: { whatever: true },
  });
  assert.deepEqual(keys, ["assistantConfig"]);
  assert.deepEqual(Object.keys(data), ["assistantConfig"]);
  assert.equal(data.pendingBatch, undefined);
  assert.equal(data.somethingElse, undefined);
});

test("the bare and enveloped forms of the same storage restore identically", () => {
  const storage = sampleStorage();
  assert.deepEqual(validateBackup(storage).data, validateBackup(buildBackup(storage, NOW)).data);
});
