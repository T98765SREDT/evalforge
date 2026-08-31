import {
  createAssignmentForSession,
  createBlindDisplayDto,
  createSession
} from "../domain/blind-session.js";
import { assertWorkspaceDocument } from "../domain/entities.js";

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required.`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object.`);
  return value;
}

function orderedCases(document, datasetId) {
  return document.cases
    .filter((reviewCase) => reviewCase.datasetId === datasetId)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Return only the information needed to populate a session picker. The
 * picker deliberately does not expose case text or candidate metadata.
 */
export function v3DatasetOptions(document) {
  const value = object(document, "document");
  return value.datasets
    .map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      description: dataset.description || "",
      rubricRef: dataset.rubricRef,
      isDemo: dataset.isDemo === true,
      caseCount: value.cases.filter((reviewCase) => reviewCase.datasetId === dataset.id).length
    }))
    .filter((dataset) => dataset.caseCount > 0)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/**
 * Build a complete, reproducible blind session without writing anything.
 * The caller persists the returned session and assignments in one transaction.
 */
export function createV3SessionPlan(document, {
  datasetId,
  reviewerId = "local-reviewer",
  seed,
  now,
  idFactory
} = {}) {
  const value = object(document, "document");
  const validation = assertWorkspaceDocument(value);
  const selectedDatasetId = requiredText(datasetId, "datasetId");
  const dataset = value.datasets.find((candidate) => candidate.id === selectedDatasetId);
  if (!dataset) throw new RangeError(`Dataset ${selectedDatasetId} was not found.`);
  const rubric = value.rubrics.find((candidate) => candidate.id === dataset.rubricRef);
  if (!rubric) throw new RangeError(`Rubric ${dataset.rubricRef} was not found.`);
  const cases = orderedCases(value, selectedDatasetId);
  if (!cases.length) throw new RangeError("The selected dataset has no review cases.");
  const session = createSession({
    datasetId: dataset.id,
    rubricRef: rubric.id,
    reviewerId: requiredText(reviewerId, "reviewerId"),
    seed: requiredText(seed, "seed"),
    blindMode: true,
    state: "active"
  }, { now, idFactory });
  const assignments = cases.map((reviewCase) => createAssignmentForSession({ session, reviewCase }, { now, idFactory }));
  return { session, assignments, cases, dataset, rubric, sourceSchemaVersion: validation ? value.schemaVersion : null };
}

/**
 * Restore the newest persisted blind session from a validated document. The browser
 * keeps the currently selected session in memory, so a refresh would
 * otherwise make a persisted session look lost. This helper only assembles a
 * view-model; it never mutates the document or storage.
 */
export function restoreV3SessionState(document, { sessionId = null } = {}) {
  const value = object(document, "document");
  assertWorkspaceDocument(value);
  const sessions = value.sessions
    .filter((session) => session.blindMode === true && (sessionId ? session.id === sessionId : ["active", "completed", "revealed"].includes(session.state)))
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  for (const session of sessions) {
    const assignments = value.assignments
      .filter((assignment) => assignment.sessionId === session.id)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!assignments.length) continue;
    const cases = value.cases.filter((reviewCase) => assignments.some((assignment) => assignment.caseId === reviewCase.id));
    if (cases.length !== assignments.length) continue;
    const dataset = value.datasets.find((candidate) => candidate.id === session.datasetId);
    const rubric = value.rubrics.find((candidate) => candidate.id === session.rubricRef);
    if (!dataset || !rubric) continue;
    const reviewById = new Map(value.reviews.map((review) => [review.id, review]));
    const reviews = assignments
      .map((assignment) => {
        if (assignment.reviewId && reviewById.has(assignment.reviewId)) return reviewById.get(assignment.reviewId);
        return value.reviews
          .filter((review) => review.assignmentId === assignment.id)
          .sort((left, right) => right.revision - left.revision || right.updatedAt.localeCompare(left.updatedAt))[0] || null;
      })
      .filter(Boolean);
    const revisions = Object.fromEntries(reviews.map((review) => [review.assignmentId, review.revision]));
    const firstOpen = assignments.findIndex((assignment) => !["complete", "skipped"].includes(assignment.state));
    return {
      session,
      assignments,
      cases,
      dataset,
      rubric,
      reviews,
      revisions,
      currentIndex: firstOpen >= 0 ? firstOpen : 0,
      resumed: true,
      sourceSchemaVersion: value.schemaVersion
    };
  }
  return null;
}

function boundedIndex(index, total) {
  if (!total) return 0;
  const numeric = Number.isInteger(index) ? index : 0;
  return Math.min(Math.max(numeric, 0), total - 1);
}

/**
 * Convert a persisted assignment into the safe reviewer projection. This is
 * the only object the browser renderer should use for blind candidate text.
 */
export function createV3AssignmentView({ session, assignments, cases, index = 0 } = {}) {
  const sessionValue = object(session, "session");
  const assignmentValues = Array.isArray(assignments) ? assignments : [];
  const caseValues = Array.isArray(cases) ? cases : [];
  const position = boundedIndex(index, assignmentValues.length);
  const assignment = assignmentValues[position];
  if (!assignment) return { empty: true, position: 0, total: 0, view: null };
  const reviewCase = caseValues.find((candidate) => candidate.id === assignment.caseId);
  if (!reviewCase) throw new RangeError(`Case ${assignment.caseId} was not found.`);
  const view = createBlindDisplayDto(sessionValue, assignment, reviewCase);
  return {
    empty: false,
    position,
    total: assignmentValues.length,
    assignmentState: assignment.state,
    assignmentId: assignment.id,
    caseId: reviewCase.id,
    view
  };
}

export function nextV3AssignmentIndex(assignments, index, direction = 1) {
  const total = Array.isArray(assignments) ? assignments.length : 0;
  if (!total) return 0;
  const step = direction < 0 ? -1 : 1;
  return (boundedIndex(index, total) + step + total) % total;
}
