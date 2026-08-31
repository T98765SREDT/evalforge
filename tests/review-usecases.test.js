import test from "node:test";
import assert from "node:assert/strict";
import { createAssignment, createCase, createReview, createRubric } from "../js/domain/entities.js";
import { MemoryRepository } from "../js/persistence/memory-repository.js";
import { RepositoryConflictError } from "../js/persistence/repository.js";
import { completeReview, reviseCompletedReview, saveDraft, skipAssignment, startAssignment } from "../js/domain/review-usecases.js";

const now = () => "2026-08-29T13:00:00.000Z";
const anchors = { 1: "Needs work.", 3: "Meets the baseline.", 5: "Excellent." };
const dimensions = [{ id: "quality", label: "Quality", description: "Overall quality.", weight: 100, anchors }];
const snapshot = { rubricId: "rubric-memory", rubricVersion: "1.0.0", scoringAlgorithmVersion: "weighted-ratings-v1", tieThreshold: 2, dimensions };

function setupRepository() {
  const reviewCase = createCase({ id: "case-usecase", datasetId: "dataset-usecase", externalId: "row-1", input: "Compare two answers.", candidates: [{ id: "candidate-usecase-1", content: "First answer" }, { id: "candidate-usecase-2", content: "Second answer" }] });
  const assignment = createAssignment({ id: "assignment-usecase", sessionId: "session-usecase", caseId: reviewCase.id, displayOrder: reviewCase.candidates.map(({ id }) => id) });
  return new MemoryRepository({ cases: { [reviewCase.id]: reviewCase }, assignments: { [assignment.id]: assignment } });
}

function completeInput() {
  return {
    rubricSnapshot: snapshot,
    ratings: { "candidate-usecase-1": { quality: 5 }, "candidate-usecase-2": { quality: 3 } },
    computed: { scoreByCandidate: { "candidate-usecase-1": 100, "candidate-usecase-2": 60 }, winner: "candidate-usecase-1" },
    preference: "candidate-usecase-1",
    confidence: 92,
    preferenceEvidence: "The preferred answer addresses the concrete user need more directly.",
    rationale: "The first answer is clearer and provides the more useful outcome.",
    issueLabels: []
  };
}

test("start and saveDraft transition state with optimistic revisions", () => {
  const repository = setupRepository();
  const started = startAssignment(repository, { assignmentId: "assignment-usecase", now });
  assert.equal(started.assignment.state, "in_progress");
  assert.equal(repository.list("auditEvents").length, 1);
  const saved = saveDraft(repository, { assignmentId: "assignment-usecase", review: createReview({ id: "draft-usecase", ratings: { "candidate-usecase-1": { quality: 4 } }, computed: { scoreByCandidate: {}, winner: "pending" }, preference: "pending" }), expectedRevision: 0, now });
  assert.equal(saved.review.revision, 1);
  assert.equal(repository.get("assignments", "assignment-usecase").reviewId, saved.review.id);
  assert.throws(() => saveDraft(repository, { assignmentId: "assignment-usecase", review: saved.review, expectedRevision: 0, now }), RepositoryConflictError);
});

test("completeReview writes review, assignment, and audit atomically", () => {
  const repository = setupRepository();
  startAssignment(repository, { assignmentId: "assignment-usecase", now });
  const result = completeReview(repository, { assignmentId: "assignment-usecase", review: completeInput(), expectedRevision: 0, now });
  assert.equal(result.review.state, "complete");
  assert.equal(result.assignment.state, "complete");
  assert.equal(repository.list("reviews").length, 1);
  assert.equal(repository.list("auditEvents").length, 2);
  const duplicate = completeReview(repository, { assignmentId: "assignment-usecase", review: completeInput(), now });
  assert.equal(duplicate.duplicate, true);
  assert.throws(() => completeReview(repository, { assignmentId: "assignment-usecase", review: { ...completeInput(), rationale: "A different conclusion that changes the saved result." }, now }), /already complete/);
});

test("completing a review locks the referenced rubric once", () => {
  const base = setupRepository();
  const rubric = createRubric({ id: "rubric-usecase", name: "Locked rubric", dimensions }, { idFactory: () => "unused" });
  const repository = new MemoryRepository({
    ...base.snapshot(),
    sessions: { "session-usecase": { id: "session-usecase", rubricRef: rubric.id } },
    rubrics: { [rubric.id]: rubric }
  });
  startAssignment(repository, { assignmentId: "assignment-usecase", now });
  const result = completeReview(repository, { assignmentId: "assignment-usecase", review: completeInput(), now });
  assert.equal(result.rubric.lockedAt, now());
  assert.equal(repository.get("rubrics", rubric.id).lockedAt, now());
  assert.equal(repository.list("auditEvents").filter(({ action }) => action === "rubric_locked").length, 1);
  const duplicate = completeReview(repository, { assignmentId: "assignment-usecase", review: completeInput(), now });
  assert.equal(duplicate.duplicate, true);
  assert.equal(repository.list("auditEvents").filter(({ action }) => action === "rubric_locked").length, 1);
});

test("failed complete does not leave a review or assignment update", () => {
  for (const failureAtWrite of [1, 2, 3]) {
    const repository = setupRepository();
    startAssignment(repository, { assignmentId: "assignment-usecase", now });
    const before = repository.snapshot();
    repository.setFailureAtWrite(failureAtWrite);
    assert.throws(() => completeReview(repository, { assignmentId: "assignment-usecase", review: completeInput(), now }), /Injected failure/);
    assert.deepEqual(repository.snapshot(), before);
  }
});

test("skip requires a reason and is idempotent", () => {
  const repository = setupRepository();
  assert.throws(() => skipAssignment(repository, { assignmentId: "assignment-usecase", reason: "", now }), /requires a reason/);
  const skipped = skipAssignment(repository, { assignmentId: "assignment-usecase", reason: "Needs a separate safety rubric.", now });
  assert.equal(skipped.assignment.state, "skipped");
  assert.equal(skipped.auditEvent.action, "assignment_skipped");
  assert.equal(skipAssignment(repository, { assignmentId: "assignment-usecase", reason: "Needs a separate safety rubric.", now }).duplicate, true);
  assert.throws(() => skipAssignment(repository, { assignmentId: "assignment-usecase", reason: "Changed reason", now }), /already skipped/);
});

test("revision keeps the prior complete review and increments revision", () => {
  const repository = setupRepository();
  startAssignment(repository, { assignmentId: "assignment-usecase", now });
  const first = completeReview(repository, { assignmentId: "assignment-usecase", review: completeInput(), now });
  const revised = reviseCompletedReview(repository, { assignmentId: "assignment-usecase", review: { ...completeInput(), preference: "tie", computed: { ...completeInput().computed, winner: "tie" }, rationale: "After checking the edge case, both answers are acceptable." }, expectedRevision: 1, now });
  assert.equal(revised.review.revision, 2);
  assert.notEqual(revised.review.id, first.review.id);
  assert.equal(revised.review.supersedesReviewId, first.review.id);
  assert.equal(repository.list("reviews").length, 2);
  assert.equal(repository.get("assignments", "assignment-usecase").reviewId, revised.review.id);
  assert.throws(() => reviseCompletedReview(repository, { assignmentId: "assignment-usecase", review: completeInput(), expectedRevision: 1, now }), /stale/);
});
