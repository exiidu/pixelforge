/** 上传源文件的持久化（IndexedDB）——会话恢复后仍可重转换。
 *
 * 会话只序列化 JSON（localStorage 5MB 轻量副本 + web/session.json 全量），都是文本通道，
 * 上传的 File 无法序列化，于是恢复后的文档没有源图：不能重转换、也不能出引擎线稿。
 * 这里把原始 Blob 存进 IndexedDB（可存二进制、配额远大于 localStorage），会话里只记一个 key。
 *
 * 失败一律降级：任何一步拿不到 IndexedDB 就返回 null，调用方按"无源图"处理（原有行为）。
 */

const DB_NAME = "pf.sources";
const STORE = "sources";
const MAX_COUNT = 200; // 最多保留的源文件数，超出按最久未用淘汰（LRU）

interface SourceRecord {
  key: string;
  name: string;
  type: string;
  size: number;
  lastUsed: number;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" }).createIndex("lastUsed", "lastUsed");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** 内容指纹（SHA-256 前 32 位十六进制）；无 subtle 时退化为名字+大小+时间。 */
async function fileKey(file: File): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  } catch {
    return `f_${file.name}_${file.size}_${file.lastModified}`
      .replace(/[^\w.-]/g, "_").slice(0, 60);
  }
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** 存入源文件，返回 key；失败返回 null（调用方按"无源图"降级）。 */
export async function putSource(file: File): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  const key = await fileKey(file);
  const rec: SourceRecord = {
    key, name: file.name, type: file.type, size: file.size,
    lastUsed: Date.now(), blob: file,
  };
  let ok = (await run(db, "readwrite", (s) => s.put(rec))) !== null;
  if (!ok) {
    // 多半是配额打满：先淘汰一半再试一次，仍失败就放弃（会话正文不受影响）
    await prune(db, Math.floor(MAX_COUNT / 2));
    ok = (await run(db, "readwrite", (s) => s.put(rec))) !== null;
  }
  if (!ok) return null;
  void prune(db, MAX_COUNT);
  return key;
}

/** 取回源文件（刷新 LRU 时间）；无则 null。 */
export async function getSource(key: string): Promise<File | null> {
  const db = await openDb();
  if (!db) return null;
  const rec = await run<SourceRecord>(db, "readonly", (s) => s.get(key) as IDBRequest<SourceRecord>);
  if (!rec) return null;
  void run(db, "readwrite", (s) => s.put({ ...rec, lastUsed: Date.now() }));
  return rec.blob instanceof File
    ? rec.blob
    : new File([rec.blob], rec.name, { type: rec.type });
}

/** 淘汰到 <= limit 个（按最久未用优先）。 */
async function prune(db: IDBDatabase, limit: number): Promise<void> {
  const total = await run<number>(db, "readonly", (s) => s.count());
  if (total === null || total <= limit) return;
  let excess = total - limit;
  await new Promise<void>((resolve) => {
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const cursorReq = store.index("lastUsed").openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || excess <= 0) { resolve(); return; }
        cursor.delete();
        excess--;
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 清空全部源文件（会话"忽略并清空"时调用）。 */
export async function clearSources(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await run(db, "readwrite", (s) => s.clear());
}
