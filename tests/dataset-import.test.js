import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DatasetImportError,
  createDatasetImportPlan,
  importPlanSummary,
  parseDatasetImport
} from "../js/domain/dataset-import.js";

const EXAMPLES = new URL("../examples/", import.meta.url);

async function example(name) {
  return readFile(new URL(name, EXAMPLES), "utf8");
}

test("coding JSONL fixture reports accepted, duplicate, and rejected rows", async () => {
  const plan = parseDatasetImport(await example("coding-pairs.jsonl"), { format: "jsonl" });
  assert.equal(plan.format, "jsonl");
  assert.equal(plan.total, 10);
  assert.equal(plan.accepted, 8);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.rejected, 1);
  assert.equal(plan.rejectedRows[0].issues[0].field, "response_2");
  assert.equal(importPlanSummary(plan), "8 accepted, 1 duplicate, 1 rejected");
  assert.equal(plan.acceptedRows[0].record.candidates[0].id.startsWith("candidate-"), true);
});

test("CSV parser handles BOM, quoted commas, embedded newlines, tags, and metadata", async () => {
  const csv = "\uFEFFexternal_id,prompt,response_1,response_2,tags,metadata\r\n"
    + "row-1,\"Line one, with comma\",\"First line\nsecond line\",Second,python|safety,\"{\"\"source\"\":\"\"fixture\"\"}\"\r\n";
  const plan = parseDatasetImport(csv, { format: "csv" });
  assert.equal(plan.accepted, 1);
  assert.equal(plan.rejected, 0);
  assert.equal(plan.acceptedRows[0].record.input, "Line one, with comma");
  assert.equal(plan.acceptedRows[0].record.candidates[0].content, "First line\nsecond line");
  assert.deepEqual(plan.acceptedRows[0].record.metadata.tags, ["python", "safety"]);
  assert.equal(plan.acceptedRows[0].record.metadata.source, "fixture");
});

test("JSON arrays and rows/data envelopes are accepted while backup exports are rejected", () => {
  const row = { external_id: "one", prompt: "P", response_1: "A", response_2: "B" };
  assert.equal(parseDatasetImport(JSON.stringify([row])).accepted, 1);
  assert.equal(parseDatasetImport(JSON.stringify({ rows: [row] })).accepted, 1);
  assert.equal(parseDatasetImport(JSON.stringify({ data: [row] })).accepted, 1);
  const backup = parseDatasetImport(JSON.stringify({ schemaVersion: 2, evaluations: [] }));
  assert.equal(backup.rejected, 1);
  assert.equal(backup.issues[0].code, "backup_restore_not_dataset");
});

test("duplicate detection is exact and case-sensitive", () => {
  const first = { external_id: "row-1", prompt: "Same", response_1: "A", response_2: "B" };
  const same = { ...first };
  const differentCase = { ...first, external_id: "ROW-1", prompt: "Different" };
  const plan = createDatasetImportPlan([first, same, differentCase], { format: "json" });
  assert.equal(plan.accepted, 2);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.duplicateRows[0].issues[0].code, "duplicate_external_id");
});

test("required fields and malformed JSONL lines are reported with line and field", () => {
  const missing = parseDatasetImport(JSON.stringify([{ external_id: "x", prompt: "P", response_1: "A" }]), { format: "json" });
  assert.equal(missing.rejected, 1);
  assert.equal(missing.issues[0].line, 1);
  assert.equal(missing.issues[0].field, "response_2");
  const jsonl = parseDatasetImport('{"external_id":"ok","prompt":"P","response_1":"A","response_2":"B"}\nnot-json', { format: "jsonl" });
  assert.equal(jsonl.accepted, 1);
  assert.equal(jsonl.rejected, 1);
  assert.equal(jsonl.issues.find(({ code }) => code === "jsonl_invalid").line, 2);
});

test("optional field mistakes become warnings and unclosed CSV quotes remain recoverable", () => {
  const row = parseDatasetImport(JSON.stringify([{
    external_id: "warning-1",
    prompt: "P",
    response_1: "A",
    response_2: "B",
    tags: "not-an-array",
    metadata: ["not-an-object"],
    extra: "kept only as a warning"
  }]));
  assert.equal(row.accepted, 1);
  assert.equal(row.warnings, 3);
  assert.equal(row.issues.filter(({ severity }) => severity === "warning").length, 3);
  const malformed = parseDatasetImport("external_id,prompt,response_1,response_2\nrow-1,\"unclosed,P,A,B", { format: "csv" });
  assert.equal(malformed.accepted, 0);
  assert.equal(malformed.rejected, 1);
  assert.equal(malformed.issues[0].code, "csv_unclosed_quote");
});

test("lenient mode accepts extra columns without unknown-field warnings", () => {
  const plan = parseDatasetImport(JSON.stringify([{
    external_id: "lenient-1",
    prompt: "P",
    response_1: "A",
    response_2: "B",
    vendor_column: "allowed by the caller"
  }]), { mode: "lenient" });
  assert.equal(plan.accepted, 1);
  assert.equal(plan.warnings, 0);
  assert.equal(plan.issues.length, 0);
});

test("unsupported formats throw a typed dataset import error", () => {
  assert.throws(() => parseDatasetImport("x", { format: "yaml" }), DatasetImportError);
});
