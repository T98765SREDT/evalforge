import test from "node:test";
import assert from "node:assert/strict";
import { createAssignment, createReview, createRubric, assertReview } from "../js/domain/entities.js";
import {
  CONFIDENCE_ANCHORS,
  cloneRubricVersion,
  confidenceAnchor,
  confidenceLabel,
  computeCalibrationMetrics,
  createCalibrationRepeat,
  isPreferenceDisagreement,
  lockRubric,
  requiresPreferenceEvidence,
  selectCalibrationRepeats
} from "../js/domain/calibration.js";

const now = () => "2026-08-29T14:00:00.000Z";
const snapshot = {
  rubricId: "rubric-calibration",
  rubricVersion: "1.0.0",
  scoringAlgorithmVersion: "weighted-ratings-v1",
  tieThreshold: 2,
  dimensions: [{ id: "quality", label: "Quality", description: "Overall quality.", weight: 100, anchors: { 1: "Needs work.", 3: "Meets the baseline.", 5: "Excellent." } }]
};

function completeReview(overrides = {}) {
  return createReview({
    id: "review-calibration",
    assignmentId: "assignment-calibration",
    rubricSnapshot: snapshot,
    ratings: { "candidate-calibration-1": { quality: 4 }, "candidate-calibration-2": { quality: 2 } },
    computed: { scoreByCandidate: { "candidate-calibration-1": 80, "candidate-calibration-2": 40 }, winner: "candidate-calibration-1" },
    preference: "candidate-calibration-1",
    confidence: 4,
    rationale: "The first answer is more accurate and directly addresses the requested outcome.",
    issueLabels: [],
    state: "complete",
    createdAt: now(),
    updatedAt: now(),
    completedAt: now(),
    ...overrides
  });
}

test("new reviews use anchored confidence while legacy percentages stay explicit", () => {
  const review = completeReview();
  assert.equal(review.confidence, 4);
  assert.equal(review.confidenceScale, "anchored-1-5");
  assert.equal(confidenceAnchor(92, "legacy-0-100"), 5);
  assert.equal(confidenceAnchor(60, "legacy-0-100"), 3);
  assert.equal(confidenceLabel(2), CONFIDENCE_ANCHORS[2]);
  assert.doesNotThrow(() => assertReview(review, { candidateIds: ["candidate-calibration-1", "candidate-calibration-2"] }));
  assert.throws(() => assertReview({ ...review, confidence: 6 }, { candidateIds: ["candidate-calibration-1", "candidate-calibration-2"] }), /Anchored confidence/);
});

test("preference disagreement is visible and requires a separate evidence note", () => {
  const disagreement = completeReview({ preference: "candidate-calibration-2" });
  assert.equal(isPreferenceDisagreement(disagreement), true);
  assert.equal(requiresPreferenceEvidence(disagreement), true);
  assert.throws(() => assertReview(disagreement, { candidateIds: ["candidate-calibration-1", "candidate-calibration-2"] }), /explicit evidence/);
  const explained = { ...disagreement, preferenceEvidence: "I preferred the second answer because it avoids the failure mode in the first answer." };
  assert.equal(requiresPreferenceEvidence(explained), false);
  assert.doesNotThrow(() => assertReview(explained, { candidateIds: ["candidate-calibration-1", "candidate-calibration-2"] }));
});

test("completed rubric can be locked and changes produce an unlocked clone", () => {
  const rubric = createRubric({ id: "rubric-calibration", name: "Calibration rubric", version: "1.0.0", dimensions: snapshot.dimensions }, { idFactory: () => "unused", now });
  const locked = lockRubric(rubric, now());
  assert.equal(locked.lockedAt, now());
  assert.equal(rubric.lockedAt, null);
  const clone = cloneRubricVersion(locked, { id: "rubric-calibration-v2", version: "2.0.0" });
  assert.equal(clone.id, "rubric-calibration-v2");
  assert.equal(clone.version, "2.0.0");
  assert.equal(clone.lockedAt, null);
  assert.notEqual(clone.checksum, locked.checksum);
});

test("calibration repeats are deterministic, bounded, and reverse display order", () => {
  const assignments = Array.from({ length: 20 }, (_, index) => createAssignment({
    id: `assignment-cal-${index}`,
    sessionId: "session-calibration",
    caseId: `case-cal-${index}`,
    displayOrder: ["candidate-calibration-1", "candidate-calibration-2"]
  }));
  const first = selectCalibrationRepeats(assignments, { seed: "session-seed", fraction: 0.1 });
  const second = selectCalibrationRepeats(assignments, { seed: "session-seed", fraction: 0.1 });
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  const repeat = createCalibrationRepeat(assignments.find(({ id }) => id === first[0]));
  assert.equal(repeat.calibration, true);
  assert.equal(repeat.repeatOf, first[0]);
  assert.deepEqual(repeat.displayOrder, ["candidate-calibration-2", "candidate-calibration-1"]);
});

test("calibration metrics compare preferences, ratings, and position switches", () => {
  const metrics = computeCalibrationMetrics([
    {
      original: { reviewerId: "reviewer-real", preference: "candidate-calibration-1", ratings: { "candidate-calibration-1": { quality: 5 }, "candidate-calibration-2": { quality: 2 } }, displayOrder: ["candidate-calibration-1", "candidate-calibration-2"] },
      repeat: { reviewerId: "reviewer-real", preference: "candidate-calibration-1", ratings: { "candidate-calibration-1": { quality: 4 }, "candidate-calibration-2": { quality: 2 } }, displayOrder: ["candidate-calibration-2", "candidate-calibration-1"] }
    },
    {
      original: { reviewerId: "reviewer-real", preference: "candidate-calibration-2", ratings: { "candidate-calibration-1": { quality: 3 }, "candidate-calibration-2": { quality: 4 } }, displayOrder: ["candidate-calibration-1", "candidate-calibration-2"] },
      repeat: { reviewerId: "reviewer-real", preference: "candidate-calibration-1", ratings: { "candidate-calibration-1": { quality: 3 }, "candidate-calibration-2": { quality: 5 } }, displayOrder: ["candidate-calibration-2", "candidate-calibration-1"] }
    }
  ]);
  assert.equal(metrics.repeats, 2);
  assert.equal(metrics.preference.agreements, 1);
  assert.equal(metrics.preference.compared, 2);
  assert.equal(metrics.preference.agreementRate, 0.5);
  assert.equal(metrics.ratingMeanAbsoluteDelta, 0.5);
  assert.equal(metrics.position.switchRate, 1);
  assert.equal(metrics.reviewerStats, null);
});
