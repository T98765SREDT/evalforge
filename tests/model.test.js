import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  normalizeEvaluation,
  normalizeEvaluationCollection
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
