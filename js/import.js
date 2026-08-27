import { CURRENT_SCHEMA_VERSION, normalizeEvaluationCollection } from "./model.js";

export class ImportValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export function parseEvaluationImport(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ImportValidationError("This file is not valid JSON.");
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ImportValidationError("Choose an EvalForge JSON export.");
  }

  const schemaVersion = Number(document.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new ImportValidationError("The export is missing a supported schemaVersion.");
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new ImportValidationError(`This export uses schema version ${schemaVersion}. This version of EvalForge supports up to ${CURRENT_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(document.evaluations)) {
    throw new ImportValidationError("The export does not contain an evaluations array.");
  }

  const result = normalizeEvaluationCollection(document.evaluations);
  if (document.evaluations.length && !result.evaluations.length) {
    throw new ImportValidationError("No valid evaluations were found in this export.");
  }

  return {
    schemaVersion,
    exportedAt: typeof document.exportedAt === "string" ? document.exportedAt : null,
    evaluations: result.evaluations,
    report: result.report
  };
}

export function createImportPlan(existing, imported, mode = "merge") {
  if (mode !== "merge" && mode !== "replace") {
    throw new TypeError("Import mode must be merge or replace.");
  }

  const existingIds = new Set(existing.map(({ id }) => id));
  const conflicts = imported.filter(({ id }) => existingIds.has(id)).length;

  if (mode === "replace") {
    return {
      mode,
      conflicts,
      added: imported.length,
      updated: 0,
      removed: existing.length,
      evaluations: structuredClone(imported)
    };
  }

  const importedById = new Map(imported.map((evaluation) => [evaluation.id, evaluation]));
  const merged = existing.map((evaluation) => importedById.get(evaluation.id) || evaluation);
  for (const evaluation of imported) {
    if (!existingIds.has(evaluation.id)) merged.push(evaluation);
  }

  return {
    mode,
    conflicts,
    added: imported.length - conflicts,
    updated: conflicts,
    removed: 0,
    evaluations: structuredClone(merged)
  };
}
