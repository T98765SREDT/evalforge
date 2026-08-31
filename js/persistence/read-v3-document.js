import { validateWorkspaceDocument } from "../domain/entities.js";
import { IndexedDbRepository } from "./indexeddb-repository.js";

/**
 * Entity stores that make up a complete v3 workspace document. Recovery and
 * metadata records are deliberately excluded: they are migration/control
 * data, not part of the review document consumed by analytics and exports.
 */
export const V3_DOCUMENT_STORES = Object.freeze([
  "workspaces",
  "rubrics",
  "datasets",
  "cases",
  "sessions",
  "assignments",
  "reviews",
  "auditEvents"
]);

function readError(error, fallbackCode = "indexeddb_read_failed") {
  return {
    code: error?.code || fallbackCode,
    message: error?.message || "Could not read the EvalForge v3 workspace."
  };
}

function emptyCollections() {
  return Object.fromEntries(V3_DOCUMENT_STORES.map((store) => [store, []]));
}

function documentFromCollections(collections) {
  return {
    schemaVersion: 3,
    workspace: collections.workspaces[0],
    rubrics: collections.rubrics,
    datasets: collections.datasets,
    cases: collections.cases,
    sessions: collections.sessions,
    assignments: collections.assignments,
    reviews: collections.reviews,
    auditEvents: collections.auditEvents
  };
}

/**
 * Read the v3 IndexedDB entity stores without writing, migrating, or changing
 * the legacy browser UI state. The result is explicit so callers can keep the
 * old UI usable when v3 is unavailable, empty, or invalid.
 */
export async function readV3Document({ repository = null, indexedDB = globalThis.indexedDB } = {}) {
  let target = repository;
  let ownsRepository = false;
  try {
    if (!target) {
      target = new IndexedDbRepository({ indexedDB });
      ownsRepository = true;
    }

    const values = await Promise.all(V3_DOCUMENT_STORES.map(async (store) => {
      const records = await target.list(store);
      if (!Array.isArray(records)) throw new Error(`IndexedDB store ${store} did not return an array.`);
      return [store, records];
    }));
    const collections = Object.fromEntries(values);
    const workspaces = collections.workspaces;

    if (workspaces.length === 0) {
      return { status: "empty", document: null, counts: Object.fromEntries(V3_DOCUMENT_STORES.map((store) => [store, collections[store].length])) };
    }
    if (workspaces.length !== 1) {
      return {
        status: "invalid",
        document: null,
        error: { code: "multiple_workspaces", message: "EvalForge v3 expects exactly one workspace record." },
        counts: { workspaces: workspaces.length }
      };
    }

    const document = documentFromCollections(collections);
    const validation = validateWorkspaceDocument(document);
    if (!validation.valid) {
      return { status: "invalid", document: null, error: { code: "invalid_v3_document", errors: validation.errors }, counts: Object.fromEntries(V3_DOCUMENT_STORES.map((store) => [store, collections[store].length])) };
    }

    return {
      status: "ready",
      document,
      readOnly: true,
      source: "indexeddb-v3",
      counts: Object.fromEntries(V3_DOCUMENT_STORES.map((store) => [store, collections[store].length]))
    };
  } catch (error) {
    const unavailable = error?.code === "indexeddb_unavailable";
    return { status: unavailable ? "unavailable" : "error", document: null, error: readError(error, unavailable ? "indexeddb_unavailable" : "indexeddb_read_failed") };
  } finally {
    if (ownsRepository) target?.close();
  }
}

/**
 * A small display-safe summary for status banners and diagnostics. It never
 * includes prompts, candidate content, rationale, or other review text.
 */
export function summarizeV3Read(result) {
  if (!result || typeof result !== "object") return { status: "error", label: "Unavailable", detail: "No v3 read result was returned." };
  if (result.status === "ready") {
    const count = result.counts?.reviews || 0;
    return { status: "ready", label: "Verified v3 workspace", detail: `${count} review${count === 1 ? "" : "s"} available for read-only analysis.` };
  }
  if (result.status === "empty") return { status: "empty", label: "No v3 workspace", detail: "IndexedDB does not contain a migrated workspace yet." };
  if (result.status === "unavailable") return { status: "unavailable", label: "v3 storage unavailable", detail: result.error?.message || "IndexedDB is unavailable in this browser." };
  return { status: result.status || "error", label: "v3 workspace needs attention", detail: result.error?.message || "The v3 workspace could not be verified." };
}

export { documentFromCollections, emptyCollections };
