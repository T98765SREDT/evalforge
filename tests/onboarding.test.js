import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DATASET_TEMPLATE_CSV,
  DATASET_TEMPLATE_JSONL,
  hasDemoEvaluations,
  hasUserEvaluations,
  matchesHistoryFilter,
  metricsInput,
  onboardingCopy,
  removeDemoEvaluations,
  sampleEvaluationsOnly,
  seedDemoEvaluations,
  userEvaluations
} from "../js/ui/onboarding.js";

const user = { id: "user-1", status: "complete" };
const demo = { id: "demo-1", status: "complete", isSample: true };
const INDEX_HTML = new URL("../index.html", import.meta.url);

test("clean libraries have empty user metrics and separate demo records", () => {
  assert.equal(hasUserEvaluations([]), false);
  assert.equal(hasDemoEvaluations([demo]), true);
  assert.deepEqual(metricsInput([demo]), []);
  assert.deepEqual(userEvaluations([user, demo]), [user]);
  assert.deepEqual(sampleEvaluationsOnly([user, demo]), [demo]);
});

test("demo seeding is explicit, marked, idempotent, and does not replace user data", () => {
  const first = seedDemoEvaluations([user], [demo]);
  assert.equal(first.added, 1);
  assert.equal(first.evaluations.find(({ id }) => id === "demo-1").isSample, true);
  const second = seedDemoEvaluations(first.evaluations, [demo]);
  assert.equal(second.added, 0);
  assert.equal(second.evaluations.length, 2);
  assert.deepEqual(second.evaluations.find(({ id }) => id === "user-1"), user);
});

test("reset removes demo rows only", () => {
  const result = removeDemoEvaluations([user, demo]);
  assert.deepEqual(result.evaluations, [user]);
  assert.equal(result.removed, 1);
});

test("history filters keep legacy user and sample records distinguishable", () => {
  assert.equal(matchesHistoryFilter(user, "user"), true);
  assert.equal(matchesHistoryFilter(demo, "user"), false);
  assert.equal(matchesHistoryFilter(demo, "sample"), true);
  assert.equal(matchesHistoryFilter(user, "sample"), false);
  assert.equal(matchesHistoryFilter(user, "complete"), true);
});

test("onboarding copy explains empty, demo, and storage-error states", () => {
  assert.match(onboardingCopy().title, /Start/);
  assert.match(onboardingCopy({ hasSamples: true }).description, /demo/i);
  assert.equal(onboardingCopy({ storageError: true }).tone, "error");
});

test("download templates contain the required response-pair fields", () => {
  assert.match(DATASET_TEMPLATE_CSV, /external_id,prompt,response_1,response_2/);
  const jsonl = JSON.parse(DATASET_TEMPLATE_JSONL);
  assert.deepEqual(Object.keys(jsonl).slice(0, 4), ["external_id", "prompt", "response_1", "response_2"]);
});

test("HTML keeps the onboarding controls and dataset file input wired by stable IDs", async () => {
  const html = await readFile(INDEX_HTML, "utf8");
  for (const id of ["onboarding-panel", "onboarding-import", "onboarding-load-demo", "onboarding-create", "onboarding-reset-demo", "download-template-csv", "download-template-jsonl", "dataset-file", "dataset-library", "dataset-nav-count", "dataset-import-open", "dataset-import-dialog", "dataset-import-issues", "download-rejected-rows", "review-session-header", "session-name", "session-position", "session-progress-fill", "session-blind-indicator", "workstation-save-state", "complete-session", "previous-case", "skip-current-case", "skip-dialog", "skip-reason", "accept-skip", "analytics", "analytics-dataset-filter", "analytics-rubric-filter", "analytics-tag-filter", "analytics-reviewer-filter", "analytics-date-from", "analytics-date-to", "analytics-include-samples", "analytics-completion", "analytics-skip", "analytics-tie", "analytics-conflict", "analytics-low-confidence", "analytics-dimensions", "analytics-gap-buckets", "analytics-source", "analytics-calibration", "analytics-limitations", "audit-exports", "audit-include-samples", "export-audit-json", "export-analysis-csv", "export-summary-md", "v3-storage-status", "v3-storage-label", "v3-storage-detail", "use-v3-workspace", "bootstrap-v3-workspace", "check-v3-workspace", "v3-review-panel", "v3-dataset-select", "v3-reviewer-id", "v3-session-seed", "v3-create-session", "v3-session-status", "v3-assignment-view", "v3-previous-assignment", "v3-start-assignment", "v3-next-assignment", "v3-complete-session", "v3-reveal-session", "methodology-dialog", "methodology-title", "methodology-description", "import-dialog", "import-title", "import-detail"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /<dialog[^>]+id=["']methodology-dialog["'][^>]+aria-labelledby=["']methodology-title["'][^>]+aria-describedby=["']methodology-description["']/);
  assert.match(html, /<dialog[^>]+id=["']import-dialog["'][^>]+aria-labelledby=["']import-title["'][^>]+aria-describedby=["']import-detail["']/);
  assert.match(html, /accept=["'][^"']*\.csv/);
  assert.match(html, /accept=["'][^"']*\.jsonl/);
});
