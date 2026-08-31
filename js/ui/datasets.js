import { createId } from "../model.js";

export const DATASET_SCHEMA_VERSION = 1;
export const DATASET_STORAGE_KEY = "evalforge.datasets.v1";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function validDate(value) {
  return typeof value === "string" && value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function uniqueId(value, idFactory) {
  const candidate = text(value);
  return candidate && candidate.length <= 160 ? candidate : idFactory();
}

function recordSignature(record) {
  return JSON.stringify([
    record.input,
    record.candidates?.[0]?.content || "",
    record.candidates?.[1]?.content || ""
  ]);
}

function externalId(record) {
  return text(record?.externalId);
}

export function normalizeDataset(value, { idFactory = createId, now = new Date().toISOString() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cases = Array.isArray(value.cases) ? value.cases.filter((record) => record && typeof record === "object") : [];
  const createdAt = validDate(value.createdAt) || now;
  const normalized = {
    schemaVersion: DATASET_SCHEMA_VERSION,
    id: uniqueId(value.id, idFactory),
    name: text(value.name, "Untitled dataset").slice(0, 200),
    description: text(value.description).slice(0, 2000),
    rubricId: text(value.rubricId, "general"),
    sourceFile: text(value.sourceFile).slice(0, 500),
    createdAt,
    updatedAt: validDate(value.updatedAt) || createdAt,
    isDemo: value.isDemo === true,
    cases: clone(cases)
  };
  return normalized;
}

export function normalizeDatasetCollection(value, options = {}) {
  const raw = Array.isArray(value) ? value : value?.datasets;
  if (!Array.isArray(raw)) return { datasets: [], report: { total: 0, accepted: 0, repaired: 0, skipped: 0 } };
  const seen = new Set();
  let repaired = 0;
  let skipped = 0;
  const datasets = [];
  raw.forEach((item) => {
    const normalized = normalizeDataset(item, options);
    if (!normalized || seen.has(normalized.id)) {
      skipped += 1;
      return;
    }
    seen.add(normalized.id);
    if (JSON.stringify(normalized) !== JSON.stringify(item)) repaired += 1;
    datasets.push(normalized);
  });
  return { datasets, report: { total: raw.length, accepted: datasets.length, repaired, skipped } };
}

export function loadDatasetState(fallback = [], storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem?.(DATASET_STORAGE_KEY);
    if (!stored) {
      const result = normalizeDatasetCollection(fallback);
      return { datasets: result.datasets, report: { ...result.report, source: "fallback" }, error: null };
    }
    const result = normalizeDatasetCollection(JSON.parse(stored));
    return { datasets: result.datasets, report: { ...result.report, source: "storage" }, error: null };
  } catch (error) {
    const result = normalizeDatasetCollection(fallback);
    return { datasets: result.datasets, report: { ...result.report, source: "fallback", skipped: result.report.skipped + 1 }, error };
  }
}

export function saveDatasetCollection(datasets, storage = globalThis.localStorage) {
  try {
    storage.setItem(DATASET_STORAGE_KEY, JSON.stringify(datasets));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

export function commitDatasetCollection(candidate, previous, storage = globalThis.localStorage) {
  const result = saveDatasetCollection(candidate, storage);
  return result.ok
    ? { ok: true, datasets: clone(candidate), error: null }
    : { ok: false, datasets: clone(previous), error: result.error };
}

function duplicateRow(row, code, message) {
  return {
    ...clone(row),
    status: "duplicate",
    record: null,
    issues: [...(row.issues || []), { line: row.line, field: code === "duplicate_external_id" ? "external_id" : "", code, message, severity: "error" }]
  };
}

/**
 * Build a new dataset candidate without touching storage. Existing external
 * ids and exact prompt/candidate content are rejected across the library.
 */
export function createDatasetApplyPlan(existingDatasets = [], importPlan, { name = "Imported dataset", description = "", rubricId = "general", sourceFile = "", now = new Date().toISOString(), idFactory = createId } = {}) {
  const current = Array.isArray(existingDatasets) ? existingDatasets : [];
  const knownExternalIds = new Set(current.flatMap((dataset) => dataset.cases || []).map(externalId).filter(Boolean));
  const knownSignatures = new Set(current.flatMap((dataset) => dataset.cases || []).map(recordSignature));
  const acceptedRows = [];
  const duplicateRows = [];
  for (const row of importPlan?.acceptedRows || []) {
    const record = row.record;
    if (knownExternalIds.has(externalId(record))) {
      duplicateRows.push(duplicateRow(row, "duplicate_external_id", "This external_id already exists in the dataset library."));
      continue;
    }
    const signature = recordSignature(record);
    if (knownSignatures.has(signature)) {
      duplicateRows.push(duplicateRow(row, "duplicate_content", "This prompt and candidate pair already exists in the dataset library."));
      continue;
    }
    knownExternalIds.add(externalId(record));
    knownSignatures.add(signature);
    acceptedRows.push(row);
  }

  const dataset = acceptedRows.length
    ? normalizeDataset({ name, description, rubricId, sourceFile, createdAt: now, updatedAt: now, isDemo: false, cases: acceptedRows.map(({ record }) => record) }, { idFactory, now })
    : null;
  return {
    dataset,
    acceptedRows: clone(acceptedRows),
    duplicateRows: clone(duplicateRows),
    accepted: acceptedRows.length,
    duplicates: duplicateRows.length,
    rejected: importPlan?.rejected || 0,
    warnings: importPlan?.warnings || 0,
    total: importPlan?.total || 0
  };
}

export function datasetCaseCount(dataset) {
  return Array.isArray(dataset?.cases) ? dataset.cases.length : 0;
}

export function datasetLibrarySummary(datasets = []) {
  const list = Array.isArray(datasets) ? datasets : [];
  const cases = list.reduce((total, dataset) => total + datasetCaseCount(dataset), 0);
  return { datasets: list.length, cases, demo: list.filter(({ isDemo }) => isDemo).length };
}
