import { deterministicId } from "./ids.js";

export const DATASET_IMPORT_VERSION = 1;
export const DATASET_REQUIRED_FIELDS = Object.freeze(["external_id", "prompt", "response_1", "response_2"]);
export const DATASET_OPTIONAL_FIELDS = Object.freeze(["model_1", "model_2", "model_version", "prompt_version", "reference_answer", "tags", "metadata"]);

const KNOWN_FIELDS = new Set([...DATASET_REQUIRED_FIELDS, ...DATASET_OPTIONAL_FIELDS]);

export class DatasetImportError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "DatasetImportError";
    this.code = "dataset_import_error";
    this.issues = issues;
  }
}

function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function issue(line, field, code, message, severity = "error") { return { line, field, code, message, severity }; }
function emptyPlan(format, mode) {
  return { importVersion: DATASET_IMPORT_VERSION, format, mode, total: 0, accepted: 0, duplicates: 0, warnings: 0, rejected: 0, rows: [], acceptedRows: [], duplicateRows: [], rejectedRows: [], issues: [] };
}
function addRow(plan, row) {
  plan.rows.push(row);
  plan.issues.push(...row.issues);
  const issueWarnings = row.issues.filter(({ severity }) => severity === "warning").length;
  plan.warnings += issueWarnings;
  if (row.status === "accepted") { plan.accepted += 1; plan.acceptedRows.push(row); }
  if (row.status === "duplicate") { plan.duplicates += 1; plan.duplicateRows.push(row); }
  if (row.status === "rejected") { plan.rejected += 1; plan.rejectedRows.push(row); }
}

function parseCsvRows(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  let rowStart = 1;
  let line = 1;
  let index = 0;
  const pushRow = () => {
    if (row.length || value.length) rows.push({ values: [...row, value], line: rowStart });
    row = [];
    value = "";
    rowStart = line;
  };
  while (index < source.length) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { value += '"'; index += 2; continue; }
        quoted = false;
        index += 1;
        continue;
      }
      value += character;
      if (character === "\n") line += 1;
      index += 1;
      continue;
    }
    if (character === '"' && value.length === 0) { quoted = true; index += 1; continue; }
    if (character === ",") { row.push(value); value = ""; index += 1; continue; }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      line += 1;
      pushRow();
      index += 1;
      continue;
    }
    value += character;
    index += 1;
  }
  if (quoted) throw new DatasetImportError("The CSV contains an unclosed quoted field.", [issue(rowStart, "", "csv_unclosed_quote", "The quoted field reaches the end of the file without a closing quote.")]);
  if (row.length || value.length) pushRow();
  return rows;
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return { headers: [], rows: [], issues: [] };
  const headers = rows[0].values;
  const issues = [];
  const seen = new Set();
  headers.forEach((header, index) => {
    if (!header) issues.push(issue(1, `column_${index + 1}`, "empty_header", "CSV headers cannot be empty."));
    if (seen.has(header)) issues.push(issue(1, header, "duplicate_header", `The CSV header ${header} appears more than once.`));
    seen.add(header);
  });
  return {
    headers,
    rows: rows.slice(1).map(({ values, line }) => ({ line, value: Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) })),
    issues
  };
}

function parseJson(text) {
  let document;
  try { document = JSON.parse(String(text ?? "").replace(/^\uFEFF/, "")); }
  catch (error) {
    return { rows: [], issues: [issue(1, "", "json_invalid", `The JSON document could not be parsed: ${error.message}`)] };
  }
  if (plainObject(document) && Array.isArray(document.evaluations)) {
    return { rows: [], issues: [issue(1, "evaluations", "backup_restore_not_dataset", "This is an EvalForge backup. Use Restore Backup instead of Dataset Import.")] };
  }
  const values = Array.isArray(document) ? document : plainObject(document) && Array.isArray(document.rows) ? document.rows : plainObject(document) && Array.isArray(document.data) ? document.data : null;
  if (!values) return { rows: [], issues: [issue(1, "", "json_expected_rows", "Dataset JSON must be an array or an object with a rows/data array.")] };
  return { rows: values.map((value, index) => ({ line: index + 1, value })), issues: [] };
}

function parseJsonl(text) {
  const rows = [];
  const issues = [];
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((lineText, index) => {
    const line = index + 1;
    if (!lineText.trim()) return;
    try { rows.push({ line, value: JSON.parse(lineText) }); }
    catch (error) { issues.push(issue(line, "", "jsonl_invalid", `This JSONL line could not be parsed: ${error.message}`)); }
  });
  return { rows, issues };
}

function detectFormat(text) {
  const first = String(text ?? "").replace(/^\uFEFF/, "").trimStart()[0];
  return first === "[" || first === "{" ? "json" : "csv";
}

function valueString(value, line, field, required, issues) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    if (required) issues.push(issue(line, field, "missing_required_field", `${field} is required and cannot be empty.`));
    return null;
  }
  if (typeof value !== "string") {
    issues.push(issue(line, field, "expected_string", `${field} must be a string.`));
    return null;
  }
  return value;
}

function optionalString(value, line, field, issues) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    issues.push(issue(line, field, "optional_string_invalid", `${field} must be a string when provided.`, "warning"));
    return null;
  }
  return value;
}

function optionalTags(value, line, issues, isCsv) {
  if (value === undefined || value === null || value === "") return [];
  if (isCsv) return String(value).split("|").map((tag) => tag.trim()).filter(Boolean);
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    issues.push(issue(line, "tags", "tags_invalid", "tags must be an array of strings.", "warning"));
    return [];
  }
  return [...value];
}

function optionalMetadata(value, line, issues, isCsv) {
  if (value === undefined || value === null || value === "") return {};
  if (isCsv) {
    try { value = JSON.parse(value); }
    catch { issues.push(issue(line, "metadata", "metadata_invalid_json", "metadata must contain a JSON object in CSV.", "warning")); return {}; }
  }
  if (!plainObject(value)) {
    issues.push(issue(line, "metadata", "metadata_invalid", "metadata must be an object.", "warning"));
    return {};
  }
  return structuredClone(value);
}

function normalizeRow(raw, { line, isCsv, mode }) {
  const issues = [];
  if (!plainObject(raw)) return { line, status: "rejected", raw, record: null, issues: [issue(line, "", "row_not_object", "Each dataset row must be an object.")] };
  const values = raw;
  const externalId = valueString(values.external_id, line, "external_id", true, issues);
  const prompt = valueString(values.prompt, line, "prompt", true, issues);
  const response1 = valueString(values.response_1, line, "response_1", true, issues);
  const response2 = valueString(values.response_2, line, "response_2", true, issues);
  const unknownFields = Object.keys(values).filter((field) => !KNOWN_FIELDS.has(field) && values[field] !== "" && values[field] !== undefined && values[field] !== null);
  if (mode === "strict") {
    unknownFields.forEach((field) => issues.push(issue(line, field, "unknown_field", `${field} is not a recognized dataset field.`, "warning")));
  }
  if (issues.some(({ severity }) => severity === "error")) return { line, status: "rejected", raw: structuredClone(raw), record: null, issues };
  const model1 = optionalString(values.model_1, line, "model_1", issues);
  const model2 = optionalString(values.model_2, line, "model_2", issues);
  const modelVersion = optionalString(values.model_version, line, "model_version", issues);
  const promptVersion = optionalString(values.prompt_version, line, "prompt_version", issues);
  const referenceAnswer = optionalString(values.reference_answer, line, "reference_answer", issues);
  const tags = optionalTags(values.tags, line, issues, isCsv);
  const metadata = optionalMetadata(values.metadata, line, issues, isCsv);
  const baseMetadata = { ...metadata };
  if (modelVersion !== null) baseMetadata.modelVersion = modelVersion;
  if (promptVersion !== null) baseMetadata.promptVersion = promptVersion;
  if (referenceAnswer !== null) baseMetadata.referenceAnswer = referenceAnswer;
  if (tags.length) baseMetadata.tags = tags;
  const record = {
    externalId,
    input: prompt,
    candidates: [
      { id: deterministicId("candidate", { externalId, slot: "first" }), content: response1, source: model1, metadata: { modelVersion } },
      { id: deterministicId("candidate", { externalId, slot: "second" }), content: response2, source: model2, metadata: { modelVersion } }
    ],
    metadata: baseMetadata
  };
  return { line, status: "accepted", raw: structuredClone(raw), record, issues };
}

/**
 * Parse a real response-pair dataset without touching DOM, files, storage, or
 * model APIs. `mode` is intentionally documented in the result so callers can
 * show whether unknown optional fields were tolerated under strict review.
 */
export function createDatasetImportPlan(rawRows, { format = "json", mode = "strict", parserIssues = [] } = {}) {
  const plan = emptyPlan(format, mode);
  const seenExternalIds = new Set();
  const seenContent = new Set();
  for (const parserIssue of parserIssues) addRow(plan, { line: parserIssue.line, status: "rejected", record: null, issues: [parserIssue] });
  for (const [index, raw] of rawRows.entries()) {
    const value = raw && Object.prototype.hasOwnProperty.call(raw, "value") ? raw.value : raw;
    const line = raw && Number.isInteger(raw.line) ? raw.line : index + 1;
    const row = normalizeRow(value, { line, isCsv: format === "csv", mode });
    if (row.status === "accepted") {
      const contentKey = JSON.stringify([row.record.input, row.record.candidates[0].content, row.record.candidates[1].content]);
      if (seenExternalIds.has(row.record.externalId)) {
        row.status = "duplicate";
        row.record = null;
        row.issues.push(issue(row.line, "external_id", "duplicate_external_id", "This external_id already appeared earlier in the import."));
      } else if (seenContent.has(contentKey)) {
        row.status = "duplicate";
        row.record = null;
        row.issues.push(issue(row.line, "", "duplicate_content", "This exact prompt and candidate pair already appeared earlier in the import."));
      } else {
        seenExternalIds.add(row.record.externalId);
        seenContent.add(contentKey);
      }
    }
    addRow(plan, row);
  }
  plan.total = plan.rows.length;
  return plan;
}

export function parseDatasetImport(text, { format = "auto", mode = "strict" } = {}) {
  const resolvedFormat = format === "auto" ? detectFormat(text) : format;
  if (!["csv", "json", "jsonl"].includes(resolvedFormat)) throw new DatasetImportError(`Unsupported dataset format: ${resolvedFormat}.`);
  let parsed;
  try {
    if (resolvedFormat === "csv") parsed = parseCsv(text);
  } catch (error) {
    if (!(error instanceof DatasetImportError)) throw error;
    return createDatasetImportPlan([], { format: resolvedFormat, mode, parserIssues: error.issues });
  }
  if (resolvedFormat === "json") parsed = parseJson(text);
  if (resolvedFormat === "jsonl") parsed = parseJsonl(text);
  const plan = createDatasetImportPlan(parsed.rows, { format: resolvedFormat, mode, parserIssues: parsed.issues });
  return plan;
}

export function importPlanSummary(plan) {
  return `${plan.accepted} accepted, ${plan.duplicates} duplicate, ${plan.rejected} rejected${plan.warnings ? `, ${plan.warnings} warning${plan.warnings === 1 ? "" : "s"}` : ""}`;
}
