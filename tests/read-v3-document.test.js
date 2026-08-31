import test from "node:test";
import assert from "node:assert/strict";

import { createSyntheticDocument } from "../scripts/benchmark.mjs";
import { createWorkspace } from "../js/domain/entities.js";
import { MemoryRepository } from "../js/persistence/memory-repository.js";
import { readV3Document, summarizeV3Read, V3_DOCUMENT_STORES } from "../js/persistence/read-v3-document.js";

function repositoryFromDocument(document) {
  return new MemoryRepository({
    workspaces: { [document.workspace.id]: document.workspace },
    rubrics: Object.fromEntries(document.rubrics.map((value) => [value.id, value])),
    datasets: Object.fromEntries(document.datasets.map((value) => [value.id, value])),
    cases: Object.fromEntries(document.cases.map((value) => [value.id, value])),
    sessions: Object.fromEntries(document.sessions.map((value) => [value.id, value])),
    assignments: Object.fromEntries(document.assignments.map((value) => [value.id, value])),
    reviews: Object.fromEntries(document.reviews.map((value) => [value.id, value])),
    auditEvents: Object.fromEntries(document.auditEvents.map((value) => [value.id, value]))
  });
}

test("readV3Document reports an unavailable adapter and an empty repository explicitly", async () => {
  const unavailable = await readV3Document({ indexedDB: null });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.error.code, "indexeddb_unavailable");

  const emptyRepository = new MemoryRepository();
  const empty = await readV3Document({ repository: emptyRepository });
  assert.equal(empty.status, "empty");
  assert.equal(empty.document, null);
  assert.deepEqual(Object.keys(empty.counts), V3_DOCUMENT_STORES);
  assert.deepEqual(summarizeV3Read(empty), {
    status: "empty",
    label: "No v3 workspace",
    detail: "IndexedDB does not contain a migrated workspace yet."
  });
});

test("readV3Document returns a validated, read-only document without mutating storage", async () => {
  const source = createSyntheticDocument(2);
  const repository = repositoryFromDocument(source);
  const result = await readV3Document({ repository });

  assert.equal(result.status, "ready");
  assert.equal(result.readOnly, true);
  assert.equal(result.source, "indexeddb-v3");
  assert.deepEqual(result.counts, {
    workspaces: 1,
    rubrics: 1,
    datasets: 1,
    cases: 2,
    sessions: 1,
    assignments: 2,
    reviews: 2,
    auditEvents: 2
  });
  assert.deepEqual(result.document, source);

  result.document.cases[0].input = "local mutation only";
  assert.notEqual(repository.get("cases", source.cases[0].id).input, "local mutation only");
  assert.deepEqual(summarizeV3Read(result), {
    status: "ready",
    label: "Verified v3 workspace",
    detail: "2 reviews available for read-only analysis."
  });
});

test("readV3Document rejects malformed and ambiguous workspace collections", async () => {
  const malformed = new MemoryRepository({ workspaces: { "workspace-bad": { schemaVersion: 3, id: "workspace-bad" } } });
  const invalid = await readV3Document({ repository: malformed });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.error.code, "invalid_v3_document");
  assert.equal(invalid.error.errors[0].path, "workspace.name");

  const workspaceA = createWorkspace({ id: "workspace-a", name: "A", createdAt: "2026-01-01T00:00:00.000Z" });
  const workspaceB = createWorkspace({ id: "workspace-b", name: "B", createdAt: "2026-01-01T00:00:00.000Z" });
  const ambiguous = new MemoryRepository({ workspaces: { [workspaceA.id]: workspaceA, [workspaceB.id]: workspaceB } });
  const multiple = await readV3Document({ repository: ambiguous });
  assert.equal(multiple.status, "invalid");
  assert.equal(multiple.error.code, "multiple_workspaces");
  assert.equal(multiple.counts.workspaces, 2);
});

