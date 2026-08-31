#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseDatasetImport, importPlanSummary } from "../js/domain/dataset-import.js";
import { migrateV2ToV3 } from "../js/domain/migrate-v2.js";
import {
  documentFromAuditBundle,
  summaryMarkdown,
  summarizeAuditDocument,
  validateAuditBundle,
  verifyAuditBundle
} from "../js/domain/audit-export.js";

function usage() {
  return [
    "EvalForge CLI",
    "",
    "  node cli/evalforge.mjs validate dataset.jsonl",
    "  node cli/evalforge.mjs migrate backup-v2.json --out backup-v3.json",
    "  node cli/evalforge.mjs verify audit.json",
    "  node cli/evalforge.mjs summarize audit.json --format table|json|md"
  ].join("\n");
}

function fail(message, code = 2) {
  console.error(message);
  process.exitCode = code;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function parseOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

function formatForPath(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  return "auto";
}

function table(summary) {
  return [
    "Metric                         Value",
    "----------------------------  -----",
    `Completed reviews             ${summary.completedReviews}`,
    `Preference/score conflicts    ${summary.preferenceScoreConflicts}`,
    `Conflict rate                 ${summary.conflictRate === null ? "—" : `${Math.round(summary.conflictRate * 100)}%`}`,
    `Average confidence            ${summary.averageConfidence === null ? "—" : summary.averageConfidence.toFixed(2)}`,
    `Revised reviews               ${summary.revisions}`,
    `Datasets                      ${summary.datasets}`,
    `Cases                         ${summary.cases}`
  ].join("\n");
}

async function main(argv) {
  const [command, input, ...options] = argv;
  if (!command || command === "--help" || command === "-h") {
    print(usage());
    return;
  }
  if (!input) return fail(`Missing input file.\n\n${usage()}`);

  try {
    if (command === "validate") {
      const plan = parseDatasetImport(await readFile(resolve(input), "utf8"), { format: formatForPath(input), mode: "strict" });
      print({ file: basename(input), format: plan.format, summary: importPlanSummary(plan), accepted: plan.accepted, duplicates: plan.duplicates, rejected: plan.rejected, warnings: plan.warnings, issues: plan.issues });
      if (plan.rejected > 0) process.exitCode = 1;
      return;
    }
    if (command === "migrate") {
      const out = parseOption(options, "--out");
      if (!out) return fail("migrate requires --out output.json");
      const migrated = migrateV2ToV3(await readJson(input), { now: () => new Date().toISOString(), idFactory: (() => { let count = 0; return () => `cli-${++count}`; })() });
      await writeFile(resolve(out), `${JSON.stringify(migrated.workspace, null, 2)}\n`, "utf8");
      print({ output: out, sourceHash: migrated.sourceHash, report: migrated.report });
      return;
    }
    if (command === "verify") {
      const result = validateAuditBundle(await readJson(input));
      print(result);
      if (!result.valid) process.exitCode = 1;
      return;
    }
    if (command === "summarize") {
      const bundle = await readJson(input);
      const verified = verifyAuditBundle(bundle);
      const document = documentFromAuditBundle(bundle);
      const format = parseOption(options, "--format", "table");
      const summary = summarizeAuditDocument(document);
      if (format === "json") print({ verified, summary });
      else if (format === "md") print(summaryMarkdown(document));
      else if (format === "table") print(table(summary));
      else return fail(`Unsupported summary format: ${format}`);
      return;
    }
    return fail(`Unknown command: ${command}\n\n${usage()}`);
  } catch (error) {
    fail(error.message || "EvalForge CLI failed.", 1);
  }
}

await main(process.argv.slice(2));
