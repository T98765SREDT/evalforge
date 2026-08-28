import { createId } from "./model.js";
import { getRubricProfile } from "./scoring.js";

export const QUEUE_SCHEMA_VERSION = 1;
export const QUEUE_STATUSES = Object.freeze(["pending", "in_progress", "completed", "skipped"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value) {
  return typeof value === "string" && value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function uniqueId(value, idFactory) {
  const id = text(value);
  return id && id.length <= 128 ? id : idFactory();
}

function normalizedSignature(value) {
  return [value.prompt, value.responseA, value.responseB]
    .map((part) => text(part).replace(/\s+/g, " ").toLowerCase())
    .join("\u001f");
}

export function normalizeQueueCase(value, { idFactory = createId, now = new Date().toISOString() } = {}) {
  if (!isPlainObject(value)) return null;
  const prompt = text(value.prompt);
  const responseA = text(value.responseA);
  const responseB = text(value.responseB);
  if (!prompt || !responseA || !responseB) return null;

  const profile = getRubricProfile(typeof value.rubricId === "string" ? value.rubricId : "general");
  const status = QUEUE_STATUSES.includes(value.status) ? value.status : "pending";
  const createdAt = validDate(value.createdAt) || now;
  const updatedAt = validDate(value.updatedAt) || createdAt;

  return {
    id: uniqueId(value.id, idFactory),
    title: text(value.title) || prompt.split("\n")[0].slice(0, 80),
    prompt,
    responseA,
    responseB,
    rubricId: profile.id,
    status,
    evaluationId: text(value.evaluationId) || null,
    skipReason: text(value.skipReason) || "",
    createdAt,
    updatedAt
  };
}

export function createBatch({ id = null, name = "Review queue", rubricId = "general", createdAt = null, updatedAt = null, cases = [] } = {}, { idFactory = createId, now = new Date().toISOString() } = {}) {
  const profile = getRubricProfile(rubricId);
  const seen = new Set();
  const normalizedCases = [];
  for (const value of Array.isArray(cases) ? cases : []) {
    const item = normalizeQueueCase(value, { idFactory, now });
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    normalizedCases.push(item);
  }
  const created = validDate(createdAt) || now;
  return {
    queueVersion: QUEUE_SCHEMA_VERSION,
    id: uniqueId(id, idFactory),
    name: text(name) || "Review queue",
    rubricId: profile.id,
    createdAt: created,
    updatedAt: validDate(updatedAt) || created,
    cases: normalizedCases
  };
}

export function normalizeBatch(value, { idFactory = createId, now = new Date().toISOString() } = {}) {
  if (!isPlainObject(value)) return null;
  const rawCases = Array.isArray(value.cases) ? value.cases : [];
  const batch = createBatch({
    id: value.id,
    name: value.name,
    rubricId: value.rubricId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    cases: rawCases
  }, { idFactory, now });
  const repaired = JSON.stringify(batch) !== JSON.stringify(value);
  return { batch, report: { total: rawCases.length, accepted: batch.cases.length, repaired, skipped: rawCases.length - batch.cases.length } };
}

export function enqueueCase(batch, value, { idFactory = createId, now = new Date().toISOString() } = {}) {
  const item = normalizeQueueCase(value, { idFactory, now });
  if (!item) throw new TypeError("A queue case needs a prompt and two responses.");
  const signature = normalizedSignature(item);
  const duplicate = batch.cases.find((candidate) => normalizedSignature(candidate) === signature && candidate.status !== "skipped");
  if (duplicate) return { batch: structuredClone(batch), queuedCase: structuredClone(duplicate), duplicate: true };
  const next = structuredClone(batch);
  next.cases.push(item);
  next.updatedAt = now;
  return { batch: next, queuedCase: structuredClone(item), duplicate: false };
}

export function startCase(batch, caseId, now = new Date().toISOString()) {
  const next = structuredClone(batch);
  const item = next.cases.find((candidate) => candidate.id === caseId);
  if (!item || ["completed", "skipped"].includes(item.status)) return { batch: next, queuedCase: null };
  item.status = "in_progress";
  item.updatedAt = now;
  next.updatedAt = now;
  return { batch: next, queuedCase: structuredClone(item) };
}

export function claimNextCase(batch, now = new Date().toISOString()) {
  const item = batch.cases.find((candidate) => candidate.status === "pending");
  return item ? startCase(batch, item.id, now) : { batch: structuredClone(batch), queuedCase: null };
}

export function completeCase(batch, caseId, evaluationId = null, now = new Date().toISOString()) {
  return updateCase(batch, caseId, (item) => {
    item.status = "completed";
    item.evaluationId = text(evaluationId) || item.evaluationId || null;
    item.skipReason = "";
    item.updatedAt = now;
  }, now);
}

export function skipCase(batch, caseId, reason = "", now = new Date().toISOString()) {
  return updateCase(batch, caseId, (item) => {
    item.status = "skipped";
    item.skipReason = text(reason) || "Skipped from the review queue.";
    item.updatedAt = now;
  }, now);
}

function updateCase(batch, caseId, update, now) {
  const next = structuredClone(batch);
  const item = next.cases.find((candidate) => candidate.id === caseId);
  if (!item) return { batch: next, updated: false };
  update(item);
  next.updatedAt = now;
  return { batch: next, updated: true };
}

export function nextPendingCase(batch) {
  const item = batch.cases.find((candidate) => candidate.status === "pending");
  return item ? structuredClone(item) : null;
}

export function queueProgress(batch) {
  const counts = Object.fromEntries(QUEUE_STATUSES.map((status) => [status, 0]));
  batch.cases.forEach(({ status }) => { counts[status] = (counts[status] || 0) + 1; });
  const total = batch.cases.length;
  const finished = counts.completed + counts.skipped;
  return {
    total,
    pending: counts.pending,
    inProgress: counts.in_progress,
    completed: counts.completed,
    skipped: counts.skipped,
    finished,
    percent: total ? Math.round((finished / total) * 100) : 0
  };
}
