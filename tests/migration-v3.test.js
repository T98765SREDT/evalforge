import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migrateV2ToV3 } from "../js/domain/migrate-v2.js";
import { validateWorkspaceDocument } from "../js/domain/entities.js";

const FIXTURE_ROOT = new URL("./fixtures/", import.meta.url);
const now = () => "2026-08-29T12:00:00.000Z";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

function idFactory() {
  let next = 0;
  return () => `migration-${++next}`;
}

test("v2 export and queue migrate to one valid v3 workspace", async () => {
  const exportData = await fixture("v2-export.json");
  const queueData = await fixture("v2-queue.json");
  const result = migrateV2ToV3({ export: exportData, queue: queueData }, { now, idFactory: idFactory() });
  assert.equal(result.workspace.schemaVersion, 3);
  assert.equal(result.workspace.cases.length, 6);
  assert.equal(result.workspace.datasets.filter((dataset) => dataset.isDemo).length, 1);
  assert.equal(result.workspace.reviews.length, 3);
  assert.equal(result.workspace.assignments.length, 6);
  assert.equal(validateWorkspaceDocument(result.workspace).valid, true);
  assert.equal(result.workspace.workspace.settings.blindHistory, "not_blind");
  const custom = result.workspace.reviews.find((review) => review.rubricSnapshot.rubricId === "custom-reliability");
  assert.deepEqual(custom.rubricSnapshot.dimensions.map(({ id, weight }) => ({ id, weight })), [
    { id: "accuracy", weight: 35 },
    { id: "relevance", weight: 20 },
    { id: "clarity", weight: 15 },
    { id: "completeness", weight: 20 },
    { id: "safety", weight: 10 }
  ]);
  assert.equal(custom.rubricSnapshot.tieThreshold, 3);
  assert.equal(custom.computed.winner, custom.preference);
  assert.equal(result.report.repaired >= 1, true);
  assert.equal(result.report.warnings.some(({ code }) => code === "legacy-scoring-algorithm-unknown"), true);
});

test("browser array storage migrates instead of producing an empty workspace", async () => {
  const exportData = await fixture("v2-export.json");
  const result = migrateV2ToV3({ export: exportData.evaluations }, { now, idFactory: idFactory() });
  assert.equal(result.workspace.cases.length, exportData.evaluations.length);
  assert.equal(result.workspace.reviews.length, exportData.evaluations.length);
  assert.equal(result.report.accepted, exportData.evaluations.length);
  assert.equal(validateWorkspaceDocument(result.workspace).valid, true);
});

test("migration is deterministic and never mutates v2 input", async () => {
  const exportData = await fixture("v2-export.json");
  const queueData = await fixture("v2-queue.json");
  const input = { export: exportData, queue: queueData };
  const before = structuredClone(input);
  const first = migrateV2ToV3(input, { now, idFactory: idFactory() });
  const second = migrateV2ToV3(input, { now, idFactory: idFactory() });
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});

test("linked queue cases reuse the migrated evaluation case", async () => {
  const exportData = await fixture("v2-export.json");
  const queueData = await fixture("v2-queue.json");
  const result = migrateV2ToV3({ evaluations: exportData.evaluations, queue: queueData }, { now, idFactory: idFactory() });
  const linkedEvaluationCase = result.workspace.cases.find((reviewCase) => reviewCase.externalId === "v2-complete-custom-rubric");
  assert.equal(result.workspace.cases.filter((reviewCase) => reviewCase.externalId === "v2-complete-custom-rubric").length, 1);
  assert.equal(result.workspace.assignments.filter((assignment) => assignment.caseId === linkedEvaluationCase.id).length, 1);
  assert.equal(result.report.warnings.some(({ code }) => code === "linked-queue-content-diff"), true);
});

test("invalid v2 entries are skipped with a path and reason", () => {
  const result = migrateV2ToV3({ evaluations: [null, { unrelated: true }] }, { now, idFactory: idFactory() });
  assert.equal(result.report.skipped, 2);
  assert.equal(result.report.warnings.length, 2);
  assert.equal(result.report.warnings[0].path, "evaluations[0]");
  assert.equal(result.report.warnings[0].code, "invalid-evaluation");
  assert.equal(validateWorkspaceDocument(result.workspace).valid, true);
});
