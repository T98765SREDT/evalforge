import test from "node:test";
import assert from "node:assert/strict";
import { createBatch } from "../js/queue.js";
import {
  QUEUE_STORAGE_KEY,
  STORAGE_KEY,
  commitEvaluations,
  commitQueue,
  loadEvaluationState,
  loadQueueState,
  saveEvaluations,
  saveQueue
} from "../js/storage.js";

class MemoryStorage {
  constructor(value = null) {
    this.value = value;
    this.failRead = false;
    this.failWrite = false;
  }

  setItem(key, value) {
    assert.ok([STORAGE_KEY, QUEUE_STORAGE_KEY].includes(key));
    if (this.failWrite) throw new Error("quota exceeded");
    this.values ??= {};
    this.values[key] = value;
    if (key === STORAGE_KEY) this.value = value;
  }

  removeItem(key) {
    this.value = null;
    this.values ??= {};
    delete this.values[key];
  }

  getItem(key) {
    if (this.failRead) throw new Error("read blocked");
    return this.values?.[key] ?? (key === STORAGE_KEY ? this.value : null);
  }
}

const previous = [{ id: "kept", prompt: "Existing record" }];
const candidate = [{ id: "new", prompt: "Candidate record" }];

function withoutWarnings(callback) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return callback();
  } finally {
    console.warn = warn;
  }
}

test("failed saves return an error instead of reporting success", () => {
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const result = withoutWarnings(() => saveEvaluations(candidate, storage));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /quota exceeded/);
});

test("failed commits keep the prior in-memory collection unchanged", () => {
  const storage = new MemoryStorage(JSON.stringify(previous));
  storage.failWrite = true;
  const result = withoutWarnings(() => commitEvaluations(candidate, previous, storage));
  assert.equal(result.ok, false);
  assert.deepEqual(result.evaluations, previous);
  assert.equal(storage.value, JSON.stringify(previous));
});

test("successful commits publish the complete candidate atomically", () => {
  const storage = new MemoryStorage(JSON.stringify(previous));
  const result = commitEvaluations(candidate, previous, storage);
  assert.equal(result.ok, true);
  assert.deepEqual(result.evaluations, candidate);
  assert.deepEqual(JSON.parse(storage.value), candidate);
});

test("storage loading repairs usable records and skips malformed entries", () => {
  const storage = new MemoryStorage(JSON.stringify([
    null,
    { id: "usable", prompt: "Recovered prompt" }
  ]));
  const result = loadEvaluationState([], storage);
  assert.equal(result.error, null);
  assert.equal(result.report.source, "storage");
  assert.equal(result.report.accepted, 1);
  assert.equal(result.report.repaired, 1);
  assert.equal(result.report.skipped, 1);
  assert.equal(result.evaluations[0].prompt, "Recovered prompt");
});

test("unreadable storage falls back without throwing or overwriting data", () => {
  const storage = new MemoryStorage("not-json");
  const fallback = [{ id: "sample", prompt: "Fallback prompt" }];
  const result = withoutWarnings(() => loadEvaluationState(fallback, storage));
  assert.ok(result.error);
  assert.equal(result.report.source, "fallback");
  assert.equal(result.evaluations[0].prompt, "Fallback prompt");
  assert.equal(storage.value, "not-json");
});

test("queue storage round-trips a normalized batch", () => {
  const storage = new MemoryStorage();
  const batch = createBatch({
    id: "batch-1",
    name: "Coding queue",
    cases: [{ id: "case-1", prompt: "Prompt", responseA: "A", responseB: "B" }]
  });
  assert.equal(saveQueue(batch, storage).ok, true);
  const loaded = loadQueueState(createBatch({ id: "fallback" }), storage);
  assert.equal(loaded.error, null);
  assert.equal(loaded.batch.id, "batch-1");
  assert.equal(loaded.batch.cases[0].id, "case-1");
});

test("failed queue commits preserve the prior batch", () => {
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const previousBatch = createBatch({ id: "previous" });
  const candidateBatch = createBatch({ id: "candidate" });
  const result = withoutWarnings(() => commitQueue(candidateBatch, previousBatch, storage));
  assert.equal(result.ok, false);
  assert.equal(result.batch.id, "previous");
});
