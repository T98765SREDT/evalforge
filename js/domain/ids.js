const RESERVED_CANDIDATE_IDS = new Set(["a", "b", "left", "right"]);

export function isReservedCandidateId(value) {
  return typeof value === "string" && RESERVED_CANDIDATE_IDS.has(value.trim().toLowerCase());
}

export function assertStableId(value, path = "id") {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.trim())) {
    throw new TypeError(`${path} must be a stable identifier.`);
  }
  return value.trim();
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function stableSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

// Deterministic, non-cryptographic digest for content checks and reproducible IDs.
export function stableHash(value) {
  const text = typeof value === "string" ? value : stableSerialize(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function deterministicId(prefix, value) {
  const cleanPrefix = assertStableId(prefix, "prefix").replace(/[:._-]+$/g, "");
  return `${cleanPrefix}-${stableHash(value)}`;
}

export function contentHash(value) {
  return `fnv1a-${stableHash(value)}`;
}

export function requireIdFactory(idFactory) {
  if (typeof idFactory !== "function") throw new TypeError("An idFactory must be injected when an entity has no id.");
  return assertStableId(idFactory(), "id");
}

export function requireClock(now) {
  if (typeof now !== "function") throw new TypeError("A now function must be injected when an entity has no timestamp.");
  const value = now();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError("now() must return an ISO timestamp.");
  return value;
}
