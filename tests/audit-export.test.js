import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAuditBundle, analysisCsv, documentFromAuditBundle, summaryMarkdown, summarizeAuditDocument, validateAuditBundle, verifyAuditBundle } from "../js/domain/audit-export.js";
import { migrateV2ToV3 } from "../js/domain/migrate-v2.js";

const fixtureRoot = new URL("./fixtures/", import.meta.url);
const now = () => "2026-08-29T15:00:00.000Z";

async function migratedDocument() {
  const source = {
    export: JSON.parse(await readFile(new URL("v2-export.json", fixtureRoot), "utf8")),
    queue: JSON.parse(await readFile(new URL("v2-queue.json", fixtureRoot), "utf8"))
  };
  return migrateV2ToV3(source, { now, idFactory: (() => { let count = 0; return () => `audit-test-${++count}`; })() }).workspace;
}

test("audit bundle excludes demo data by default and verifies references/checksums", async () => {
  const document = await migratedDocument();
  const bundle = createAuditBundle(document, { generatedAt: now() });
  assert.equal(bundle.bundleVersion, 1);
  assert.equal(bundle.includeSamples, false);
  assert.equal(bundle.datasets.some(({ isDemo }) => isDemo), false);
  assert.equal(bundle.reviews.length, 2);
  assert.deepEqual(verifyAuditBundle(bundle).counts.reviews, 2);
  assert.equal(validateAuditBundle(bundle).valid, true);
});

test("audit bundle can include samples and restore the validated document shape", async () => {
  const document = await migratedDocument();
  const bundle = createAuditBundle(document, { includeSamples: true, generatedAt: now() });
  assert.equal(bundle.datasets.some(({ isDemo }) => isDemo), true);
  const restored = documentFromAuditBundle(bundle);
  assert.equal(restored.schemaVersion, 3);
  assert.equal(restored.cases.length, document.cases.length);
});

test("tampering with immutable candidate content fails audit verification", async () => {
  const bundle = createAuditBundle(await migratedDocument(), { generatedAt: now() });
  const tampered = structuredClone(bundle);
  tampered.cases[0].candidates[0].content = "Changed after export";
  const result = validateAuditBundle(tampered);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /contentHash/);
});

test("analysis CSV keeps source metadata and protects spreadsheet formulas", async () => {
  const document = await migratedDocument();
  document.reviews.find(({ state }) => state === "complete").rationale = "=unsafe formula text";
  const output = analysisCsv(document);
  assert.match(output, /humanPreference/);
  assert.match(output, /'=unsafe formula text/);
  assert.doesNotMatch(output, /prompt|responseA|responseB/);
});

test("summary uses aggregate values without leaking prompt or candidate content", async () => {
  const document = await migratedDocument();
  const summary = summarizeAuditDocument(document);
  assert.equal(summary.completedReviews, 1);
  const markdown = summaryMarkdown(document);
  assert.match(markdown, /Completed reviews/);
  assert.doesNotMatch(markdown, /Compare these responses|Close the ticket/);
});
