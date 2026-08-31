import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  createBlankEvaluation,
  normalizeEvaluation,
  normalizeEvaluationCollection,
  normalizeRubricSnapshot
} from "../js/model.js";

const completeRatings = {
  accuracy: 5,
  relevance: 4,
  clarity: 3,
  completeness: 2,
  safety: 1
};

function completeEvaluation(overrides = {}) {
  return {
    id: "evaluation-1",
    title: "Reliable comparison",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:05:00.000Z",
    status: "complete",
    prompt: "Compare these responses.",
    responseA: "Response A",
    responseB: "Response B",
    ratings: { A: completeRatings, B: { ...completeRatings, accuracy: 3 } },
    confidence: 91,
    tags: ["AI evaluation"],
    notes: "Response A is more accurate and supports its main conclusion.",
    ...overrides
  };
}

test("normalization snapshots the exact rubric and score contributions", () => {
  const normalized = normalizeEvaluation(completeEvaluation());
  assert.equal(normalized.recordVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(normalized.rubricSnapshot.rubricVersion, "1.0.0");
  assert.equal(normalized.rubricSnapshot.tieThreshold, 2);
  assert.equal(normalized.rubricSnapshot.weights.accuracy, 30);
  assert.equal(normalized.rubricSnapshot.contributions.A.accuracy, 30);
  assert.equal(normalized.rubricSnapshot.contributions.A.safety, 4);
  assert.equal(normalized.scores.A.score, 65);
  assert.equal(normalized.status, "complete");
});

test("incomplete legacy records are migrated safely and cannot remain complete", () => {
  const normalized = normalizeEvaluation({
    id: "legacy",
    status: "complete",
    prompt: "Prompt",
    responseA: "A",
    responseB: "B",
    ratings: { A: { accuracy: 5 }, B: { accuracy: 5 } },
    notes: "short"
  });
  assert.equal(normalized.recordVersion, 2);
  assert.equal(normalized.status, "draft");
  assert.equal(normalized.winner, "pending");
  assert.equal(normalized.rubricSnapshot.contributions.A.accuracy, 30);
});

test("collection migration skips invalid entries, repairs duplicate IDs, and reports counts", () => {
  let nextId = 0;
  const result = normalizeEvaluationCollection([
    null,
    { unrelated: true },
    { id: "duplicate", prompt: 42 },
    { id: "duplicate", prompt: "Usable draft" }
  ], { idFactory: () => `generated-${++nextId}` });

  assert.equal(result.report.accepted, 2);
  assert.equal(result.report.repaired, 2);
  assert.equal(result.report.skipped, 2);
  assert.equal(new Set(result.evaluations.map(({ id }) => id)).size, 2);
  assert.equal(result.evaluations[0].prompt, "");
  assert.equal(result.evaluations[1].id, "generated-1");
});

test("malformed values are constrained to safe field types", () => {
  const normalized = normalizeEvaluation(completeEvaluation({
    id: "x".repeat(200),
    confidence: 300,
    tags: [" valid ", 42, "valid", "second"],
    createdAt: "not-a-date",
    ratings: { A: { ...completeRatings, accuracy: "5" }, B: completeRatings }
  }), { idFactory: () => "replacement-id" });
  assert.equal(normalized.id, "replacement-id");
  assert.equal(normalized.confidence, 100);
  assert.deepEqual(normalized.tags, ["valid", "second"]);
  assert.equal(normalized.createdAt, null);
  assert.equal(normalized.ratings.A.accuracy, 5);
});

test("sample records keep their provenance while user records remain exportable", () => {
  const sample = normalizeEvaluation({ id: "sample", isSample: true, title: "Example", prompt: "Prompt" });
  const user = normalizeEvaluation({ id: "user", title: "My review", prompt: "Prompt" });
  assert.equal(sample.isSample, true);
  assert.equal(user.isSample, false);
});

test("a selected rubric is carried into the record and uses its dimensions", () => {
  const blank = createBlankEvaluation("coding-draft", "coding");
  assert.equal(blank.rubricId, "coding");
  assert.deepEqual(Object.keys(blank.ratings.A), ["correctness", "requirements", "clarity", "edge_cases", "safety"]);
  const normalized = normalizeEvaluation({ ...blank, title: "Coding review" });
  assert.equal(normalized.rubricId, "coding");
  assert.equal(normalized.rubricSnapshot.rubricId, "coding");
  assert.equal(normalized.rubricSnapshot.weights.correctness, 35);
});

test("a persisted custom rubric remains the scoring source after preset changes", () => {
  const customSnapshot = {
    rubricId: "custom-support",
    rubricName: "Support quality",
    rubricVersion: "2.4.0",
    scoringAlgorithmVersion: "weighted-ratings-v1",
    tieThreshold: 25,
    weights: { support: 100 },
    dimensions: [{ id: "support", label: "Support", description: "Evidence and practical help.", weight: 100 }]
  };
  const normalized = normalizeEvaluation({
    id: "custom-history",
    rubricId: "general",
    rubricSnapshot: customSnapshot,
    prompt: "Compare two support answers.",
    responseA: "A provides evidence.",
    responseB: "B provides less evidence.",
    ratings: { A: { support: 5 }, B: { support: 4 } },
    notes: "The first response explains the decision and gives a useful next step.",
    status: "complete"
  });
  assert.equal(normalized.rubricId, "custom-support");
  assert.equal(normalized.rubricSnapshot.rubricVersion, "2.4.0");
  assert.equal(normalized.rubricSnapshot.weights.support, 100);
  assert.equal(normalized.scores.A.score, 100);
  assert.equal(normalized.scores.B.score, 80);
  assert.equal(normalized.winner, "tie");
  assert.equal(normalized.rubricSnapshot.auditStatus, "verified");
});

test("invalid snapshots fall back with an explicit repair reason", () => {
  const normalized = normalizeEvaluation({
    id: "broken-history",
    rubricId: "coding",
    rubricSnapshot: { dimensions: [], tieThreshold: "unknown" },
    prompt: "Prompt",
    responseA: "A",
    responseB: "B",
    ratings: { A: { correctness: 5 }, B: { correctness: 5 } },
    notes: "This record is intentionally incomplete for recovery testing."
  });
  assert.equal(normalized.rubricSnapshot.auditStatus, "fallback");
  assert.equal(normalized.rubricSnapshot.repairReason, "missing-rubric-dimensions");
  assert.equal(normalized.rubricId, "coding");
});

test("snapshot normalization reports legacy algorithm metadata as limited", () => {
  const result = normalizeRubricSnapshot({
    rubricId: "legacy-custom",
    rubricVersion: "0.9.0",
    tieThreshold: 1,
    dimensions: [{ id: "quality", label: "Quality", weight: 100 }]
  }, undefined, { A: { quality: 4 }, B: { quality: 4 } });
  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "missing-scoring-algorithm-version");
  assert.equal(result.snapshot.auditStatus, "limited");
  assert.equal(result.snapshot.weights.quality, 100);
});
