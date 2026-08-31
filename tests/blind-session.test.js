import test from "node:test";
import assert from "node:assert/strict";
import { createCase } from "../js/domain/entities.js";
import {
  candidateIdAtPosition,
  createAssignmentForSession,
  createBlindDisplayDto,
  createDisplayDto,
  createSession,
  deriveDisplayOrder,
  isHistoricalNonBlind,
  persistedDisplayOrder,
  winnerCandidateId
} from "../js/domain/blind-session.js";

const now = () => "2026-08-29T14:00:00.000Z";
const caseValue = createCase({
  id: "case-blind-1",
  datasetId: "dataset-blind",
  externalId: "row-1",
  input: "Which answer handles the request better?",
  candidates: [
    { id: "candidate-alpha", content: "The first answer.", source: "model-alpha", metadata: { model: "alpha" } },
    { id: "candidate-beta", content: "The second answer.", source: "model-beta", metadata: { model: "beta" } }
  ]
});

function session(seed = "seed-a", blindMode = true) {
  return createSession({
    id: `session-${seed}`,
    datasetId: "dataset-blind",
    rubricRef: "rubric-general",
    reviewerId: "reviewer-1",
    blindMode,
    seed
  }, { now });
}

test("createSession requires explicit assignment-affecting fields", () => {
  assert.equal(session().datasetId, "dataset-blind");
  assert.equal(session().rubricRef, "rubric-general");
  assert.equal(session().blindMode, true);
  assert.throws(() => createSession({ id: "session-missing-seed", datasetId: "dataset-blind", rubricRef: "rubric-general", reviewerId: "reviewer-1", blindMode: true }, { now }), /session.seed/);
  assert.throws(() => createSession({ id: "session-missing-mode", datasetId: "dataset-blind", rubricRef: "rubric-general", reviewerId: "reviewer-1", seed: "x" }, { now }), /session.blindMode/);
});

test("display order is deterministic for a seed and changes for a new seed", () => {
  const first = deriveDisplayOrder(session("seed-a"), caseValue);
  assert.deepEqual(deriveDisplayOrder(session("seed-a"), caseValue), first);
  assert.notDeepEqual(deriveDisplayOrder(session("seed-b"), caseValue), first);
});

test("assignment persists order and refresh does not reshuffle it", () => {
  const originalSession = session("seed-a");
  const assignment = createAssignmentForSession({ session: originalSession, reviewCase: caseValue });
  const refreshedSession = { ...originalSession, seed: "a-different-seed" };
  assert.deepEqual(persistedDisplayOrder(assignment), assignment.displayOrder);
  assert.deepEqual(createAssignmentForSession({ session: refreshedSession, reviewCase: caseValue, displayOrder: assignment.displayOrder }).displayOrder, assignment.displayOrder);
  assert.equal(candidateIdAtPosition(assignment, 0), assignment.displayOrder[0]);
});

test("blind DTO exposes labels and content but no source/model metadata", () => {
  const currentSession = session("seed-a");
  const assignment = createAssignmentForSession({ session: currentSession, reviewCase: caseValue });
  const dto = createBlindDisplayDto(currentSession, assignment, caseValue);
  assert.equal(dto.blind, true);
  assert.deepEqual(Object.keys(dto.candidates[0]).sort(), ["content", "label"]);
  assert.match(dto.candidates[0].label, /^Candidate [12]$/);
  assert.equal("source" in dto.candidates[0], false);
  assert.equal("model" in dto.candidates[0], false);
  assert.equal("metadata" in dto.candidates[0], false);
  assert.doesNotMatch(JSON.stringify(dto), /model-alpha|model-beta/);
});

test("migrated non-blind assignments remain explicitly non-blind", () => {
  const migratedSession = session("migrated-v2-session", false);
  const assignment = createAssignmentForSession({ session: migratedSession, reviewCase: caseValue });
  const dto = createDisplayDto(migratedSession, assignment, caseValue);
  assert.equal(isHistoricalNonBlind(migratedSession), true);
  assert.equal(dto.blind, false);
  assert.equal(dto.candidates[0].source.startsWith("model-"), true);
  assert.throws(() => createBlindDisplayDto(migratedSession, assignment, caseValue), /non-blind/);
});

test("winner is tied to candidate ids rather than display position", () => {
  const scores = { "candidate-alpha": 92, "candidate-beta": 71 };
  assert.equal(winnerCandidateId(scores), "candidate-alpha");
  assert.equal(winnerCandidateId({ "candidate-beta": 71, "candidate-alpha": 92 }), "candidate-alpha");
  assert.equal(winnerCandidateId({ "candidate-alpha": 80, "candidate-beta": 81 }, 2), "tie");
});

test("assignment generation rejects an incomplete or foreign display order", () => {
  const currentSession = session();
  assert.throws(() => createAssignmentForSession({ session: currentSession, reviewCase: caseValue, displayOrder: ["candidate-alpha"] }), /every candidate/);
  assert.throws(() => createAssignmentForSession({ session: currentSession, reviewCase: caseValue, displayOrder: ["candidate-alpha", "candidate-unknown"] }), /every candidate/);
  assert.throws(() => createAssignmentForSession({ session: currentSession, reviewCase: { ...caseValue, datasetId: "dataset-other" } }), /datasetId/);
});
