export const SAVE_STATES = Object.freeze(["clean", "dirty", "saving", "saved", "error", "conflict"]);
export const SESSION_STATES = Object.freeze(["planned", "active", "completed", "revealed"]);
export const ASSIGNMENT_STATES = Object.freeze(["pending", "in_progress", "complete", "skipped"]);

const FINISHED_ASSIGNMENTS = new Set(["complete", "skipped"]);

function nonEmpty(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string.`);
  return value.trim();
}

function stateIn(value, allowed, field) {
  const normalized = value || allowed[0];
  if (!allowed.includes(normalized)) throw new TypeError(`${field} is not supported.`);
  return normalized;
}

function assignmentState(value) {
  return stateIn(value, ASSIGNMENT_STATES, "assignmentState");
}

export function createReviewWorkstationState(input = {}) {
  const state = {
    saveState: stateIn(input.saveState, SAVE_STATES, "saveState"),
    sessionState: stateIn(input.sessionState, SESSION_STATES, "sessionState"),
    assignmentState: assignmentState(input.assignmentState),
    assignmentId: input.assignmentId ? nonEmpty(input.assignmentId, "assignmentId") : null,
    assignmentIndex: Number.isInteger(input.assignmentIndex) && input.assignmentIndex >= 0 ? input.assignmentIndex : 0,
    totalAssignments: Number.isInteger(input.totalAssignments) && input.totalAssignments >= 0 ? input.totalAssignments : 0,
    expectedRevision: Number.isInteger(input.expectedRevision) && input.expectedRevision >= 0 ? input.expectedRevision : 0,
    conflictRevision: input.conflictRevision ?? null,
    skipReason: input.skipReason || "",
    lastError: input.lastError || null
  };
  if (state.assignmentIndex >= state.totalAssignments && state.totalAssignments > 0) {
    state.assignmentIndex = state.totalAssignments - 1;
  }
  return state;
}

function update(state, patch) {
  return createReviewWorkstationState({ ...state, ...patch });
}

export function markWorkstationDirty(state) {
  return update(state, { saveState: "dirty", lastError: null, conflictRevision: null });
}

export function beginWorkstationSave(state) {
  if (!["dirty", "error", "conflict", "clean"].includes(state.saveState)) return state;
  return update(state, { saveState: "saving", lastError: null });
}

export function workstationSaveSucceeded(state, revision = null) {
  return update(state, {
    saveState: "saved",
    expectedRevision: Number.isInteger(revision) && revision >= 0 ? revision : state.expectedRevision,
    conflictRevision: null,
    lastError: null
  });
}

export function workstationSaveFailed(state, error = "The local save failed.") {
  return update(state, { saveState: "error", lastError: String(error || "The local save failed.") });
}

export function workstationSaveConflicted(state, currentRevision) {
  if (!Number.isInteger(currentRevision) || currentRevision < 0) throw new TypeError("currentRevision must be a non-negative integer.");
  return update(state, { saveState: "conflict", conflictRevision: currentRevision, lastError: "A newer draft exists." });
}

export function startWorkstationSession(state) {
  if (state.sessionState === "revealed" || state.sessionState === "completed") return state;
  return update(state, { sessionState: "active", assignmentState: state.assignmentState === "pending" ? "in_progress" : state.assignmentState });
}

export function completeWorkstationAssignment(state) {
  if (!["pending", "in_progress"].includes(state.assignmentState)) throw new Error("Only a pending or in-progress assignment can be completed.");
  return update(state, { assignmentState: "complete", saveState: "saved" });
}

export function skipWorkstationAssignment(state, reason) {
  const cleanReason = nonEmpty(reason, "skipReason");
  if (FINISHED_ASSIGNMENTS.has(state.assignmentState)) throw new Error("A finished assignment cannot be skipped.");
  return update(state, { assignmentState: "skipped", skipReason: cleanReason, saveState: "saved" });
}

export function completeWorkstationSession(state, assignments = []) {
  if (state.sessionState !== "active") throw new Error("Only an active session can be completed.");
  if (assignments.some((assignment) => !FINISHED_ASSIGNMENTS.has(assignmentState(assignment?.state)))) {
    throw new Error("Every assignment must be complete or skipped before the session can be completed.");
  }
  return update(state, { sessionState: "completed" });
}

export function revealWorkstationSession(state) {
  if (state.sessionState !== "completed") throw new Error("Only a completed session can be revealed.");
  return update(state, { sessionState: "revealed" });
}

export function nextPendingAssignment(assignments = [], currentAssignmentId = null) {
  if (!Array.isArray(assignments)) throw new TypeError("assignments must be an array.");
  const currentIndex = currentAssignmentId ? assignments.findIndex((item) => item?.id === currentAssignmentId) : -1;
  const ordered = currentIndex >= 0 ? [...assignments.slice(currentIndex + 1), ...assignments.slice(0, currentIndex + 1)] : assignments;
  const next = ordered.find((item) => ["pending", "in_progress"].includes(item?.state));
  return next?.id || null;
}

export function hasUnsavedWork(state) {
  return ["dirty", "saving", "error", "conflict"].includes(state.saveState);
}

export function serializeDraft(draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new TypeError("draft must be an object.");
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), draft }, null, 2);
}

/**
 * Small bounded debounce helper used by the UI. The callback receives the
 * latest draft only once after the user pauses; flush() is useful for tests and
 * for an explicit Save action.
 */
export function createAutosaveController({ delayMs = 700, onSave } = {}) {
  if (!Number.isFinite(delayMs) || delayMs < 100 || delayMs > 5000) throw new TypeError("delayMs must be between 100 and 5000 milliseconds.");
  if (typeof onSave !== "function") throw new TypeError("onSave must be a function.");
  let timer = null;
  let pending = undefined;

  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending === undefined) return false;
    const draft = pending;
    pending = undefined;
    onSave(draft);
    return true;
  }

  return {
    schedule(draft) {
      pending = draft;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = undefined;
    },
    get pending() { return pending !== undefined; }
  };
}
