import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { INDEXEDDB_STORES, IndexedDbRepository } from "../js/persistence/indexeddb-repository.js";
import { bootstrapV3, MIGRATION_MARKER_ID, RECOVERY_RECORD_IDS } from "../js/persistence/bootstrap.js";
import { QUEUE_STORAGE_KEY, STORAGE_KEY } from "../js/storage.js";

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  succeed(value) { this.result = value; queueMicrotask(() => this.onsuccess?.()); }
  fail(error) { this.error = error; queueMicrotask(() => this.onerror?.()); }
}

class FakeTransaction {
  constructor(database, stores, mode = "readwrite") {
    this.database = database;
    this.stores = stores;
    this.mode = mode;
    this.pending = new Map();
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this.aborted = false;
    this.timer = setTimeout(() => this.complete(), 0);
  }

  objectStore(name) {
    if (!this.stores.includes(name)) throw new Error(`Store ${name} was not included in the transaction.`);
    return new FakeObjectStore(this, name);
  }

  stage(name, id, value) {
    if (!this.pending.has(name)) this.pending.set(name, new Map());
    this.pending.get(name).set(id, structuredClone(value));
  }

  read(name, id) {
    if (this.pending.get(name)?.has(id)) return structuredClone(this.pending.get(name).get(id));
    return structuredClone(this.database.stores.get(name)?.get(id));
  }

  all(name) {
    const values = new Map(this.database.stores.get(name));
    for (const [id, value] of this.pending.get(name) || []) values.set(id, value);
    return [...values.values()].map((value) => structuredClone(value));
  }

  complete() {
    if (this.aborted) return;
    for (const [name, values] of this.pending) for (const [id, value] of values) this.database.stores.get(name).set(id, value);
    this.oncomplete?.();
  }

  abort(error = new Error("Transaction aborted")) {
    clearTimeout(this.timer);
    this.aborted = true;
    this.error = error;
    queueMicrotask(() => this.onabort?.());
  }
}

class FakeObjectStore {
  constructor(transaction, name) { this.transaction = transaction; this.name = name; }
  get(id) { const request = new FakeRequest(); request.succeed(this.transaction.read(this.name, id)); return request; }
  getAll() { const request = new FakeRequest(); request.succeed(this.transaction.all(this.name)); return request; }
  put(value) { if (this.transaction.mode === "readonly") throw new Error("A readonly transaction cannot write."); const request = new FakeRequest(); this.transaction.stage(this.name, value.id, value); request.succeed(value.id); return request; }
  delete(id) { const request = new FakeRequest(); this.transaction.stage(this.name, id, undefined); request.succeed(undefined); return request; }
}

class FakeDatabase {
  constructor() { this.stores = new Map(); this.lastTransactionMode = null; this.objectStoreNames = { contains: (name) => this.stores.has(name) }; }
  createObjectStore(name) { this.stores.set(name, new Map()); return {}; }
  transaction(names, mode) { this.lastTransactionMode = mode; return new FakeTransaction(this, names, mode); }
  close() {}
}

class FakeIndexedDB {
  constructor() { this.database = null; this.failAtWrite = null; }
  open() {
    const request = new FakeRequest();
    queueMicrotask(() => {
      if (!this.database) this.database = new FakeDatabase();
      request.result = this.database;
      if (!this.database.stores.size) request.onupgradeneeded?.();
      request.succeed(this.database);
    });
    return request;
  }
}

function localStorageStub(values) {
  const map = new Map(Object.entries(values));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    raw: map
  };
}

test("IndexedDbRepository creates the v3 stores and commits a transaction", async () => {
  const indexedDB = new FakeIndexedDB();
  const repository = new IndexedDbRepository({ indexedDB, name: "adapter-test" });
  await repository.transaction(async (transaction) => {
    await transaction.put("meta", { id: "settings", value: { theme: "light" } });
    await transaction.put("recovery", { id: "legacy:queue", payload: "{}" });
  });
  assert.deepEqual([...indexedDB.database.stores.keys()], INDEXEDDB_STORES);
  assert.deepEqual(await repository.get("meta", "settings"), { id: "settings", value: { theme: "light" } });
  assert.equal(indexedDB.database.lastTransactionMode, "readonly");
  assert.equal((await repository.list("recovery")).length, 1);
  assert.equal(indexedDB.database.lastTransactionMode, "readonly");
});

test("IndexedDbRepository keeps reads readonly and rejects writes in readonly mode", async () => {
  const indexedDB = new FakeIndexedDB();
  const repository = new IndexedDbRepository({ indexedDB, name: "readonly-test" });
  await repository.put("meta", { id: "safe", value: true });
  await assert.rejects(() => repository.transaction((transaction) => transaction.put("meta", { id: "blocked", value: true }), { stores: ["meta"], mode: "readonly" }), /readonly transaction cannot write/);
  assert.equal(await repository.get("meta", "blocked"), undefined);
});

test("IndexedDbRepository aborts a failed transaction without publishing staged data", async () => {
  const indexedDB = new FakeIndexedDB();
  const repository = new IndexedDbRepository({ indexedDB, name: "rollback-test" });
  await assert.rejects(() => repository.transaction(async (transaction) => {
    await transaction.put("meta", { id: "not-published", value: true });
    throw new Error("simulated quota failure");
  }), /simulated quota failure/);
  assert.equal(await repository.get("meta", "not-published"), undefined);
});

test("bootstrap captures exact legacy strings and is idempotent", async () => {
  const exportData = JSON.parse(await readFile(new URL("./fixtures/v2-export.json", import.meta.url), "utf8"));
  const queueData = JSON.parse(await readFile(new URL("./fixtures/v2-queue.json", import.meta.url), "utf8"));
  const storage = localStorageStub({ [STORAGE_KEY]: JSON.stringify(exportData), [QUEUE_STORAGE_KEY]: JSON.stringify(queueData) });
  const indexedDB = new FakeIndexedDB();
  const repository = new IndexedDbRepository({ indexedDB, name: "bootstrap-test" });
  const now = () => "2026-08-29T14:00:00.000Z";
  const idFactory = (() => { let next = 0; return () => `bootstrap-${++next}`; })();
  const first = await bootstrapV3({ repository, storage, now, idFactory });
  assert.equal(first.status, "completed");
  assert.equal(first.recovery.length, 2);
  assert.equal((await repository.list("cases")).length, 6);
  assert.equal((await repository.get("recovery", RECOVERY_RECORD_IDS.evaluations)).payload, storage.raw.get(STORAGE_KEY));
  assert.equal((await repository.get("meta", MIGRATION_MARKER_ID)).status, "completed");
  assert.equal(storage.raw.get(STORAGE_KEY), JSON.stringify(exportData));
  const second = await bootstrapV3({ repository, storage, now, idFactory });
  assert.equal(second.idempotent, true);
  assert.equal((await repository.list("cases")).length, 6);
});

test("bootstrap preserves recovery data when migration publication fails", async () => {
  const exportData = JSON.parse(await readFile(new URL("./fixtures/v2-export.json", import.meta.url), "utf8"));
  const storage = localStorageStub({ [STORAGE_KEY]: JSON.stringify(exportData) });
  const indexedDB = new FakeIndexedDB();
  const repository = new IndexedDbRepository({ indexedDB, name: "failure-bootstrap-test" });
  const originalTransaction = repository.transaction.bind(repository);
  let transactionNumber = 0;
  repository.transaction = async (...args) => {
    transactionNumber += 1;
    if (transactionNumber === 3) {
      const [callback, options] = args;
      return originalTransaction(async (transaction) => {
        let writes = 0;
        const failing = {
          ...transaction,
          put: async (...putArgs) => {
            writes += 1;
            if (writes === 4) throw new Error("simulated quota failure");
            return transaction.put(...putArgs);
          }
        };
        return callback(failing);
      }, options);
    }
    return originalTransaction(...args);
  };
  const result = await bootstrapV3({ repository, storage, now: () => "2026-08-29T14:00:00.000Z", idFactory: (() => { let next = 0; return () => `failed-${++next}`; })() });
  assert.equal(result.status, "failed");
  assert.equal(result.needsRecovery, true);
  assert.equal((await repository.list("recovery")).length, 2);
  assert.equal((await repository.get("meta", MIGRATION_MARKER_ID)).status, "failed");
  assert.equal((await repository.list("cases")).length, 0);
  const blocked = await bootstrapV3({ repository, storage, now: () => "2026-08-29T14:00:00.000Z", idFactory: (() => { let next = 0; return () => `retry-${++next}`; })() });
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.needsRecovery, true);
});

test("bootstrap retains malformed legacy payloads for manual recovery", async () => {
  const storage = localStorageStub({ [STORAGE_KEY]: "{not-json" });
  const repository = new IndexedDbRepository({ indexedDB: new FakeIndexedDB(), name: "malformed-bootstrap-test" });
  const result = await bootstrapV3({ repository, storage, now: () => "2026-08-29T14:00:00.000Z", idFactory: () => "malformed-1" });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "legacy_json_invalid");
  assert.equal(result.recovery.find(({ id }) => id === RECOVERY_RECORD_IDS.evaluations).payload, "{not-json");
  assert.equal((await repository.get("meta", MIGRATION_MARKER_ID)).status, "failed");
});
