import test from "node:test";
import assert from "node:assert/strict";
import { ENTITY_STORES, RepositoryConflictError, RepositoryError, clone } from "../js/persistence/repository.js";
import { createAssignment, createCase, createDataset, createReviewSession, createRubric } from "../js/domain/entities.js";
import { buildV3ReviewInput, createEmptyV3Draft } from "../js/ui/v3-review.js";
import {
  completeIndexedDbReview,
  completeIndexedDbSession,
  revealIndexedDbSession,
  saveIndexedDbDraft,
  startIndexedDbAssignment
} from "../js/domain/indexeddb-review-usecases.js";

const timestamp = "2026-08-29T15:00:00.000Z";
const now = () => timestamp;

/**
 * A small asynchronous adapter used to exercise the same transaction shape
 * as IndexedDbRepository without depending on a browser IndexedDB runtime.
 */
class AsyncMemoryRepository {
  constructor(seed = {}) {
    this.state = Object.fromEntries(ENTITY_STORES.map((store) => [store, new Map(Object.entries(seed[store] || {}))]));
    this.failAtWrite = null;
  }

  async transaction(callback, { stores = ENTITY_STORES, mode = "readwrite" } = {}) {
    if (typeof callback !== "function") throw new TypeError("transaction() requires a callback.");
    const candidate = Object.fromEntries(stores.map((store) => [store, new Map([...this.state[store].entries()].map(([id, value]) => [id, clone(value)]))]));
    let writes = 0;
    const transaction = {
      get: async (store, id) => clone(candidate[store]?.get(id)),
      list: async (store) => [...(candidate[store]?.values() || [])].map(clone),
      put: async (store, value) => {
        if (mode === "readonly") throw new RepositoryError("A readonly transaction cannot write.", { code: "readonly_write", store });
        if (!value || typeof value.id !== "string" || !value.id) throw new RepositoryError("Repository entities require a stable id.", { code: "missing_id", store });
        writes += 1;
        if (this.failAtWrite === writes) throw new RepositoryError("Injected async write failure.", { code: "injected_failure", store, id: value.id });
        candidate[store].set(value.id, clone(value));
        return clone(value);
      },
      delete: async (store, id) => {
        if (mode === "readonly") throw new RepositoryError("A readonly transaction cannot write.", { code: "readonly_write", store });
        writes += 1;
        if (this.failAtWrite === writes) throw new RepositoryError("Injected async write failure.", { code: "injected_failure", store, id });
        candidate[store].delete(id);
      },
      checkpoint: async (name, value) => transaction.put("checkpoints", { id: name, value })
    };
    const result = await callback(transaction);
    if (mode !== "readonly") for (const store of stores) this.state[store] = candidate[store];
    return clone(result);
  }

  async get(store, id) { return this.transaction((transaction) => transaction.get(store, id), { stores: [store], mode: "readonly" }); }
  async list(store) { return this.transaction((transaction) => transaction.list(store), { stores: [store], mode: "readonly" }); }
  async put(store, value) { return this.transaction((transaction) => transaction.put(store, value), { stores: [store] }); }
  async checkpoint(name, value) { return this.transaction((transaction) => transaction.checkpoint(name, value), { stores: ["checkpoints"] }); }
}

function fixture() {
  const rubric = createRubric({
    id: "rubric-async",
    name: "Async review rubric",
    dimensions: [{ id: "quality", label: "Quality", description: "Overall quality", weight: 100, anchors: { 1: "Low", 3: "Adequate", 5: "High" } }]
  });
  const dataset = createDataset({ id: "dataset-async", name: "Async dataset", rubricRef: rubric.id, createdAt: timestamp });
  const reviewCase = createCase({
    id: "case-async",
    datasetId: dataset.id,
    externalId: "row-1",
    input: "Compare the two answers.",
    candidates: [
      { id: "candidate-async-a", content: "The first answer.", source: "model-a" },
      { id: "candidate-async-b", content: "The second answer.", source: "model-b" }
    ]
  });
  const session = createReviewSession({ id: "session-async", datasetId: dataset.id, rubricRef: rubric.id, reviewerId: "reviewer-async", seed: "seed-async", blindMode: true, state: "active", createdAt: timestamp });
  const assignment = createAssignment({ id: "assignment-async", sessionId: session.id, caseId: reviewCase.id, displayOrder: ["candidate-async-a", "candidate-async-b"] });
  return {
    repository: new AsyncMemoryRepository({
      rubrics: { [rubric.id]: rubric },
      datasets: { [dataset.id]: dataset },
      cases: { [reviewCase.id]: reviewCase },
      sessions: { [session.id]: session },
      assignments: { [assignment.id]: assignment }
    }),
    rubric,
    reviewCase,
    assignment
  };
}

function completeInput(reviewCase, rubric) {
  return buildV3ReviewInput(reviewCase, rubric, {
    ratings: {
      "candidate-async-a": { quality: 5 },
      "candidate-async-b": { quality: 3 }
    },
    preference: "candidate-async-a",
    confidence: 4,
    rationale: "The first answer is clearer and more useful for the stated request."
  });
}

test("async start and draft save persist optimistic revisions", async () => {
  const { repository, reviewCase, rubric, assignment } = fixture();
  const started = await startIndexedDbAssignment(repository, { assignmentId: assignment.id, now, actorId: "reviewer-async" });
  assert.equal(started.assignment.state, "in_progress");
  assert.equal((await repository.list("auditEvents")).length, 1);

  const draft = buildV3ReviewInput(reviewCase, rubric, createEmptyV3Draft(reviewCase, rubric));
  const saved = await saveIndexedDbDraft(repository, { assignmentId: assignment.id, review: draft, expectedRevision: 0, now, actorId: "reviewer-async" });
  assert.equal(saved.review.state, "draft");
  assert.equal(saved.review.revision, 1);
  assert.equal((await repository.get("assignments", assignment.id)).reviewId, saved.review.id);

  await assert.rejects(
    () => saveIndexedDbDraft(repository, { assignmentId: assignment.id, review: draft, expectedRevision: 0, now }),
    (error) => error instanceof RepositoryConflictError && error.code === "stale_revision"
  );
  assert.equal((await repository.get("reviews", saved.review.id)).revision, 1);
});

test("async completion writes review, assignment, audit, and rubric lock atomically", async () => {
  const { repository, reviewCase, rubric, assignment } = fixture();
  await startIndexedDbAssignment(repository, { assignmentId: assignment.id, now, actorId: "reviewer-async" });
  const result = await completeIndexedDbReview(repository, {
    assignmentId: assignment.id,
    review: completeInput(reviewCase, rubric),
    expectedRevision: 0,
    now,
    actorId: "reviewer-async"
  });
  assert.equal(result.review.state, "complete");
  assert.equal(result.assignment.state, "complete");
  assert.equal((await repository.list("reviews")).length, 1);
  assert.equal((await repository.list("auditEvents")).length, 3);
  assert.equal((await repository.get("rubrics", rubric.id)).lockedAt, timestamp);

  const duplicate = await completeIndexedDbReview(repository, { assignmentId: assignment.id, review: completeInput(reviewCase, rubric), now });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await repository.list("auditEvents")).length, 3);
});

test("async completion failure leaves all stores unchanged", async () => {
  const { repository, reviewCase, rubric, assignment } = fixture();
  await startIndexedDbAssignment(repository, { assignmentId: assignment.id, now, actorId: "reviewer-async" });
  const before = {
    assignment: await repository.get("assignments", assignment.id),
    reviews: await repository.list("reviews"),
    audits: await repository.list("auditEvents"),
    rubric: await repository.get("rubrics", rubric.id)
  };
  repository.failAtWrite = 2;
  await assert.rejects(
    () => completeIndexedDbReview(repository, { assignmentId: assignment.id, review: completeInput(reviewCase, rubric), expectedRevision: 0, now }),
    /Injected async write failure/
  );
  assert.deepEqual(await repository.get("assignments", assignment.id), before.assignment);
  assert.deepEqual(await repository.list("reviews"), before.reviews);
  assert.deepEqual(await repository.list("auditEvents"), before.audits);
  assert.deepEqual(await repository.get("rubrics", rubric.id), before.rubric);
});

test("session completion refuses unresolved assignments without writing", async () => {
  const { repository, assignment } = fixture();
  await assert.rejects(
    () => completeIndexedDbSession(repository, { sessionId: "session-async", now, actorId: "reviewer-async" }),
    (error) => error.code === "incomplete_session" && /still need review/.test(error.message)
  );
  assert.equal((await repository.get("sessions", "session-async")).state, "active");
  assert.equal((await repository.list("auditEvents")).length, 0);
  assert.equal((await repository.get("assignments", assignment.id)).state, "pending");
});

test("session completion refuses completed assignments with missing, draft, or mismatched reviews", async () => {
  for (const reviewState of ["missing", "draft", "mismatched"]) {
    const { repository, reviewCase, rubric, assignment } = fixture();
    if (reviewState !== "missing") {
      const draft = buildV3ReviewInput(reviewCase, rubric, createEmptyV3Draft(reviewCase, rubric));
      await repository.put("reviews", {
        ...draft,
        id: "review-draft-only",
        assignmentId: reviewState === "mismatched" ? "assignment-other" : assignment.id,
        revision: 1,
        state: reviewState === "mismatched" ? "complete" : "draft",
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: reviewState === "mismatched" ? timestamp : null
      });
    }
    await repository.put("assignments", {
      ...assignment,
      state: "complete",
      reviewId: reviewState === "missing" ? "review-does-not-exist" : "review-draft-only"
    });

    await assert.rejects(
      () => completeIndexedDbSession(repository, { sessionId: "session-async", now, actorId: "reviewer-async" }),
      (error) => error.code === "invalid_session_records" && /complete review|missing review/.test(error.message)
    );
    assert.equal((await repository.get("sessions", "session-async")).state, "active");
    assert.equal((await repository.list("auditEvents")).length, 0);
  }
});

test("session completion and metadata reveal are explicit, ordered, and idempotent", async () => {
  const { repository, assignment } = fixture();
  await repository.put("assignments", { ...assignment, state: "skipped", skipReason: "Not part of this sample." });
  const completed = await completeIndexedDbSession(repository, { sessionId: "session-async", now, actorId: "reviewer-async" });
  assert.equal(completed.session.state, "completed");
  assert.equal(completed.session.completedAt, timestamp);
  assert.equal((await repository.list("auditEvents")).at(-1).action, "session_completed");

  const revealed = await revealIndexedDbSession(repository, { sessionId: "session-async", now, actorId: "reviewer-async" });
  assert.equal(revealed.session.state, "revealed");
  assert.equal(revealed.session.revealedAt, timestamp);
  assert.equal((await repository.list("auditEvents")).at(-1).action, "session_revealed");
  assert.equal((await revealIndexedDbSession(repository, { sessionId: "session-async", now })).duplicate, true);
  assert.equal((await repository.list("auditEvents")).length, 2);
});
