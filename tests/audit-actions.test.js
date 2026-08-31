import test from "node:test";
import assert from "node:assert/strict";
import { createSyntheticDocument } from "../scripts/benchmark.mjs";
import { createBrowserAuditDocument, createBrowserAuditExports } from "../js/ui/audit-actions.js";

const now = () => "2026-08-29T16:00:00.000Z";

const evaluation = {
  id: "user-evaluation-1",
  title: "A support answer",
  prompt: "How should I reset my password?",
  responseA: "Use the reset link.",
  responseB: "Contact support.",
  ratings: {
    A: { accuracy: 5, relevance: 4, clarity: 4, completeness: 3, safety: 5 },
    B: { accuracy: 4, relevance: 3, clarity: 3, completeness: 3, safety: 5 }
  },
  scores: { A: { score: 84 }, B: { score: 72 } },
  winner: "A",
  confidence: 80,
  notes: "A gives a direct recovery path.",
  tags: ["support"],
  status: "complete",
  createdAt: now(),
  updatedAt: now()
};

test("browser audit document is pure and keeps the active stores unchanged", () => {
  const evaluations = [evaluation];
  const queueCases = [];
  const document = createBrowserAuditDocument({ evaluations, queueCases, now, idFactory: (() => { let id = 0; return () => `test-${++id}`; })() });
  assert.equal(document.schemaVersion, 3);
  assert.equal(document.reviews.length, 1);
  assert.equal(evaluations[0].id, "user-evaluation-1");
  assert.deepEqual(queueCases, []);
});

test("browser exports honor sample filtering and produce all three deliverables", () => {
  const output = createBrowserAuditExports({ evaluations: [evaluation], now, generatedAt: now() });
  assert.equal(output.bundle.bundleVersion, 1);
  assert.equal(output.bundle.reviews.length, 1);
  assert.match(output.csv, /humanPreference/);
  assert.match(output.markdown, /Completed reviews/);
  assert.doesNotMatch(output.markdown, /reset my password/);
});

test("browser export includes linked queue cases without changing application state", () => {
  const output = createBrowserAuditExports({
    evaluations: [],
    queueCases: [{ id: "queue-1", title: "Queued", prompt: "Prompt", responseA: "A", responseB: "B", status: "pending" }],
    now
  });
  assert.equal(output.bundle.cases.length, 1);
  assert.equal(output.bundle.assignments[0].state, "pending");
  assert.equal(output.bundle.reviews.length, 0);
});

test("browser exports can use an explicitly selected validated v3 document", () => {
  const source = createSyntheticDocument(1);
  const output = createBrowserAuditExports({ document: source, generatedAt: now() });
  assert.equal(output.bundle.workspace.id, source.workspace.id);
  assert.equal(output.bundle.reviews.length, 1);
  assert.match(output.csv, /model-alpha/);
  source.cases[0].input = "caller mutation";
  assert.notEqual(output.document.cases[0].input, "caller mutation");
});
