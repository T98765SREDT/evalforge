import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));

function allIds(document) {
  const ids = [];
  for (const evaluation of document.evaluations || []) ids.push(evaluation.id);
  for (const item of document.cases || []) ids.push(item.id);
  return ids;
}

test("v2 export fixture freezes draft, complete, sample, and custom rubric records", () => {
  const fixture = readFixture("v2-export.json");
  assert.equal(fixture.schemaVersion, 2);
  assert.equal(fixture.evaluationCount, 3);
  assert.equal(fixture.evaluations.filter((item) => item.status === "complete").length, 2);
  assert.equal(fixture.evaluations.filter((item) => item.status === "draft").length, 1);
  assert.equal(fixture.evaluations.filter((item) => item.isSample).length, 1);
  const custom = fixture.evaluations.find((item) => item.id === "v2-complete-custom-rubric");
  assert.equal(custom.rubricSnapshot.tieThreshold, 3);
  assert.deepEqual(custom.rubricSnapshot.weights, { accuracy: 35, relevance: 20, clarity: 15, completeness: 20, safety: 10 });
});

test("v2 storage and queue fixtures contain stable IDs and every queue state", () => {
  const storage = readFixture("v2-storage.json");
  const queue = readFixture("v2-queue.json");
  assert.equal(storage.evaluations.length, 1);
  assert.deepEqual(new Set(queue.cases.map((item) => item.status)), new Set(["pending", "in_progress", "completed", "skipped"]));
  assert.equal(queue.cases.find((item) => item.id === "case-completed-api").evaluationId, "v2-complete-custom-rubric");
  assert.match(queue.cases.find((item) => item.id === "case-pending-unicode").prompt, /emoji/);
  assert.ok(queue.cases.find((item) => item.id === "case-in-progress-code").responseA.includes("SELECT"));
  assert.deepEqual(new Set(allIds(storage).concat(allIds(queue))).size, 5);
});

test("baseline fixtures contain no personal contact or production data", () => {
  for (const name of ["v2-export.json", "v2-storage.json", "v2-queue.json"]) {
    const text = fs.readFileSync(path.join(here, "fixtures", name), "utf8");
    assert.doesNotMatch(text, /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    assert.doesNotMatch(text, /github\.com|linkedin\.com|example\.com/i);
  }
});
