import {
  assertAssignment,
  assertReviewSession,
  createAssignment,
  createReviewSession
} from "./entities.js";
import { deterministicId, stableHash } from "./ids.js";

/**
 * Blind-session helpers deliberately keep presentation projection separate
 * from the persisted case entity. A blind DTO contains only what a reviewer
 * needs to see; source/model metadata never gets copied into it.
 */

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value.trim();
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
  return value;
}

function sessionFields(input) {
  object(input, "session");
  const datasetId = requiredString(input.datasetId, "session.datasetId");
  const rubricRef = requiredString(input.rubricRef ?? input.rubricId, "session.rubricRef");
  const reviewerId = requiredString(input.reviewerId, "session.reviewerId");
  const seed = requiredString(input.seed, "session.seed");
  const blindMode = requiredBoolean(input.blindMode, "session.blindMode");
  return { datasetId, rubricRef, reviewerId, seed, blindMode };
}

/**
 * Create a session only when all assignment-affecting inputs are explicit.
 * This avoids silently creating a non-reproducible session with a default
 * reviewer, seed, or blind setting.
 */
export function createSession(input = {}, options = {}) {
  const fields = sessionFields(input);
  return createReviewSession({ ...input, ...fields }, options);
}

function requireSession(value) {
  const session = object(value, "session");
  assertReviewSession(session);
  return session;
}

function requireReviewCase(value) {
  const reviewCase = object(value, "case");
  if (typeof reviewCase.id !== "string" || !reviewCase.id.trim()) throw new TypeError("case.id must be a non-empty string.");
  if (!Array.isArray(reviewCase.candidates) || reviewCase.candidates.length < 2) throw new TypeError("case.candidates must contain at least two candidates.");
  return reviewCase;
}

function candidateIds(reviewCase) {
  const ids = reviewCase.candidates.map((candidate) => requiredString(candidate.id, "case.candidates[].id"));
  if (new Set(ids).size !== ids.length) throw new TypeError("case candidates must have unique ids.");
  return ids;
}

function stableCandidateRank(seed, caseId, candidateId) {
  return stableHash({ seed, caseId, candidateId });
}

/**
 * Derive an order from the session seed once. Callers must persist the result
 * on the assignment; rendering should use assignment.displayOrder directly.
 */
export function deriveDisplayOrder(sessionOrSeed, reviewCase, { seed: overrideSeed } = {}) {
  const reviewCaseValue = requireReviewCase(reviewCase);
  const sessionValue = typeof sessionOrSeed === "string"
    ? { seed: sessionOrSeed }
    : object(sessionOrSeed, "session");
  const seed = requiredString(overrideSeed ?? sessionValue.seed, "session.seed");
  const ids = candidateIds(reviewCaseValue);
  if (ids.length === 2) {
    // The two-item case has only two possible permutations. Hash the complete
    // seed/case pair so a new session seed can change the visible side without
    // ever depending on the candidate's source or position label.
    const sessionHash = Number.parseInt(stableHash(`${seed}|${reviewCaseValue.id}`), 16);
    return (sessionHash & 1) === 0 ? ids : ids.reverse();
  }
  return ids
    .map((id) => ({ id, rank: stableCandidateRank(seed, reviewCaseValue.id, id) }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id))
    .map(({ id }) => id);
}

function validateDisplayOrder(displayOrder, reviewCase) {
  const expected = candidateIds(reviewCase);
  if (!Array.isArray(displayOrder) || displayOrder.length !== expected.length) {
    throw new TypeError("assignment.displayOrder must contain every candidate exactly once.");
  }
  const actual = displayOrder.map((id) => requiredString(id, "assignment.displayOrder[]"));
  if (new Set(actual).size !== actual.length || actual.some((id) => !expected.includes(id))) {
    throw new TypeError("assignment.displayOrder must contain every candidate exactly once.");
  }
  return actual;
}

function assignmentArgs(input, reviewCase, options) {
  const value = object(input, "assignment");
  const session = requireSession(value.session);
  const reviewCaseValue = requireReviewCase(reviewCase || value.reviewCase);
  if (session.datasetId !== reviewCaseValue.datasetId) {
    throw new TypeError("session.datasetId must match case.datasetId.");
  }
  const displayOrder = value.displayOrder
    ? validateDisplayOrder(value.displayOrder, reviewCaseValue)
    : (session.blindMode
      ? deriveDisplayOrder(session, reviewCaseValue)
      : candidateIds(reviewCaseValue));
  const id = value.id || deterministicId("assignment", { sessionId: session.id, caseId: reviewCaseValue.id });
  const assignment = createAssignment({
    ...value,
    id,
    sessionId: session.id,
    caseId: reviewCaseValue.id,
    displayOrder
  }, options);
  assertAssignment(assignment);
  return { session, reviewCase: reviewCaseValue, assignment };
}

/**
 * Create an assignment with a persisted order. Existing assignments should be
 * passed back with their displayOrder; this function never re-shuffles them.
 */
export function createAssignmentForSession(input = {}, options = {}) {
  return assignmentArgs(input, input.reviewCase, options).assignment;
}

export function createBlindAssignment({ session, reviewCase, ...assignment } = {}, options = {}) {
  const value = assignmentArgs({ ...assignment, session, reviewCase }, reviewCase, options);
  if (!value.session.blindMode) throw new TypeError("createBlindAssignment requires a blind session.");
  return value.assignment;
}

export function persistedDisplayOrder(assignment) {
  const value = object(assignment, "assignment");
  return [...validateDisplayOrder(value.displayOrder, { candidates: value.displayOrder.map((id) => ({ id })) })];
}

function displayArgs(first, second, third) {
  if (first && first.session && first.assignment && first.reviewCase) {
    return { session: first.session, assignment: first.assignment, reviewCase: first.reviewCase };
  }
  return { session: first, assignment: second, reviewCase: third };
}

function orderedCandidates(session, assignment, reviewCase) {
  const sessionValue = requireSession(session);
  const reviewCaseValue = requireReviewCase(reviewCase);
  const assignmentValue = object(assignment, "assignment");
  if (assignmentValue.sessionId !== sessionValue.id || assignmentValue.caseId !== reviewCaseValue.id) {
    throw new TypeError("assignment must belong to the supplied session and case.");
  }
  const order = validateDisplayOrder(assignmentValue.displayOrder, reviewCaseValue);
  const byId = new Map(reviewCaseValue.candidates.map((candidate) => [candidate.id, candidate]));
  return { session: sessionValue, assignment: assignmentValue, reviewCase: reviewCaseValue, order, byId };
}

/**
 * Safe projection for a blind reviewer. Candidate ids, source, model names,
 * metadata, and data-* attributes are intentionally absent from the DTO.
 */
export function createBlindDisplayDto(first, second, third) {
  const { session, assignment, reviewCase } = displayArgs(first, second, third);
  const ordered = orderedCandidates(session, assignment, reviewCase);
  if (!ordered.session.blindMode) throw new TypeError("A non-blind session cannot use the blind display projection.");
  return {
    blind: true,
    caseId: ordered.reviewCase.id,
    input: ordered.reviewCase.input,
    candidates: ordered.order.map((candidateId, index) => ({
      label: `Candidate ${index + 1}`,
      content: ordered.byId.get(candidateId).content
    }))
  };
}

/**
 * Non-blind projection is retained for migrated history. It is never inferred
 * from a new seed and therefore cannot silently change historical meaning.
 */
export function createDisplayDto(first, second, third) {
  const { session, assignment, reviewCase } = displayArgs(first, second, third);
  const ordered = orderedCandidates(session, assignment, reviewCase);
  if (ordered.session.blindMode) return createBlindDisplayDto(ordered.session, ordered.assignment, ordered.reviewCase);
  return {
    blind: false,
    caseId: ordered.reviewCase.id,
    input: ordered.reviewCase.input,
    candidates: ordered.order.map((candidateId, index) => {
      const candidate = ordered.byId.get(candidateId);
      return {
        label: candidate.id,
        candidateId: candidate.id,
        content: candidate.content,
        source: candidate.source ?? null,
        metadata: { ...(candidate.metadata || {}) },
        position: index + 1
      };
    })
  };
}

export function candidateIdAtPosition(assignment, position) {
  const value = object(assignment, "assignment");
  if (!Number.isInteger(position) || position < 0 || position >= value.displayOrder.length) {
    throw new RangeError("position is outside assignment.displayOrder.");
  }
  return value.displayOrder[position];
}

/**
 * Compute a winner from stable candidate ids. Display order is deliberately
 * not an input, so reversing the two visible sides cannot change the result.
 */
export function winnerCandidateId(scoreByCandidate, tieThreshold = 0) {
  object(scoreByCandidate, "scoreByCandidate");
  if (!Number.isFinite(tieThreshold) || tieThreshold < 0) throw new TypeError("tieThreshold must be a non-negative number.");
  const entries = Object.entries(scoreByCandidate).filter(([, score]) => Number.isFinite(score));
  if (entries.length < 2) return "pending";
  const ranked = [...entries].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (Math.abs(ranked[0][1] - ranked[1][1]) <= tieThreshold) return "tie";
  return ranked[0][0];
}

export function isHistoricalNonBlind(session) {
  return Boolean(session && session.blindMode === false);
}
