import {
  DEFAULT_RUBRIC,
  DEFAULT_TIE_THRESHOLD,
  getRubricProfile,
  RUBRIC_VERSION,
  SCORING_ALGORITHM_VERSION,
  calculateDimensionContributions,
  calculateWeightedScore,
  determineWinner,
  emptyRatings
} from "./scoring.js";

export const CURRENT_SCHEMA_VERSION = 2;

const TEXT_FIELDS = ["title", "prompt", "responseA", "responseB", "notes"];
const RECOGNIZED_FIELDS = new Set([
  "id",
  "isSample",
  "rubricId",
  "title",
  "prompt",
  "responseA",
  "responseB",
  "ratings",
  "createdAt",
  "updatedAt"
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRecognizedContent(value) {
  return isPlainObject(value) && Object.keys(value).some((key) => RECOGNIZED_FIELDS.has(key));
}

function validDate(value) {
  return typeof value === "string" && value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 80;
}

function normalizeRating(value) {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0;
}

function normalizeRatings(value, rubric = DEFAULT_RUBRIC) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(rubric.map(({ id }) => [id, normalizeRating(source[id])]));
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, tags) => tags.indexOf(tag) === index)
    .slice(0, 8);
}

export function createId() {
  return globalThis.crypto?.randomUUID?.() || `eval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createBlankEvaluation(id = createId(), rubricId = "general") {
  const rubricProfile = getRubricProfile(rubricId);
  const rubric = rubricProfile.dimensions;
  const ratings = { A: emptyRatings(rubric), B: emptyRatings(rubric) };
  const scores = {
    A: calculateWeightedScore(ratings.A, rubric),
    B: calculateWeightedScore(ratings.B, rubric)
  };

  return {
    recordVersion: CURRENT_SCHEMA_VERSION,
    id,
    isSample: false,
    rubricId: rubricProfile.id,
    title: "",
    createdAt: null,
    updatedAt: null,
    status: "draft",
    prompt: "",
    responseA: "",
    responseB: "",
    ratings,
    scores,
    winner: "pending",
    confidence: 80,
    tags: [],
    notes: "",
    rubricSnapshot: createRubricSnapshot(ratings, rubric, rubricProfile.tieThreshold, rubricProfile)
  };
}

export function createRubricSnapshot(ratings, rubric = DEFAULT_RUBRIC, tieThreshold = DEFAULT_TIE_THRESHOLD, profile = null) {
  return {
    rubricId: profile?.id || "general",
    rubricName: profile?.name || "General review",
    rubricVersion: profile?.version || RUBRIC_VERSION,
    scoringAlgorithmVersion: SCORING_ALGORITHM_VERSION,
    tieThreshold,
    weights: Object.fromEntries(rubric.map(({ id, weight }) => [id, weight])),
    dimensions: rubric.map(({ id, label, description = "", weight }) => ({ id, label, description, weight })),
    contributions: {
      A: calculateDimensionContributions(ratings?.A, rubric),
      B: calculateDimensionContributions(ratings?.B, rubric)
    },
    auditStatus: "verified",
    repairReason: null
  };
}

function rubricSnapshotFailure(reason, fallbackSnapshot) {
  return {
    snapshot: {
      ...fallbackSnapshot,
      auditStatus: "fallback",
      repairReason: reason
    },
    repaired: true,
    repairReason: reason
  };
}

/**
 * Keep a persisted rubric as the source of truth. A fallback is marked so it
 * can be repaired later and is never mistaken for a fully audited review.
 */
export function normalizeRubricSnapshot(value, fallbackProfile = getRubricProfile("general"), ratings = {}) {
  const fallbackSnapshot = createRubricSnapshot(
    ratings,
    fallbackProfile.dimensions,
    fallbackProfile.tieThreshold,
    fallbackProfile
  );
  if (!isPlainObject(value)) return rubricSnapshotFailure("missing-rubric-snapshot", fallbackSnapshot);

  const dimensions = Array.isArray(value.dimensions) ? value.dimensions : null;
  if (!dimensions || dimensions.length === 0) return rubricSnapshotFailure("missing-rubric-dimensions", fallbackSnapshot);

  const seen = new Set();
  const normalizedDimensions = [];
  for (const dimension of dimensions) {
    if (!isPlainObject(dimension)) return rubricSnapshotFailure("invalid-rubric-dimension", fallbackSnapshot);
    const id = typeof dimension.id === "string" ? dimension.id.trim() : "";
    const label = typeof dimension.label === "string" ? dimension.label.trim() : "";
    const weight = Number(dimension.weight);
    if (!id || !label || seen.has(id) || !Number.isFinite(weight) || weight <= 0) {
      return rubricSnapshotFailure("invalid-rubric-dimension", fallbackSnapshot);
    }
    seen.add(id);
    normalizedDimensions.push({
      id,
      label,
      description: typeof dimension.description === "string" ? dimension.description : "",
      weight
    });
  }

  const totalWeight = normalizedDimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return rubricSnapshotFailure("invalid-rubric-weights", fallbackSnapshot);

  const rubricId = typeof value.rubricId === "string" && value.rubricId.trim()
    ? value.rubricId.trim()
    : fallbackProfile.id;
  const rubricVersion = typeof value.rubricVersion === "string" && value.rubricVersion.trim()
    ? value.rubricVersion.trim()
    : null;
  if (!rubricVersion) return rubricSnapshotFailure("missing-rubric-version", fallbackSnapshot);

  const tieThreshold = Number(value.tieThreshold);
  if (!Number.isFinite(tieThreshold) || tieThreshold < 0) return rubricSnapshotFailure("invalid-tie-threshold", fallbackSnapshot);

  const weights = Object.fromEntries(normalizedDimensions.map(({ id, weight }) => [id, weight]));
  const algorithmVersion = typeof value.scoringAlgorithmVersion === "string" && value.scoringAlgorithmVersion.trim()
    ? value.scoringAlgorithmVersion.trim()
    : null;
  const savedAuditStatus = ["verified", "limited", "fallback"].includes(value.auditStatus)
    ? value.auditStatus
    : null;
  const savedRepairReason = typeof value.repairReason === "string" && value.repairReason.trim()
    ? value.repairReason.trim()
    : null;
  const auditStatus = savedAuditStatus === "fallback" && savedRepairReason
    ? "fallback"
    : algorithmVersion
      ? "verified"
      : "limited";
  const repairReason = auditStatus === "fallback" || !algorithmVersion
    ? savedRepairReason || "missing-scoring-algorithm-version"
    : null;
  const normalized = {
    rubricId,
    rubricName: typeof value.rubricName === "string" && value.rubricName.trim() ? value.rubricName.trim() : "Saved rubric",
    rubricVersion,
    ...(algorithmVersion ? { scoringAlgorithmVersion: algorithmVersion } : {}),
    tieThreshold,
    weights,
    dimensions: normalizedDimensions,
    contributions: {
      A: calculateDimensionContributions(ratings?.A, normalizedDimensions),
      B: calculateDimensionContributions(ratings?.B, normalizedDimensions)
    },
    auditStatus,
    repairReason
  };
  return {
    snapshot: normalized,
    repaired: !algorithmVersion,
    repairReason
  };
}

export function normalizeEvaluation(value, { idFactory = createId } = {}) {
  if (!hasRecognizedContent(value)) return null;

  const rawId = typeof value.id === "string" ? value.id.trim() : "";
  const id = rawId && rawId.length <= 128 ? rawId : idFactory();
  const rubricProfile = getRubricProfile(typeof value.rubricId === "string" ? value.rubricId : "general");
  const snapshotResult = normalizeRubricSnapshot(value.rubricSnapshot, rubricProfile, value.ratings);
  const rubric = snapshotResult.snapshot.dimensions;
  const ratings = {
    A: normalizeRatings(value.ratings?.A, rubric),
    B: normalizeRatings(value.ratings?.B, rubric)
  };
  const scores = {
    A: calculateWeightedScore(ratings.A, rubric),
    B: calculateWeightedScore(ratings.B, rubric)
  };
  const winner = scores.A.isComplete && scores.B.isComplete
    ? determineWinner(scores.A.score, scores.B.score, snapshotResult.snapshot.tieThreshold)
    : "pending";
  const createdAt = validDate(value.createdAt);
  const updatedAt = validDate(value.updatedAt) || createdAt;

  const rubricSnapshot = {
    ...snapshotResult.snapshot,
    contributions: {
      A: calculateDimensionContributions(ratings.A, rubric),
      B: calculateDimensionContributions(ratings.B, rubric)
    }
  };

  const normalized = {
    recordVersion: CURRENT_SCHEMA_VERSION,
    id,
    isSample: value.isSample === true,
    rubricId: snapshotResult.snapshot.rubricId,
    title: "",
    createdAt,
    updatedAt,
    status: "draft",
    prompt: "",
    responseA: "",
    responseB: "",
    ratings,
    scores,
    winner,
    confidence: clampConfidence(value.confidence),
    tags: normalizeTags(value.tags),
    notes: "",
    rubricSnapshot
  };

  for (const field of TEXT_FIELDS) {
    normalized[field] = typeof value[field] === "string" ? value[field] : "";
  }

  const canBeComplete = normalized.prompt.trim()
    && normalized.responseA.trim()
    && normalized.responseB.trim()
    && normalized.notes.trim().length >= 20
    && scores.A.isComplete
    && scores.B.isComplete;
  normalized.status = value.status === "complete" && canBeComplete ? "complete" : "draft";
  return normalized;
}

export function normalizeEvaluationCollection(value, { idFactory = createId } = {}) {
  if (!Array.isArray(value)) {
    return {
      evaluations: [],
      report: { total: 0, accepted: 0, repaired: 0, skipped: 1 }
    };
  }

  let repaired = 0;
  let rubricSnapshotRepairs = 0;
  const rubricSnapshotRepairReasons = {};
  let skipped = 0;
  const seenIds = new Set();
  const evaluations = [];

  for (const item of value) {
    const normalized = normalizeEvaluation(item, { idFactory });
    if (!normalized) {
      skipped += 1;
      continue;
    }

    if (seenIds.has(normalized.id)) {
      normalized.id = idFactory();
    }
    seenIds.add(normalized.id);

    if (JSON.stringify(normalized) !== JSON.stringify(item)) repaired += 1;
    if (normalized.rubricSnapshot.repairReason) {
      rubricSnapshotRepairs += 1;
      const reason = normalized.rubricSnapshot.repairReason;
      rubricSnapshotRepairReasons[reason] = (rubricSnapshotRepairReasons[reason] || 0) + 1;
    }
    evaluations.push(normalized);
  }

  return {
    evaluations,
    report: {
      total: value.length,
      accepted: evaluations.length,
      repaired,
      rubricSnapshotRepairs,
      rubricSnapshotRepairReasons,
      skipped
    }
  };
}
