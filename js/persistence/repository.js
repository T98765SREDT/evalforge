export const ENTITY_STORES = Object.freeze([
  "workspaces",
  "rubrics",
  "datasets",
  "cases",
  "sessions",
  "assignments",
  "reviews",
  "auditEvents",
  "checkpoints"
]);

export class RepositoryError extends Error {
  constructor(message, { code = "repository_error", store = null, id = null } = {}) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
    this.store = store;
    this.id = id;
  }
}

export class RepositoryConflictError extends RepositoryError {
  constructor(message, details = {}) { super(message, { ...details, code: details.code || "conflict" }); this.name = "RepositoryConflictError"; }
}

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function assertStoreName(store) {
  if (!ENTITY_STORES.includes(store)) throw new RepositoryError(`Unknown repository store: ${store}.`, { code: "unknown_store", store });
  return store;
}

export function assertRepositoryContract(repository) {
  for (const method of ["transaction", "get", "list", "put", "checkpoint"]) {
    if (typeof repository?.[method] !== "function") throw new TypeError(`Repository must implement ${method}().`);
  }
  return repository;
}
