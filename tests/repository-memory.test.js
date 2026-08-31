import test from "node:test";
import assert from "node:assert/strict";
import { createAssignment, createCase } from "../js/domain/entities.js";
import { MemoryRepository } from "../js/persistence/memory-repository.js";
import { RepositoryError } from "../js/persistence/repository.js";

function baseState() {
  const reviewCase = createCase({ id: "case-memory", datasetId: "dataset-memory", externalId: "row-1", input: "Compare two answers.", candidates: [{ id: "candidate-memory-1", content: "First answer" }, { id: "candidate-memory-2", content: "Second answer" }] });
  const assignment = createAssignment({ id: "assignment-memory", sessionId: "session-memory", caseId: reviewCase.id, displayOrder: reviewCase.candidates.map(({ id }) => id) });
  return { cases: { [reviewCase.id]: reviewCase }, assignments: { [assignment.id]: assignment } };
}

const now = () => "2026-08-29T13:00:00.000Z";

test("memory repository implements entity reads, writes, lists, and checkpoints", () => {
  const repository = new MemoryRepository(baseState());
  assert.equal(repository.get("cases", "case-memory").externalId, "row-1");
  assert.equal(repository.list("assignments").length, 1);
  repository.put("checkpoints", { id: "migration", value: { state: "completed" } });
  assert.deepEqual(repository.get("checkpoints", "migration"), { id: "migration", value: { state: "completed" } });
  assert.throws(() => repository.get("not-a-store", "x"), RepositoryError);
});

test("a transaction rolls back every write after an injected failure", () => {
  for (const failureAtWrite of [1, 2, 3]) {
    const repository = new MemoryRepository(baseState(), { failureAtWrite });
    const before = repository.snapshot();
    assert.throws(() => repository.transaction((transaction) => {
      transaction.put("assignments", { ...transaction.get("assignments", "assignment-memory"), state: "in_progress" });
      transaction.put("reviews", { id: "review-memory", revision: 1 });
      transaction.checkpoint("last-write", { ok: true });
    }), /Injected failure/);
    assert.deepEqual(repository.snapshot(), before);
  }
});

test("async transaction callbacks are rejected without changing state", () => {
  const repository = new MemoryRepository(baseState());
  const before = repository.snapshot();
  assert.throws(() => repository.transaction(async (transaction) => {
    transaction.put("assignments", { ...transaction.get("assignments", "assignment-memory"), state: "in_progress" });
  }), /synchronous/);
  assert.deepEqual(repository.snapshot(), before);
});
