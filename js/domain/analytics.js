import { computeCalibrationMetrics } from "./calibration.js";

export const ANALYTICS_FILTER_DEFAULTS = Object.freeze({
  datasetId: "all",
  rubricId: "all",
  tag: "all",
  reviewerId: "all",
  from: "",
  to: "",
  includeSamples: false
});

const WORKFLOW_STATES = new Set(["complete", "completed", "skipped", "pending", "in_progress"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizeFilters(filters = {}) {
  return { ...ANALYTICS_FILTER_DEFAULTS, ...(filters || {}) };
}

function normalizedDate(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "";
  return value;
}

function isWithinDateRange(value, filters) {
  const date = normalizedDate(value);
  if (filters.from && (!date || date.slice(0, 10) < filters.from)) return false;
  if (filters.to && (!date || date.slice(0, 10) > filters.to)) return false;
  return true;
}

function tagsFor(...values) {
  return [...new Set(values.flatMap((value) => asArray(value).map(text).filter(Boolean)))];
}

function normalizeState(value) {
  if (value === "completed") return "complete";
  return WORKFLOW_STATES.has(value) ? value : "draft";
}

function createLegacyRows(evaluations, queueCases) {
  const records = asArray(evaluations).filter((item) => item && typeof item === "object");
  const byId = new Map(records.map((item) => [text(item.id), item]).filter(([id]) => id));
  const linkedEvaluationIds = new Set();
  const rows = [];

  for (const queueCase of asArray(queueCases)) {
    if (!queueCase || typeof queueCase !== "object") continue;
    const evaluation = queueCase.evaluationId ? byId.get(text(queueCase.evaluationId)) : null;
    if (evaluation) linkedEvaluationIds.add(evaluation.id);
    const state = normalizeState(queueCase.status);
    const sourceRecord = evaluation || queueCase;
    const scores = sourceRecord.scores || {};
    rows.push({
      id: evaluation?.id || text(queueCase.id) || `queue-${rows.length + 1}`,
      assignmentId: text(queueCase.id) || null,
      caseId: text(queueCase.id) || null,
      datasetId: text(evaluation?.datasetId || queueCase.datasetId) || null,
      datasetName: text(queueCase.datasetName || evaluation?.datasetName),
      rubricId: text(evaluation?.rubricId || queueCase.rubricId) || "general",
      reviewerId: text(evaluation?.reviewerId || queueCase.reviewerId) || null,
      tags: tagsFor(evaluation?.tags, queueCase.tags),
      isDemo: evaluation?.isSample === true || queueCase.isSample === true,
      state,
      date: normalizedDate(evaluation?.updatedAt || queueCase.updatedAt || evaluation?.createdAt || queueCase.createdAt),
      preference: evaluation?.preference || evaluation?.winner || null,
      computedWinner: evaluation?.computedWinner || evaluation?.winner || null,
      confidence: number(evaluation?.confidence),
      confidenceScale: evaluation?.confidenceScale || (number(evaluation?.confidence) > 5 ? "legacy-0-100" : "anchored-1-5"),
      rationale: text(evaluation?.notes),
      ratings: evaluation?.ratings || {},
      scoreByCandidate: { A: number(scores.A?.score), B: number(scores.B?.score) },
      displayOrder: ["A", "B"],
      sourceByCandidate: { A: text(evaluation?.sourceA), B: text(evaluation?.sourceB) },
      repeatOf: text(evaluation?.repeatOf) || null,
      calibration: evaluation?.calibration === true,
      reviewComplete: evaluation?.status === "complete"
    });
  }

  for (const evaluation of records) {
    if (linkedEvaluationIds.has(evaluation.id) || evaluation.status !== "complete") continue;
    const scores = evaluation.scores || {};
    rows.push({
      id: evaluation.id,
      assignmentId: null,
      caseId: null,
      datasetId: text(evaluation.datasetId) || null,
      datasetName: text(evaluation.datasetName),
      rubricId: text(evaluation.rubricId) || "general",
      reviewerId: text(evaluation.reviewerId) || null,
      tags: tagsFor(evaluation.tags),
      isDemo: evaluation.isSample === true,
      state: "complete",
      date: normalizedDate(evaluation.updatedAt || evaluation.createdAt),
      preference: evaluation.preference || evaluation.winner || null,
      computedWinner: evaluation.computedWinner || evaluation.winner || null,
      confidence: number(evaluation.confidence),
      confidenceScale: evaluation.confidenceScale || (number(evaluation.confidence) > 5 ? "legacy-0-100" : "anchored-1-5"),
      rationale: text(evaluation.notes),
      ratings: evaluation.ratings || {},
      scoreByCandidate: { A: number(scores.A?.score), B: number(scores.B?.score) },
      displayOrder: ["A", "B"],
      sourceByCandidate: { A: text(evaluation.sourceA), B: text(evaluation.sourceB) },
      repeatOf: text(evaluation.repeatOf) || null,
      calibration: evaluation.calibration === true,
      reviewComplete: true
    });
  }
  return rows;
}

function createV3Rows(document) {
  const source = document && typeof document === "object" ? document : {};
  const datasets = new Map(asArray(source.datasets).map((dataset) => [dataset.id, dataset]));
  const cases = new Map(asArray(source.cases).map((reviewCase) => [reviewCase.id, reviewCase]));
  const sessions = new Map(asArray(source.sessions).map((session) => [session.id, session]));
  const reviews = new Map(asArray(source.reviews).map((review) => [review.id, review]));

  return asArray(source.assignments).map((assignment) => {
    const reviewCase = cases.get(assignment.caseId);
    const dataset = reviewCase ? datasets.get(reviewCase.datasetId) : null;
    const session = sessions.get(assignment.sessionId);
    const review = assignment.reviewId ? reviews.get(assignment.reviewId) : null;
    const candidates = asArray(reviewCase?.candidates);
    const displayOrder = asArray(assignment.displayOrder).length ? [...assignment.displayOrder] : candidates.map((candidate) => candidate.id);
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const sourceRevealed = session?.blindMode !== true || Boolean(session?.revealedAt);
    const sourceByCandidate = sourceRevealed
      ? Object.fromEntries(candidates.map((candidate) => [candidate.id, text(candidate.source)]))
      : {};
    const reviewDate = normalizedDate(review?.updatedAt || review?.completedAt || review?.createdAt);
    return {
      id: review?.id || assignment.id,
      assignmentId: assignment.id,
      caseId: assignment.caseId,
      datasetId: dataset?.id || null,
      datasetName: text(dataset?.name),
      rubricId: text(session?.rubricRef || dataset?.rubricRef),
      reviewerId: text(session?.reviewerId) || null,
      tags: tagsFor(reviewCase?.metadata?.tags, review?.issueLabels),
      isDemo: dataset?.isDemo === true,
      state: normalizeState(assignment.state),
      date: reviewDate,
      preference: review?.preference || null,
      computedWinner: review?.computed?.winner || null,
      confidence: number(review?.confidence),
      confidenceScale: review?.confidenceScale || (number(review?.confidence) > 5 ? "legacy-0-100" : "anchored-1-5"),
      rationale: text(review?.rationale),
      ratings: review?.ratings || {},
      scoreByCandidate: Object.fromEntries(Object.entries(review?.computed?.scoreByCandidate || {}).map(([id, score]) => [id, number(score)])),
      displayOrder,
      sourceByCandidate,
      repeatOf: text(assignment.repeatOf) || null,
      calibration: assignment.calibration === true,
      reviewComplete: review?.state === "complete",
      candidateById
    };
  });
}

function filterMatches(row, filters) {
  if (!filters.includeSamples && row.isDemo) return false;
  if (filters.datasetId !== "all" && filters.datasetId !== row.datasetId) return false;
  if (filters.rubricId !== "all" && filters.rubricId !== row.rubricId) return false;
  if (filters.reviewerId !== "all" && filters.reviewerId !== row.reviewerId) return false;
  if (filters.tag !== "all" && !row.tags.some((tag) => tag.toLowerCase() === String(filters.tag).toLowerCase())) return false;
  return isWithinDateRange(row.date, filters);
}

function percent(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function sortedNumbers(values) {
  return values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
}

function quantile(values, position) {
  if (!values.length) return null;
  const index = (values.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function scoreGap(row) {
  const order = row.displayOrder || Object.keys(row.scoreByCandidate || {});
  const scores = order.slice(0, 2).map((candidateId) => row.scoreByCandidate?.[candidateId]).filter(Number.isFinite);
  return scores.length === 2 ? Math.abs(scores[0] - scores[1]) : null;
}

function gapDistribution(gaps) {
  const values = sortedNumbers(gaps);
  const buckets = [
    { label: "0–2", max: 2 },
    { label: "3–5", max: 5 },
    { label: "6–10", max: 10 },
    { label: "11–20", max: 20 },
    { label: "21+", max: Infinity }
  ];
  let lower = 0;
  return {
    count: values.length,
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    maximum: values.length ? values[values.length - 1] : null,
    buckets: buckets.map((bucket) => {
      const count = values.filter((value) => value >= lower && value <= bucket.max).length;
      const result = { label: bucket.label, count, rate: percent(count, values.length) };
      lower = bucket.max === Infinity ? Infinity : bucket.max + 1;
      return result;
    })
  };
}

function dimensionAverages(rows) {
  const values = new Map();
  for (const row of rows) {
    for (const candidateRatings of Object.values(row.ratings || {})) {
      if (!candidateRatings || typeof candidateRatings !== "object") continue;
      for (const [dimension, rating] of Object.entries(candidateRatings)) {
        if (!Number.isFinite(Number(rating))) continue;
        const current = values.get(dimension) || { sum: 0, count: 0 };
        current.sum += Number(rating);
        current.count += 1;
        values.set(dimension, current);
      }
    }
  }
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([dimension, value]) => ({
    dimension,
    average: value.count ? value.sum / value.count : null,
    count: value.count
  }));
}

function isLowConfidence(row) {
  if (!Number.isFinite(row.confidence)) return false;
  if (row.confidenceScale === "legacy-0-100" || row.confidence > 5) return row.confidence <= 60;
  return row.confidence <= 2;
}

function sourceWinRate(rows) {
  const bySource = new Map();
  let compared = 0;
  for (const row of rows) {
    if (!row.preference || row.preference === "tie" || row.preference === "pending") continue;
    const preferredSource = text(row.sourceByCandidate?.[row.preference]);
    const sources = [...new Set((row.displayOrder || Object.keys(row.sourceByCandidate || {})).map((candidateId) => text(row.sourceByCandidate?.[candidateId])).filter(Boolean))];
    if (!preferredSource || sources.length < 2) continue;
    compared += 1;
    for (const source of sources) {
      const result = bySource.get(source) || { source, wins: 0, compared: 0 };
      result.wins += source === preferredSource ? 1 : 0;
      result.compared += 1;
      bySource.set(source, result);
    }
  }
  if (!compared) {
    return { available: false, reason: "Source metadata is unavailable until a revealed session provides it.", compared: 0, bySource: [] };
  }
  return {
    available: true,
    reason: "",
    compared,
    bySource: [...bySource.values()].map((item) => ({ ...item, winRate: item.wins / item.compared })).sort((left, right) => left.source.localeCompare(right.source))
  };
}

function calibrationFor(rows) {
  const byAssignment = new Map(rows.map((row) => [row.assignmentId, row]));
  const pairs = rows
    .filter((row) => row.calibration && row.repeatOf && row.reviewComplete)
    .map((repeat) => ({ original: byAssignment.get(repeat.repeatOf), repeat }))
    .filter(({ original }) => original?.reviewComplete);
  return computeCalibrationMetrics(pairs);
}

function limitations({ reviewCount, source, calibration }) {
  const notes = [];
  if (reviewCount > 0 && reviewCount < 5) notes.push(`Small sample: ${reviewCount} completed review${reviewCount === 1 ? "" : "s"}; treat rates as directional.`);
  if (!source.available) notes.push(source.reason);
  if (!calibration.repeats) notes.push("Calibration consistency is unavailable until a completed repeat pair exists.");
  return notes;
}

/**
 * Calculate decision-oriented metrics from either a v3 audit document or the
 * browser's legacy evaluation and queue stores. This function is pure and
 * never infers a reviewer, source, or calibration result that is not present.
 */
export function calculateAnalytics({ document, evaluations = [], queueCases = [], filters = {} } = {}) {
  const normalized = normalizeFilters(filters);
  const hasV3 = document && document.schemaVersion === 3 && Array.isArray(document.assignments);
  const allRows = hasV3 ? createV3Rows(document) : createLegacyRows(evaluations, queueCases);
  const rows = allRows.filter((row) => filterMatches(row, normalized));
  const workflowRows = rows.filter((row) => ["complete", "skipped", "pending", "in_progress"].includes(row.state));
  const completedRows = rows.filter((row) => row.state === "complete" && row.reviewComplete);
  const completed = workflowRows.filter((row) => row.state === "complete").length;
  const skipped = workflowRows.filter((row) => row.state === "skipped").length;
  const active = workflowRows.filter((row) => ["pending", "in_progress"].includes(row.state)).length;
  const workflowTotal = workflowRows.length;
  const conflicts = completedRows.filter((row) => row.preference && row.computedWinner && row.preference !== "pending" && row.computedWinner !== "pending" && row.preference !== row.computedWinner).length;
  const ties = completedRows.filter((row) => row.preference === "tie").length;
  const lowConfidence = completedRows.filter(isLowConfidence).length;
  const source = sourceWinRate(completedRows);
  const calibration = calibrationFor(allRows.filter((row) => filterMatches(row, normalized)));
  const gaps = completedRows.map(scoreGap).filter(Number.isFinite);

  return {
    filters: normalized,
    workflow: {
      total: workflowTotal,
      completed,
      skipped,
      active,
      completionRate: percent(completed, workflowTotal),
      skipRate: percent(skipped, workflowTotal)
    },
    reviews: {
      completed: completedRows.length,
      ties,
      tieRate: percent(ties, completedRows.length),
      conflicts,
      conflictRate: percent(conflicts, completedRows.length),
      lowConfidence,
      lowConfidenceRate: percent(lowConfidence, completedRows.length)
    },
    scoreGap: gapDistribution(gaps),
    dimensions: dimensionAverages(completedRows),
    sourceWinRate: source,
    calibration,
    limitations: limitations({ reviewCount: completedRows.length, source, calibration })
  };
}

export function analyticsFilterOptions({ document, evaluations = [], queueCases = [] } = {}) {
  const hasV3 = document && document.schemaVersion === 3 && Array.isArray(document.assignments);
  const rows = hasV3 ? createV3Rows(document) : createLegacyRows(evaluations, queueCases);
  return {
    datasets: [...new Map(rows.filter((row) => row.datasetId).map((row) => [row.datasetId, { id: row.datasetId, name: row.datasetName || row.datasetId }])).values()].sort((left, right) => left.name.localeCompare(right.name)),
    rubrics: [...new Set(rows.map((row) => row.rubricId).filter(Boolean))].sort(),
    tags: [...new Set(rows.flatMap((row) => row.tags))].sort((left, right) => left.localeCompare(right)),
    reviewers: [...new Set(rows.map((row) => row.reviewerId).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  };
}
