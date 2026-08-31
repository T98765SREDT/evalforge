import { assertAssignment, assertReview, createAuditEvent, createReview } from "./entities.js";
import { deterministicId, requireClock } from "./ids.js";
import { RepositoryConflictError, RepositoryError, assertRepositoryContract, clone } from "../persistence/repository.js";

const DEFAULT_ACTOR_ID = "local-reviewer";

export class ReviewUseCaseError extends RepositoryError {
  constructor(message, details = {}) { super(message, details); this.name = "ReviewUseCaseError"; }
}

function setup(repository, options = {}) {
  assertRepositoryContract(repository);
  const now = requireClock(options.now);
  const actorId = options.actorId || DEFAULT_ACTOR_ID;
  return { now, actorId };
}

function requireAssignment(transaction, assignmentId) {
  const assignment = transaction.get("assignments", assignmentId);
  if (!assignment) throw new ReviewUseCaseError(`Assignment ${assignmentId} was not found.`, { code: "not_found", store: "assignments", id: assignmentId });
  return assignment;
}

function requireCase(transaction, assignment) {
  const reviewCase = transaction.get("cases", assignment.caseId);
  if (!reviewCase) throw new ReviewUseCaseError(`Case ${assignment.caseId} was not found.`, { code: "not_found", store: "cases", id: assignment.caseId });
  return reviewCase;
}

function candidateIds(reviewCase) { return reviewCase.candidates.map((candidate) => candidate.id); }

function currentReview(transaction, assignment) {
  return assignment.reviewId ? transaction.get("reviews", assignment.reviewId) : null;
}

function checkRevision(existing, expectedRevision) {
  const current = existing?.revision || 0;
  const expected = expectedRevision ?? current;
  if (expected !== current) throw new RepositoryConflictError(`This review is stale. Expected revision ${expected}, current revision is ${current}.`, { code: "stale_revision", expectedRevision: expected, actualRevision: current, id: existing?.id || null, store: "reviews" });
  return current;
}

function draftReview(input, existing, assignmentId, revision, timestamp) {
  return createReview({
    ...(existing || {}),
    ...(input || {}),
    id: input?.id || existing?.id || deterministicId("review", { assignmentId, revision }),
    assignmentId,
    revision,
    state: "draft",
    createdAt: existing?.createdAt || input?.createdAt || timestamp,
    updatedAt: timestamp,
    completedAt: null
  });
}

function completeReviewRecord(input, existing, assignmentId, revision, timestamp) {
  return createReview({
    ...(existing || {}),
    ...(input || {}),
    id: input?.id || existing?.id || deterministicId("review", { assignmentId, revision }),
    assignmentId,
    revision,
    supersedesReviewId: input?.supersedesReviewId ?? null,
    state: "complete",
    createdAt: existing?.createdAt || input?.createdAt || timestamp,
    updatedAt: timestamp,
    completedAt: input?.completedAt || timestamp
  });
}

function writeAudit(transaction, { id, entityType, entityId, action, actorId, at, details }) {
  const existing = transaction.get("auditEvents", id);
  if (existing) throw new RepositoryConflictError(`Audit event ${id} already exists.`, { code: "duplicate_audit", store: "auditEvents", id });
  return transaction.put("auditEvents", createAuditEvent({ id, entityType: entityType || (entityId.startsWith("assignment-") ? "assignment" : "review"), entityId, action, actorId, at, details }, { idFactory: () => id, now: () => at }));
}

function lockRubricForAssignment(transaction, assignment, { actorId, at }) {
  const session = transaction.get("sessions", assignment.sessionId);
  if (!session?.rubricRef) return null;
  const rubric = transaction.get("rubrics", session.rubricRef);
  if (!rubric || rubric.lockedAt) return null;
  const lockedRubric = { ...rubric, lockedAt: at };
  transaction.put("rubrics", lockedRubric);
  const auditEvent = writeAudit(transaction, {
    id: deterministicId("audit", { rubricId: rubric.id, assignmentId: assignment.id, action: "locked" }),
    entityType: "rubric",
    entityId: rubric.id,
    action: "rubric_locked",
    actorId,
    at,
    details: { assignmentId: assignment.id, sessionId: session.id, rubricVersion: rubric.version }
  });
  return { rubric: lockedRubric, auditEvent };
}

export function startAssignment(repository, { assignmentId, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction((transaction) => {
    const assignment = requireAssignment(transaction, assignmentId);
    if (assignment.state === "complete" || assignment.state === "skipped") throw new ReviewUseCaseError(`Cannot start an ${assignment.state} assignment.`, { code: "illegal_transition", store: "assignments", id: assignmentId });
    if (assignment.state === "in_progress") return { assignment, changed: false, auditEvent: null };
    const next = { ...assignment, state: "in_progress" };
    transaction.put("assignments", next);
    const event = writeAudit(transaction, { id: deterministicId("audit", { assignmentId, action: "started" }), entityId: assignmentId, action: "assignment_started", actorId: setupOptions.actorId, at: setupOptions.now, details: {} });
    return { assignment: next, changed: true, auditEvent: event };
  });
}

export function saveDraft(repository, { assignmentId, review = {}, expectedRevision, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction((transaction) => {
    const assignment = requireAssignment(transaction, assignmentId);
    if (["complete", "skipped"].includes(assignment.state)) throw new ReviewUseCaseError(`Cannot save a draft for an ${assignment.state} assignment.`, { code: "illegal_transition", store: "assignments", id: assignmentId });
    const reviewCase = requireCase(transaction, assignment);
    const existing = currentReview(transaction, assignment);
    const currentRevision = checkRevision(existing, expectedRevision);
    const nextReview = draftReview(review, existing, assignmentId, currentRevision + 1, setupOptions.now);
    assertReview(nextReview, { candidateIds: candidateIds(reviewCase) });
    transaction.put("reviews", nextReview);
    const nextAssignment = assignment.reviewId ? assignment : { ...assignment, reviewId: nextReview.id };
    if (!assignment.reviewId) transaction.put("assignments", nextAssignment);
    return { review: nextReview, assignment: nextAssignment, changed: true };
  });
}

function sameCompletion(left, right) {
  if (!left || !right) return false;
  const scale = (review) => review.confidenceScale || (Number.isFinite(review.confidence) && review.confidence > 5 ? "legacy-0-100" : "anchored-1-5");
  return JSON.stringify({ ratings: left.ratings, computed: left.computed, preference: left.preference, confidence: left.confidence, confidenceScale: scale(left), preferenceEvidence: left.preferenceEvidence || "", rationale: left.rationale, issueLabels: left.issueLabels, rubricSnapshot: left.rubricSnapshot })
    === JSON.stringify({ ratings: right.ratings, computed: right.computed, preference: right.preference, confidence: right.confidence, confidenceScale: scale(right), preferenceEvidence: right.preferenceEvidence || "", rationale: right.rationale, issueLabels: right.issueLabels, rubricSnapshot: right.rubricSnapshot });
}

export function completeReview(repository, { assignmentId, review = {}, expectedRevision, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction((transaction) => {
    const assignment = requireAssignment(transaction, assignmentId);
    const existing = currentReview(transaction, assignment);
    if (assignment.state === "complete") {
      if (sameCompletion(review, existing) || (!Object.keys(review).length && existing)) return { review: clone(existing), assignment, auditEvent: null, duplicate: true };
      throw new RepositoryConflictError("This assignment is already complete and cannot be overwritten.", { code: "duplicate_complete", store: "assignments", id: assignmentId });
    }
    if (assignment.state === "skipped") throw new ReviewUseCaseError("A skipped assignment cannot be completed.", { code: "illegal_transition", store: "assignments", id: assignmentId });
    const reviewCase = requireCase(transaction, assignment);
    const currentRevision = checkRevision(existing, expectedRevision);
    const nextReview = completeReviewRecord(review, existing, assignmentId, currentRevision + 1, setupOptions.now);
    assertReview(nextReview, { candidateIds: candidateIds(reviewCase) });
    const nextAssignment = { ...assignment, state: "complete", reviewId: nextReview.id, skipReason: null };
    transaction.put("reviews", nextReview);
    transaction.put("assignments", nextAssignment);
    const event = writeAudit(transaction, { id: deterministicId("audit", { reviewId: nextReview.id, revision: nextReview.revision, action: "completed" }), entityId: nextReview.id, action: "review_completed", actorId: setupOptions.actorId, at: setupOptions.now, details: { assignmentId, revision: nextReview.revision } });
    const locked = lockRubricForAssignment(transaction, assignment, { actorId: setupOptions.actorId, at: setupOptions.now });
    return { review: nextReview, assignment: nextAssignment, auditEvent: event, rubric: locked?.rubric || null, rubricAuditEvent: locked?.auditEvent || null, duplicate: false };
  });
}

export function skipAssignment(repository, { assignmentId, reason = "", now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (!cleanReason) throw new ReviewUseCaseError("Skipping an assignment requires a reason.", { code: "missing_skip_reason", store: "assignments", id: assignmentId });
  return repository.transaction((transaction) => {
    const assignment = requireAssignment(transaction, assignmentId);
    if (assignment.state === "complete") throw new ReviewUseCaseError("A complete assignment cannot be skipped.", { code: "illegal_transition", store: "assignments", id: assignmentId });
    if (assignment.state === "skipped") {
      if (assignment.skipReason === cleanReason) return { assignment, auditEvent: null, duplicate: true };
      throw new RepositoryConflictError("This assignment is already skipped with a different reason.", { code: "duplicate_skip", store: "assignments", id: assignmentId });
    }
    const next = { ...assignment, state: "skipped", skipReason: cleanReason };
    transaction.put("assignments", next);
    const event = writeAudit(transaction, { id: deterministicId("audit", { assignmentId, action: "skipped" }), entityId: assignmentId, action: "assignment_skipped", actorId: setupOptions.actorId, at: setupOptions.now, details: { reason: cleanReason } });
    return { assignment: next, auditEvent: event, duplicate: false };
  });
}

export function reviseCompletedReview(repository, { assignmentId, review = {}, expectedRevision, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction((transaction) => {
    const assignment = requireAssignment(transaction, assignmentId);
    if (assignment.state !== "complete") throw new ReviewUseCaseError("Only a complete assignment can be revised.", { code: "illegal_transition", store: "assignments", id: assignmentId });
    const existing = currentReview(transaction, assignment);
    const reviewCase = requireCase(transaction, assignment);
    const currentRevision = checkRevision(existing, expectedRevision);
    const nextReview = completeReviewRecord({ ...review, id: deterministicId("review", { assignmentId, revision: currentRevision + 1 }), supersedesReviewId: existing.id }, existing, assignmentId, currentRevision + 1, setupOptions.now);
    assertReview(nextReview, { candidateIds: candidateIds(reviewCase) });
    const nextAssignment = { ...assignment, reviewId: nextReview.id };
    transaction.put("reviews", nextReview);
    transaction.put("assignments", nextAssignment);
    const event = writeAudit(transaction, { id: deterministicId("audit", { reviewId: nextReview.id, revision: nextReview.revision, action: "revised" }), entityId: nextReview.id, action: "review_revised", actorId: setupOptions.actorId, at: setupOptions.now, details: { assignmentId, previousReviewId: existing.id, revision: nextReview.revision } });
    return { review: nextReview, previousReview: existing, assignment: nextAssignment, auditEvent: event };
  });
}
