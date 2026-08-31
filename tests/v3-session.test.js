import test from "node:test";
import assert from "node:assert/strict";
import {
  createCase,
  createDataset,
  createRubric,
  createReview,
  createWorkspace
} from "../js/domain/entities.js";
import { buildV3ReviewInput } from "../js/ui/v3-review.js";
import {
  createV3AssignmentView,
  createV3SessionPlan,
  nextV3AssignmentIndex,
  restoreV3SessionState,
  v3DatasetOptions
} from "../js/ui/v3-session.js";

const now = () => "2026-08-29T14:00:00.000Z";
const idFactory = () => "session-from-test";

function rubric() {
  return createRubric({
    id: "rubric-general",
    name: "General review",
    version: "1.0.0",
    tieThreshold: 2,
    dimensions: [
      { id: "accuracy", label: "Accuracy", description: "Correctness", weight: 30, anchors: { 1: "Low", 3: "Adequate", 5: "High" } },
      { id: "relevance", label: "Relevance", description: "Fit", weight: 20, anchors: { 1: "Low", 3: "Adequate", 5: "High" } },
      { id: "clarity", label: "Clarity", description: "Readable", weight: 15, anchors: { 1: "Low", 3: "Adequate", 5: "High" } },
      { id: "completeness", label: "Completeness", description: "Coverage", weight: 15, anchors: { 1: "Low", 3: "Adequate", 5: "High" } },
      { id: "safety", label: "Safety", description: "Responsible", weight: 20, anchors: { 1: "Low", 3: "Adequate", 5: "High" } }
    ]
  }, { now });
}

function documentFixture() {
  const currentRubric = rubric();
  const dataset = createDataset({ id: "dataset-support", name: "Support pairs", description: "Two response pairs", rubricRef: currentRubric.id, createdAt: now() }, { now });
  const emptyDataset = createDataset({ id: "dataset-empty", name: "Empty set", rubricRef: currentRubric.id, createdAt: now() }, { now });
  const cases = [
    createCase({ id: "case-1", datasetId: dataset.id, externalId: "row-1", input: "How should a support agent reply?", candidates: [{ id: "candidate-1a", content: "A careful response.", source: "model-a", metadata: { model: "a" } }, { id: "candidate-1b", content: "A short response.", source: "model-b", metadata: { model: "b" } }] }),
    createCase({ id: "case-2", datasetId: dataset.id, externalId: "row-2", input: "How should a user recover?", candidates: [{ id: "candidate-2a", content: "Explain the recovery steps.", source: "model-a", metadata: { model: "a" } }, { id: "candidate-2b", content: "Ask them to try again.", source: "model-b", metadata: { model: "b" } }] })
  ];
  return {
    schemaVersion: 3,
    workspace: createWorkspace({ id: "workspace-1", name: "Test workspace", rubricIds: [currentRubric.id], datasetIds: [dataset.id, emptyDataset.id], createdAt: now(), updatedAt: now() }, { now }),
    rubrics: [currentRubric],
    datasets: [dataset, emptyDataset],
    cases,
    sessions: [],
    assignments: [],
    reviews: [],
    auditEvents: []
  };
}

test("dataset picker exposes only reviewable datasets and case counts", () => {
  const options = v3DatasetOptions(documentFixture());
  assert.deepEqual(options.map(({ id, caseCount }) => ({ id, caseCount })), [{ id: "dataset-support", caseCount: 2 }]);
});

test("session plan creates active blind assignments with reproducible order", () => {
  const document = documentFixture();
  const first = createV3SessionPlan(document, { datasetId: "dataset-support", reviewerId: "reviewer-1", seed: "seed-1", now, idFactory });
  const second = createV3SessionPlan(document, { datasetId: "dataset-support", reviewerId: "reviewer-1", seed: "seed-1", now, idFactory });
  assert.equal(first.session.state, "active");
  assert.equal(first.session.blindMode, true);
  assert.equal(first.assignments.length, 2);
  assert.deepEqual(first.assignments.map(({ displayOrder }) => displayOrder), second.assignments.map(({ displayOrder }) => displayOrder));
  assert.ok(first.assignments.every(({ state }) => state === "pending"));
});

test("assignment view never exposes candidate identity or source metadata", () => {
  const plan = createV3SessionPlan(documentFixture(), { datasetId: "dataset-support", reviewerId: "reviewer-1", seed: "seed-1", now, idFactory });
  const result = createV3AssignmentView(plan);
  assert.equal(result.total, 2);
  assert.equal(result.assignmentState, "pending");
  assert.deepEqual(Object.keys(result.view.candidates[0]).sort(), ["content", "label"]);
  assert.doesNotMatch(JSON.stringify(result.view), /candidate-1|model-a|model-b/);
  assert.match(result.view.candidates[0].label, /^Candidate [12]$/);
});

test("assignment navigation wraps and empty plans stay safe", () => {
  const plan = createV3SessionPlan(documentFixture(), { datasetId: "dataset-support", reviewerId: "reviewer-1", seed: "seed-1", now, idFactory });
  assert.equal(nextV3AssignmentIndex(plan.assignments, 0, -1), 1);
  assert.equal(nextV3AssignmentIndex(plan.assignments, 1, 1), 0);
  assert.deepEqual(createV3AssignmentView({ session: plan.session, assignments: [], cases: [] }), { empty: true, position: 0, total: 0, view: null });
  assert.throws(() => createV3SessionPlan(documentFixture(), { datasetId: "dataset-empty", reviewerId: "reviewer-1", seed: "seed-1", now, idFactory }), /no review cases/);
});

test("restore selects the newest active session and resumes the first open assignment", () => {
  const document = documentFixture();
  const older = createV3SessionPlan(document, { datasetId: "dataset-support", reviewerId: "reviewer-1", seed: "older", now, idFactory: () => "older-id" });
  older.session.createdAt = "2026-08-28T14:00:00.000Z";
  const newer = createV3SessionPlan(document, { datasetId: "dataset-support", reviewerId: "reviewer-2", seed: "newer", now, idFactory: () => "newer-id" });
  newer.session.createdAt = "2026-08-29T14:00:00.000Z";
  newer.assignments[0] = { ...newer.assignments[0], state: "complete", reviewId: "review-newer-1" };
  document.sessions = [older.session, newer.session];
  document.assignments = [...older.assignments, ...newer.assignments];
  const completeInput = buildV3ReviewInput(document.cases[0], document.rubrics[0], {
    ratings: {
      "candidate-1a": { accuracy: 5, relevance: 5, clarity: 5, completeness: 5, safety: 5 },
      "candidate-1b": { accuracy: 4, relevance: 4, clarity: 4, completeness: 4, safety: 4 }
    },
    preference: "candidate-1a",
    confidence: 4,
    rationale: "The first response is clearer and covers the support workflow more completely."
  });
  const latestReview = createReview({
    ...completeInput,
    id: "review-newer-1",
    assignmentId: newer.assignments[0].id,
    revision: 2,
    state: "complete",
    createdAt: now(),
    updatedAt: now(),
    completedAt: now()
  });
  document.reviews = [{ ...latestReview, id: "review-newer-0", revision: 1 }, latestReview];
  const restored = restoreV3SessionState(document);
  assert.equal(restored.session.id, newer.session.id);
  assert.equal(restored.currentIndex, 1);
  assert.equal(restored.revisions[newer.assignments[0].id], 2);
  assert.equal(restored.resumed, true);
});

test("restore returns null when there is no active session with assignments", () => {
  const document = documentFixture();
  assert.equal(restoreV3SessionState(document), null);
});

test("restore does not route migrated non-blind sessions into the blind panel", () => {
  const document = documentFixture();
  const plan = createV3SessionPlan(document, { datasetId: "dataset-support", reviewerId: "reviewer-legacy", seed: "legacy", now, idFactory });
  const session = { ...plan.session, id: "session-legacy", blindMode: false, state: "completed", completedAt: now() };
  const assignment = { ...plan.assignments[0], id: "assignment-legacy", sessionId: session.id, state: "skipped", skipReason: "Legacy non-blind record." };
  document.sessions = [session];
  document.assignments = [assignment];
  assert.equal(restoreV3SessionState(document), null);
});
