import test from "node:test";
import assert from "node:assert/strict";
import {
  QUEUE_SCHEMA_VERSION,
  claimNextCase,
  completeCase,
  createBatch,
  enqueueCase,
  normalizeBatch,
  nextPendingCase,
  queueProgress,
  skipCase,
  startCase
} from "../js/queue.js";

function caseInput(overrides = {}) {
  return {
    id: "case-1",
    title: "Retry handling",
    prompt: "Review this retry implementation.",
    responseA: "Response A",
    responseB: "Response B",
    rubricId: "coding",
    ...overrides
  };
}

test("createBatch normalizes review cases and keeps the selected rubric", () => {
  const batch = createBatch({ id: "batch-1", name: "Coding set", rubricId: "coding", cases: [caseInput()] }, { now: "2026-08-28T10:00:00.000Z" });
  assert.equal(batch.queueVersion, QUEUE_SCHEMA_VERSION);
  assert.equal(batch.rubricId, "coding");
  assert.equal(batch.cases[0].status, "pending");
  assert.equal(batch.cases[0].title, "Retry handling");
});

test("invalid or incomplete queue cases are skipped during normalization", () => {
  const result = normalizeBatch({ name: "Mixed", cases: [caseInput(), { prompt: "missing responses" }] }, { now: "2026-08-28T10:00:00.000Z" });
  assert.equal(result.batch.cases.length, 1);
  assert.equal(result.report.skipped, 1);
});

test("enqueueCase prevents duplicate active cases", () => {
  const batch = createBatch({ cases: [caseInput()] });
  const result = enqueueCase(batch, caseInput({ id: "case-2", title: "Same content" }));
  assert.equal(result.duplicate, true);
  assert.equal(result.batch.cases.length, 1);
  assert.equal(result.queuedCase.id, "case-1");
});

test("claimNextCase moves the first pending case to in progress", () => {
  const batch = createBatch({ cases: [caseInput(), caseInput({ id: "case-2", prompt: "Second prompt" })] });
  const result = claimNextCase(batch, "2026-08-28T10:05:00.000Z");
  assert.equal(result.queuedCase.id, "case-1");
  assert.equal(result.batch.cases[0].status, "in_progress");
  assert.equal(nextPendingCase(result.batch).id, "case-2");
});

test("starting a specific case does not reopen completed work", () => {
  const batch = createBatch({ cases: [caseInput({ status: "completed" })] });
  const result = startCase(batch, "case-1");
  assert.equal(result.queuedCase, null);
  assert.equal(result.batch.cases[0].status, "completed");
});

test("completeCase links a saved evaluation and clears skip metadata", () => {
  const batch = createBatch({ cases: [caseInput({ status: "skipped", skipReason: "Later" })] });
  const result = completeCase(batch, "case-1", "evaluation-1", "2026-08-28T10:10:00.000Z");
  assert.equal(result.updated, true);
  assert.equal(result.batch.cases[0].status, "completed");
  assert.equal(result.batch.cases[0].evaluationId, "evaluation-1");
  assert.equal(result.batch.cases[0].skipReason, "");
});

test("skipCase records a human-readable reason", () => {
  const batch = createBatch({ cases: [caseInput()] });
  const result = skipCase(batch, "case-1", "Needs a different prompt", "2026-08-28T10:10:00.000Z");
  assert.equal(result.batch.cases[0].status, "skipped");
  assert.equal(result.batch.cases[0].skipReason, "Needs a different prompt");
});

test("queueProgress reports pending, active, and finished work", () => {
  const batch = createBatch({ cases: [
    caseInput({ id: "pending" }),
    caseInput({ id: "active", status: "in_progress" }),
    caseInput({ id: "done", status: "completed" }),
    caseInput({ id: "skipped", status: "skipped" })
  ] });
  assert.deepEqual(queueProgress(batch), { total: 4, pending: 1, inProgress: 1, completed: 1, skipped: 1, finished: 2, percent: 50 });
});
