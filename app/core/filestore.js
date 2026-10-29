import { enqueue, drain, clearOutbox, discardStaleOperations, firstQueuedOperation, rewriteQueuedOperation } from './outbox.js';
import { applyChanges, diffChanges } from './sync.js';
import { entityFields } from './entity-sync.js';
/**
 * core/filestore.js —— 本地文件存储同步层
 *
 * 目标（用户要求）：**角色不用导出，直接保存在电脑本地的文件里，关掉程序也不会消失**。
 *
 * 工作方式：
 *   1. 浏览器里照旧用 IndexedDB 做即时读写（渲染、搜索都快）；
 *   2. 每次改动（新增/修改/删除角色、消息、记忆、设置）都镜像写一份到服务器，
 *      由 server.mjs 落盘到 `app/data/db/` 下的 JSON 文件；
 *   3. 每次启动时，以磁盘文件为准回填浏览器数据库 —— 所以哪怕浏览器数据被清空、
 *      换了浏览器、甚至换了一台电脑（把这个项目文件夹拷过去），角色和聊天记录都还在。
 *
 * 冲突策略：先重放持久化队列中的本地修改；全部确认成功后，才用磁盘快照回填本地库。
 * 同一 ID 的追加/更新可安全重试；若服务器是空的而本地库有角色
 * （即老用户第一次升级到带文件存储的版本），则把本地库整体推上盘，避免丢数据。
 *
 * 与 core/store.js 的分工：store.js 负责本地读写并在写完后调用这里的 mirror* 函数，
 * 本模块只做"与磁盘对话"，不参与界面。
 */
import { bus } from './bus.js';
import { createId, num } from './util.js';

const API = '/api/db';
const DELETED_KEY = 'aichat.deleted.v1';
const ENABLED_KEY = 'aichat.filestore.enabled';
const GENERATION_KEY = 'aichat.filestore.generation';
// Each tab keeps the generation of the data it loaded, not a sibling tab's later localStorage value.
let generation = '0';
try { generation = localStorage.getItem(GENERATION_KEY) || '0'; } catch {}
let wipedGeneration = null;
function acceptGeneration(value) {
  generation = value;
  try { localStorage.setItem(GENERATION_KEY, value); } catch {}
}

/** @type {{available:boolean, dir:string, status:'off'|'ok'|'syncing'|'error', error:string, lastSync:number, pending:number, conflict:boolean}} */
const state = {
  available: false,
  known: false,
  dir: '',
  status: 'off', // off=没用文件存储 / syncing / ok / error
  error: '',
  lastSync: 0,
  pending: 0,
  conflict: false,
};

function setStatus(status, error = '', detail = null) {
  state.status = status;
  state.error = error;
  state.conflict = detail?.code === 'entity-conflict';
  bus.emit('filestore:status', { ...state });
}

/** 取当前同步状态（给界面显示） */
export function fileStatus() {
  return { ...state };
}

/* ------------------------------------------------------------------ *
 * 本地删除墓碑：防止"服务器上已删、本地却因为回填又冒出来"
 * ------------------------------------------------------------------ */

function readDeleted() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeDeleted(obj) {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify(obj));
  } catch {
    /* 忽略：写不进去也不影响主流程 */
  }
}

/** 记录一次删除（charIds 之外的 extra 是"整库清空"时顺带清掉的 id） */
export function noteDeleted(charId, at = Date.now()) {
  if (!charId) return;
  const all = readDeleted();
  all[charId] = at;
  writeDeleted(all);
}

/** 清空删除记录（整库清空后调用，墓碑也随之失效） */
export function clearDeleted() {
  writeDeleted({});
}

/* ---- 群聊的删除墓碑（与角色分开存，避免 id 空间互相干扰） ---- */

const DELETED_GROUP_KEY = 'aichat.deleted.groups.v1';

function readGroupDeleted() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_GROUP_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeGroupDeleted(obj) {
  try {
    localStorage.setItem(DELETED_GROUP_KEY, JSON.stringify(obj));
  } catch {
    /* 忽略 */
  }
}

/** 记录一次群聊删除 */
export function noteGroupDeleted(groupId, at = Date.now()) {
  if (!groupId) return;
  const all = readGroupDeleted();
  all[groupId] = at;
  writeGroupDeleted(all);
}

/** 清空群聊删除记录 */
export function clearGroupDeleted() {
  writeGroupDeleted({});
}

/* ------------------------------------------------------------------ *
 * 与服务器通信
 * ------------------------------------------------------------------ */

async function apiPost(path, body, method = 'POST', expectedGeneration = generation, keepalive = false) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Aichat-Db-Generation': expectedGeneration },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    ...(keepalive ? { keepalive: true } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let info;
    try { info = JSON.parse(text).error; } catch {}
    const err = new Error(info?.message || `文件存储接口 ${res.status}：${text.slice(0, 200)}`);
    err.code = info?.code;
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

let pendingJournal = Promise.resolve();
function journal(path, body, method = 'POST') {
  bindPagehide();
  const operation = { path, body, method, generation };
  const ready = enqueue(operation);
  pendingJournal = Promise.all([pendingJournal.catch(() => {}), ready]);
  pendingJournal.catch(() => {});
  return ready;
}
async function mirrorPost(path, body, method = 'POST') {
  await journal(path, body, method);
  if (!state.available) throw new Error('文件服务离线，修改已保留，连接恢复后重试');
  await drain(apiPost);
}

async function apiGet(path) {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`文件存储接口 ${res.status}`);
  return res.json();
}

/**
 * 探测服务器是否提供本地文件存储（可能有人是纯静态部署，没有 server.mjs）
 * @returns {Promise<boolean>}
 */
export async function available(force = false) {
  try { state.known ||= localStorage.getItem(ENABLED_KEY) === '1'; } catch {}
  if (state.available && !force) return true;
  try {
    const res = await fetch(`${API}/state`, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    state.available = true;
    state.known = true;
    try { localStorage.setItem(ENABLED_KEY, '1'); } catch {}
    state.dir = data.dir || '';
    setStatus('ok');
    return true;
  } catch (err) {
    state.available = false;
    state.dir = '';
    setStatus(state.known ? 'error' : 'off', err && err.message ? err.message : '');
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 镜像写入（store.js 在每次本地写入后调用；失败不抛给调用方）
 * ------------------------------------------------------------------ */

/** 统一包装：出错只记录状态并广播，绝不影响聊天 */
function mirror(label, fn) {
  state.pending++;
  return fn()
    .then(() => {
      state.pending = Math.max(0, state.pending - 1);
      state.lastSync = Date.now();
      if (state.pending === 0) setStatus('ok');
      return true;
    })
    .catch((err) => {
      state.pending = Math.max(0, state.pending - 1);
      console.warn(`[filestore] ${label} 写盘失败（本地数据已保留）`, err && err.message);
      setStatus('error', (err && err.message) || String(err), err);
      return false;
    });
}

/**
 * 镜像一个角色（新增或修改）
 * @param {object} char
 */
export function mirrorCharacter(char, previous) {
  if (!char || !char.id) return Promise.resolve(false);
  // 存盘时不带 history 快照里的冗余内容也可以，但保留它便于回滚，所以整体写入
  const body = { data: char };
  if (previous !== undefined) body.base = previous && { ...previous, history: undefined };
  return mirror('角色', () => mirrorPost(`/characters/${encodeURIComponent(char.id)}`, body));
}

/** 镜像一条或多条消息（追加与修改都走追加，服务端按 id 去重后取最新） */
export function mirrorMessages(charId, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).filter((m) => m && m.id);
  if (!charId || !list.length) return Promise.resolve(false);
  return mirror('消息', () => mirrorPost(`/messages/${encodeURIComponent(charId)}`, { messages: list }));
}

/** 标记一条消息被删除（写一条删除标记，读到时会过滤掉） */
export function mirrorMessageDeleted(charId, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!charId || !list.length) return Promise.resolve(false);
  const marks = list.map((id) => ({ id, charId, deleted: true, at: Date.now() }));
  return mirror('删除消息', () => mirrorPost(`/messages/${encodeURIComponent(charId)}`, { messages: marks }));
}

/** 整段聊天记录重新落盘（清空聊天记录、或本地已有很多条需要对齐时用） */
export function mirrorMessagesReplace(charId, messages) {
  if (!charId) return Promise.resolve(false);
  return mirror('重写聊天记录', () => mirrorPost(`/messages/${encodeURIComponent(charId)}/replace`, { messages: messages || [] }));
}

/** 镜像角色记忆 */
export function mirrorMemory(charId, memory) {
  if (!charId) return Promise.resolve(false);
  return mirror('记忆', () => mirrorPost(`/memory/${encodeURIComponent(charId)}`, { data: { charId, ...memory } }));
}

/* ---------------------------------------------------------------------------
 * 设置与运行时状态（好感度 / 情绪 / 未读）的统一落盘
 *
 * 这里踩过一个真实的坑：原先 mirrorSettings 与 mirrorRuntime 是两个独立的去抖写入，
 * 而 mirrorSettings 写的是"调用那一刻捕获的 runtime 快照"。于是配置变更（拖滑块、
 * 切主题等）会把几百毫秒前的旧好感度延后写盘，正好覆盖掉刚聊出来的新值，
 * 表现为"重启后好感度退回初始值"。现在合并成一次写入，并且**在真正写盘的那一刻**
 * 才去取最新的设置与运行时状态，杜绝陈旧快照。
 * ------------------------------------------------------------------------- */
let stateTimer = null;
let statePayload = null;
/** pagehide 兜底只挂一次 */
let pagehideBound = false;
/** 当前待写任务的 resolve（被后来者取代时要先 settle，否则那个 Promise 永远 pending） */
let stateResolve = null;

/**
 * 运行时状态里只允许"真实存在的角色 / 群聊"的 id，其余一律丢掉。
 * 为什么要这一步：调试或旧版本可能往 runtime 里塞进过非角色键（例如探针用的键），
 * 它们会被一起写进磁盘文件，还会在启动回填时被合并回来，形成永远清不掉的垃圾数据。
 * @param {object} runtime
 * @returns {object}
 */
function sanitizeRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return {};
  const out = {};
  for (const [id, value] of Object.entries(runtime)) {
    if (!/^[a-z]_[A-Za-z0-9_-]{4,}$/i.test(id)) continue; // 只认 c_xxx / g_xxx 这类 id
    if (!value || typeof value !== 'object') continue;
    out[id] = value;
  }
  return out;
}

/** 同一实体保留更新较晚的完整运行时记录；无时间戳的旧记录以磁盘为准。 */
export function mergeRuntimeSnapshots(localRuntime, diskRuntime, liveIds) {
  const local = sanitizeRuntime(localRuntime);
  const disk = sanitizeRuntime(diskRuntime);
  const merged = {};
  for (const id of new Set([...Object.keys(disk), ...Object.keys(local)])) {
    if (liveIds instanceof Set && !liveIds.has(id)) continue;
    const a = local[id];
    const b = disk[id];
    const chosen = !b ? a : !a ? b : num(a.updatedAt, 0) > num(b.updatedAt, 0) ? a : b;
    if (chosen) merged[id] = { ...chosen };
  }
  return merged;
}

/**
 * 待写队列里的 runtime 是否"确实有待写内容"。
 *
 * 为什么不能用 `!== undefined` 判断：合并逻辑里 `(statePayload && statePayload.runtime)`
 * 在 statePayload 为 null 时会得到 **null**（不是 undefined），而 `sanitizeRuntime(null)`
 * 返回 `{}` —— 于是"只改了设置"也会给服务端送一个 `runtime:{}`，
 * 服务端看到 truthy 就把 runtime.json（好感度/未读）整份覆盖成空对象。
 * @param {unknown} v
 * @returns {boolean}
 */
const hasRuntimePayload = (v) => v !== undefined && v !== null;

/**
 * 安排一次"设置 + 运行时状态"落盘（去抖 700ms 合并）
 * @param {{settings?:object, runtime?:object, runtimes?:object}} patch
 * @returns {Promise<boolean>}
 */
export function mirrorSettings(patch) {
  bindPagehide();
  const p = patch || {};
  const data = {};
  if (p.settings !== undefined) data.settings = p.settings;
  if (hasRuntimePayload(p.runtime || p.runtimes)) data.runtime = sanitizeRuntime(p.runtime || p.runtimes);
  if (p.settingsChanges?.length) data.settingsChanges = p.settingsChanges;
  if (p.runtimeChanges?.length) data.runtimeChanges = p.runtimeChanges;
  if (!Object.keys(data).length) return Promise.resolve(true);
  const ready = journal('/settings', { data });
  ready.catch((err) => setStatus('error', err.message, err));
  const prev = statePayload || {};
  // 合并进待写队列：谁后到谁生效，避免互相覆盖。
  // 注意 `prev` 走默认 `{}`：直接写 `statePayload && statePayload.runtime` 会把 null 存进队列（见 hasRuntimePayload）。
  statePayload = {
    settings: p.settings !== undefined ? p.settings : prev.settings,
    settingsChanges: [...(prev.settingsChanges || []), ...(p.settingsChanges || [])],
    runtimeChanges: [...(prev.runtimeChanges || []), ...(p.runtimeChanges || [])],
    runtime: p.runtime !== undefined ? p.runtime : p.runtimes !== undefined ? p.runtimes : prev.runtime,
  };
  if (stateTimer) {
    clearTimeout(stateTimer);
    // 上一个待写任务被这次合并取代：把它 settle 掉（它要写的内容已经并进 statePayload）
    if (stateResolve) {
      stateResolve(false);
      stateResolve = null;
    }
  }
  return new Promise((resolve) => {
    stateResolve = resolve;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      stateResolve = null;
      statePayload = null;
      resolve(mirror('设置', async () => {
        await pendingJournal;
        if (!state.available) throw new Error('文件服务离线，设置已保留待同步');
        await drain(apiPost);
      }));
    }, 700);
  });
}

/**
 * 运行时状态（好感度/情绪/未读）落盘。
 * 与 mirrorSettings 共用同一个去抖队列，保证不会互相覆盖。
 * @param {object} runtime
 */
export function mirrorRuntime(runtime) {
  return mirrorSettings({ runtime });
}

/* ------------------------------------------------------------------ *
 * 群聊的镜像写入（与角色完全对称：群资料 / 群消息 / 删除墓碑）
 * ------------------------------------------------------------------ */

/** 镜像一个群聊（新增或修改） */
export function mirrorGroup(group, previous) {
  if (!group || !group.id) return Promise.resolve(false);
  const body = { data: group };
  if (previous !== undefined) body.base = previous;
  return mirror('群聊', () => mirrorPost(`/groups/${encodeURIComponent(group.id)}`, body));
}

/** 镜像群消息（追加与修改都走追加，服务端按 id 去重后取最新） */
export function mirrorGroupMessages(groupId, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).filter((m) => m && m.id);
  if (!groupId || !list.length) return Promise.resolve(false);
  return mirror('群消息', () => mirrorPost(`/groupmsgs/${encodeURIComponent(groupId)}`, { messages: list }));
}

/** 标记群消息被删除 */
export function mirrorGroupMessageDeleted(groupId, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!groupId || !list.length) return Promise.resolve(false);
  const marks = list.map((id) => ({ id, groupId, deleted: true, at: Date.now() }));
  return mirror('删除群消息', () => mirrorPost(`/groupmsgs/${encodeURIComponent(groupId)}`, { messages: marks }));
}

/** 整段群聊记录重新落盘（清空聊天记录时用） */
export function mirrorGroupMessagesReplace(groupId, messages) {
  if (!groupId) return Promise.resolve(false);
  return mirror('重写群聊记录', () =>
    mirrorPost(`/groupmsgs/${encodeURIComponent(groupId)}/replace`, { messages: messages || [] })
  );
}

/** 删除群聊：写墓碑并清掉它在磁盘上的两份数据 */
export function mirrorGroupDeleted(groupId) {
  if (!groupId) return Promise.resolve(false);
  noteGroupDeleted(groupId);
  return mirror('删除群聊', () => mirrorPost(`/groups/${encodeURIComponent(groupId)}`, undefined, 'DELETE'));
}

/**
 * 关窗/切后台时把还没写出去的状态立刻补发。
 * 为什么需要：设置与运行时状态是 700ms 去抖写盘，用户改完立刻关标签页就会丢掉这次改动，
 * 下次启动以磁盘为准就表现为"改了没生效"。
 * 用 fetch + keepalive（sendBeacon 不能设 Content-Type，服务器解析不了 JSON）。
 */
function flushStateNow() {
  if (!state.available || !statePayload) return;
  statePayload = null;
  if (stateTimer) {
    clearTimeout(stateTimer);
    stateTimer = null;
  }
  if (stateResolve) {
    stateResolve(false);
    stateResolve = null;
  }
  void pendingJournal.then(() => drain((path, body, method, expectedGeneration) => apiPost(path, body, method, expectedGeneration, true)))
    .catch((err) => setStatus('error', err.message, err));
}

/** 绑定关窗兜底（只挂一次） */
function bindPagehide() {
  if (pagehideBound || typeof window === 'undefined' || !window.addEventListener) return;
  pagehideBound = true;
  window.addEventListener('pagehide', flushStateNow);
  window.addEventListener('online', () => {
    void available(true).then((ok) => ok && pendingJournal.then(() => drain(apiPost)))
      .then(() => { if (state.available) setStatus('ok'); }).catch((err) => setStatus('error', err.message, err));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStateNow();
  });
}

/** 删除角色：写墓碑并清掉它在磁盘上的三份数据 */
export function mirrorCharacterDeleted(charId) {
  if (!charId) return Promise.resolve(false);
  noteDeleted(charId);
  return mirror('删除角色', () => mirrorPost(`/characters/${encodeURIComponent(charId)}`, undefined, 'DELETE'));
}

/** 整库清空（同时清掉本地删除墓碑） */
/**
 * 丢弃尚未发出的去抖写请求。
 * 用于整库清空/覆盖之前：那些请求携带的是"清空前"的数据，
 * 若在服务器清空之后才到达，会往刚删掉的目录里写文件（500 ENOENT），
 * 也会把已经清掉的数据又写回去。
 */
export function dropPendingWrites() {
  if (stateTimer) {
    clearTimeout(stateTimer);
    stateTimer = null;
  }
  if (stateResolve) {
    stateResolve(false);
    stateResolve = null;
  }
  statePayload = null;
}

export async function mirrorWipeAll(charIds) {
  if (!state.available) {
    if (state.known) { setStatus('error', '文件服务暂时不可用，已停止清空'); return false; }
    await pendingJournal;
    await clearOutbox();
    return false; // 纯静态模式没有远端数据库
  }
  // 清空前先把待写队列丢掉（否则旧数据可能在清空之后才落盘）
  dropPendingWrites();
  // force:true 表示"这是用户在设置里主动清空"，服务器才会放行整库删除
  // （不带 force 的整库清空会被 server.mjs 拒绝，防止误删电脑上的数据）
  return mirror('清空数据', async () => {
    await pendingJournal;
    await drain(apiPost);
    const ok = await apiPost('/wipe', { charIds: charIds || [], force: true });
    wipedGeneration = ok.generation || generation;
    // 墓碑要等服务端确认删除成功后再清：若请求失败而墓碑已丢，
    // 下次回填会把"删过但没真删掉"的角色/群拉回来
    await discardStaleOperations(ok.retiredGenerations || []);
    clearDeleted();
    clearGroupDeleted();
    return ok;
  });
}

/** Called only after store.wipeAll has successfully cleared the browser tables. */
export function completeWipeAll() {
  if (wipedGeneration !== null) acceptGeneration(wipedGeneration);
  wipedGeneration = null;
}

/* ------------------------------------------------------------------ *
 * 启动回填：以磁盘文件为准恢复浏览器数据库
 * ------------------------------------------------------------------ */

/**
 * 启动同步。返回值告诉调用方发生了什么，便于界面提示。
 * @returns {Promise<{ok:boolean, action:'off'|'none'|'pull'|'push'|'error', chars:number, messages:number, dir:string, error?:string}>}
 */
export async function syncOnBoot() {
  const ok = await available();
  if (!ok) return { ok: false, action: 'off', chars: 0, messages: 0, dir: '' };

  try {
    const store = await import('./store.js');
    state.status = 'syncing';
    bus.emit('filestore:status', { ...state });

    // Inspect the reset marker before replay: an old outbox must not refill a cleared database.
    let remote = await apiGet('/state');
    const remoteGeneration = remote.generation || '0';
    const reset = remoteGeneration !== generation;
    // Failed journaling of a retired database must not prevent loading the new one.
    if (reset) pendingJournal = pendingJournal.catch(() => {});
    await pendingJournal;
    if (reset) {
      dropPendingWrites();
    }
    await discardStaleOperations(remote.retiredGenerations || []);
    // Preserve writes already made by a sibling tab in the new generation before replacing shared IDB.
    await drain(apiPost);
    remote = await apiGet('/state');
    if ((remote.generation || '0') !== remoteGeneration) throw new Error('数据已在其他页面清空，请刷新页面后继续');
    const localChars = await store.listCharacters();

    // 盘上有什么"用户数据"？角色是主判据，但**群聊也必须算**：
    // 角色被删光（删角色会顺手把它从群里摘掉，群于是变成零成员）之后，磁盘上就只剩群文件，
    // 只按"磁盘有角色"判断的话，清掉浏览器数据再打开就什么都回填不出来，群与它的聊天记录看着就没了。
    const diskGroupRows = (Array.isArray(remote.groups) ? remote.groups : [])
      .map((r) => r && r.data)
      .filter((g) => g && g.id);
    // ---- 情况 A：盘上有用户数据 → 以盘为准，整体回填本地 ----
    // 注意"只有群、没有角色"这种盘面要多加一个条件：此时若浏览器本地还有角色（例如建完角色
    // 磁盘写入失败），一旦以盘为准就会把本地角色冲掉。所以这种情况只在"本地也没有角色"时才回填，
    // 其余情形交给情况 B 把本地整体推上盘，两边都不会丢。
    const hasDiskChars = Array.isArray(remote.characters) && remote.characters.length > 0;
    const restoreFromDisk = reset || remoteGeneration !== '0' || hasDiskChars || (diskGroupRows.length > 0 && localChars.length === 0);
    if (restoreFromDisk) {
      // 墓碑 = 本地 localStorage 记录 ∪ 服务器返回的（跨浏览器/清站点数据后仍有效）
      const deleted = reset ? {} : readDeleted();
      for (const t of Array.isArray(remote.deleted) ? remote.deleted : []) {
        if (t && t.id && (!t.kind || t.kind === 'character')) deleted[t.id] = num(t.at, Date.now());
      }
      const chars = remote.characters
        .map((r) => r && r.data)
        .filter((c) => c && c.id && !deleted[c.id]);

      // 所有远端数据先读齐：任何一个请求失败都中止回填，绝不能把失败伪装成空记录后清掉本地库。
      const charData = [];
      for (const c of chars) {
        const [msgs, mem] = await Promise.all([
          apiGet(`/messages/${encodeURIComponent(c.id)}`),
          apiGet(`/memory/${encodeURIComponent(c.id)}`),
        ]);
        if (!Array.isArray(msgs.messages)) throw new Error(`角色「${c.name || c.id}」的消息数据格式无效`);
        charData.push({ char: c, messages: msgs.messages, memory: mem?.data || null });
      }

      // 群聊：同样以盘为准回填（成员里已经不存在的角色会被过滤掉）
      const deletedGroups = reset ? {} : readGroupDeleted();
      for (const t of Array.isArray(remote.deleted) ? remote.deleted : []) {
        if (t && t.id && t.kind === 'group') deletedGroups[t.id] = num(t.at, Date.now());
      }
      const liveIds = new Set(chars.map((c) => c.id));
      const groups = (Array.isArray(remote.groups) ? remote.groups : [])
        .map((r) => r && r.data)
        .filter((g) => g && g.id && !deletedGroups[g.id]);
      const groupData = [];
      for (const g of groups) {
        const gmsgs = await apiGet(`/groupmsgs/${encodeURIComponent(g.id)}`);
        if (!Array.isArray(gmsgs.messages)) throw new Error(`群「${g.name || g.id}」的消息数据格式无效`);
        groupData.push({ group: g, messages: gmsgs.messages });
      }

      const localRuntimeBefore = reset ? {} : sanitizeRuntime(store.readRuntimeAll() || {});
      const privateMessages = charData.flatMap((row) => row.messages);
      const groupMessages = groupData.flatMap((row) => row.messages);
      if (((await apiGet('/state')).generation || '0') !== remoteGeneration) {
        throw new Error('数据已在其他页面清空，请刷新页面后继续');
      }
      await store.replaceLocalSnapshot({
        characters: charData.map((row) => row.char),
        messages: privateMessages,
        memory: charData.filter((row) => row.memory).map((row) => ({ ...row.memory, charId: row.char.id })),
        groups: groupData.map((row) => row.group),
        groupMessages,
      });
      if (reset) {
        clearDeleted();
        clearGroupDeleted();
      }
      acceptGeneration(remoteGeneration);
      const msgCount = privateMessages.length;
      const groupMsgCount = groupMessages.length;

      if (remote.settings) {
        try {
          store.setSettings(remote.settings, { localOnly: true });
        } catch {
          /* 忽略坏了的历史设置 */
        }
      }
      // 好感度允许下降，因此不能取 max；按每条运行时记录的更新时间选较新版本。
      // 旧版没有 updatedAt 的双方冲突时遵守“磁盘优先”，磁盘空时才保留本地。
      const liveRuntimeIds = new Set([...liveIds, ...groups.map((g) => g.id)]);
      const mergedRuntime = mergeRuntimeSnapshots(localRuntimeBefore, remote.runtime, liveRuntimeIds);
      store.writeRuntimeAll(mergedRuntime);
      if (JSON.stringify(mergedRuntime) !== JSON.stringify(sanitizeRuntime(remote.runtime))) {
        void mirrorRuntime(mergedRuntime);
      }
      state.lastSync = Date.now();
      setStatus('ok');
      bus.emit('filestore:restored', {
        chars: chars.length,
        messages: msgCount,
        groups: groups.length,
        groupMessages: groupMsgCount,
        dir: state.dir,
      });
      return {
        ok: true,
        action: 'pull',
        chars: chars.length,
        messages: msgCount,
        groups: groups.length,
        groupMessages: groupMsgCount,
        dir: state.dir,
      };
    }

    // ---- 情况 B：盘上空的、本地有数据 → 把本地整体推上盘（老用户第一次升级） ----
    if (localChars.length || (await store.listGroups()).length) {
      const payload = {
        characters: [],
        messages: [],
        memory: [],
        groups: [],
        groupMessages: [],
        settings: store.getSettings(),
        runtime: store.readRuntimeAll(),
      };
      for (const c of localChars) {
        payload.characters.push(c);
        const msgs = await store.listMessages(c.id);
        for (const m of msgs) payload.messages.push(m);
        const mem = await store.getMemory(c.id);
        if (mem && (mem.summary || mem.facts?.length || mem.factRecords?.length)) payload.memory.push({ charId: c.id, ...mem });
      }
      for (const g of await store.listGroups()) {
        payload.groups.push(g);
        for (const m of await store.listGroupMessages(g.id)) payload.groupMessages.push(m);
      }
      await apiPost('/replace', payload);
      state.lastSync = Date.now();
      setStatus('ok');
      bus.emit('filestore:pushed', {
        chars: payload.characters.length,
        messages: payload.messages.length,
        groups: payload.groups.length,
        groupMessages: payload.groupMessages.length,
        dir: state.dir,
      });
      return {
        ok: true,
        action: 'push',
        chars: payload.characters.length,
        messages: payload.messages.length,
        groups: payload.groups.length,
        groupMessages: payload.groupMessages.length,
        dir: state.dir,
      };
    }

    if (remote.settings) store.setSettings(remote.settings, { localOnly: true });
    if (remote.runtime) store.writeRuntimeAll(remote.runtime);
    acceptGeneration(remoteGeneration);
    setStatus('ok');
    return { ok: true, action: 'none', chars: 0, messages: 0, groups: 0, groupMessages: 0, dir: state.dir };
  } catch (err) {
    console.warn('[filestore] 启动同步失败', err);
    setStatus('error', (err && err.message) || String(err), err);
    return { ok: false, action: 'error', chars: 0, messages: 0, dir: state.dir, error: (err && err.message) || String(err) };
  }
}

/** Flush durable changes in order; never overwrite newer disk data with an old browser snapshot. */
export async function syncNow() {
  const ok = await available(true);
  if (!ok) return { ok: false, action: 'off' };
  try {
    setStatus('syncing');
    const remote = await apiGet('/state');
    const remoteGeneration = remote.generation || '0';
    if (remoteGeneration !== generation) throw new Error('数据已在其他页面清空，请刷新页面后继续；清空前的修改不会重新写入');
    await discardStaleOperations(remote.retiredGenerations || []);
    // Mirror writes journal before sending; drain shares the lock with every window.
    let checkpoint;
    do {
      checkpoint = pendingJournal;
      await checkpoint;
      await drain(apiPost);
    } while (checkpoint !== pendingJournal);
    state.lastSync = Date.now();
    setStatus('ok');
    return { ok: true, action: 'flush', dir: state.dir };
  } catch (err) {
    setStatus('error', err.message || String(err), err);
    return { ok: false, action: 'error', error: err.message || String(err) };
  }
}

/** 返回当前冲突的两端内容供用户核对，不修改队列。 */
export async function getSyncConflict() {
  await pendingJournal;
  const row = await firstQueuedOperation();
  if (!row || !/^\/(characters|groups)\/[A-Za-z0-9_%~-]+$/.test(row.path)) throw new Error('当前没有可处理的资料冲突');
  const remote = (await apiGet(row.path)).data;
  const changes = diffChanges(entityFields(row.body.base || remote), entityFields(row.body.data));
  return { sequence: row.sequence, name: row.body.data?.name || remote?.name || '资料', remote, local: row.body.data, changes };
}

/** 用户选定后仅重放这次修改的字段，保留电脑端其他较新字段。 */
export async function resolveSyncConflict(sequence, choice) {
  if (!['local', 'remote'].includes(choice)) throw new Error('请选择要保留的版本');
  await pendingJournal;
  await rewriteQueuedOperation(sequence, async (row) => {
    const current = (await apiGet(row.path)).data;
    if (choice === 'remote') return null;
    if (!current) throw new Error('电脑上的这份资料已经删除，请选择保留电脑版本');
    const changes = diffChanges(entityFields(row.body.base || current), entityFields(row.body.data));
    return { base: current, data: applyChanges(current, changes) };
  });
  await drain(apiPost);
  const result = await syncOnBoot();
  if (!result.ok) throw new Error(result.error || '同步未完成');
  return result;
}

/** 手动留一份整库快照到磁盘（备份文件由服务器自己管理，界面上不再暴露导入导出） */
export async function snapshotNow() {
  const ok = await available(true);
  if (!ok) return { ok: false };
  try {
    const res = await apiPost('/snapshot', {});
    return { ok: true, file: res.file, counts: res.counts };
  } catch (err) {
    setStatus('error', (err && err.message) || String(err));
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

export default {
  available,
  syncOnBoot,
  syncNow,
  snapshotNow,
  fileStatus,
  mirrorCharacter,
  mirrorMessages,
  mirrorMessageDeleted,
  mirrorMessagesReplace,
  mirrorMemory,
  mirrorSettings,
  mirrorRuntime,
  flushStateNow,
  dropPendingWrites,
  mirrorCharacterDeleted,
  mirrorWipeAll,
  mirrorGroup,
  mirrorGroupMessages,
  mirrorGroupMessageDeleted,
  mirrorGroupMessagesReplace,
  mirrorGroupDeleted,
  noteDeleted,
  clearDeleted,
  noteGroupDeleted,
  clearGroupDeleted,
  createId,
  num,
};
