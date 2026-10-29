/** Durable, ordered mirror operations. Replay is idempotent (IDs / field patches). */
let database;
let chain = Promise.resolve();
const UNSAFE = 'aichat.sync.unjournaled';

async function open() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('aichat-file-outbox', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('operations', { autoIncrement: true, keyPath: 'sequence' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function transaction(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('operations', mode);
    const request = fn(tx.objectStore('operations'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = () => reject(tx.error || new Error('待同步记录保存失败'));
    tx.onerror = () => {};
  });
}

export function enqueue(operation) {
  // Copy now: callers may mutate their settings/runtime objects while IDB opens.
  const copy = JSON.parse(JSON.stringify(operation));
  const pending = transaction('readwrite', (s) => s.add(copy));
  pending.catch(() => { try { localStorage.setItem(UNSAFE, copy.generation || '0'); } catch {} });
  return pending;
}

function serialized(run) {
  const locked = () => globalThis.navigator?.locks
    ? navigator.locks.request('aichat-file-sync', run) : run();
  const result = chain.then(locked, locked);
  chain = result.catch(() => {});
  return result;
}

export function drain(send) {
  return serialized(async () => {
    if (localStorage.getItem(UNSAFE)) throw new Error('有修改未能保存到同步队列，已保留浏览器数据；请先导出浏览器备份，再通过导入备份恢复；立即同步不会覆盖未入队的数据');
    for (const row of await transaction('readonly', (s) => s.getAll())) {
      try { await send(row.path, row.body, row.method, row.generation || '0'); }
      catch (err) { err.operation = row; throw err; }
      await transaction('readwrite', (s) => s.delete(row.sequence));
    }
  });
}

export async function firstQueuedOperation() {
  return (await transaction('readonly', (s) => s.getAll()))[0] || null;
}

/** 解决冲突只处理当前队首；与所有窗口的同步共用锁，避免误删另一条操作。 */
export function rewriteQueuedOperation(sequence, rewrite) {
  return serialized(async () => {
    const row = await firstQueuedOperation();
    if (!row || row.sequence !== sequence) throw new Error('待同步内容已变化，请重新查看');
    const body = await rewrite(row);
    if (body === null) await transaction('readwrite', (s) => s.delete(sequence));
    else await transaction('readwrite', (s) => s.put({ ...row, body }));
  });
}

export async function clearOutbox() {
  return serialized(async () => {
    await transaction('readwrite', (s) => s.clear());
    localStorage.removeItem(UNSAFE);
  });
}

/** A reset invalidates old operations, but must not discard another tab's new-generation writes. */
export function discardStaleOperations(retiredGenerations) {
  return serialized(async () => {
    // A stale /state response must never discard writes from a later reset.
    const retired = new Set(retiredGenerations);
    const rows = await transaction('readonly', (s) => s.getAll());
    await transaction('readwrite', (s) => {
      for (const row of rows) if (retired.has(row.generation || '0')) s.delete(row.sequence);
    });
    const unsafe = localStorage.getItem(UNSAFE);
    if (unsafe && retired.has(unsafe === '1' ? '0' : unsafe)) localStorage.removeItem(UNSAFE);
  });
}
