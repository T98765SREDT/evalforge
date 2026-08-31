import test from "node:test";
import assert from "node:assert/strict";
import { createCase, createRubric } from "../js/domain/entities.js";
import {
  buildV3ReviewInput,
  createEmptyV3Draft,
  normalizeV3Draft
} from "../js/ui/v3-review.js";

const reviewCase = createCase({
  id: "case-review-1",
  datasetId: "dataset-review",
  externalId: "row-1",
  input: "Choose the more useful answer.",
  candidates: [
    { id: "candidate-review-a", content: "Answer one.", source: "model-a" },
    { id: "candidate-review-b", content: "Answer two.", source: "model-b" }
  ]
});

const rubric = createRubric({
  id: "rubric-review",
  name: "Small rubric",
  version: "1.0.0",
  tieThreshold: 2,
  dimensions: [
    { id: "accuracy", label: "Accuracy", description: "Correctness", weight: 60, anchors: { 1: "Low", 3: "Adequate", 5: "High" } },
    { id: "clarity", label: "Clarity", description: "Readable", weight: 40, anchors: { 1: "Low", 3: "Adequate", 5: "High" } }
  ]
});

test("empty v3 draft uses candidate identities internally and zero ratings", () => {
  const draft = createEmptyV3Draft(reviewCase, rubric);
  assert.deepEqual(Object.keys(draft.ratings), ["candidate-review-a", "candidate-review-b"]);
  assert.deepEqual(draft.ratings["candidate-review-a"], { accuracy: 0, clarity: 0 });
  assert.equal(draft.preference, "pending");
});

test("v3 review input calculates candidate-id scores and blocks incomplete completion", () => {
  const draft = createEmptyV3Draft(reviewCase, rubric);
  const input = buildV3ReviewInput(reviewCase, rubric, draft);
  assert.equal(input.computed.winner, "pending");
  assert.equal(input.ready, false);
  assert.match(input.missing[0], /Rate every dimension/);
  const complete = buildV3ReviewInput(reviewCase, rubric, {
    ratings: {
      "candidate-review-a": { accuracy: 5, clarity: 5 },
      "candidate-review-b": { accuracy: 3, clarity: 3 }
    },
    preference: "candidate-review-a",
    confidence: 4,
    rationale: "Candidate one is more accurate and clearer for the stated request."
  });
  assert.equal(complete.ready, true);
  assert.equal(complete.computed.winner, "candidate-review-a");
  assert.equal(complete.computed.scoreByCandidate["candidate-review-a"], 100);
  assert.equal(complete.computed.scoreByCandidate["candidate-review-b"], 60);
  assert.equal(complete.rubricSnapshot.scoringAlgorithmVersion, "weighted-ratings-v1");
});

test("draft normalization ignores invalid ratings and unsupported preferences", () => {
  const draft = normalizeV3Draft(reviewCase, rubric, {
    ratings: { "candidate-review-a": { accuracy: 9, clarity: 4 } },
    preference: "candidate-unknown",
    confidence: 99,
    rationale: 42
  });
  assert.equal(draft.ratings["candidate-review-a"].accuracy, 0);
  assert.equal(draft.ratings["candidate-review-a"].clarity, 4);
  assert.equal(draft.preference, "pending");
  assert.equal(draft.confidence, 3);
  assert.equal(draft.rationale, "");
});

test("preference disagreement requires explicit evidence before completion", () => {
  const input = buildV3ReviewInput(reviewCase, rubric, {
    ratings: {
      "candidate-review-a": { accuracy: 5, clarity: 5 },
      "candidate-review-b": { accuracy: 3, clarity: 3 }
    },
    preference: "candidate-review-b",
    confidence: 4,
    rationale: "The second answer better matches the user's communication style."
  });
  assert.equal(input.computed.winner, "candidate-review-a");
  assert.equal(input.ready, false);
  assert.match(input.missing.at(-1), /preference differs/);

  const withEvidence = buildV3ReviewInput(reviewCase, rubric, {
    ...input,
    preferenceEvidence: "Although the score favors the first answer, the second better matches the requested tone."
  });
  assert.equal(withEvidence.ready, true);
});
