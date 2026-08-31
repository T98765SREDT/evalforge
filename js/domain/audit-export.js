import { assertWorkspaceDocument, validateWorkspaceDocument } from "./entities.js";
import { stableHash } from "./ids.js";

export const AUDIT_BUNDLE_VERSION = 1;

function clone(value) {
  return structuredClone(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function csv(value) {
  const raw = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  const safe = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function candidateById(reviewCase) {
  return new Map(asArray(reviewCase?.candidates).map((candidate) => [candidate.id, candidate]));
}

function includedDocument(document, includeSamples) {
  const source = clone(document);
  if (includeSamples) return source;
  const demoDatasets = new Set(source.datasets.filter((dataset) => dataset.isDemo).map((dataset) => dataset.id));
  const datasetIds = new Set(source.datasets.filter((dataset) => !demoDatasets.has(dataset.id)).map((dataset) => dataset.id));
  const caseIds = new Set(source.cases.filter((reviewCase) => datasetIds.has(reviewCase.datasetId)).map((reviewCase) => reviewCase.id));
  const sessionIds = new Set(source.sessions.filter((session) => datasetIds.has(session.datasetId)).map((session) => session.id));
  const assignmentIds = new Set(source.assignments.filter((assignment) => sessionIds.has(assignment.sessionId) && caseIds.has(assignment.caseId)).map((assignment) => assignment.id));
  const reviewIds = new Set(source.reviews.filter((review) => assignmentIds.has(review.assignmentId)).map((review) => review.id));
  const entityIds = new Set([...datasetIds, ...caseIds, ...sessionIds, ...assignmentIds, ...reviewIds, ...source.rubrics.map((rubric) => rubric.id), source.workspace.id]);
  return {
    ...source,
    workspace: { ...source.workspace, datasetIds: source.workspace.datasetIds.filter((id) => datasetIds.has(id)) },
    datasets: source.datasets.filter((dataset) => datasetIds.has(dataset.id)),
    cases: source.cases.filter((reviewCase) => caseIds.has(reviewCase.id)),
    sessions: source.sessions.filter((session) => sessionIds.has(session.id)),
    assignments: source.assignments.filter((assignment) => assignmentIds.has(assignment.id)),
    reviews: source.reviews.filter((review) => reviewIds.has(review.id)),
    auditEvents: source.auditEvents.filter((event) => entityIds.has(event.entityId))
  };
}

function assertRubricChecksums(document) {
  for (const rubric of document.rubrics) {
    const expected = stableHash({ id: rubric.id, version: rubric.version, dimensions: rubric.dimensions });
    if (rubric.checksum !== expected) {
      const error = new Error(`Rubric checksum mismatch for ${rubric.id}.`);
      error.code = "rubric_checksum_mismatch";
      throw error;
    }
  }
}

function assertRevisionChains(document) {
  const byId = new Map(document.reviews.map((review) => [review.id, review]));
  for (const review of document.reviews) {
    const seen = new Set([review.id]);
    let previousId = review.supersedesReviewId ?? null;
    while (previousId) {
      if (seen.has(previousId)) throw new Error(`Review revision cycle detected at ${review.id}.`);
      seen.add(previousId);
      const previous = byId.get(previousId);
      if (!previous) throw new Error(`Review ${review.id} references a missing revision ${previousId}.`);
      previousId = previous.supersedesReviewId ?? null;
    }
  }
}

export function documentFromAuditBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new TypeError("Audit bundle must be an object.");
  if (bundle.bundleVersion !== AUDIT_BUNDLE_VERSION) throw new TypeError(`Unsupported audit bundle version: ${bundle.bundleVersion}.`);
  return {
    schemaVersion: 3,
    workspace: bundle.workspace,
    rubrics: asArray(bundle.rubrics),
    datasets: asArray(bundle.datasets),
    cases: asArray(bundle.cases),
    sessions: asArray(bundle.sessions),
    assignments: asArray(bundle.assignments),
    reviews: asArray(bundle.reviews),
    auditEvents: asArray(bundle.auditEvents)
  };
}

export function verifyAuditBundle(bundle) {
  const document = documentFromAuditBundle(bundle);
  assertWorkspaceDocument(document);
  assertRubricChecksums(document);
  assertRevisionChains(document);
  return {
    valid: true,
    bundleVersion: bundle.bundleVersion,
    counts: Object.fromEntries(["rubrics", "datasets", "cases", "sessions", "assignments", "reviews", "auditEvents"].map((key) => [key, document[key].length]))
  };
}

export function createAuditBundle(document, { includeSamples = false, generatedAt = new Date().toISOString() } = {}) {
  const source = {
    schemaVersion: document?.schemaVersion,
    workspace: document?.workspace,
    rubrics: asArray(document?.rubrics),
    datasets: asArray(document?.datasets),
    cases: asArray(document?.cases),
    sessions: asArray(document?.sessions),
    assignments: asArray(document?.assignments),
    reviews: asArray(document?.reviews),
    auditEvents: asArray(document?.auditEvents)
  };
  assertWorkspaceDocument(source);
  const filtered = includedDocument(source, includeSamples);
  assertWorkspaceDocument(filtered);
  return {
    bundleVersion: AUDIT_BUNDLE_VERSION,
    generatedAt,
    includeSamples,
    workspace: filtered.workspace,
    rubrics: filtered.rubrics,
    datasets: filtered.datasets,
    cases: filtered.cases,
    sessions: filtered.sessions,
    assignments: filtered.assignments,
    reviews: filtered.reviews,
    auditEvents: filtered.auditEvents,
    derived: summarizeAuditDocument(filtered)
  };
}

export function analysisRows(document, { includeSamples = false } = {}) {
  const source = includedDocument({
    schemaVersion: document?.schemaVersion,
    workspace: document?.workspace,
    rubrics: asArray(document?.rubrics),
    datasets: asArray(document?.datasets),
    cases: asArray(document?.cases),
    sessions: asArray(document?.sessions),
    assignments: asArray(document?.assignments),
    reviews: asArray(document?.reviews),
    auditEvents: asArray(document?.auditEvents)
  }, includeSamples);
  const cases = new Map(source.cases.map((reviewCase) => [reviewCase.id, reviewCase]));
  const assignments = new Map(source.assignments.map((assignment) => [assignment.id, assignment]));
  return source.reviews.filter((review) => review.state === "complete").map((review) => {
    const assignment = assignments.get(review.assignmentId);
    const reviewCase = assignment && cases.get(assignment.caseId);
    const candidates = candidateById(reviewCase);
    const row = {
      reviewId: review.id,
      assignmentId: review.assignmentId,
      caseId: reviewCase?.id || "",
      externalId: reviewCase?.externalId || "",
      humanPreference: review.preference,
      computedWinner: review.computed.winner,
      confidence: review.confidence,
      confidenceScale: review.confidenceScale || (review.confidence > 5 ? "legacy-0-100" : "anchored-1-5"),
      rationale: review.rationale,
      revision: review.revision,
      supersedesReviewId: review.supersedesReviewId || ""
    };
    const scoreByCandidate = review.computed.scoreByCandidate || {};
    const displayOrder = assignment?.displayOrder || [...candidates.keys()];
    displayOrder.forEach((candidateId, index) => {
      const candidate = candidates.get(candidateId);
      const prefix = `candidate${index + 1}`;
      row[`${prefix}Source`] = candidate?.source || "";
      row[`${prefix}Score`] = scoreByCandidate[candidateId] ?? "";
      const ratings = review.ratings?.[candidateId];
      if (ratings && typeof ratings === "object") {
        for (const [dimension, rating] of Object.entries(ratings)) row[`${prefix}Rating_${dimension}`] = rating;
      } else row[`${prefix}Rating`] = ratings ?? "";
    });
    return row;
  });
}

export function analysisCsv(document, options = {}) {
  const rows = analysisRows(document, options);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [columns.map(csv).join(","), ...rows.map((row) => columns.map((column) => csv(row[column])).join(","))].join("\n");
}

export function summarizeAuditDocument(document) {
  const reviews = asArray(document?.reviews).filter((review) => review.state === "complete");
  const conflicts = reviews.filter((review) => review.preference !== review.computed.winner).length;
  const confidenceValues = reviews.map((review) => review.confidence).filter((value) => Number.isFinite(value));
  return {
    completedReviews: reviews.length,
    preferenceScoreConflicts: conflicts,
    conflictRate: reviews.length ? conflicts / reviews.length : null,
    averageConfidence: confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : null,
    revisions: reviews.filter((review) => review.revision > 1).length,
    datasets: asArray(document?.datasets).length,
    cases: asArray(document?.cases).length
  };
}

export function summaryMarkdown(document, { title = "EvalForge audit summary" } = {}) {
  const summary = summarizeAuditDocument(document);
  const percent = (value) => value === null ? "—" : `${Math.round(value * 100)}%`;
  return [
    `# ${title}`,
    "",
    "This summary contains aggregate review statistics only. Prompt and candidate content are intentionally omitted.",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Completed reviews | ${summary.completedReviews} |`,
    `| Preference / score conflicts | ${summary.preferenceScoreConflicts} (${percent(summary.conflictRate)}) |`,
    `| Average confidence | ${summary.averageConfidence === null ? "—" : summary.averageConfidence.toFixed(2)} |`,
    `| Revised reviews | ${summary.revisions} |`,
    `| Datasets | ${summary.datasets} |`,
    `| Cases | ${summary.cases} |`,
    ""
  ].join("\n");
}

export function validateAuditBundle(bundle) {
  try {
    return { ...verifyAuditBundle(bundle), errors: [] };
  } catch (error) {
    return { valid: false, errors: [{ code: error.code || "invalid_audit_bundle", message: error.message }] };
  }
}

