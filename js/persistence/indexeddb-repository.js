import { RepositoryError, clone } from "./repository.js";

export const INDEXEDDB_NAME = "evalforge-v3";
export const INDEXEDDB_VERSION = 1;
export const INDEXEDDB_STORES = Object.freeze([
  "workspaces",
  "rubrics",
  "datasets",
  "cases",
  "sessions",
  "assignments",
  "reviews",
  "auditEvents",
  "recovery",
  "meta"
]);

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new RepositoryError("IndexedDB request failed.", { code: "indexeddb_request_failed" }));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new RepositoryError("IndexedDB transaction failed.", { code: "indexeddb_transaction_failed" }));
    transaction.onabort = () => reject(transaction.error || new RepositoryError("IndexedDB transaction was aborted.", { code: "indexeddb_transaction_aborted" }));
  });
}

function cursorValues(request) {
  return new Promise((resolve, reject) => {
    const values = [];
    request.onerror = () => reject(request.error || new RepositoryError("IndexedDB cursor failed.", { code: "indexeddb_request_failed" }));
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(values);
        return;
      }
      values.push(clone(cursor.value));
      cursor.continue();
    };
  });
}

function resolvedStore(store) {
  return store === "checkpoints" ? "meta" : store;
}

class IndexedDbTransaction {
  constructor(transaction) { this.transaction = transaction; }

  get(store, id) {
    return requestPromise(this.transaction.objectStore(resolvedStore(store)).get(id)).then(clone);
  }

  list(store) {
    const objectStore = this.transaction.objectStore(resolvedStore(store));
    if (typeof objectStore.getAll === "function") return requestPromise(objectStore.getAll()).then((values) => values.map(clone));
    return cursorValues(objectStore.openCursor());
  }

  put(store, value) {
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) throw new RepositoryError("IndexedDB entities require a stable id.", { code: "missing_id", store });
    const record = store === "checkpoints" ? { id: `checkpoint:${value.id}`, type: "checkpoint", value: clone(value.value) } : clone(value);
    return requestPromise(this.transaction.objectStore(resolvedStore(store)).put(record)).then(() => clone(value));
  }

  delete(store, id) {
    return requestPromise(this.transaction.objectStore(resolvedStore(store)).delete(store === "checkpoints" ? `checkpoint:${id}` : id));
  }

  checkpoint(name, value) {
    return this.put("checkpoints", { id: name, value });
  }
}

export class IndexedDbRepository {
  constructor({ indexedDB = globalThis.indexedDB, name = INDEXEDDB_NAME, version = INDEXEDDB_VERSION } = {}) {
    if (!indexedDB || typeof indexedDB.open !== "function") throw new RepositoryError("IndexedDB is not available in this browser.", { code: "indexeddb_unavailable" });
    this.indexedDB = indexedDB;
    this.name = name;
    this.version = version;
    this.dbPromise = null;
  }

  open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      let request;
      try { request = this.indexedDB.open(this.name, this.version); }
      catch (error) { reject(new RepositoryError(error.message, { code: "indexeddb_open_failed" })); return; }
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of INDEXEDDB_STORES) if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new RepositoryError("Could not open IndexedDB.", { code: "indexeddb_open_failed" }));
      request.onblocked = () => reject(new RepositoryError("Another tab is blocking the EvalForge database upgrade.", { code: "indexeddb_upgrade_blocked" }));
    }).catch((error) => {
      this.dbPromise = null;
      throw error;
    });
    return this.dbPromise;
  }

  async transaction(callback, { stores = INDEXEDDB_STORES, mode = "readwrite" } = {}) {
    if (typeof callback !== "function") throw new TypeError("transaction() requires a callback.");
    if (mode !== "readonly" && mode !== "readwrite") throw new RepositoryError("IndexedDB transaction mode is not supported.", { code: "invalid_transaction_mode" });
    const database = await this.open();
    let transaction;
    try { transaction = database.transaction(stores.map(resolvedStore), mode); }
    catch (error) { throw new RepositoryError(error.message, { code: "indexeddb_transaction_failed" }); }
    const api = new IndexedDbTransaction(transaction);
    try {
      const result = await callback(api);
      await transactionPromise(transaction);
      return clone(result);
    } catch (error) {
      try { transaction.abort(); } catch { /* already aborted */ }
      throw error;
    }
  }

  async get(store, id) {
    return this.transaction((transaction) => transaction.get(store, id), { stores: [resolvedStore(store)], mode: "readonly" });
  }

  async list(store) {
    return this.transaction((transaction) => transaction.list(store), { stores: [resolvedStore(store)], mode: "readonly" });
  }

  async put(store, value) {
    return this.transaction((transaction) => transaction.put(store, value), { stores: [resolvedStore(store)] });
  }

  async checkpoint(name, value) {
    return this.transaction((transaction) => transaction.checkpoint(name, value), { stores: ["meta"] });
  }

  close() {
    if (this.dbPromise) this.dbPromise.then((database) => database.close());
    this.dbPromise = null;
  }
}
