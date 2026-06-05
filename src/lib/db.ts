import type { HistoryItem } from "./types";

const DB_NAME = "EcomImgGen";
const DB_VERSION = 1;
const STORE = "detailPages";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const dbAdd = (item: HistoryItem) =>
  run<IDBValidKey>("readwrite", (store) => store.add(item));

export const dbPut = (item: HistoryItem) =>
  run<IDBValidKey>("readwrite", (store) => store.put(item));

export const dbAll = () =>
  run<HistoryItem[]>("readonly", (store) => store.getAll());

export const dbDel = (id: number) =>
  run<undefined>("readwrite", (store) => store.delete(id));

export const dbClear = () =>
  run<undefined>("readwrite", (store) => store.clear());
