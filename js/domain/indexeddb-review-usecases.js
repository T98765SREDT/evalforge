import { assertReview, createAuditEvent, createReview } from "./entities.js";
import { deterministicId, requireClock } from "./ids.js";
import { RepositoryConflictError, RepositoryError, assertRepositoryContract, clone } from "../persistence/repository.js";

const DEFAULT_ACTOR_ID = "local-reviewer";

export class IndexedDbReviewError extends RepositoryError {
  constructor(message, details = {}) { super(message, details); this.name = "IndexedDbReviewError"; }
}

function setup(repository, { now, actorId = DEFAULT_ACTOR_ID } = {}) {
  assertRepositoryContract(repository);
  return { now: requireClock(now), actorId: actorId || DEFAULT_ACTOR_ID };
}

async function assignmentFor(transaction, assignmentId) {
  const assignment = await transaction.get("assignments", assignmentId);
  if (!assignment) throw new IndexedDbReviewError(`Assignment ${assignmentId} was not found.`, { code: "not_found", store: "assignments", id: assignmentId });
  return assignment;
}

async function sessionFor(transaction, sessionId) {
  const session = await transaction.get("sessions", sessionId);
  if (!session) throw new IndexedDbReviewError(`Session ${sessionId} was not found.`, { code: "not_found", store: "sessions", id: sessionId });
  return session;
}

async function reviewCaseFor(transaction, assignment) {
  const reviewCase = await transaction.get("cases", assignment.caseId);
  if (!reviewCase) throw new IndexedDbReviewError(`Case ${assignment.caseId} was not found.`, { code: "not_found", store: "cases", id: assignment.caseId });
  return reviewCase;
}

async function currentReviewFor(transaction, assignment) {
  return assignment.reviewId ? transaction.get("reviews", assignment.reviewId) : null;
}

/**
 * A completed assignment is only a valid session result when its current
 * review record is present and complete. Cross-store references can still be
 * damaged by an interrupted import, manual storage edits, or an older client,
 * so enforce the relationship at the session boundary.
 */
function assertCompletedAssignmentRecords(assignments, reviews) {
  const reviewById = new Map(reviews.map((review) => [review?.id, review]).filter(([id]) => typeof id === "string" && id));
  for (const assignment of assignments.filter((item) => item.state === "complete")) {
    const review = assignment.reviewId ? reviewById.get(assignment.reviewId) : null;
    if (!assignment.reviewId) {
      throw new IndexedDbReviewError(`Completed assignment ${assignment.id} has no review record.`, { code: "invalid_session_records", store: "assignments", id: assignment.id });
    }
    if (!review) {
      throw new IndexedDbReviewError(`Completed assignment ${assignment.id} references a missing review.`, { code: "invalid_session_records", store: "reviews", id: assignment.reviewId });
    }
    if (review.assignmentId !== assignment.id || review.state !== "complete") {
      throw new IndexedDbReviewError(`Completed assignment ${assignment.id} must reference its own complete review.`, { code: "invalid_session_records", store: "reviews", id: review.id });
    }
  }
}

function revisionFor(existing, expectedRevision) {
  const current = existing?.revision || 0;
  const expected = expectedRevision ?? current;
  if (expected !== current) throw new RepositoryConflictError(`This review is stale. Expected revision ${expected}, current revision is ${current}.`, { code: "stale_revision", expectedRevision: expected, actualRevision: current, id: existing?.id || null, store: "reviews" });
  return current;
}

function reviewRecord(input, existing, assignmentId, revision, timestamp, state) {
  return createReview({
    ...(existing || {}),
    ...(input || {}),
    id: input?.id || existing?.id || deterministicId("review", { assignmentId, revision }),
    assignmentId,
    revision,
    state,
    createdAt: existing?.createdAt || input?.createdAt || timestamp,
    updatedAt: timestamp,
    completedAt: state === "complete" ? (input?.completedAt || timestamp) : null
  });
}

function sameCompletion(left, right) {
  if (!left || !right) return false;
  return JSON.stringify({ ratings: left.ratings, computed: left.computed, preference: left.preference, confidence: left.confidence, confidenceScale: left.confidenceScale, preferenceEvidence: left.preferenceEvidence || "", rationale: left.rationale, issueLabels: left.issueLabels, rubricSnapshot: left.rubricSnapshot })
    === JSON.stringify({ ratings: right.ratings, computed: right.computed, preference: right.preference, confidence: right.confidence, confidenceScale: right.confidenceScale, preferenceEvidence: right.preferenceEvidence || "", rationale: right.rationale, issueLabels: right.issueLabels, rubricSnapshot: right.rubricSnapshot });
}

async function writeAudit(transaction, { id, entityType, entityId, action, actorId, at, details }) {
  const existing = await transaction.get("auditEvents", id);
  if (existing) throw new RepositoryConflictError(`Audit event ${id} already exists.`, { code: "duplicate_audit", store: "auditEvents", id });
  const event = createAuditEvent({ id, entityType, entityId, action, actorId, at, details }, { idFactory: () => id, now: () => at });
  await transaction.put("auditEvents", event);
  return event;
}

async function lockRubric(transaction, assignment, { actorId, at }) {
  const session = await transaction.get("sessions", assignment.sessionId);
  if (!session?.rubricRef) return null;
  const rubric = await transaction.get("rubrics", session.rubricRef);
  if (!rubric || rubric.lockedAt) return null;
  const locked = { ...rubric, lockedAt: at };
  await transaction.put("rubrics", locked);
  const event = await writeAudit(transaction, {
    id: deterministicId("audit", { rubricId: rubric.id, assignmentId: assignment.id, action: "locked" }),
    entityType: "rubric",
    entityId: rubric.id,
    action: "rubric_locked",
    actorId,
    at,
    details: { assignmentId: assignment.id, sessionId: session.id, rubricVersion: rubric.version }
  });
  return { rubric: locked, auditEvent: event };
}

/** Start an assignment in an asynchronous IndexedDB transaction. */
export async function startIndexedDbAssignment(repository, { assignmentId, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction(async (transaction) => {
    const assignment = await assignmentFor(transaction, assignmentId);
    if (["complete", "skipped"].includes(assignment.state)) throw new IndexedDbReviewError(`Cannot start a ${assignment.state} assignment.`, { code: "illegal_transition", store: "assignments", id: assignmentId });
    if (assignment.state === "in_progress") return { assignment, changed: false, auditEvent: null };
    const next = { ...assignment, state: "in_progress" };
    await transaction.put("assignments", next);
    const event = await writeAudit(transaction, { id: deterministicId("audit", { assignmentId, action: "started" }), entityType: "assignment", entityId: assignmentId, action: "assignment_started", actorId: setupOptions.actorId, at: setupOptions.now, details: {} });
    return { assignment: next, changed: true, auditEvent: event };
  }, { stores: ["assignments", "auditEvents"] });
}

/** Complete a session only after every assignment has been resolved. */
export async function completeIndexedDbSession(repository, { sessionId, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction(async (transaction) => {
    const session = await sessionFor(transaction, sessionId);
    if (session.state === "completed") return { session, auditEvent: null, duplicate: true };
    if (session.state === "revealed") throw new IndexedDbReviewError("A revealed session cannot be completed again.", { code: "illegal_transition", store: "sessions", id: sessionId });
    if (session.state !== "active") throw new IndexedDbReviewError(`Only an active session can be completed (current state: ${session.state}).`, { code: "illegal_transition", store: "sessions", id: sessionId });
    const assignments = (await transaction.list("assignments")).filter((assignment) => assignment.sessionId === sessionId);
    if (!assignments.length) throw new IndexedDbReviewError("A session with no assignments cannot be completed.", { code: "empty_session", store: "sessions", id: sessionId });
    const unresolved = assignments.filter((assignment) => !["complete", "skipped"].includes(assignment.state));
    if (unresolved.length) throw new IndexedDbReviewError(`${unresolved.length} assignment${unresolved.length === 1 ? "" : "s"} still need review.`, { code: "incomplete_session", store: "assignments", id: unresolved[0].id });
    assertCompletedAssignmentRecords(assignments, await transaction.list("reviews"));
    const next = { ...session, state: "completed", completedAt: setupOptions.now };
    await transaction.put("sessions", next);
    const event = await writeAudit(transaction, {
      id: deterministicId("audit", { sessionId, action: "completed" }),
      entityType: "session",
      entityId: sessionId,
      action: "session_completed",
      actorId: setupOptions.actorId,
      at: setupOptions.now,
      details: { assignmentCount: assignments.length }
    });
    return { session: next, auditEvent: event, duplicate: false };
  }, { stores: ["sessions", "assignments", "reviews", "auditEvents"] });
}

/** Reveal metadata only as an explicit action after session completion. */
export async function revealIndexedDbSession(repository, { sessionId, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction(async (transaction) => {
    const session = await sessionFor(transaction, sessionId);
    if (session.state === "revealed") return { session, auditEvent: null, duplicate: true };
    if (session.state !== "completed") throw new IndexedDbReviewError("Only a completed session can reveal metadata.", { code: "illegal_transition", store: "sessions", id: sessionId });
    const next = { ...session, state: "revealed", revealedAt: setupOptions.now };
    await transaction.put("sessions", next);
    const event = await writeAudit(transaction, {
      id: deterministicId("audit", { sessionId, action: "revealed" }),
      entityType: "session",
      entityId: sessionId,
      action: "session_revealed",
      actorId: setupOptions.actorId,
      at: setupOptions.now,
      details: { blindMode: session.blindMode }
    });
    return { session: next, auditEvent: event, duplicate: false };
  }, { stores: ["sessions", "auditEvents"] });
}

/** Save a draft review against the asynchronous IndexedDB repository. */
export async function saveIndexedDbDraft(repository, { assignmentId, review = {}, expectedRevision, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction(async (transaction) => {
    const assignment = await assignmentFor(transaction, assignmentId);
    if (["complete", "skipped"].includes(assignment.state)) throw new IndexedDbReviewError(`Cannot save a draft for a ${assignment.state} assignment.`, { code: "illegal_transition", store: "assignments", id: assignmentId });
    const reviewCase = await reviewCaseFor(transaction, assignment);
    const existing = await currentReviewFor(transaction, assignment);
    const currentRevision = revisionFor(existing, expectedRevision);
    const nextReview = reviewRecord(review, existing, assignmentId, currentRevision + 1, setupOptions.now, "draft");
    assertReview(nextReview, { candidateIds: reviewCase.candidates.map((candidate) => candidate.id) });
    await transaction.put("reviews", nextReview);
    const nextAssignment = assignment.reviewId ? assignment : { ...assignment, reviewId: nextReview.id };
    if (!assignment.reviewId) await transaction.put("assignments", nextAssignment);
    return { review: nextReview, assignment: nextAssignment, changed: true };
  }, { stores: ["assignments", "cases", "reviews"] });
}

/** Complete a review, lock its rubric, and write the audit trail atomically. */
export async function completeIndexedDbReview(repository, { assignmentId, review = {}, expectedRevision, now, actorId = DEFAULT_ACTOR_ID } = {}) {
  const setupOptions = setup(repository, { now, actorId });
  return repository.transaction(async (transaction) => {
    const assignment = await assignmentFor(transaction, assignmentId);
    const existing = await currentReviewFor(transaction, assignment);
    if (assignment.state === "complete") {
      if (sameCompletion(review, existing) || (!Object.keys(review).length && existing)) return { review: clone(existing), assignment, auditEvent: null, duplicate: true };
      throw new RepositoryConflictError("This assignment is already complete and cannot be overwritten.", { code: "duplicate_complete", store: "assignments", id: assignmentId });
    }
    if (assignment.state === "skipped") throw new IndexedDbReviewError("A skipped assignment cannot be completed.", { code: "illegal_transition", store: "assignments", id: assignmentId });
    const reviewCase = await reviewCaseFor(transaction, assignment);
    const currentRevision = revisionFor(existing, expectedRevision);
    const nextReview = reviewRecord(review, existing, assignmentId, currentRevision + 1, setupOptions.now, "complete");
    assertReview(nextReview, { candidateIds: reviewCase.candidates.map((candidate) => candidate.id) });
    const nextAssignment = { ...assignment, state: "complete", reviewId: nextReview.id, skipReason: null };
    await transaction.put("reviews", nextReview);
    await transaction.put("assignments", nextAssignment);
    const event = await writeAudit(transaction, { id: deterministicId("audit", { reviewId: nextReview.id, revision: nextReview.revision, action: "completed" }), entityType: "review", entityId: nextReview.id, action: "review_completed", actorId: setupOptions.actorId, at: setupOptions.now, details: { assignmentId, revision: nextReview.revision } });
    const locked = await lockRubric(transaction, assignment, { actorId: setupOptions.actorId, at: setupOptions.now });
    return { review: nextReview, assignment: nextAssignment, auditEvent: event, rubric: locked?.rubric || null, rubricAuditEvent: locked?.auditEvent || null, duplicate: false };
  }, { stores: ["assignments", "cases", "reviews", "auditEvents", "sessions", "rubrics"] });
}
