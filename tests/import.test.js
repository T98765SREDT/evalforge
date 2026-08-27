import test from "node:test";
import assert from "node:assert/strict";
import { evaluationsToJson } from "../js/export.js";
import { ImportValidationError, createImportPlan, parseEvaluationImport } from "../js/import.js";
import { normalizeEvaluation } from "../js/model.js";

function evaluation(id, prompt = `Prompt ${id}`) {
  return normalizeEvaluation({ id, prompt });
}

test("a current EvalForge export can be parsed for restore", () => {
  const source = [evaluation("one"), evaluation("two")];
  const parsed = parseEvaluationImport(evaluationsToJson(source));
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.report.accepted, 2);
  assert.equal(parsed.report.repaired, 0);
  assert.deepEqual(parsed.evaluations, source);
});

test("legacy schema exports are migrated with a visible repair count", () => {
  const parsed = parseEvaluationImport(JSON.stringify({
    schemaVersion: 1,
    evaluations: [{ id: "legacy", prompt: "Legacy prompt" }, null]
  }));
  assert.equal(parsed.report.accepted, 1);
  assert.equal(parsed.report.repaired, 1);
  assert.equal(parsed.report.skipped, 1);
  assert.equal(parsed.evaluations[0].recordVersion, 2);
});

test("future and malformed schemas are rejected before state changes", () => {
  assert.throws(
    () => parseEvaluationImport('{"schemaVersion":99,"evaluations":[]}'),
    (error) => error instanceof ImportValidationError && /supports up to/.test(error.message)
  );
  assert.throws(
    () => parseEvaluationImport('{"schemaVersion":2}'),
    /evaluations array/
  );
  assert.throws(() => parseEvaluationImport("not json"), /not valid JSON/);
});

test("merge keeps local records while imported ID conflicts use the imported version", () => {
  const existing = [evaluation("one", "Local one"), evaluation("two", "Local two")];
  const imported = [evaluation("two", "Imported two"), evaluation("three", "Imported three")];
  const plan = createImportPlan(existing, imported, "merge");
  assert.equal(plan.added, 1);
  assert.equal(plan.updated, 1);
  assert.equal(plan.removed, 0);
  assert.deepEqual(plan.evaluations.map(({ id }) => id), ["one", "two", "three"]);
  assert.equal(plan.evaluations[1].prompt, "Imported two");
});

test("replace produces a complete isolated candidate without mutating either input", () => {
  const existing = [evaluation("one")];
  const imported = [evaluation("two")];
  const plan = createImportPlan(existing, imported, "replace");
  plan.evaluations[0].prompt = "Changed candidate";
  assert.equal(existing[0].prompt, "Prompt one");
  assert.equal(imported[0].prompt, "Prompt two");
  assert.equal(plan.removed, 1);
});
