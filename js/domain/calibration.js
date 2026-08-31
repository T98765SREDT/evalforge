import { createRubric } from "./entities.js";
import { deterministicId, stableHash } from "./ids.js";

export const CONFIDENCE_ANCHORS = Object.freeze({
  1: "Very uncertain — I may be missing important evidence.",
  2: "Somewhat uncertain — the evidence is incomplete or mixed.",
  3: "Moderately confident — the main evidence supports my judgement.",
  4: "Very confident — the evidence is clear with only minor uncertainty.",
  5: "Extremely confident — the evidence is decisive and consistent."
});

const ANCHORED_SCALE = "anchored-1-5";
const LEGACY_SCALE = "legacy-0-100";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function integer(value, name, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer from ${min} through ${max}.`);
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value.trim();
}

/**
 * Convert a legacy percentage to the nearest anchored confidence level. The
 * conversion is intentionally explicit so old records can be displayed
 * without pretending that a percentage had more precision than it carried.
 */
export function confidenceAnchor(value, scale = ANCHORED_SCALE) {
  if (scale === LEGACY_SCALE) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError("Legacy confidence must be between 0 and 100.");
    return Math.min(5, Math.max(1, Math.round(1 + (value / 100) * 4)));
  }
  return integer(value, "confidence", { min: 1, max: 5 });
}

export function confidenceLabel(value, scale = ANCHORED_SCALE) {
  const anchor = confidenceAnchor(value, scale);
  return CONFIDENCE_ANCHORS[anchor];
}

export function isPreferenceDisagreement(review) {
  object(review, "review");
  const computed = review.computed?.winner;
  const preference = review.preference;
  return Boolean(computed && preference && computed !== "pending" && preference !== "pending" && computed !== preference);
}

export function requiresPreferenceEvidence(review, minimumCharacters = 20) {
  object(review, "review");
  if (!isPreferenceDisagreement(review)) return false;
  const evidence = typeof review.preferenceEvidence === "string" ? review.preferenceEvidence.trim() : "";
  return evidence.length < minimumCharacters;
}

export function lockRubric(rubric, lockedAt) {
  object(rubric, "rubric");
  text(lockedAt, "lockedAt");
  if (rubric.lockedAt) return structuredClone(rubric);
  return { ...structuredClone(rubric), lockedAt };
}

export function cloneRubricVersion(rubric, { id, version, name, now } = {}) {
  object(rubric, "rubric");
  const nextId = text(id || deterministicId("rubric", { source: rubric.id, version: version || rubric.version } ), "id");
  const nextVersion = text(version || `${rubric.version}-copy`, "version");
  const createdAt = typeof now === "function" ? now() : null;
  const clone = createRubric({
    ...structuredClone(rubric),
    id: nextId,
    version: nextVersion,
    name: name || `${rubric.name} (copy)`,
    lockedAt: null,
    checksum: undefined,
    ...(createdAt ? { createdAt } : {})
  }, { idFactory: () => nextId });
  return clone;
}

function rankFor(seed, assignment) {
  return stableHash(`${seed}|${assignment.id}|${assignment.caseId || ""}`);
}

/** Select a deterministic, documented 5–10% calibration sample. */
export function selectCalibrationRepeats(assignments = [], { fraction = 0.1, seed = "calibration" } = {}) {
  if (!Array.isArray(assignments)) throw new TypeError("assignments must be an array.");
  if (!Number.isFinite(fraction) || fraction < 0.05 || fraction > 0.1) throw new TypeError("fraction must be between 0.05 and 0.1.");
  const candidates = assignments.filter((assignment) => assignment && typeof assignment.id === "string" && !assignment.repeatOf && assignment.calibration !== true);
  if (!candidates.length) return [];
  const count = Math.max(1, Math.round(candidates.length * fraction));
  return [...candidates].sort((left, right) => rankFor(seed, left).localeCompare(rankFor(seed, right)) || left.id.localeCompare(right.id)).slice(0, count).map((assignment) => assignment.id);
}

export function createCalibrationRepeat(assignment, { id, reverseDisplayOrder = true } = {}) {
  object(assignment, "assignment");
  text(assignment.id, "assignment.id");
  if (!Array.isArray(assignment.displayOrder) || assignment.displayOrder.length < 2) throw new TypeError("assignment.displayOrder must contain at least two candidate ids.");
  const repeatId = id || deterministicId("assignment-repeat", assignment.id);
  return {
    ...structuredClone(assignment),
    id: text(repeatId, "id"),
    repeatOf: assignment.id,
    calibration: true,
    state: "pending",
    reviewId: null,
    skipReason: null,
    displayOrder: reverseDisplayOrder ? [...assignment.displayOrder].reverse() : [...assignment.displayOrder]
  };
}

function preferenceFor(record, key) {
  const value = record?.[key] ?? record?.review?.[key];
  return value === "pending" || value === "tie" || typeof value === "string" ? value : null;
}

function ratingsFor(record) {
  return record?.ratings || record?.review?.ratings || {};
}

function numericRatings(ratings) {
  const values = [];
  for (const candidate of Object.values(ratings || {})) {
    if (Number.isInteger(candidate)) values.push(candidate);
    else if (candidate && typeof candidate === "object") {
      for (const value of Object.values(candidate)) if (Number.isInteger(value)) values.push(value);
    }
  }
  return values;
}

function ratingDelta(left, right) {
  const values = [];
  const candidateIds = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const candidateId of candidateIds) {
    const a = left?.[candidateId];
    const b = right?.[candidateId];
    if (Number.isInteger(a) && Number.isInteger(b)) values.push(Math.abs(a - b));
    else if (a && typeof a === "object" && b && typeof b === "object") {
      for (const dimension of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (Number.isInteger(a[dimension]) && Number.isInteger(b[dimension])) values.push(Math.abs(a[dimension] - b[dimension]));
      }
    }
  }
  return values;
}

/**
 * Calculate repeat consistency without inventing reviewer identities. Each
 * item pairs an original review with its calibration repeat and may include
 * explicit reviewerId values when real multi-reviewer data exists.
 */
export function computeCalibrationMetrics(records = []) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array.");
  const usable = records.filter((record) => record && record.original && record.repeat);
  let preferenceCompared = 0;
  let preferenceAgreements = 0;
  const deltas = [];
  let positionCompared = 0;
  let positionSwitches = 0;
  const reviewerIds = new Set();

  for (const record of usable) {
    const originalPreference = preferenceFor(record.original, "preference");
    const repeatPreference = preferenceFor(record.repeat, "preference");
    if (originalPreference && repeatPreference && originalPreference !== "pending" && repeatPreference !== "pending") {
      preferenceCompared += 1;
      if (originalPreference === repeatPreference) preferenceAgreements += 1;
    }
    deltas.push(...ratingDelta(ratingsFor(record.original), ratingsFor(record.repeat)));
    const originalOrder = record.original.displayOrder || record.original.assignment?.displayOrder;
    const repeatOrder = record.repeat.displayOrder || record.repeat.assignment?.displayOrder;
    if (Array.isArray(originalOrder) && Array.isArray(repeatOrder)) {
      positionCompared += 1;
      if (JSON.stringify(originalOrder) !== JSON.stringify(repeatOrder)) positionSwitches += 1;
    }
    for (const id of [record.original.reviewerId, record.repeat.reviewerId]) if (typeof id === "string" && id.trim()) reviewerIds.add(id.trim());
  }

  const multiReviewer = reviewerIds.size > 1;
  return {
    repeats: usable.length,
    preference: {
      agreements: preferenceAgreements,
      compared: preferenceCompared,
      agreementRate: preferenceCompared ? preferenceAgreements / preferenceCompared : null
    },
    ratingMeanAbsoluteDelta: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
    ratingComparisons: deltas.length,
    position: {
      switched: positionSwitches,
      compared: positionCompared,
      switchRate: positionCompared ? positionSwitches / positionCompared : null
    },
    reviewerStats: multiReviewer ? { reviewerCount: reviewerIds.size, available: true } : null
  };
}
