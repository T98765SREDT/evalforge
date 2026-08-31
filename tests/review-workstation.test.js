import test from "node:test";
import assert from "node:assert/strict";
import {
  beginWorkstationSave,
  completeWorkstationAssignment,
  completeWorkstationSession,
  createAutosaveController,
  createReviewWorkstationState,
  hasUnsavedWork,
  markWorkstationDirty,
  nextPendingAssignment,
  revealWorkstationSession,
  serializeDraft,
  skipWorkstationAssignment,
  startWorkstationSession,
  workstationSaveConflicted,
  workstationSaveFailed,
  workstationSaveSucceeded
} from "../js/ui/review-workstation.js";
import { createSessionHeaderModel, saveStateTone, sessionProgress } from "../js/ui/session-header.js";

test("workstation save state has explicit dirty, saving, saved, error, and conflict transitions", () => {
  let state = createReviewWorkstationState({ assignmentId: "assignment-1", totalAssignments: 2 });
  state = markWorkstationDirty(state);
  assert.equal(state.saveState, "dirty");
  state = beginWorkstationSave(state);
  assert.equal(state.saveState, "saving");
  state = workstationSaveSucceeded(state, 2);
  assert.equal(state.saveState, "saved");
  assert.equal(state.expectedRevision, 2);
  state = workstationSaveFailed(state, "Quota exceeded");
  assert.equal(state.lastError, "Quota exceeded");
  state = workstationSaveConflicted(state, 3);
  assert.equal(state.saveState, "conflict");
  assert.equal(state.conflictRevision, 3);
  assert.equal(hasUnsavedWork(state), true);
});

test("session and assignment transitions keep completion explicit", () => {
  let state = createReviewWorkstationState({ sessionState: "planned", assignmentState: "pending" });
  state = startWorkstationSession(state);
  assert.deepEqual({ session: state.sessionState, assignment: state.assignmentState }, { session: "active", assignment: "in_progress" });
  state = completeWorkstationAssignment(state);
  assert.equal(state.assignmentState, "complete");
  state = completeWorkstationSession(state, [{ state: "complete" }, { state: "skipped" }]);
  assert.equal(state.sessionState, "completed");
  assert.equal(revealWorkstationSession(state).sessionState, "revealed");
});

test("skip requires a reason and next assignment wraps around", () => {
  const state = createReviewWorkstationState({ assignmentState: "in_progress" });
  assert.throws(() => skipWorkstationAssignment(state, ""), /skipReason/);
  assert.equal(skipWorkstationAssignment(state, "Needs a different rubric.").skipReason, "Needs a different rubric.");
  const assignments = [{ id: "a", state: "complete" }, { id: "b", state: "pending" }, { id: "c", state: "in_progress" }];
  assert.equal(nextPendingAssignment(assignments, "c"), "b");
  assert.equal(nextPendingAssignment(assignments, "b"), "c");
  assert.equal(nextPendingAssignment(assignments, "c"), "b");
});

test("draft serialization is explicit and autosave keeps only the latest draft", () => {
  const text = serializeDraft({ assignmentId: "assignment-1", notes: "Draft evidence" });
  assert.match(text, /"schemaVersion": 1/);
  assert.match(text, /Draft evidence/);
  const saved = [];
  const autosave = createAutosaveController({ delayMs: 100, onSave: (draft) => saved.push(draft) });
  autosave.schedule({ value: 1 });
  autosave.schedule({ value: 2 });
  assert.equal(autosave.flush(), true);
  assert.deepEqual(saved, [{ value: 2 }]);
  assert.equal(autosave.pending, false);
});

test("session header exposes progress, blind indicator, and save tone", () => {
  const assignments = [{ state: "complete" }, { state: "skipped" }, { state: "pending" }, { state: "in_progress" }];
  assert.deepEqual(sessionProgress(assignments), { total: 4, pending: 1, inProgress: 1, completed: 1, skipped: 1, finished: 2, percent: 50 });
  const header = createSessionHeaderModel({ session: { id: "session-1", name: "Support batch", state: "active", blindMode: true }, assignments, saveState: "saved", assignmentIndex: 2 });
  assert.equal(header.blindLabel, "Blind review");
  assert.equal(header.positionLabel, "3 of 4");
  assert.equal(header.progress.percent, 50);
  assert.equal(header.canCompleteSession, false);
  assert.equal(saveStateTone("error"), "attention");
});
