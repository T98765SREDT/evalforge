import test from "node:test";
import assert from "node:assert/strict";

import { createSyntheticDocument, createSyntheticJsonl, runBenchmark } from "../scripts/benchmark.mjs";

test("synthetic benchmark document is deterministic and valid", () => {
  const first = createSyntheticDocument(4);
  const second = createSyntheticDocument(4);

  assert.deepEqual(first, second);
  assert.equal(first.cases.length, 4);
  assert.equal(first.assignments.length, 4);
  assert.equal(first.reviews.length, 4);
  assert.equal(first.reviews[0].state, "complete");
  assert.equal(first.sessions[0].blindMode, true);
  assert.equal(first.sessions[0].revealedAt, "2026-01-01T00:00:06.000Z");
});

test("synthetic JSONL has the expected import shape", () => {
  const lines = createSyntheticJsonl(3).split("\n");
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(first).sort(), ["external_id", "model_1", "model_2", "prompt", "response_1", "response_2", "tags"]);
  assert.equal(first.external_id, "benchmark-0000");
});

test("benchmark reports all required operations and environment metadata", () => {
  const report = runBenchmark({ size: 4, repetitions: 2 });

  assert.equal(report.input.cases, 4);
  assert.equal(report.input.completedReviews, 4);
  assert.equal(report.input.repetitions, 2);
  assert.match(report.environment.adapter, /MemoryRepository/);
  assert.deepEqual(report.operations.map(({ name }) => name), [
    "importPlanning",
    "memoryTransactionApply",
    "sessionCreation",
    "analytics",
    "auditExport"
  ]);
  report.operations.forEach((operation) => {
    assert.equal(operation.repetitions, 2);
    assert.ok(operation.medianMs >= 0);
    assert.ok(operation.p95Ms >= operation.medianMs);
  });
});
