import test from "node:test";
import assert from "node:assert/strict";
import { parseDatasetImport } from "../js/domain/dataset-import.js";
import {
  DATASET_STORAGE_KEY,
  commitDatasetCollection,
  createDatasetApplyPlan,
  datasetCaseCount,
  datasetLibrarySummary,
  loadDatasetState,
  normalizeDataset,
  normalizeDatasetCollection
} from "../js/ui/datasets.js";

class MemoryStorage {
  constructor(value = null) { this.value = value; this.failWrite = false; }
  getItem(key) { assert.equal(key, DATASET_STORAGE_KEY); return this.value; }
  setItem(key, value) { assert.equal(key, DATASET_STORAGE_KEY); if (this.failWrite) throw new Error("quota exceeded"); this.value = value; }
}

const source = [
  { external_id: "case-1", prompt: "How do I reset a password?", response_1: "Use the reset link.", response_2: "Ask support to reset it." },
  { external_id: "case-2", prompt: "How do I export data?", response_1: "Choose Export.", response_2: "Download the CSV." }
];

test("dataset normalization and storage round-trip preserve library metadata", () => {
  const dataset = normalizeDataset({ id: "ds-1", name: "Support", cases: [{ externalId: "case-1" }] }, { now: "2026-01-01T00:00:00.000Z" });
  assert.equal(dataset.schemaVersion, 1);
  assert.equal(dataset.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(datasetCaseCount(dataset), 1);
  const storage = new MemoryStorage();
  assert.equal(commitDatasetCollection([dataset], [], storage).ok, true);
  const loaded = loadDatasetState([], storage);
  assert.equal(loaded.error, null);
  assert.equal(loaded.datasets[0].name, "Support");
});

test("normalization skips duplicate ids and reports repairs", () => {
  const result = normalizeDatasetCollection([{ id: "same", name: "A" }, { id: "same", name: "B" }, null]);
  assert.equal(result.datasets.length, 1);
  assert.equal(result.report.skipped, 2);
  assert.equal(result.report.repaired, 1);
});

test("apply plan rejects existing ids and exact content without mutating input", () => {
  const plan = parseDatasetImport(JSON.stringify(source), { format: "json" });
  const existing = [{ id: "old", name: "Existing", cases: [plan.acceptedRows[0].record] }];
  const before = structuredClone(existing);
  const result = createDatasetApplyPlan(existing, plan, { name: "New", now: "2026-01-02T00:00:00.000Z", idFactory: () => "new-id" });
  assert.equal(result.accepted, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.dataset.id, "new-id");
  assert.deepEqual(existing, before);
  assert.equal(result.dataset.cases.length, 1);
});

test("library summary counts cases and demo datasets", () => {
  const result = datasetLibrarySummary([
    { isDemo: true, cases: [{}, {}] },
    { isDemo: false, cases: [{}] }
  ]);
  assert.deepEqual(result, { datasets: 2, cases: 3, demo: 1 });
});

test("failed dataset commit keeps previous storage value", () => {
  const storage = new MemoryStorage(JSON.stringify([{ id: "old" }]));
  storage.failWrite = true;
  const result = commitDatasetCollection([{ id: "new" }], [{ id: "old" }], storage);
  assert.equal(result.ok, false);
  assert.deepEqual(result.datasets, [{ id: "old" }]);
  assert.equal(storage.value, JSON.stringify([{ id: "old" }]));
});
