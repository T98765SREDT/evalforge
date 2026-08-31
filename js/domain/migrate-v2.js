import { getRubricProfile } from "../scoring.js";
import { normalizeEvaluation } from "../model.js";
import {
  createAssignment,
  createAuditEvent,
  createCase,
  createDataset,
  createReview,
  createReviewSession,
  createRubric,
  createWorkspace,
  assertWorkspaceDocument
} from "./entities.js";
import { contentHash, deterministicId, requireClock, requireIdFactory, stableHash } from "./ids.js";

const LEGACY_REVIEWER_ID = "migrated-v2-reviewer";
const LEGACY_ALGORITHM_VERSION = "legacy-unknown";

function asArray(value) { return Array.isArray(value) ? value : []; }

function warning(code, path, message) { return { code, path, message }; }

function anchorSet(dimension) {
  if (dimension?.anchors && typeof dimension.anchors === "object") {
    const anchors = { 1: dimension.anchors[1] ?? dimension.anchors["1"], 3: dimension.anchors[3] ?? dimension.anchors["3"], 5: dimension.anchors[5] ?? dimension.anchors["5"] };
    if ([1, 3, 5].every((score) => typeof anchors[score] === "string" && anchors[score].trim())) return anchors;
  }
  return {
    1: "Needs significant improvement.",
    3: "Meets the baseline expectation.",
    5: "Excellent and consistently demonstrates the criterion."
  };
}

function snapshotForEvaluation(evaluation, profile, warnings, path) {
  const source = evaluation.rubricSnapshot;
  const dimensions = Array.isArray(source?.dimensions) && source.dimensions.length
    ? source.dimensions
    : profile.dimensions;
  if (!source?.dimensions?.length) warnings.push(warning("missing-rubric-snapshot", path, "The v2 record had no usable rubric snapshot; the current preset was used."));
  const algorithm = typeof source?.scoringAlgorithmVersion === "string" && source.scoringAlgorithmVersion.trim()
    ? source.scoringAlgorithmVersion.trim()
    : LEGACY_ALGORITHM_VERSION;
  if (algorithm === LEGACY_ALGORITHM_VERSION) warnings.push(warning("legacy-scoring-algorithm-unknown", `${path}.rubricSnapshot`, "The v2 record did not store its scoring algorithm version."));
  return {
    rubricId: source?.rubricId || profile.id,
    rubricName: source?.rubricName || profile.name,
    rubricVersion: source?.rubricVersion || profile.version,
    scoringAlgorithmVersion: algorithm,
    tieThreshold: Number.isFinite(Number(source?.tieThreshold)) ? Number(source.tieThreshold) : profile.tieThreshold,
    dimensions: dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      description: typeof dimension.description === "string" ? dimension.description : "",
      weight: Number(dimension.weight),
      anchors: anchorSet(dimension)
    })),
    contributions: { A: {}, B: {} },
    auditStatus: algorithm === LEGACY_ALGORITHM_VERSION ? "limited" : "verified",
    repairReason: algorithm === LEGACY_ALGORITHM_VERSION ? "missing-scoring-algorithm-version" : null
  };
}

function rubricFromSnapshot(snapshot, profile, warnings, path) {
  const dimensions = snapshot.dimensions.map((dimension) => ({
    id: dimension.id,
    label: dimension.label,
    description: dimension.description,
    weight: dimension.weight,
    anchors: dimension.anchors
  }));
  try {
    return createRubric({
      id: snapshot.rubricId || profile.id,
      name: snapshot.rubricName || profile.name,
      description: profile.description || "Migrated rubric",
      version: snapshot.rubricVersion || profile.version,
      tieThreshold: snapshot.tieThreshold,
      dimensions
    });
  } catch (error) {
    warnings.push(warning("invalid-rubric-snapshot", path, `The saved rubric could not be used (${error.message}); the current preset was used.`));
    return createRubric({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      version: profile.version,
      tieThreshold: profile.tieThreshold,
      dimensions: profile.dimensions.map((dimension) => ({ ...dimension, anchors: anchorSet(dimension) }))
    });
  }
}

function candidateIds(recordId) {
  return {
    first: deterministicId("candidate", { recordId, slot: "first" }),
    second: deterministicId("candidate", { recordId, slot: "second" })
  };
}

function caseFromEvaluation(evaluation, datasetId, warnings, path) {
  const ids = candidateIds(evaluation.id);
  const reviewCase = createCase({
    id: deterministicId("case", { recordId: evaluation.id }),
    datasetId,
    externalId: evaluation.id,
    input: evaluation.prompt,
    candidates: [
      { id: ids.first, content: evaluation.responseA, source: null, metadata: { legacyRecordId: evaluation.id, legacyPosition: "first" } },
      { id: ids.second, content: evaluation.responseB, source: null, metadata: { legacyRecordId: evaluation.id, legacyPosition: "second" } }
    ],
    metadata: { legacyRecordId: evaluation.id, title: evaluation.title, tags: evaluation.tags }
  });
  if (!evaluation.prompt.trim() || !evaluation.responseA.trim() || !evaluation.responseB.trim()) warnings.push(warning("incomplete-case-content", path, "The migrated case is a draft because one or more v2 text fields were empty."));
  return reviewCase;
}

function reviewFromEvaluation(evaluation, assignmentId, snapshot, reviewCase) {
  const ids = reviewCase.candidates.map((candidate) => candidate.id);
  const ratings = {
    [ids[0]]: { ...evaluation.ratings.A },
    [ids[1]]: { ...evaluation.ratings.B }
  };
  const winner = evaluation.winner === "A" ? ids[0] : evaluation.winner === "B" ? ids[1] : evaluation.winner === "tie" ? "tie" : "pending";
  const computed = {
    scoreByCandidate: { [ids[0]]: evaluation.scores.A.score, [ids[1]]: evaluation.scores.B.score },
    winner
  };
  return createReview({
    id: deterministicId("review", { recordId: evaluation.id }),
    assignmentId,
    revision: 1,
    rubricSnapshot: snapshot,
    ratings,
    computed,
    preference: winner,
    confidence: evaluation.confidence,
    rationale: evaluation.notes,
    issueLabels: evaluation.tags.map((tag) => tag.toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter(Boolean).slice(0, 8),
    state: evaluation.status === "complete" ? "complete" : "draft",
    createdAt: evaluation.createdAt,
    updatedAt: evaluation.updatedAt,
    completedAt: evaluation.status === "complete" ? evaluation.updatedAt || evaluation.createdAt : null
  });
}

function ensureDate(value, fallback) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback; }

/**
 * Convert a v2 backup and optional v2 queue into one deterministic v3 document.
 * The function is pure with respect to its input and requires a clock/id factory
 * so tests and recovery tools never depend on wall time or random IDs.
 */
export function migrateV2ToV3(input, { now, idFactory } = {}) {
  const fallbackNow = requireClock(now);
  const factory = () => requireIdFactory(idFactory);
  const source = input && typeof input === "object" ? input : {};
  // The browser's v2 localStorage stores a plain evaluation array, while
  // exported backups wrap the same records in an `{ evaluations: [...] }`
  // object. Accept both shapes so an in-browser migration does not silently
  // produce an empty v3 workspace.
  const evaluations = asArray(
    source.evaluations
      || (Array.isArray(source.export) ? source.export : source.export?.evaluations)
  );
  const queueCases = asArray(source.queue?.cases || source.queueCases || source.cases);
  const warnings = [];
  let repaired = 0;
  let skipped = 0;
  const rubricsById = new Map();
  const datasetsById = new Map();
  const casesByLegacyId = new Map();
  const sessionsByDataset = new Map();
  const assignmentsByCase = new Map();
  const reviews = [];
  const assignments = [];
  const auditEvents = [];

  function ensureRubric(snapshot, profile, path) {
    const key = snapshot.rubricId || profile.id;
    if (!rubricsById.has(key)) rubricsById.set(key, rubricFromSnapshot(snapshot, profile, warnings, path));
    return rubricsById.get(key);
  }
  function ensureDataset(rubric, isDemo, createdAt) {
    const key = isDemo ? "demo" : rubric.id;
    if (!datasetsById.has(key)) datasetsById.set(key, createDataset({ id: deterministicId("dataset", key), name: isDemo ? "Migrated demo records" : `Migrated ${rubric.name}`, description: isDemo ? "Sample records separated during v2 migration." : "Records migrated from an EvalForge v2 workspace.", rubricRef: rubric.id, createdAt, isDemo }, { idFactory: factory, now: () => fallbackNow }));
    return datasetsById.get(key);
  }
  function ensureSession(dataset, rubric, createdAt) {
    if (!sessionsByDataset.has(dataset.id)) sessionsByDataset.set(dataset.id, createReviewSession({ id: deterministicId("session", dataset.id), datasetId: dataset.id, rubricRef: rubric.id, reviewerId: LEGACY_REVIEWER_ID, blindMode: false, seed: `migrated-v2-${dataset.id}`, state: "active", createdAt }, { idFactory: factory, now: () => fallbackNow }));
    return sessionsByDataset.get(dataset.id);
  }
  function addEvaluation(raw, index) {
    const path = `evaluations[${index}]`;
    const evaluation = normalizeEvaluation(raw, { idFactory: () => deterministicId("evaluation", { index, raw }) });
    if (!evaluation) {
      skipped += 1;
      warnings.push(warning("invalid-evaluation", path, "The v2 entry was skipped because it has no recognized evaluation fields."));
      return;
    }
    const profile = getRubricProfile(evaluation.rubricId);
    const snapshot = snapshotForEvaluation(evaluation, profile, warnings, path);
    if (snapshot.repairReason) repaired += 1;
    const rubric = ensureRubric(snapshot, profile, path);
    const dataset = ensureDataset(rubric, evaluation.isSample, ensureDate(evaluation.createdAt, fallbackNow));
    const session = ensureSession(dataset, rubric, ensureDate(evaluation.createdAt, fallbackNow));
    const reviewCase = caseFromEvaluation(evaluation, dataset.id, warnings, path);
    casesByLegacyId.set(evaluation.id, reviewCase);
    const assignmentId = deterministicId("assignment", { recordId: evaluation.id });
    const reviewId = deterministicId("review", { recordId: evaluation.id });
    const review = reviewFromEvaluation(evaluation, assignmentId, snapshot, reviewCase);
    const assignment = createAssignment({ id: assignmentId, sessionId: session.id, caseId: reviewCase.id, displayOrder: reviewCase.candidates.map((candidate) => candidate.id), state: review.state === "complete" ? "complete" : "in_progress", skipReason: null, reviewId: review.state === "complete" ? reviewId : null }, { idFactory: factory });
    assignmentsByCase.set(reviewCase.id, assignment);
    assignments.push(assignment);
    reviews.push(review);
    if (review.state === "complete") auditEvents.push(createAuditEvent({ id: deterministicId("audit", { recordId: evaluation.id, action: "migrated-complete" }), entityType: "review", entityId: review.id, action: "migrated_complete", actorId: LEGACY_REVIEWER_ID, at: ensureDate(evaluation.updatedAt, fallbackNow), details: { sourceRecordId: evaluation.id, blindMode: false } }, { idFactory: factory, now: () => fallbackNow }));
  }

  evaluations.forEach(addEvaluation);
  queueCases.forEach((queueCase, index) => {
    const path = `queue.cases[${index}]`;
    if (!queueCase || typeof queueCase !== "object") {
      skipped += 1;
      warnings.push(warning("invalid-queue-case", path, "The queue entry was skipped because it is not an object."));
      return;
    }
    if (queueCase.evaluationId && casesByLegacyId.has(queueCase.evaluationId)) {
      const existing = casesByLegacyId.get(queueCase.evaluationId);
      if (queueCase.prompt && queueCase.prompt !== existing.input) warnings.push(warning("linked-queue-content-diff", path, "The linked queue entry had different text; the saved evaluation content was preserved."));
      const assignment = assignmentsByCase.get(existing.id);
      if (queueCase.status === "skipped" && assignment.state !== "complete") {
        const replacement = createAssignment({ ...assignment, state: "skipped", skipReason: queueCase.skipReason || "Skipped during v2 review.", reviewId: null }, { idFactory: factory });
        assignments.splice(assignments.indexOf(assignment), 1, replacement);
        assignmentsByCase.set(existing.id, replacement);
        const session = sessionsByDataset.get(existing.datasetId);
        auditEvents.push(createAuditEvent({ id: deterministicId("audit", { queueId: queueCase.id, action: "migrated-skip" }), entityType: "assignment", entityId: replacement.id, action: "migrated_skip", actorId: LEGACY_REVIEWER_ID, at: ensureDate(queueCase.updatedAt, fallbackNow), details: { sourceQueueId: queueCase.id, reason: replacement.skipReason } }, { idFactory: factory, now: () => fallbackNow }));
        if (session?.state === "active") session.state = "active";
      }
      return;
    }
    const rubricId = typeof queueCase.rubricId === "string" ? queueCase.rubricId : "general";
    const profile = getRubricProfile(rubricId);
    const snapshot = snapshotForEvaluation({ rubricId, rubricSnapshot: null }, profile, warnings, path);
    repaired += 1;
    const rubric = ensureRubric(snapshot, profile, path);
    const dataset = ensureDataset(rubric, false, ensureDate(queueCase.createdAt, fallbackNow));
    const session = ensureSession(dataset, rubric, ensureDate(queueCase.createdAt, fallbackNow));
    const synthetic = {
      id: queueCase.id || deterministicId("queue", { index, queueCase }),
      title: queueCase.title || "",
      prompt: typeof queueCase.prompt === "string" ? queueCase.prompt : "",
      responseA: typeof queueCase.responseA === "string" ? queueCase.responseA : "",
      responseB: typeof queueCase.responseB === "string" ? queueCase.responseB : "",
      tags: [],
      isSample: false
    };
    const reviewCase = caseFromEvaluation(synthetic, dataset.id, warnings, path);
    casesByLegacyId.set(synthetic.id, reviewCase);
    const state = queueCase.status === "completed" ? "complete" : queueCase.status === "skipped" ? "skipped" : queueCase.status === "in_progress" ? "in_progress" : "pending";
    const assignment = createAssignment({ id: deterministicId("assignment", { queueId: synthetic.id }), sessionId: session.id, caseId: reviewCase.id, displayOrder: reviewCase.candidates.map((candidate) => candidate.id), state, skipReason: state === "skipped" ? queueCase.skipReason || "Skipped during v2 review." : null, reviewId: null }, { idFactory: factory });
    assignments.push(assignment);
    assignmentsByCase.set(reviewCase.id, assignment);
    if (state === "skipped") auditEvents.push(createAuditEvent({ id: deterministicId("audit", { queueId: synthetic.id, action: "migrated-skip" }), entityType: "assignment", entityId: assignment.id, action: "migrated_skip", actorId: LEGACY_REVIEWER_ID, at: ensureDate(queueCase.updatedAt, fallbackNow), details: { sourceQueueId: synthetic.id, reason: assignment.skipReason } }, { idFactory: factory, now: () => fallbackNow }));
  });

  const createdAt = ensureDate(source.exportedAt, fallbackNow);
  const rubricList = [...rubricsById.values()];
  const datasetList = [...datasetsById.values()];
  const workspace = createWorkspace({ id: factory(), name: "Migrated EvalForge workspace", createdAt, updatedAt: createdAt, rubricIds: rubricList.map((rubric) => rubric.id), datasetIds: datasetList.map((dataset) => dataset.id), settings: { migratedFrom: "v2", blindHistory: "not_blind" } }, { idFactory: factory, now: () => fallbackNow });
  const document = { schemaVersion: 3, workspace, rubrics: rubricList, datasets: datasetList, cases: [...casesByLegacyId.values()], sessions: [...sessionsByDataset.values()], assignments, reviews, auditEvents };
  assertWorkspaceDocument(document);
  return {
    workspace: document,
    sourceHash: `fnv1a-${stableHash(source)}`,
    report: { accepted: evaluations.length + queueCases.length - skipped, repaired, skipped, warnings }
  };
}
