import test from "node:test";
import assert from "node:assert/strict";
import { parseDatasetImport } from "../js/domain/dataset-import.js";
import {
  beginDatasetImport,
  canApplyDatasetImport,
  createDatasetImportDialogState,
  datasetImportIssueRows,
  datasetImportPreview,
  failDatasetImport,
  finishDatasetImportApply,
  rejectedRowsAsJsonl,
  startDatasetImportApply
} from "../js/ui/import-dataset-dialog.js";

const plan = parseDatasetImport(JSON.stringify([
  { external_id: "ok", prompt: "Prompt", response_1: "A", response_2: "B" },
  { external_id: "bad", prompt: "", response_1: "A", response_2: "B" }
]), { format: "json" });

test("dataset import dialog transitions from reading to preview to applying to success", () => {
  const reading = beginDatasetImport("pairs.json");
  assert.equal(reading.state, "reading");
  const preview = datasetImportPreview("pairs.json", plan);
  assert.equal(preview.state, "preview_ready");
  assert.equal(canApplyDatasetImport(preview), true);
  const applying = startDatasetImportApply(preview);
  assert.equal(applying.state, "applying");
  assert.equal(canApplyDatasetImport(applying), false);
  const success = finishDatasetImportApply(applying, { accepted: 1 });
  assert.equal(success.state, "success");
  assert.equal(success.result.accepted, 1);
});

test("errors retain the parsed preview and rejected rows can be downloaded", () => {
  const preview = datasetImportPreview("pairs.json", plan);
  const failed = failDatasetImport(preview, new Error("save failed"));
  assert.equal(failed.state, "error");
  assert.equal(failed.fileName, "pairs.json");
  assert.equal(failed.plan.accepted, 1);
  assert.equal(canApplyDatasetImport(failed), true);
  assert.equal(startDatasetImportApply(failed).state, "applying");
  assert.match(rejectedRowsAsJsonl(plan), /_importError/);
});

test("issue table is bounded and idle state cannot apply", () => {
  assert.equal(canApplyDatasetImport(createDatasetImportDialogState()), false);
  assert.equal(datasetImportIssueRows(plan, 1).length, 1);
});
