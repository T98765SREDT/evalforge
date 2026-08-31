import { performance } from "node:perf_hooks";

import { calculateAnalytics } from "../js/domain/analytics.js";
import { createAuditBundle } from "../js/domain/audit-export.js";
import { createBlindAssignment, createSession } from "../js/domain/blind-session.js";
import { contentHash, stableHash } from "../js/domain/ids.js";
import {
  createCase,
  createDataset,
  createReview,
  createRubric,
  createWorkspace,
  assertWorkspaceDocument
} from "../js/domain/entities.js";
import { parseDatasetImport } from "../js/domain/dataset-import.js";
import { MemoryRepository } from "../js/persistence/memory-repository.js";

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const DIMENSIONS = Object.freeze([
  { id: "accuracy", label: "Accuracy", description: "Correctness of claims and logic.", weight: 30, anchors: { 1: "Contains major errors.", 3: "Mostly correct with minor issues.", 5: "Correct and well-supported." } },
  { id: "relevance", label: "Relevance", description: "How directly the response addresses the prompt.", weight: 20, anchors: { 1: "Does not address the prompt.", 3: "Partly addresses the prompt.", 5: "Directly addresses the prompt." } },
  { id: "clarity", label: "Clarity", description: "How easy the response is to understand.", weight: 15, anchors: { 1: "Hard to follow.", 3: "Understandable with some friction.", 5: "Clear and easy to follow." } },
  { id: "completeness", label: "Completeness", description: "Coverage of requirements and important edge cases.", weight: 15, anchors: { 1: "Important requirements are missing.", 3: "Covers the main path.", 5: "Covers requirements and edge cases." } },
  { id: "safety", label: "Safety", description: "Avoidance of harmful or misleading guidance.", weight: 20, anchors: { 1: "Introduces serious risk.", 3: "Generally safe with gaps.", 5: "Careful and appropriate." } }
]);

function timestamp(index = 0) {
  return new Date(BASE_TIME + index * 1000).toISOString();
}

function benchmarkRubric() {
  return createRubric({
    id: "rubric-benchmark",
    name: "Benchmark rubric",
    description: "Deterministic rubric used only for local performance measurements.",
    version: "1.0.0",
    tieThreshold: 2,
    dimensions: DIMENSIONS
  });
}

function benchmarkCase(index, datasetId) {
  const suffix = String(index).padStart(4, "0");
  return createCase({
    id: `case-benchmark-${suffix}`,
    datasetId,
    externalId: `benchmark-${suffix}`,
    input: `How should a support agent handle benchmark request ${suffix}?`,
    candidates: [
      {
        id: `candidate-benchmark-${suffix}-one`,
        content: `Candidate one gives a concise, safe answer for request ${suffix}.`,
        source: "model-alpha",
        metadata: { modelVersion: "alpha-1" }
      },
      {
        id: `candidate-benchmark-${suffix}-two`,
        content: `Candidate two gives an alternative answer for request ${suffix}.`,
        source: "model-beta",
        metadata: { modelVersion: "beta-1" }
      }
    ],
    metadata: { tags: [index % 2 === 0 ? "support" : "technical", "benchmark"] }
  });
}

function rubricSnapshot(rubric) {
  return {
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    scoringAlgorithmVersion: "weighted-v1",
    tieThreshold: rubric.tieThreshold,
    dimensions: rubric.dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      description: dimension.description,
      weight: dimension.weight,
      anchors: { ...dimension.anchors }
    }))
  };
}

function benchmarkReview(index, assignmentId, reviewCase, rubric) {
  const candidateIds = reviewCase.candidates.map((candidate) => candidate.id);
  const firstRatings = Object.fromEntries(rubric.dimensions.map((dimension) => [dimension.id, 5 - (index % 2)]));
  const secondRatings = Object.fromEntries(rubric.dimensions.map((dimension) => [dimension.id, 4]));
  const preference = index % 5 === 0 ? candidateIds[1] : candidateIds[0];
  return createReview({
    id: `review-benchmark-${String(index).padStart(4, "0")}`,
    assignmentId,
    revision: 1,
    rubricSnapshot: rubricSnapshot(rubric),
    ratings: { [candidateIds[0]]: firstRatings, [candidateIds[1]]: secondRatings },
    computed: {
      scoreByCandidate: { [candidateIds[0]]: index % 2 === 0 ? 92 : 88, [candidateIds[1]]: 84 },
      winner: candidateIds[0]
    },
    preference,
    confidence: index % 3 === 0 ? 2 : 4,
    confidenceScale: "anchored-1-5",
    preferenceEvidence: preference === candidateIds[0] ? "" : "The second response is more direct for this support context.",
    rationale: "The first response is clearer and safer for the stated support workflow.",
    issueLabels: [],
    state: "complete",
    createdAt: timestamp(index + 1),
    updatedAt: timestamp(index + 1),
    completedAt: timestamp(index + 1)
  });
}

/**
 * Build a deterministic, de-identified v3 document for local measurements.
 * The generated records never leave the process and contain no user data.
 */
export function createSyntheticDocument(size = 1000) {
  if (!Number.isInteger(size) || size < 1 || size > 10000) throw new RangeError("size must be an integer between 1 and 10000.");
  const rubric = benchmarkRubric();
  const dataset = createDataset({
    id: "dataset-benchmark",
    name: "Synthetic benchmark dataset",
    description: "Generated locally for repeatable measurements.",
    rubricRef: rubric.id,
    tags: ["benchmark"],
    createdAt: timestamp(),
    isDemo: false
  });
  const cases = Array.from({ length: size }, (_, index) => benchmarkCase(index, dataset.id));
  const session = createSession({
    id: "session-benchmark",
    datasetId: dataset.id,
    rubricRef: rubric.id,
    reviewerId: "reviewer-benchmark",
    seed: "benchmark-seed-2026",
    blindMode: true,
    state: "revealed",
    createdAt: timestamp(),
    completedAt: timestamp(size + 1),
    revealedAt: timestamp(size + 2)
  });
  const assignments = [];
  const reviews = [];
  const auditEvents = [];
  cases.forEach((reviewCase, index) => {
    const assignmentId = `assignment-benchmark-${String(index).padStart(4, "0")}`;
    const reviewId = `review-benchmark-${String(index).padStart(4, "0")}`;
    const assignment = createBlindAssignment({
      id: assignmentId,
      session,
      reviewCase,
      state: "complete",
      reviewId
    });
    assignments.push(assignment);
    reviews.push(benchmarkReview(index, assignmentId, reviewCase, rubric));
    auditEvents.push({
      schemaVersion: 3,
      id: `audit-benchmark-${String(index).padStart(4, "0")}`,
      entityType: "review",
      entityId: reviewId,
      action: "review_completed",
      actorId: session.reviewerId,
      at: timestamp(index + 1),
      details: { benchmark: true }
    });
  });
  const document = {
    schemaVersion: 3,
    workspace: createWorkspace({
      id: "workspace-benchmark",
      name: "Synthetic benchmark workspace",
      createdAt: timestamp(),
      updatedAt: timestamp(size + 3),
      rubricIds: [rubric.id],
      datasetIds: [dataset.id],
      settings: { benchmark: true }
    }),
    rubrics: [rubric],
    datasets: [dataset],
    cases,
    sessions: [session],
    assignments,
    reviews,
    auditEvents
  };
  assertWorkspaceDocument(document);
  return document;
}

export function createSyntheticJsonl(size = 1000) {
  return Array.from({ length: size }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    return JSON.stringify({
      external_id: `benchmark-${suffix}`,
      prompt: `How should a support agent handle benchmark request ${suffix}?`,
      response_1: `Candidate one gives a concise, safe answer for request ${suffix}.`,
      response_2: `Candidate two gives an alternative answer for request ${suffix}.`,
      model_1: "model-alpha",
      model_2: "model-beta",
      tags: [index % 2 === 0 ? "support" : "technical"]
    });
  }).join("\n");
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function measure(name, operation, repetitions) {
  const samples = [];
  let result;
  for (let index = 0; index < repetitions; index += 1) {
    const start = performance.now();
    result = operation();
    samples.push(performance.now() - start);
  }
  return {
    name,
    repetitions,
    medianMs: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
    result
  };
}

function applyDocument(document) {
  const repository = new MemoryRepository();
  repository.transaction((transaction) => {
    for (const [store, key] of [["workspaces", "workspace"], ["rubrics", "rubrics"], ["datasets", "datasets"], ["cases", "cases"], ["sessions", "sessions"], ["assignments", "assignments"], ["reviews", "reviews"], ["auditEvents", "auditEvents"]]) {
      const values = key === "workspace" ? [document.workspace] : document[key];
      values.forEach((value) => transaction.put(store, value));
    }
  });
  return repository.snapshot();
}

function measureSessionCreation(document) {
  const session = document.sessions[0];
  return document.cases.map((reviewCase, index) => createBlindAssignment({
    id: `session-run-assignment-${index}`,
    session,
    reviewCase
  })).length;
}

export function runBenchmark({ size = 1000, repetitions = 3 } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new RangeError("repetitions must be an integer between 1 and 20.");
  const document = createSyntheticDocument(size);
  const jsonl = createSyntheticJsonl(size);
  const audit = createAuditBundle(document, { generatedAt: timestamp(size + 4) });
  const operations = [
    measure("importPlanning", () => parseDatasetImport(jsonl, { format: "jsonl" }).accepted, repetitions),
    measure("memoryTransactionApply", () => applyDocument(document), repetitions),
    measure("sessionCreation", () => measureSessionCreation(document), repetitions),
    measure("analytics", () => calculateAnalytics({ document }), repetitions),
    measure("auditExport", () => createAuditBundle(document, { generatedAt: timestamp(size + 4) }), repetitions)
  ];
  const bytes = Buffer.byteLength(JSON.stringify(audit), "utf8");
  return {
    benchmark: "evalforge-local-v3",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      adapter: "MemoryRepository (IndexedDB is browser-only)"
    },
    input: {
      cases: size,
      candidates: size * 2,
      completedReviews: size,
      repetitions,
      auditBundleBytes: bytes,
      sourceHash: stableHash(jsonl),
      contentHash: contentHash({ cases: size, seed: "benchmark-seed-2026" })
    },
    operations: operations.map(({ result, ...summary }) => summary),
    notes: [
      "Measurements are local process timings, not service-level guarantees.",
      "Run on the same machine with the same size and repetitions when comparing changes.",
      "No production threshold is claimed until a baseline is recorded and reviewed."
    ]
  };
}

function parseArgs(argv) {
  const options = { size: 1000, repetitions: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--size") options.size = Number(argv[++index]);
    else if (argument === "--repetitions") options.repetitions = Number(argv[++index]);
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write("Usage: npm run benchmark -- [--size 1000] [--repetitions 3]\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else process.stdout.write(`${JSON.stringify(runBenchmark(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Benchmark failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
