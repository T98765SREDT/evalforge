import { normalizeEvaluationCollection } from "./model.js";
import { normalizeBatch } from "./queue.js";

export const STORAGE_KEY = "evalforge.evaluations.v1";
export const QUEUE_STORAGE_KEY = "evalforge.queue.v1";

function clone(value) {
  return structuredClone(value);
}

export function loadEvaluationState(fallback = [], storage = globalThis.localStorage) {
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (!stored) {
      const fallbackResult = normalizeEvaluationCollection(fallback);
      return {
        evaluations: fallbackResult.evaluations,
        report: { ...fallbackResult.report, repaired: 0, source: "fallback" },
        error: null
      };
    }

    const parsed = JSON.parse(stored);
    const records = Array.isArray(parsed) ? parsed : parsed?.evaluations;
    const result = normalizeEvaluationCollection(records);
    return {
      evaluations: result.evaluations,
      report: { ...result.report, source: "storage" },
      error: null
    };
  } catch (error) {
    console.warn("EvalForge could not read local storage.", error);
    const fallbackResult = normalizeEvaluationCollection(fallback);
    return {
      evaluations: fallbackResult.evaluations,
      report: { total: 0, accepted: fallbackResult.evaluations.length, repaired: 0, skipped: 1, source: "fallback" },
      error
    };
  }
}

export function loadEvaluations(fallback = [], storage = globalThis.localStorage) {
  return loadEvaluationState(fallback, storage).evaluations;
}

export function saveEvaluations(evaluations, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(evaluations));
    return { ok: true, error: null };
  } catch (error) {
    console.warn("EvalForge could not save to local storage.", error);
    return { ok: false, error };
  }
}

export function commitEvaluations(candidate, previous, storage = globalThis.localStorage) {
  const result = saveEvaluations(candidate, storage);
  return result.ok
    ? { ok: true, evaluations: clone(candidate), error: null }
    : { ok: false, evaluations: clone(previous), error: result.error };
}

export function clearStoredEvaluations(storage = globalThis.localStorage) {
  try {
    storage.removeItem(STORAGE_KEY);
    return { ok: true, error: null };
  } catch (error) {
    console.warn("EvalForge could not clear local storage.", error);
    return { ok: false, error };
  }
}

export function loadQueueState(fallback, storage = globalThis.localStorage) {
  try {
    const stored = storage.getItem(QUEUE_STORAGE_KEY);
    if (!stored) return { batch: structuredClone(fallback), report: { source: "fallback", repaired: 0, skipped: 0 }, error: null };
    const result = normalizeBatch(JSON.parse(stored));
    if (!result) throw new Error("Stored queue is not an object.");
    return { batch: result.batch, report: { ...result.report, source: "storage" }, error: null };
  } catch (error) {
    console.warn("EvalForge could not read the local review queue.", error);
    return { batch: structuredClone(fallback), report: { source: "fallback", repaired: 0, skipped: 0 }, error };
  }
}

export function saveQueue(batch, storage = globalThis.localStorage) {
  try {
    storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(batch));
    return { ok: true, error: null };
  } catch (error) {
    console.warn("EvalForge could not save the local review queue.", error);
    return { ok: false, error };
  }
}

export function commitQueue(candidate, previous, storage = globalThis.localStorage) {
  const result = saveQueue(candidate, storage);
  return result.ok
    ? { ok: true, batch: structuredClone(candidate), error: null }
    : { ok: false, batch: structuredClone(previous), error: result.error };
}
