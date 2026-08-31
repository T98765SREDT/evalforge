export const SAVE_STATE_LABELS = Object.freeze({
  clean: "Ready",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved locally",
  error: "Save failed",
  conflict: "Review conflict"
});

export const SESSION_STATE_LABELS = Object.freeze({
  planned: "Planned",
  active: "In progress",
  completed: "Complete",
  revealed: "Revealed"
});

function countAssignments(assignments) {
  const counts = { total: 0, pending: 0, inProgress: 0, completed: 0, skipped: 0 };
  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    counts.total += 1;
    if (assignment?.state === "pending") counts.pending += 1;
    if (assignment?.state === "in_progress") counts.inProgress += 1;
    if (assignment?.state === "complete") counts.completed += 1;
    if (assignment?.state === "skipped") counts.skipped += 1;
  }
  return counts;
}

export function sessionProgress(assignments = []) {
  const counts = countAssignments(assignments);
  const finished = counts.completed + counts.skipped;
  return { ...counts, finished, percent: counts.total ? Math.round((finished / counts.total) * 100) : 0 };
}

export function createSessionHeaderModel({ session = {}, assignments = [], saveState = "clean", assignmentIndex = 0 } = {}) {
  const progress = sessionProgress(assignments);
  const total = progress.total;
  const safeIndex = total ? Math.min(Math.max(assignmentIndex, 0), total - 1) : 0;
  return {
    sessionId: session.id || null,
    title: session.name || "Review workstation",
    state: session.state || "planned",
    stateLabel: SESSION_STATE_LABELS[session.state] || SESSION_STATE_LABELS.planned,
    blind: session.blindMode === true,
    blindLabel: session.blindMode === true ? "Blind review" : "Standard review",
    saveState,
    saveLabel: SAVE_STATE_LABELS[saveState] || SAVE_STATE_LABELS.clean,
    progress,
    positionLabel: total ? `${safeIndex + 1} of ${total}` : "No assignments",
    canCompleteSession: session.state === "active" && progress.total > 0 && progress.pending === 0 && progress.inProgress === 0,
    canReveal: session.state === "completed"
  };
}

export function saveStateTone(saveState) {
  return ["error", "conflict"].includes(saveState) ? "attention" : saveState === "saved" ? "positive" : "neutral";
}
