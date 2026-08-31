import test from "node:test";
import assert from "node:assert/strict";
import {
  DOMAIN_SCHEMA_VERSION,
  assertCase,
  assertReview,
  createAssignment,
  createAuditEvent,
  createCase,
  createDataset,
  createReview,
  createReviewSession,
  createRubric,
  createWorkspace,
  assertWorkspaceDocument,
  validateWorkspaceDocument,
  validateEntity
} from "../js/domain/entities.js";
import { contentHash, deterministicId, isReservedCandidateId, stableSerialize } from "../js/domain/ids.js";

const now = () => "2026-08-29T12:00:00.000Z";
const ids = (() => {
  let next = 0;
  return () => `generated-${++next}`;
})();
const anchors = { 1: "Needs work.", 3: "Meets the baseline.", 5: "Excellent." };
const dimensions = [
  { id: "quality", label: "Quality", description: "Overall quality.", weight: 60, anchors },
  { id: "safety", label: "Safety", description: "Avoids foreseeable harm.", weight: 40, anchors }
];

test("pure constructors use injected time and id factories", () => {
  const rubric = createRubric({ id: "rubric-general", name: "General", dimensions }, { idFactory: ids, now });
  const dataset = createDataset({ id: "dataset-demo", name: "Demo", rubricRef: rubric.id }, { idFactory: ids, now });
  const workspace = createWorkspace({ id: "workspace-main", rubricIds: [rubric.id], datasetIds: [dataset.id] }, { idFactory: ids, now });

  assert.equal(rubric.schemaVersion, DOMAIN_SCHEMA_VERSION);
  assert.equal(dataset.createdAt, now());
  assert.deepEqual(workspace.datasetIds, [dataset.id]);
  assert.throws(() => createWorkspace({ name: "Needs clock" }, { idFactory: ids }), /now function must be injected/);
  assert.throws(() => createWorkspace({ id: "workspace-no-time" }, { idFactory: ids }), /now function must be injected/);
});

test("case content hash covers immutable input and candidate content", () => {
  const reviewCase = createCase({
    id: "case-1",
    datasetId: "dataset-1",
    externalId: "ticket-42",
    input: "How should this support issue be handled?",
    candidates: [
      { id: "candidate-model-1", content: "Ask for the missing log." , source: "model-a" },
      { id: "candidate-model-2", content: "Close the ticket without checking.", source: "model-b" }
    ]
  }, { idFactory: ids });
  assert.match(reviewCase.contentHash, /^fnv1a-/);
  assert.equal(reviewCase.contentHash, contentHash({
    externalId: reviewCase.externalId,
    input: reviewCase.input,
    candidates: reviewCase.candidates.map(({ id, content, source }) => ({ id, content, source }))
  }));
  assert.throws(() => assertCase({ ...reviewCase, input: "Changed after import" }), /contentHash/);
  assert.throws(() => createCase({ id: "case-bad", datasetId: "dataset-1", externalId: "x", input: "x", candidates: [{ id: "A", content: "one" }, { id: "candidate-2", content: "two" }] }, { idFactory: ids }), /positional labels/);
});

test("review ratings and winner use candidate ids, not side labels", () => {
  const candidateIds = ["candidate-1", "candidate-2"];
  const snapshot = {
    rubricId: "rubric-general",
    rubricVersion: "1.0.0",
    scoringAlgorithmVersion: "weighted-ratings-v1",
    tieThreshold: 2,
    dimensions
  };
  const complete = createReview({
    id: "review-1",
    assignmentId: "assignment-1",
    rubricSnapshot: snapshot,
    ratings: {
      "candidate-1": { quality: 5, safety: 4 },
      "candidate-2": { quality: 3, safety: 3 }
    },
    computed: { scoreByCandidate: { "candidate-1": 90, "candidate-2": 60 }, winner: "candidate-1" },
    preference: "candidate-1",
    confidence: 90,
    rationale: "The first candidate is more complete and handles the safety concern directly.",
    state: "complete",
    createdAt: now(),
    updatedAt: now(),
    completedAt: now()
  });
  assertReview(complete, { candidateIds });
  assert.equal(validateEntity("review", complete, { candidateIds }).valid, true);
  assert.equal(isReservedCandidateId("Left"), true);
  assert.equal(validateEntity("review", { ...complete, ratings: { A: { quality: 5 } } }, { candidateIds }).errors[0].code, "positional_candidate_id");
  assert.throws(() => assertReview(complete, { candidateIds: ["candidate-1", "candidate-2", "candidate-3"] }), /every candidate/);
});

test("session and assignment states encode resumable review workflow", () => {
  const session = createReviewSession({ id: "session-1", datasetId: "dataset-1", rubricRef: "rubric-general", reviewerId: "reviewer-1", seed: "batch-2026-08-29" }, { idFactory: ids, now });
  const assignment = createAssignment({ id: "assignment-1", sessionId: session.id, caseId: "case-1", displayOrder: ["candidate-2", "candidate-1"] }, { idFactory: ids });
  assert.equal(session.blindMode, true);
  assert.deepEqual(assignment.displayOrder, ["candidate-2", "candidate-1"]);
  assert.throws(() => createAssignment({ id: "assignment-skip", sessionId: session.id, caseId: "case-1", displayOrder: ["candidate-1", "candidate-2"], state: "skipped" }, { idFactory: ids }), /requires a reason/);
  assert.throws(() => createAssignment({ id: "assignment-done", sessionId: session.id, caseId: "case-1", displayOrder: ["candidate-1", "candidate-2"], state: "complete" }, { idFactory: ids }), /requires a review id/);
});

test("audit events and deterministic ids are reproducible", () => {
  const event = createAuditEvent({ id: "audit-1", entityType: "review", entityId: "review-1", action: "completed", actorId: "reviewer-1", at: now(), details: { revision: 1 } }, { idFactory: ids, now });
  assert.equal(event.schemaVersion, 3);
  assert.equal(deterministicId("case", { prompt: "same", order: 1 }), deterministicId("case", { order: 1, prompt: "same" }));
  assert.equal(stableSerialize({ b: 2, a: 1 }), stableSerialize({ a: 1, b: 2 }));
  assert.notEqual(deterministicId("case", "one"), deterministicId("case", "two"));
});

test("rubric definitions require anchors and normalized weights", () => {
  assert.throws(() => createRubric({ id: "rubric-bad", name: "Bad", dimensions: [{ id: "quality", label: "Quality", description: "", weight: 99, anchors }] }, { idFactory: ids }), /total 100/);
  assert.throws(() => createRubric({ id: "rubric-bad-anchor", name: "Bad", dimensions: [{ id: "quality", label: "Quality", description: "", weight: 100, anchors: { 1: "Only one" } }] }, { idFactory: ids }), /anchors\.3/);
});

test("workspace document validation checks references before persistence", () => {
  const rubric = createRubric({ id: "rubric-doc", name: "Document rubric", dimensions }, { idFactory: ids });
  const dataset = createDataset({ id: "dataset-doc", name: "Document dataset", rubricRef: rubric.id }, { idFactory: ids, now });
  const reviewCase = createCase({ id: "case-doc", datasetId: dataset.id, externalId: "row-1", input: "Prompt", candidates: [{ id: "candidate-doc-1", content: "One" }, { id: "candidate-doc-2", content: "Two" }] }, { idFactory: ids });
  const session = createReviewSession({ id: "session-doc", datasetId: dataset.id, rubricRef: rubric.id, reviewerId: "reviewer-doc", seed: "seed-1" }, { idFactory: ids, now });
  const assignment = createAssignment({ id: "assignment-doc", sessionId: session.id, caseId: reviewCase.id, displayOrder: ["candidate-doc-1", "candidate-doc-2"] }, { idFactory: ids });
  const review = createReview({ id: "review-doc", assignmentId: assignment.id });
  const document = {
    schemaVersion: 3,
    workspace: createWorkspace({ id: "workspace-doc", rubricIds: [rubric.id], datasetIds: [dataset.id] }, { idFactory: ids, now }),
    rubrics: [rubric],
    datasets: [dataset],
    cases: [reviewCase],
    sessions: [session],
    assignments: [assignment],
    reviews: [review],
    auditEvents: [createAuditEvent({ id: "audit-doc", entityType: "dataset", entityId: dataset.id, action: "created", actorId: "reviewer-doc", at: now() }, { idFactory: ids, now })]
  };
  assert.equal(validateWorkspaceDocument(document).valid, true);
  assert.doesNotThrow(() => assertWorkspaceDocument(document));
  const broken = structuredClone(document);
  broken.assignments[0].displayOrder = ["candidate-doc-1", "missing-candidate"];
  assert.equal(validateWorkspaceDocument(broken).errors[0].code, "unknown_reference");
});

test("workspace document validation checks assignment-to-review integrity", () => {
  const rubric = createRubric({ id: "rubric-link", name: "Link rubric", dimensions }, { idFactory: ids });
  const dataset = createDataset({ id: "dataset-link", name: "Link dataset", rubricRef: rubric.id }, { idFactory: ids, now });
  const reviewCase = createCase({ id: "case-link", datasetId: dataset.id, externalId: "row-1", input: "Prompt", candidates: [{ id: "candidate-link-1", content: "One" }, { id: "candidate-link-2", content: "Two" }] }, { idFactory: ids });
  const session = createReviewSession({ id: "session-link", datasetId: dataset.id, rubricRef: rubric.id, reviewerId: "reviewer-link", seed: "seed-link" }, { idFactory: ids, now });
  const assignment = createAssignment({ id: "assignment-link", sessionId: session.id, caseId: reviewCase.id, displayOrder: ["candidate-link-1", "candidate-link-2"], state: "complete", reviewId: "review-missing" }, { idFactory: ids });
  const document = {
    schemaVersion: 3,
    workspace: createWorkspace({ id: "workspace-link", rubricIds: [rubric.id], datasetIds: [dataset.id] }, { idFactory: ids, now }),
    rubrics: [rubric],
    datasets: [dataset],
    cases: [reviewCase],
    sessions: [session],
    assignments: [assignment],
    reviews: [],
    auditEvents: []
  };
  assert.equal(validateWorkspaceDocument(document).errors[0].code, "unknown_reference");

  const draft = createReview({ id: "review-draft-link", assignmentId: assignment.id });
  const linkedDraft = { ...document, assignments: [{ ...assignment, reviewId: draft.id }], reviews: [draft] };
  assert.equal(validateWorkspaceDocument(linkedDraft).errors[0].code, "invalid_reference");
});
