import {
  DEFAULT_RUBRIC,
  DEFAULT_TIE_THRESHOLD,
  RUBRIC_VERSION,
  calculateDimensionContributions,
  calculateWeightedScore,
  determineWinner,
  emptyRatings
} from "./scoring.js";

export const CURRENT_SCHEMA_VERSION = 2;

const TEXT_FIELDS = ["title", "prompt", "responseA", "responseB", "notes"];
const RECOGNIZED_FIELDS = new Set([
  "id",
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

function normalizeRatings(value) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(DEFAULT_RUBRIC.map(({ id }) => [id, normalizeRating(source[id])]));
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

export function createBlankEvaluation(id = createId()) {
  const ratings = { A: emptyRatings(), B: emptyRatings() };
  const scores = {
    A: calculateWeightedScore(ratings.A),
    B: calculateWeightedScore(ratings.B)
  };

  return {
    recordVersion: CURRENT_SCHEMA_VERSION,
    id,
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
    rubricSnapshot: createRubricSnapshot(ratings)
  };
}

export function createRubricSnapshot(ratings, rubric = DEFAULT_RUBRIC, tieThreshold = DEFAULT_TIE_THRESHOLD) {
  return {
    rubricVersion: RUBRIC_VERSION,
    tieThreshold,
    weights: Object.fromEntries(rubric.map(({ id, weight }) => [id, weight])),
    dimensions: rubric.map(({ id, label, weight }) => ({ id, label, weight })),
    contributions: {
      A: calculateDimensionContributions(ratings?.A, rubric),
      B: calculateDimensionContributions(ratings?.B, rubric)
    }
  };
}

export function normalizeEvaluation(value, { idFactory = createId } = {}) {
  if (!hasRecognizedContent(value)) return null;

  const rawId = typeof value.id === "string" ? value.id.trim() : "";
  const id = rawId && rawId.length <= 128 ? rawId : idFactory();
  const ratings = {
    A: normalizeRatings(value.ratings?.A),
    B: normalizeRatings(value.ratings?.B)
  };
  const scores = {
    A: calculateWeightedScore(ratings.A),
    B: calculateWeightedScore(ratings.B)
  };
  const winner = scores.A.isComplete && scores.B.isComplete
    ? determineWinner(scores.A.score, scores.B.score)
    : "pending";
  const createdAt = validDate(value.createdAt);
  const updatedAt = validDate(value.updatedAt) || createdAt;

  const normalized = {
    recordVersion: CURRENT_SCHEMA_VERSION,
    id,
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
    rubricSnapshot: createRubricSnapshot(ratings)
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
    evaluations.push(normalized);
  }

  return {
    evaluations,
    report: {
      total: value.length,
      accepted: evaluations.length,
      repaired,
      skipped
    }
  };
}
