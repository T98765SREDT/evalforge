import { ENTITY_STORES, RepositoryError, assertStoreName, clone } from "./repository.js";

function emptyState(seed = {}) {
  return Object.fromEntries(ENTITY_STORES.map((store) => [store, new Map(Object.entries(seed[store] || {}))]));
}

class MemoryTransaction {
  constructor(repository, state) {
    this.repository = repository;
    this.state = state;
    this.writeCount = 0;
  }

  get(store, id) {
    assertStoreName(store);
    return clone(this.state[store].get(id));
  }

  list(store) {
    assertStoreName(store);
    return [...this.state[store].values()].map(clone);
  }

  put(store, value) {
    assertStoreName(store);
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) throw new RepositoryError("Repository entities require a stable id.", { code: "missing_id", store });
    this.state[store].set(value.id, clone(value));
    this.writeCount += 1;
    this.repository.maybeFail(this.writeCount, store, value.id);
    return clone(value);
  }

  delete(store, id) {
    assertStoreName(store);
    this.state[store].delete(id);
    this.writeCount += 1;
    this.repository.maybeFail(this.writeCount, store, id);
  }

  checkpoint(name, value) {
    return this.put("checkpoints", { id: name, value: clone(value) });
  }
}

/**
 * Synchronous in-memory implementation of the repository contract. Every
 * transaction works on a cloned state and publishes it only after the callback
 * returns, so an injected failure cannot leak a partial write.
 */
export class MemoryRepository {
  constructor(seed = {}, { failureAtWrite = null } = {}) {
    this.state = emptyState(seed);
    this.failureAtWrite = failureAtWrite;
  }

  maybeFail(writeCount, store, id) {
    if (this.failureAtWrite !== null && writeCount === this.failureAtWrite) {
      throw new RepositoryError(`Injected failure after write ${writeCount} (${store}/${id}).`, { code: "injected_failure", store, id });
    }
  }

  setFailureAtWrite(value) {
    this.failureAtWrite = value === null ? null : Number(value);
  }

  transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("transaction() requires a callback.");
    const candidate = Object.fromEntries(ENTITY_STORES.map((store) => [store, new Map([...this.state[store].entries()].map(([id, value]) => [id, clone(value)]))]));
    const transaction = new MemoryTransaction(this, candidate);
    const result = callback(transaction);
    if (result && typeof result.then === "function") throw new RepositoryError("MemoryRepository transactions must be synchronous.", { code: "async_transaction" });
    this.state = candidate;
    return clone(result);
  }

  get(store, id) {
    assertStoreName(store);
    return clone(this.state[store].get(id));
  }

  list(store) {
    assertStoreName(store);
    return [...this.state[store].values()].map(clone);
  }

  put(store, value) {
    return this.transaction((transaction) => transaction.put(store, value));
  }

  checkpoint(name, value) {
    return this.transaction((transaction) => transaction.checkpoint(name, value));
  }

  snapshot() {
    return Object.fromEntries(ENTITY_STORES.map((store) => [store, Object.fromEntries([...this.state[store].entries()].map(([id, value]) => [id, clone(value)]))]));
  }
}
