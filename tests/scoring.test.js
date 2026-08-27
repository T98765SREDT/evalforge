import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUBRIC,
  calculateDimensionContributions,
  calculateWeightedScore,
  determineWinner,
  emptyRatings,
  formatScore,
  scoreTone,
  validateRubric
} from "../js/scoring.js";

test("default rubric weights total 100", () => {
  assert.equal(validateRubric(DEFAULT_RUBRIC), 100);
});

test("all excellent ratings produce a complete 100-point score", () => {
  const ratings = Object.fromEntries(DEFAULT_RUBRIC.map(({ id }) => [id, 5]));
  assert.deepEqual(calculateWeightedScore(ratings), {
    score: 100,
    completion: 100,
    completedDimensions: 5,
    totalDimensions: 5,
    isComplete: true
  });
});

test("weighted scoring respects each dimension's contribution", () => {
  const ratings = {
    accuracy: 5,
    relevance: 4,
    clarity: 3,
    completeness: 2,
    safety: 1
  };
  assert.equal(calculateWeightedScore(ratings).score, 65);
});

test("dimension contributions preserve the score evidence", () => {
  const ratings = {
    accuracy: 5,
    relevance: 4,
    clarity: 3,
    completeness: 2,
    safety: 1
  };
  const contributions = calculateDimensionContributions(ratings);
  assert.deepEqual(contributions, {
    accuracy: 30,
    relevance: 16,
    clarity: 9,
    completeness: 6,
    safety: 4
  });
  assert.equal(Object.values(contributions).reduce((sum, value) => sum + value, 0), 65);
});

test("partial ratings expose completion separately from score", () => {
  const ratings = { ...emptyRatings(), accuracy: 5 };
  assert.deepEqual(calculateWeightedScore(ratings), {
    score: 30,
    completion: 30,
    completedDimensions: 1,
    totalDimensions: 5,
    isComplete: false
  });
});

test("winner selection applies a configurable tie threshold", () => {
  assert.equal(determineWinner(91, 82), "A");
  assert.equal(determineWinner(68, 75), "B");
  assert.equal(determineWinner(80, 78), "tie");
  assert.equal(determineWinner(80, 78, 1), "A");
});

test("score display utilities clamp and categorize values", () => {
  assert.equal(formatScore(104.2), "100%");
  assert.equal(formatScore(-2), "0%");
  assert.equal(scoreTone(86), "excellent");
  assert.equal(scoreTone(72), "strong");
  assert.equal(scoreTone(54), "mixed");
  assert.equal(scoreTone(22), "weak");
});

test("invalid rubric definitions are rejected", () => {
  assert.throws(() => validateRubric([]), /at least one dimension/);
  assert.throws(() => validateRubric([{ id: "accuracy", weight: 0 }]), /positive weight/);
});
