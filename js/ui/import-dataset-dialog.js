export const DATASET_IMPORT_DIALOG_STATES = Object.freeze(["idle", "reading", "preview_ready", "applying", "success", "error"]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createDatasetImportDialogState() {
  return { state: "idle", fileName: "", plan: null, result: null, error: null };
}

export function beginDatasetImport(fileName) {
  return { state: "reading", fileName: String(fileName || ""), plan: null, result: null, error: null };
}

export function datasetImportPreview(fileName, plan) {
  return { state: "preview_ready", fileName: String(fileName || ""), plan: clone(plan), result: null, error: null };
}

export function startDatasetImportApply(state) {
  if (!['preview_ready', 'error'].includes(state?.state) || !state.plan?.accepted) return clone(state);
  return { ...clone(state), state: "applying", error: null };
}

export function finishDatasetImportApply(state, result) {
  return { ...clone(state), state: "success", result: clone(result), error: null };
}

export function failDatasetImport(state, error) {
  return { ...clone(state), state: "error", error: String(error?.message || error || "Dataset import failed.") };
}

export function canApplyDatasetImport(state) {
  return ["preview_ready", "error"].includes(state?.state) && Boolean(state.plan?.accepted);
}

export function rejectedRowsAsJsonl(plan) {
  return (plan?.rejectedRows || []).map((row) => {
    if (row.raw && typeof row.raw === "object") return JSON.stringify({ ...row.raw, _importError: row.issues });
    return JSON.stringify({ _line: row.line, _importError: row.issues });
  }).join("\n");
}

export function datasetImportIssueRows(plan, limit = 100) {
  return (plan?.issues || []).slice(0, limit).map(({ line, field, code, message, severity }) => ({ line, field, code, message, severity }));
}
