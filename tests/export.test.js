import test from "node:test";
import assert from "node:assert/strict";
import { escapeCsv, evaluationsToCsv, evaluationsToJson } from "../js/export.js";

const evaluation = {
  id: "eval-1",
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:05:00.000Z",
  status: "complete",
  winner: "A",
  confidence: 91,
  tags: ["JavaScript", "Code review"],
  prompt: "Compare A, B, and C",
  responseA: "First line\nSecond line",
  responseB: "A plain response",
  notes: "A says \"why\", not only what.",
  scores: { A: { score: 92 }, B: { score: 68 } }
};

test("CSV escaping handles commas, quotes, newlines, and arrays", () => {
  assert.equal(escapeCsv("plain"), "plain");
  assert.equal(escapeCsv("one,two"), '"one,two"');
  assert.equal(escapeCsv('say "hello"'), '"say ""hello"""');
  assert.equal(escapeCsv(["A", "B"]), "A | B");
});

test("CSV export includes a stable header and flattened scores", () => {
  const csv = evaluationsToCsv([evaluation]);
  const lines = csv.split("\n");
  assert.match(lines[0], /^id,createdAt,updatedAt,status,winner,scoreA,scoreB/);
  assert.match(csv, /eval-1/);
  assert.match(csv, /,92,68,91,/);
  assert.match(csv, /JavaScript \| Code review/);
  assert.match(csv, /"Compare A, B, and C"/);
});

test("JSON export is versioned and preserves structured evaluation data", () => {
  const parsed = JSON.parse(evaluationsToJson([evaluation]));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.evaluationCount, 1);
  assert.equal(parsed.evaluations[0].scores.A.score, 92);
  assert.ok(!Number.isNaN(Date.parse(parsed.exportedAt)));
});
