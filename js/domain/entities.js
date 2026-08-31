import { assertStableId, contentHash, isReservedCandidateId, requireClock, requireIdFactory, stableHash } from "./ids.js";

export const DOMAIN_SCHEMA_VERSION = 3;
const SESSION_STATES = new Set(["planned", "active", "completed", "revealed"]);
const ASSIGNMENT_STATES = new Set(["pending", "in_progress", "complete", "skipped"]);
const REVIEW_STATES = new Set(["draft", "complete"]);
const CONFIDENCE_SCALES = new Set(["anchored-1-5", "legacy-0-100"]);

export class DomainValidationError extends Error {
  constructor(message, { code = "invalid_entity", path = "" } = {}) {
    super(message);
    this.name = "DomainValidationError";
    this.code = code;
    this.path = path;
  }
}

function invalid(message, path, code = "invalid_entity") { throw new DomainValidationError(message, { path, code }); }
function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${path} must be an object.`, path, "expected_object");
  return value;
}
function string(value, path, { optional = false, min = 1, max = 10000 } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || value.trim().length < min || value.length > max) invalid(`${path} must be a string between ${min} and ${max} characters.`, path, "invalid_string");
  return value;
}
function timestamp(value, path, { optional = false } = {}) {
  if (optional && value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) invalid(`${path} must be an ISO timestamp.`, path, "invalid_timestamp");
  return value;
}
function id(value, path) {
  try { return assertStableId(value, path); } catch { invalid(`${path} must be a stable identifier.`, path, "invalid_id"); }
}
function array(value, path, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) invalid(`${path} must contain at least ${min} item(s).`, path, "invalid_array");
  return value;
}
function uniqueIds(values, path) {
  const seen = new Set();
  values.forEach((value, index) => {
    const itemId = id(value, `${path}[${index}]`);
    if (seen.has(itemId)) invalid(`${path} contains a duplicate id.`, `${path}[${index}]`, "duplicate_id");
    seen.add(itemId);
  });
  return seen;
}
function jsonObject(value, path, { optional = false } = {}) {
  if (optional && value === undefined) return {};
  return object(value, path);
}
function schemaVersion(value, path) {
  if (value !== DOMAIN_SCHEMA_VERSION) invalid(`${path} must be ${DOMAIN_SCHEMA_VERSION}.`, path, "unsupported_schema");
}
function validateAnchors(anchors, path) {
  object(anchors, path);
  for (const score of ["1", "3", "5"]) string(anchors[score], `${path}.${score}`, { max: 500 });
}

export function assertRubric(rubric) {
  object(rubric, "rubric");
  schemaVersion(rubric.schemaVersion, "rubric.schemaVersion");
  id(rubric.id, "rubric.id");
  string(rubric.name, "rubric.name", { max: 200 });
  string(rubric.version, "rubric.version", { max: 80 });
  string(rubric.description, "rubric.description", { min: 0, max: 2000 });
  const dimensions = array(rubric.dimensions, "rubric.dimensions", { min: 1 });
  const dimensionIds = new Set();
  let totalWeight = 0;
  dimensions.forEach((dimension, index) => {
    const path = `rubric.dimensions[${index}]`;
    object(dimension, path);
    id(dimension.id, `${path}.id`);
    if (dimensionIds.has(dimension.id)) invalid("Rubric dimension ids must be unique.", `${path}.id`, "duplicate_dimension");
    dimensionIds.add(dimension.id);
    string(dimension.label, `${path}.label`, { max: 200 });
    string(dimension.description, `${path}.description`, { min: 0, max: 2000 });
    validateAnchors(dimension.anchors, `${path}.anchors`);
    if (!Number.isFinite(dimension.weight) || dimension.weight <= 0) invalid("Rubric weights must be positive numbers.", `${path}.weight`, "invalid_weight");
    totalWeight += dimension.weight;
  });
  if (Math.abs(totalWeight - 100) > 0.0001) invalid("Rubric weights must total 100.", "rubric.dimensions", "weights_not_100");
  if (!Number.isFinite(rubric.tieThreshold) || rubric.tieThreshold < 0) invalid("Rubric tieThreshold must be non-negative.", "rubric.tieThreshold", "invalid_tie_threshold");
  string(rubric.checksum, "rubric.checksum", { max: 100 });
  if (rubric.lockedAt !== null) timestamp(rubric.lockedAt, "rubric.lockedAt");
  return rubric;
}

export function assertCandidate(candidate) {
  object(candidate, "candidate");
  schemaVersion(candidate.schemaVersion, "candidate.schemaVersion");
  id(candidate.id, "candidate.id");
  if (isReservedCandidateId(candidate.id)) invalid("Candidate ids cannot use positional labels such as A, B, Left, or Right.", "candidate.id", "positional_candidate_id");
  string(candidate.content, "candidate.content", { max: 200000 });
  if (candidate.source !== null) string(candidate.source, "candidate.source", { max: 500 });
  jsonObject(candidate.metadata, "candidate.metadata");
  return candidate;
}

export function assertCase(reviewCase) {
  object(reviewCase, "case");
  schemaVersion(reviewCase.schemaVersion, "case.schemaVersion");
  id(reviewCase.id, "case.id");
  id(reviewCase.datasetId, "case.datasetId");
  string(reviewCase.externalId, "case.externalId", { max: 500 });
  string(reviewCase.input, "case.input", { max: 200000 });
  const candidates = array(reviewCase.candidates, "case.candidates", { min: 2 });
  candidates.forEach((candidate, index) => {
    assertCandidate(candidate);
    if (index > 0 && candidates.slice(0, index).some((previous) => previous.id === candidate.id)) invalid("Case candidate ids must be unique.", `case.candidates[${index}].id`, "duplicate_candidate_id");
  });
  jsonObject(reviewCase.metadata, "case.metadata");
  string(reviewCase.contentHash, "case.contentHash", { max: 100 });
  const expectedHash = contentHash({ externalId: reviewCase.externalId, input: reviewCase.input, candidates: candidates.map(({ id: candidateId, content, source }) => ({ id: candidateId, content, source })) });
  if (reviewCase.contentHash !== expectedHash) invalid("Case contentHash does not match its immutable content.", "case.contentHash", "content_hash_mismatch");
  return reviewCase;
}

export function assertWorkspace(workspace) {
  object(workspace, "workspace");
  schemaVersion(workspace.schemaVersion, "workspace.schemaVersion");
  id(workspace.id, "workspace.id");
  string(workspace.name, "workspace.name", { max: 200 });
  timestamp(workspace.createdAt, "workspace.createdAt");
  timestamp(workspace.updatedAt, "workspace.updatedAt");
  uniqueIds(array(workspace.rubricIds, "workspace.rubricIds"), "workspace.rubricIds");
  uniqueIds(array(workspace.datasetIds, "workspace.datasetIds"), "workspace.datasetIds");
  jsonObject(workspace.settings, "workspace.settings");
  return workspace;
}

export function assertDataset(dataset) {
  object(dataset, "dataset");
  schemaVersion(dataset.schemaVersion, "dataset.schemaVersion");
  id(dataset.id, "dataset.id");
  string(dataset.name, "dataset.name", { max: 200 });
  string(dataset.description, "dataset.description", { min: 0, max: 2000 });
  id(dataset.rubricRef, "dataset.rubricRef");
  array(dataset.tags, "dataset.tags").forEach((tag, index) => id(tag, `dataset.tags[${index}]`));
  timestamp(dataset.createdAt, "dataset.createdAt");
  if (typeof dataset.isDemo !== "boolean") invalid("dataset.isDemo must be a boolean.", "dataset.isDemo", "invalid_boolean");
  return dataset;
}

export function assertReviewSession(session) {
  object(session, "session");
  schemaVersion(session.schemaVersion, "session.schemaVersion");
  id(session.id, "session.id");
  id(session.datasetId, "session.datasetId");
  id(session.rubricRef, "session.rubricRef");
  id(session.reviewerId, "session.reviewerId");
  string(session.seed, "session.seed", { max: 500 });
  if (typeof session.blindMode !== "boolean") invalid("session.blindMode must be a boolean.", "session.blindMode", "invalid_boolean");
  if (!SESSION_STATES.has(session.state)) invalid("session.state is not supported.", "session.state", "invalid_state");
  timestamp(session.createdAt, "session.createdAt");
  if (session.completedAt !== null) timestamp(session.completedAt, "session.completedAt");
  if (session.revealedAt !== null) timestamp(session.revealedAt, "session.revealedAt");
  return session;
}

export function assertAssignment(assignment) {
  object(assignment, "assignment");
  schemaVersion(assignment.schemaVersion, "assignment.schemaVersion");
  id(assignment.id, "assignment.id");
  id(assignment.sessionId, "assignment.sessionId");
  id(assignment.caseId, "assignment.caseId");
  const displayOrder = array(assignment.displayOrder, "assignment.displayOrder", { min: 2 });
  uniqueIds(displayOrder, "assignment.displayOrder");
  if (!ASSIGNMENT_STATES.has(assignment.state)) invalid("assignment.state is not supported.", "assignment.state", "invalid_state");
  if (assignment.skipReason !== null) string(assignment.skipReason, "assignment.skipReason", { max: 2000 });
  if (assignment.reviewId !== null) id(assignment.reviewId, "assignment.reviewId");
  const repeatOf = assignment.repeatOf ?? null;
  const calibration = assignment.calibration ?? false;
  if (repeatOf !== null) id(repeatOf, "assignment.repeatOf");
  if (typeof calibration !== "boolean") invalid("assignment.calibration must be a boolean.", "assignment.calibration", "invalid_boolean");
  if (calibration && repeatOf === null) invalid("Calibration assignments require repeatOf.", "assignment.repeatOf", "missing_repeat_reference");
  if (assignment.state === "skipped" && !assignment.skipReason?.trim()) invalid("A skipped assignment requires a reason.", "assignment.skipReason", "missing_skip_reason");
  if (assignment.state === "complete" && !assignment.reviewId) invalid("A complete assignment requires a review id.", "assignment.reviewId", "missing_review_id");
  return assignment;
}

function assertRubricSnapshot(snapshot) {
  object(snapshot, "review.rubricSnapshot");
  string(snapshot.rubricId, "review.rubricSnapshot.rubricId", { max: 200 });
  string(snapshot.rubricVersion, "review.rubricSnapshot.rubricVersion", { max: 80 });
  string(snapshot.scoringAlgorithmVersion, "review.rubricSnapshot.scoringAlgorithmVersion", { max: 80 });
  if (!Number.isFinite(snapshot.tieThreshold) || snapshot.tieThreshold < 0) invalid("Review snapshot tieThreshold is invalid.", "review.rubricSnapshot.tieThreshold", "invalid_tie_threshold");
  const dimensions = array(snapshot.dimensions, "review.rubricSnapshot.dimensions", { min: 1 });
  dimensions.forEach((dimension, index) => {
    const path = `review.rubricSnapshot.dimensions[${index}]`;
    object(dimension, path);
    id(dimension.id, `${path}.id`);
    string(dimension.label, `${path}.label`, { max: 200 });
    string(dimension.description, `${path}.description`, { min: 0, max: 2000 });
    validateAnchors(dimension.anchors, `${path}.anchors`);
    if (!Number.isFinite(dimension.weight) || dimension.weight <= 0) invalid("Review snapshot weights must be positive.", `${path}.weight`, "invalid_weight");
  });
  return snapshot;
}

function ratingComplete(value, snapshot) {
  if (Number.isInteger(value)) return value >= 1 && value <= 5;
  if (!value || typeof value !== "object" || Array.isArray(value) || !snapshot) return false;
  return snapshot.dimensions.every((dimension) => Number.isInteger(value[dimension.id]) && value[dimension.id] >= 1 && value[dimension.id] <= 5);
}

export function assertReview(review, { candidateIds = [] } = {}) {
  object(review, "review");
  schemaVersion(review.schemaVersion, "review.schemaVersion");
  id(review.id, "review.id");
  id(review.assignmentId, "review.assignmentId");
  if (!Number.isInteger(review.revision) || review.revision < 1) invalid("review.revision must be a positive integer.", "review.revision", "invalid_revision");
  const known = new Set(candidateIds);
  object(review.ratings, "review.ratings");
  for (const candidateId of Object.keys(review.ratings)) {
    if (isReservedCandidateId(candidateId)) invalid("Review ratings must use stable candidate ids, not positional labels.", `review.ratings.${candidateId}`, "positional_candidate_id");
    if (known.size && !known.has(candidateId)) invalid("Review rating references an unknown candidate.", `review.ratings.${candidateId}`, "unknown_candidate");
    const rating = review.ratings[candidateId];
    const validRating = Number.isInteger(rating) || (rating && typeof rating === "object" && !Array.isArray(rating));
    if (!validRating) invalid("Ratings must be integers or per-dimension rating objects.", `review.ratings.${candidateId}`, "invalid_rating");
    if (Number.isInteger(rating) && (rating < 0 || rating > 5)) invalid("Ratings must be integers from 0 through 5.", `review.ratings.${candidateId}`, "invalid_rating");
  }
  object(review.computed, "review.computed");
  if (!("scoreByCandidate" in review.computed) || !("winner" in review.computed)) invalid("Computed score and winner are required.", "review.computed", "missing_computed_value");
  if (review.computed.winner !== "tie" && review.computed.winner !== "pending") {
    if (known.size && !known.has(review.computed.winner)) invalid("Computed winner references an unknown candidate.", "review.computed.winner", "unknown_candidate");
    id(review.computed.winner, "review.computed.winner");
  }
  if (review.preference !== "tie" && review.preference !== "pending") {
    if (known.size && !known.has(review.preference)) invalid("Preference references an unknown candidate.", "review.preference", "unknown_candidate");
    id(review.preference, "review.preference");
  }
  const confidenceScale = review.confidenceScale || (Number.isFinite(review.confidence) && review.confidence > 5 ? "legacy-0-100" : "anchored-1-5");
  if (!CONFIDENCE_SCALES.has(confidenceScale)) invalid("review.confidenceScale is not supported.", "review.confidenceScale", "invalid_confidence_scale");
  if (confidenceScale === "anchored-1-5") {
    if (!Number.isInteger(review.confidence) || review.confidence < 1 || review.confidence > 5) invalid("Anchored confidence must be an integer from 1 through 5.", "review.confidence", "invalid_confidence");
  } else if (!Number.isFinite(review.confidence) || review.confidence < 0 || review.confidence > 100) {
    invalid("Legacy confidence must be between 0 and 100.", "review.confidence", "invalid_confidence");
  }
  const supersedesReviewId = review.supersedesReviewId ?? null;
  if (supersedesReviewId !== null) id(supersedesReviewId, "review.supersedesReviewId");
  string(review.preferenceEvidence, "review.preferenceEvidence", { optional: true, max: 20000 });
  string(review.rationale, "review.rationale", { min: 0, max: 20000 });
  array(review.issueLabels, "review.issueLabels").forEach((label, index) => id(label, `review.issueLabels[${index}]`));
  if (!REVIEW_STATES.has(review.state)) invalid("review.state is not supported.", "review.state", "invalid_state");
  if (review.createdAt !== null) timestamp(review.createdAt, "review.createdAt");
  if (review.updatedAt !== null) timestamp(review.updatedAt, "review.updatedAt");
  if (review.completedAt !== null) timestamp(review.completedAt, "review.completedAt");
  if (review.state === "complete") {
    assertRubricSnapshot(review.rubricSnapshot);
    if (!known.size) invalid("Complete reviews must be validated with candidate ids.", "review", "candidate_context_required");
    if (![...known].every((candidateId) => ratingComplete(review.ratings[candidateId], review.rubricSnapshot))) invalid("Complete reviews require a rating for every candidate.", "review.ratings", "incomplete_ratings");
    if (![...known].includes(review.preference) && review.preference !== "tie") invalid("Complete reviews require a candidate preference or tie.", "review.preference", "missing_preference");
    if (review.rationale.trim().length < 20) invalid("Complete reviews require rationale of at least 20 characters.", "review.rationale", "missing_rationale");
    const preferenceDisagrees = review.preference !== "tie" && review.computed.winner !== "tie" && review.preference !== review.computed.winner;
    const preferenceEvidence = typeof review.preferenceEvidence === "string" ? review.preferenceEvidence.trim() : "";
    if (preferenceDisagrees && preferenceEvidence.length < 20) invalid("A preference that differs from the computed winner requires explicit evidence.", "review.preferenceEvidence", "missing_preference_evidence");
    if (review.completedAt === null) invalid("Complete reviews require completedAt.", "review.completedAt", "missing_completed_at");
  }
  return review;
}

export function assertAuditEvent(event) {
  object(event, "auditEvent");
  schemaVersion(event.schemaVersion, "auditEvent.schemaVersion");
  id(event.id, "auditEvent.id");
  string(event.entityType, "auditEvent.entityType", { max: 100 });
  id(event.entityId, "auditEvent.entityId");
  string(event.action, "auditEvent.action", { max: 100 });
  id(event.actorId, "auditEvent.actorId");
  timestamp(event.at, "auditEvent.at");
  jsonObject(event.details, "auditEvent.details");
  return event;
}

export function assertWorkspaceDocument(document) {
  object(document, "document");
  schemaVersion(document.schemaVersion, "document.schemaVersion");
  assertWorkspace(document.workspace);
  const collections = ["rubrics", "datasets", "cases", "sessions", "assignments", "reviews", "auditEvents"];
  for (const collection of collections) array(document[collection], `document.${collection}`);
  const byId = new Map();
  for (const [type, values] of [["rubric", document.rubrics], ["dataset", document.datasets], ["case", document.cases], ["session", document.sessions], ["assignment", document.assignments], ["review", document.reviews], ["auditEvent", document.auditEvents]]) {
    const assertion = ASSERTIONS[type];
    values.forEach((value) => {
      if (type === "review") {
        object(value, "review");
        schemaVersion(value.schemaVersion, "review.schemaVersion");
        id(value.id, "review.id");
      } else assertion(value);
      const collection = byId.get(value.id);
      if (collection) invalid(`Entity id is duplicated across ${collection} and ${type}.`, `${type}.id`, "duplicate_entity_id");
      byId.set(value.id, type);
    });
  }
  const rubricIds = new Set(document.rubrics.map((rubric) => rubric.id));
  const datasetIds = new Set(document.datasets.map((dataset) => dataset.id));
  const caseById = new Map(document.cases.map((reviewCase) => [reviewCase.id, reviewCase]));
  const sessionById = new Map(document.sessions.map((session) => [session.id, session]));
  const assignmentById = new Map(document.assignments.map((assignment) => [assignment.id, assignment]));
  const reviewById = new Map(document.reviews.map((review) => [review.id, review]));
  for (const rubricId of document.workspace.rubricIds) if (!rubricIds.has(rubricId)) invalid("Workspace references an unknown rubric.", "workspace.rubricIds", "unknown_reference");
  for (const datasetId of document.workspace.datasetIds) if (!datasetIds.has(datasetId)) invalid("Workspace references an unknown dataset.", "workspace.datasetIds", "unknown_reference");
  for (const dataset of document.datasets) if (!rubricIds.has(dataset.rubricRef)) invalid("Dataset references an unknown rubric.", `dataset.${dataset.id}.rubricRef`, "unknown_reference");
  for (const reviewCase of document.cases) if (!datasetIds.has(reviewCase.datasetId)) invalid("Case references an unknown dataset.", `case.${reviewCase.id}.datasetId`, "unknown_reference");
  for (const session of document.sessions) {
    if (!datasetIds.has(session.datasetId) || !rubricIds.has(session.rubricRef)) invalid("Session references an unknown dataset or rubric.", `session.${session.id}`, "unknown_reference");
  }
  for (const assignment of document.assignments) {
    const reviewCase = caseById.get(assignment.caseId);
    if (!sessionById.has(assignment.sessionId) || !reviewCase) invalid("Assignment references an unknown session or case.", `assignment.${assignment.id}`, "unknown_reference");
    const candidateIds = new Set(reviewCase.candidates.map((candidate) => candidate.id));
    if (assignment.displayOrder.some((candidateId) => !candidateIds.has(candidateId))) invalid("Assignment displayOrder references an unknown candidate.", `assignment.${assignment.id}.displayOrder`, "unknown_reference");
    if (assignment.reviewId !== null) {
      const review = reviewById.get(assignment.reviewId);
      if (!review) invalid("Assignment references an unknown review.", `assignment.${assignment.id}.reviewId`, "unknown_reference");
      if (review.assignmentId !== assignment.id) invalid("Assignment reviewId must reference a review for the same assignment.", `assignment.${assignment.id}.reviewId`, "invalid_reference");
      if (assignment.state === "complete" && review.state !== "complete") invalid("A complete assignment must reference a complete review.", `assignment.${assignment.id}.reviewId`, "invalid_reference");
    }
  }
  for (const review of document.reviews) {
    const assignment = assignmentById.get(review.assignmentId);
    const reviewCase = assignment && caseById.get(assignment.caseId);
    if (!assignment || !reviewCase) invalid("Review references an unknown assignment or case.", `review.${review.id}.assignmentId`, "unknown_reference");
    assertReview(review, { candidateIds: reviewCase.candidates.map((candidate) => candidate.id) });
  }
  for (const review of document.reviews) {
    if (review.supersedesReviewId !== null) {
      const superseded = reviewById.get(review.supersedesReviewId);
      if (!superseded || superseded.assignmentId !== review.assignmentId) invalid("Review revision must supersede a review from the same assignment.", `review.${review.id}.supersedesReviewId`, "invalid_revision_reference");
    }
  }
  for (const event of document.auditEvents) if (!byId.has(event.entityId)) invalid("Audit event references an unknown entity.", `auditEvent.${event.id}.entityId`, "unknown_reference");
  return document;
}

function makeId(input, idFactory, prefix) { return input || `${prefix}-${requireIdFactory(idFactory)}`; }
function makeTime(value, now) { return value || requireClock(now); }

export function createWorkspace(input = {}, options = {}) {
  const createdAt = makeTime(input.createdAt, options.now);
  return assertWorkspace({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "workspace"), name: input.name || "EvalForge workspace", createdAt, updatedAt: input.updatedAt || createdAt, rubricIds: [...(input.rubricIds || [])], datasetIds: [...(input.datasetIds || [])], settings: { ...(input.settings || {}) } });
}

export function createRubric(input = {}, options = {}) {
  const idValue = makeId(input.id, options.idFactory, "rubric");
  const dimensions = (input.dimensions || []).map((dimension) => ({ ...dimension, anchors: { ...(dimension.anchors || {}) } }));
  return assertRubric({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: idValue, name: input.name || "Untitled rubric", description: input.description || "", version: input.version || "1.0.0", tieThreshold: input.tieThreshold ?? 2, dimensions, checksum: input.checksum || stableHash({ id: idValue, version: input.version || "1.0.0", dimensions }), lockedAt: input.lockedAt ?? null });
}

export function createCandidate(input = {}, options = {}) {
  return assertCandidate({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "candidate"), content: input.content || "", source: input.source ?? null, metadata: { ...(input.metadata || {}) } });
}

export function createCase(input = {}, options = {}) {
  const candidates = (input.candidates || []).map((candidate) => createCandidate(candidate, options));
  const content = { externalId: input.externalId || "", input: input.input || "", candidates: candidates.map(({ id, content: candidateContent, source }) => ({ id, content: candidateContent, source })) };
  return assertCase({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "case"), datasetId: input.datasetId || "", externalId: input.externalId || "", input: input.input || "", candidates, metadata: { ...(input.metadata || {}) }, contentHash: input.contentHash || contentHash(content) });
}

export function createDataset(input = {}, options = {}) {
  return assertDataset({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "dataset"), name: input.name || "Untitled dataset", description: input.description || "", rubricRef: input.rubricRef || "", tags: [...(input.tags || [])], createdAt: makeTime(input.createdAt, options.now), isDemo: input.isDemo === true });
}

export function createReviewSession(input = {}, options = {}) {
  return assertReviewSession({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "session"), datasetId: input.datasetId || "", rubricRef: input.rubricRef || "", reviewerId: input.reviewerId || "", blindMode: input.blindMode !== false, seed: input.seed || "", state: input.state || "planned", createdAt: makeTime(input.createdAt, options.now), completedAt: input.completedAt ?? null, revealedAt: input.revealedAt ?? null });
}

export function createAssignment(input = {}, options = {}) {
  return assertAssignment({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "assignment"), sessionId: input.sessionId || "", caseId: input.caseId || "", displayOrder: [...(input.displayOrder || [])], state: input.state || "pending", skipReason: input.skipReason ?? null, reviewId: input.reviewId ?? null, repeatOf: input.repeatOf ?? null, calibration: input.calibration === true });
}

export function createReview(input = {}, options = {}) {
  const rawConfidence = input.confidence ?? 3;
  const confidenceScale = input.confidenceScale || (Number.isFinite(rawConfidence) && rawConfidence > 5 ? "legacy-0-100" : "anchored-1-5");
  return { schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "review"), assignmentId: input.assignmentId || "", revision: input.revision || 1, supersedesReviewId: input.supersedesReviewId ?? null, rubricSnapshot: input.rubricSnapshot ?? null, ratings: { ...(input.ratings || {}) }, computed: { ...(input.computed || { scoreByCandidate: {}, winner: "pending" }) }, preference: input.preference || "pending", confidence: rawConfidence, confidenceScale, preferenceEvidence: input.preferenceEvidence || "", rationale: input.rationale || "", issueLabels: [...(input.issueLabels || [])], state: input.state || "draft", createdAt: input.createdAt ?? null, updatedAt: input.updatedAt ?? null, completedAt: input.completedAt ?? null };
}

export function createAuditEvent(input = {}, options = {}) {
  return assertAuditEvent({ schemaVersion: DOMAIN_SCHEMA_VERSION, id: makeId(input.id, options.idFactory, "audit"), entityType: input.entityType || "", entityId: input.entityId || "", action: input.action || "", actorId: input.actorId || "", at: makeTime(input.at, options.now), details: { ...(input.details || {}) } });
}

const ASSERTIONS = { workspace: assertWorkspace, rubric: assertRubric, dataset: assertDataset, case: assertCase, candidate: assertCandidate, session: assertReviewSession, assignment: assertAssignment, review: assertReview, auditEvent: assertAuditEvent };

export function validateEntity(type, value, options = {}) {
  try { ASSERTIONS[type](value, options); return { valid: true, errors: [] }; }
  catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    return { valid: false, errors: [{ code: error.code, path: error.path, message: error.message }] };
  }
}

export function validateWorkspaceDocument(value) {
  try { assertWorkspaceDocument(value); return { valid: true, errors: [] }; }
  catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    return { valid: false, errors: [{ code: error.code, path: error.path, message: error.message }] };
  }
}
