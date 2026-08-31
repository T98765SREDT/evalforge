import { QUEUE_STORAGE_KEY, STORAGE_KEY } from "../storage.js";
import { migrateV2ToV3 } from "../domain/migrate-v2.js";
import { requireClock, stableHash } from "../domain/ids.js";
import { IndexedDbRepository } from "./indexeddb-repository.js";

export const MIGRATION_MARKER_ID = "migration:v2-to-v3";
export const RECOVERY_RECORD_IDS = Object.freeze({ evaluations: "legacy:evaluations", queue: "legacy:queue" });

function readRaw(storage, key) {
  if (!storage || typeof storage.getItem !== "function") return null;
  return storage.getItem(key);
}

function parseRaw(raw, label) {
  if (raw === null || raw === undefined || raw === "") return null;
  try { return JSON.parse(raw); }
  catch (error) {
    const wrapped = new Error(`The saved ${label} data is not valid JSON.`);
    wrapped.code = "legacy_json_invalid";
    wrapped.cause = error;
    throw wrapped;
  }
}

function recoveryRecord(id, key, raw, capturedAt) {
  return { id, key, payload: raw, integrityHash: raw === null ? null : `fnv1a-${stableHash(raw)}`, capturedAt, encoding: "utf-8", exact: true };
}

async function getMarker(repository) {
  return repository.get("meta", MIGRATION_MARKER_ID);
}

/**
 * Capture legacy localStorage strings, migrate them without mutating the old
 * keys, and publish v3 entities only in a completed IndexedDB transaction.
 */
export async function bootstrapV3({ repository = null, indexedDB = globalThis.indexedDB, storage = globalThis.localStorage, now, idFactory, retry = false } = {}) {
  const timestamp = requireClock(now);
  const target = repository || new IndexedDbRepository({ indexedDB });
  const existingMarker = await getMarker(target);
  if (existingMarker?.status === "completed") return { status: "completed", idempotent: true, marker: existingMarker, workspace: null, recovery: await listRecovery(target) };
  if (existingMarker?.status === "running" && !retry) return { status: "running", idempotent: false, needsRecovery: true, marker: existingMarker, workspace: null, recovery: await listRecovery(target) };
  if (existingMarker?.status === "failed" && !retry) return { status: "failed", idempotent: false, needsRecovery: true, marker: existingMarker, workspace: null, recovery: await listRecovery(target) };

  let evaluationsRaw;
  let queueRaw;
  try {
    evaluationsRaw = readRaw(storage, STORAGE_KEY);
    queueRaw = readRaw(storage, QUEUE_STORAGE_KEY);
  } catch (error) {
    return { status: "failed", needsRecovery: false, marker: null, workspace: null, recovery: [], error };
  }

  const recovery = [
    recoveryRecord(RECOVERY_RECORD_IDS.evaluations, STORAGE_KEY, evaluationsRaw, timestamp),
    recoveryRecord(RECOVERY_RECORD_IDS.queue, QUEUE_STORAGE_KEY, queueRaw, timestamp)
  ];
  let source;
  try {
    source = {
      export: parseRaw(evaluationsRaw, "evaluation"),
      queue: parseRaw(queueRaw, "queue")
    };
  } catch (error) {
    try {
      await target.transaction(async (transaction) => {
        for (const record of recovery) await transaction.put("recovery", record);
        await transaction.put("meta", { id: MIGRATION_MARKER_ID, status: "failed", failedAt: timestamp, error: { code: error.code || "legacy_json_invalid", message: error.message }, recoveryAvailable: false });
      });
    } catch { /* keep the original parse error as the useful result */ }
    return { status: "failed", needsRecovery: false, marker: await getMarker(target), workspace: null, recovery: await listRecovery(target), error };
  }

  try {
    await target.transaction(async (transaction) => {
      await transaction.put("meta", { id: MIGRATION_MARKER_ID, status: "running", startedAt: timestamp, sourceKeys: [STORAGE_KEY, QUEUE_STORAGE_KEY] });
      for (const record of recovery) await transaction.put("recovery", record);
    });
  } catch (error) {
    return { status: "failed", needsRecovery: true, marker: await getMarker(target), workspace: null, recovery: [], error };
  }

  try {
    const migrated = migrateV2ToV3(source, { now, idFactory });
    const document = migrated.workspace;
    await target.transaction(async (transaction) => {
      await transaction.put("workspaces", document.workspace);
      for (const rubric of document.rubrics) await transaction.put("rubrics", rubric);
      for (const dataset of document.datasets) await transaction.put("datasets", dataset);
      for (const reviewCase of document.cases) await transaction.put("cases", reviewCase);
      for (const session of document.sessions) await transaction.put("sessions", session);
      for (const assignment of document.assignments) await transaction.put("assignments", assignment);
      for (const review of document.reviews) await transaction.put("reviews", review);
      for (const event of document.auditEvents) await transaction.put("auditEvents", event);
      await transaction.put("meta", { id: MIGRATION_MARKER_ID, status: "completed", completedAt: timestamp, sourceHash: migrated.sourceHash, report: migrated.report, recoveryAvailable: true });
    });
    return { status: "completed", idempotent: false, marker: await getMarker(target), workspace: document, recovery: await listRecovery(target), report: migrated.report };
  } catch (error) {
    try {
      await target.transaction(async (transaction) => {
        await transaction.put("meta", { id: MIGRATION_MARKER_ID, status: "failed", failedAt: timestamp, error: { code: error.code || "migration_failed", message: error.message }, recoveryAvailable: true });
      });
    } catch { /* a storage failure should not hide the original migration error */ }
    return { status: "failed", needsRecovery: true, marker: await getMarker(target), workspace: null, recovery: await listRecovery(target), error };
  }
}

export async function listRecovery(repository) {
  return repository.list("recovery");
}
