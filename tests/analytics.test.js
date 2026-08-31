import test from "node:test";
import assert from "node:assert/strict";
import { analyticsFilterOptions, calculateAnalytics } from "../js/domain/analytics.js";

const evaluation = (overrides = {}) => ({
  id: overrides.id || "review-1",
  rubricId: overrides.rubricId || "general",
  prompt: "Prompt",
  responseA: "A",
  responseB: "B",
  ratings: {
    A: { accuracy: 5, relevance: 4 },
    B: { accuracy: 3, relevance: 3 }
  },
  scores: { A: { score: 90 }, B: { score: 60 } },
  winner: overrides.winner || "A",
  confidence: overrides.confidence ?? 5,
  notes: "The first response is more accurate and directly answers the prompt.",
  tags: overrides.tags || ["support"],
  status: overrides.status || "complete",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: overrides.updatedAt || "2026-08-02T00:00:00.000Z",
  ...overrides
});

test("legacy analytics reports workflow denominators, rates, gaps, and dimensions", () => {
  const result = calculateAnalytics({
    evaluations: [evaluation(), evaluation({ id: "review-2", winner: "tie", confidence: 50, confidenceScale: "legacy-0-100" })],
    queueCases: [{ id: "queued-1", prompt: "P", responseA: "A", responseB: "B", status: "skipped", rubricId: "general" }]
  });
  assert.deepEqual(result.workflow, { total: 3, completed: 2, skipped: 1, active: 0, completionRate: 2 / 3, skipRate: 1 / 3 });
  assert.equal(result.reviews.ties, 1);
  assert.equal(result.reviews.tieRate, 0.5);
  assert.equal(result.reviews.lowConfidence, 1);
  assert.equal(result.scoreGap.median, 30);
  assert.deepEqual(result.scoreGap.buckets.map(({ count }) => count), [0, 0, 0, 0, 2]);
  assert.deepEqual(result.dimensions, [
    { dimension: "accuracy", average: 4, count: 4 },
    { dimension: "relevance", average: 3.5, count: 4 }
  ]);
});

test("drafts and demo records are excluded by default and filters are reproducible", () => {
  const result = calculateAnalytics({
    evaluations: [
      evaluation(),
      evaluation({ id: "demo", isSample: true }),
      evaluation({ id: "draft", status: "draft" })
    ],
    filters: { tag: "support", from: "2026-08-01", to: "2026-08-03" }
  });
  assert.equal(result.reviews.completed, 1);
  assert.equal(result.workflow.total, 1);
  assert.equal(result.limitations.some((note) => /Small sample/.test(note)), true);
  const withSamples = calculateAnalytics({ evaluations: [evaluation({ id: "demo", isSample: true })], filters: { includeSamples: true } });
  assert.equal(withSamples.reviews.completed, 1);
});

test("source win rate stays unavailable without revealed source metadata", () => {
  const result = calculateAnalytics({ evaluations: [evaluation()] });
  assert.equal(result.sourceWinRate.available, false);
  assert.match(result.sourceWinRate.reason, /revealed session/);
});

test("filter options expose only values present in the local records", () => {
  const options = analyticsFilterOptions({ evaluations: [evaluation({ rubricId: "coding", tags: ["code", "support"], datasetId: "d1", datasetName: "Coding set" })] });
  assert.deepEqual(options.rubrics, ["coding"]);
  assert.deepEqual(options.tags, ["code", "support"]);
  assert.deepEqual(options.datasets, [{ id: "d1", name: "Coding set" }]);
});

test("v3 rows calculate conflicts and calibration pairs from candidate identities", () => {
  const document = {
    schemaVersion: 3,
    datasets: [{ id: "dataset-1", name: "Live", rubricRef: "general", isDemo: false }],
    cases: [{ id: "case-1", datasetId: "dataset-1", candidates: [{ id: "candidate-a", source: "model-a" }, { id: "candidate-b", source: "model-b" }], metadata: { tags: ["qa"] } }],
    sessions: [{ id: "session-1", datasetId: "dataset-1", rubricRef: "general", reviewerId: "reviewer-1" }],
    assignments: [
      { id: "assignment-1", sessionId: "session-1", caseId: "case-1", state: "complete", displayOrder: ["candidate-a", "candidate-b"], reviewId: "review-1" },
      { id: "assignment-2", sessionId: "session-1", caseId: "case-1", state: "complete", displayOrder: ["candidate-b", "candidate-a"], reviewId: "review-2", repeatOf: "assignment-1", calibration: true }
    ],
    reviews: [
      { id: "review-1", assignmentId: "assignment-1", state: "complete", preference: "candidate-a", computed: { winner: "candidate-b", scoreByCandidate: { "candidate-a": 70, "candidate-b": 80 } }, ratings: { "candidate-a": { accuracy: 4 }, "candidate-b": { accuracy: 5 } }, confidence: 3, confidenceScale: "anchored-1-5", rationale: "A complete rationale with enough evidence.", updatedAt: "2026-08-01T00:00:00.000Z" },
      { id: "review-2", assignmentId: "assignment-2", state: "complete", preference: "candidate-a", computed: { winner: "candidate-a", scoreByCandidate: { "candidate-a": 80, "candidate-b": 70 } }, ratings: { "candidate-a": { accuracy: 5 }, "candidate-b": { accuracy: 4 } }, confidence: 4, confidenceScale: "anchored-1-5", rationale: "A complete rationale with enough evidence.", updatedAt: "2026-08-02T00:00:00.000Z" }
    ]
  };
  const result = calculateAnalytics({ document });
  assert.equal(result.reviews.conflicts, 1);
  assert.equal(result.sourceWinRate.available, true);
  assert.deepEqual(result.sourceWinRate.bySource, [
    { source: "model-a", wins: 2, compared: 2, winRate: 1 },
    { source: "model-b", wins: 0, compared: 2, winRate: 0 }
  ]);
  assert.equal(result.calibration.repeats, 1);
  assert.equal(result.calibration.position.switchRate, 1);
});

test("active blind sessions never expose source win rates", () => {
  const document = {
    schemaVersion: 3,
    datasets: [{ id: "dataset-1", name: "Blind", rubricRef: "general", isDemo: false }],
    cases: [{ id: "case-1", datasetId: "dataset-1", candidates: [{ id: "candidate-a", source: "model-a" }, { id: "candidate-b", source: "model-b" }] }],
    sessions: [{ id: "session-1", datasetId: "dataset-1", rubricRef: "general", reviewerId: "reviewer-1", blindMode: true, revealedAt: null }],
    assignments: [{ id: "assignment-1", sessionId: "session-1", caseId: "case-1", state: "complete", displayOrder: ["candidate-a", "candidate-b"], reviewId: "review-1" }],
    reviews: [{ id: "review-1", assignmentId: "assignment-1", state: "complete", preference: "candidate-a", computed: { winner: "candidate-a", scoreByCandidate: { "candidate-a": 80, "candidate-b": 70 } }, ratings: { "candidate-a": { accuracy: 4 }, "candidate-b": { accuracy: 3 } }, confidence: 4, confidenceScale: "anchored-1-5", rationale: "A complete rationale with enough evidence.", updatedAt: "2026-08-01T00:00:00.000Z" }]
  };
  const result = calculateAnalytics({ document });
  assert.equal(result.sourceWinRate.available, false);
  assert.match(result.sourceWinRate.reason, /revealed session/);
});
