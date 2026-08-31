import { winnerCandidateId } from "../domain/blind-session.js";
import { SCORING_ALGORITHM_VERSION, calculateWeightedScore } from "../scoring.js";

function text(value) { return typeof value === "string" ? value.trim() : ""; }

function candidateIds(reviewCase) {
  return Array.isArray(reviewCase?.candidates) ? reviewCase.candidates.map((candidate) => candidate.id) : [];
}

function dimensionsFor(rubric) { return Array.isArray(rubric?.dimensions) ? rubric.dimensions : []; }

function emptyRatings(ids, rubric) {
  return Object.fromEntries(ids.map((candidateId) => [candidateId, Object.fromEntries(dimensionsFor(rubric).map(({ id }) => [id, 0]))]));
}

export function createEmptyV3Draft(reviewCase, rubric) {
  return {
    ratings: emptyRatings(candidateIds(reviewCase), rubric),
    preference: "pending",
    confidence: 3,
    confidenceScale: "anchored-1-5",
    preferenceEvidence: "",
    rationale: "",
    issueLabels: []
  };
}

export function normalizeV3Draft(reviewCase, rubric, input = {}) {
  const ids = candidateIds(reviewCase);
  const dimensions = dimensionsFor(rubric);
  const defaults = createEmptyV3Draft(reviewCase, rubric);
  const ratings = Object.fromEntries(ids.map((candidateId) => [candidateId, Object.fromEntries(dimensions.map(({ id }) => {
    const value = input.ratings?.[candidateId]?.[id];
    return [id, Number.isInteger(value) && value >= 1 && value <= 5 ? value : 0];
  }))]));
  const preference = ids.includes(input.preference) || input.preference === "tie" ? input.preference : defaults.preference;
  const confidence = Number.isInteger(input.confidence) && input.confidence >= 1 && input.confidence <= 5 ? input.confidence : defaults.confidence;
  return {
    ratings,
    preference,
    confidence,
    confidenceScale: "anchored-1-5",
    preferenceEvidence: text(input.preferenceEvidence),
    rationale: typeof input.rationale === "string" ? input.rationale : "",
    issueLabels: Array.isArray(input.issueLabels) ? input.issueLabels.filter((label) => typeof label === "string") : []
  };
}

function snapshotFor(rubric) {
  return {
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    scoringAlgorithmVersion: SCORING_ALGORITHM_VERSION,
    tieThreshold: rubric.tieThreshold,
    dimensions: dimensionsFor(rubric).map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      description: dimension.description || "",
      weight: dimension.weight,
      anchors: { ...(dimension.anchors || {}) }
    }))
  };
}

export function buildV3ReviewInput(reviewCase, rubric, draft = {}) {
  const ids = candidateIds(reviewCase);
  const normalized = normalizeV3Draft(reviewCase, rubric, draft);
  const scores = Object.fromEntries(ids.map((candidateId) => [candidateId, calculateWeightedScore(normalized.ratings[candidateId], dimensionsFor(rubric)).score]));
  const allRated = ids.every((candidateId) => dimensionsFor(rubric).every(({ id }) => normalized.ratings[candidateId][id] >= 1));
  const computed = { scoreByCandidate: scores, winner: allRated ? winnerCandidateId(scores, rubric.tieThreshold) : "pending" };
  const rationaleReady = normalized.rationale.trim().length >= 20;
  const preferenceReady = ids.includes(normalized.preference) || normalized.preference === "tie";
  const preferenceDisagrees = preferenceReady
    && normalized.preference !== "tie"
    && computed.winner !== "pending"
    && computed.winner !== "tie"
    && normalized.preference !== computed.winner;
  const preferenceEvidenceReady = !preferenceDisagrees || normalized.preferenceEvidence.trim().length >= 20;
  const ready = allRated && rationaleReady && preferenceReady && preferenceEvidenceReady;
  const missing = [];
  if (!allRated) missing.push("Rate every dimension for both candidates.");
  if (!preferenceReady) missing.push("Choose a preferred candidate or tie.");
  if (!rationaleReady) missing.push("Add at least 20 characters of rationale.");
  if (!preferenceEvidenceReady) missing.push("Explain why your preference differs from the calculated winner.");
  return {
    ...normalized,
    computed,
    rubricSnapshot: snapshotFor(rubric),
    ready,
    missing
  };
}

export function reviewDraftFromPersisted(reviewCase, rubric, review) {
  return normalizeV3Draft(reviewCase, rubric, review || {});
}
