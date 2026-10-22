import { diffChanges, validateBackup } from './sync.js';
/**
 * 持久层（契约 3.6）：IndexedDB 存角色卡与消息，localStorage 存设置。
 * 本地优先：所有数据只存在用户自己的浏览器里。
 */
import { bus } from './bus.js';
import { createId, clamp, num, firstChar, hashCode } from './util.js';
import { RECENT_LIMIT, RECENT_WINDOW_MS, experienceContent, heardGroupMessage } from './recent.js';
import { normalizeMemory, sourceKey, sourceSignature, correctFact, retractFact } from './memory.js';
import {
  mirrorCharacter,
  mirrorCharacterDeleted,
  mirrorMessages,
  mirrorMessageDeleted,
  mirrorMessagesReplace,
  mirrorMemory,
  mirrorSettings,
  mirrorRuntime,
  mirrorWipeAll,
  mirrorGroup,
  mirrorGroupDeleted,
  mirrorGroupMessages,
  mirrorGroupMessageDeleted,
  mirrorGroupMessagesReplace,
  fileStatus,
} from './filestore.js';

/** 一个群聊最多能有多少位成员（界面与存储共用这一个数字） */
export const GROUP_MEMBER_LIMIT = 24;

const DB_NAME = 'aichat';
/** v2：新增「群聊」相关的两张表（groups / groupMessages），老库会自动升级、旧数据不受影响 */
const DB_VERSION = 2;
const SETTINGS_KEY = 'aichat.settings.v1';
const RUNTIME_KEY = 'aichat.runtime.v1';

/** @type {IDBDatabase|null} */
let db = null;
let dbPromise = null;
const storageErrorHandlers = [];

/* ------------------------------------------------------------------ *
 * IndexedDB 基础
 * ------------------------------------------------------------------ */

/**
 * 打开（并缓存）数据库连接。其他模块（llm.js / tts.js）也会复用它。
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (db) return Promise.resolve(db);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('characters')) {
        const s = d.createObjectStore('characters', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!d.objectStoreNames.contains('messages')) {
        const s = d.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('charId', 'charId');
        s.createIndex('at', 'at');
        s.createIndex('char_at', ['charId', 'at']);
      }
      if (!d.objectStoreNames.contains('memory')) {
        d.createObjectStore('memory', { keyPath: 'charId' });
      }
      if (!d.objectStoreNames.contains('usage')) {
        const s = d.createObjectStore('usage', { keyPath: 'id', autoIncrement: true });
        s.createIndex('at', 'at');
        s.createIndex('charId', 'charId');
      }
      if (!d.objectStoreNames.contains('ttsCache')) {
        d.createObjectStore('ttsCache', { keyPath: 'key' });
      }
      // ---- v2：群聊 ----
      if (!d.objectStoreNames.contains('groups')) {
        const s = d.createObjectStore('groups', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!d.objectStoreNames.contains('groupMessages')) {
        const s = d.createObjectStore('groupMessages', { keyPath: 'id' });
        s.createIndex('groupId', 'groupId');
        s.createIndex('at', 'at');
        s.createIndex('group_at', ['groupId', 'at']);
      }
    };
    // 被其他标签页的旧版本连接挡住时必须**让 Promise 结束**（reject），不能只打日志。
    // 以前这里只 console.warn：open() 会一直挂在 pending，而 idb() 又是 `await openDB()`，
    // 于是所有读写（getMemory / listMessages / appendMessage…）全部永不返回 ——
    // 界面表现为「正在回复…」永久转圈、群聊连"正在输入"气泡都不出现，且没有任何报错。
    // 对照 voice/tts.js 的同名处理（那边是 resolve(null)）。
    // 另外给一个兜底定时器：onblocked 之后对方迟迟不关闭时同样要能失败退出。
    let blockedTimer = null;
    let settled = false;
    req.onblocked = () => {
      console.warn('[store] 数据库被其他标签页阻塞，请关闭其他页面');
      if (!blockedTimer) {
        blockedTimer = setTimeout(() => {
          blockedTimer = null;
          if (settled) return; // 期间已经打开成功（对方关了页面）：不要报假错
          settled = true;
          dbPromise = null; // 重置缓存，让下次调用可以重试
          const err = new Error('数据库被其他标签页占用：请关闭本站的其他页面后重试');
          err.code = 'blocked';
          storageErrorHandlers.forEach((fn) => fn(err));
          reject(err);
        }, 5000);
      }
    };
    req.onsuccess = () => {
      if (blockedTimer) {
        clearTimeout(blockedTimer);
        blockedTimer = null;
      }
      settled = true;
      db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
        db = null;
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (blockedTimer) {
        clearTimeout(blockedTimer);
        blockedTimer = null;
      }
      settled = true;
      const err = req.error || new Error('数据库打开失败');
      // 必须重置，否则之后每次 openDB() 都复用这个已 rejected 的 promise，重试永远不发生
      dbPromise = null;
      storageErrorHandlers.forEach((fn) => fn(err));
      reject(err);
    };
  });
  return dbPromise;
}

/** 注册存储错误回调 */
export function onStorageError(fn) {
  if (typeof fn === 'function') storageErrorHandlers.push(fn);
}

/**
 * 通用 IndexedDB 助手（其他模块可复用）
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest|void} fn
 */
export async function idb(storeName, mode, fn) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    let request;
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onabort = () => reject(transaction.error || new Error('数据库事务已回滚'));
    transaction.onerror = () => {}; // onabort is the final outcome
    try {
      request = fn(transaction.objectStore(storeName));
      if (request && typeof request.then === 'function') throw new Error('数据库事务回调必须同步');
    } catch (err) {
      transaction.abort();
      reject(err);
    }
  });
}

/** 在同一事务内读取、修改、写回，避免两个异步操作拿旧快照互相覆盖。 */
async function mutateRecord(storeName, id, change) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let result = null;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('数据更新已回滚'));
    tx.onerror = () => {};
    store.get(id).onsuccess = (event) => {
      try {
        result = change(event.target.result);
        if (result) store.put(result);
      } catch (err) {
        tx.abort();
        reject(err);
      }
    };
  });
}

/**
 * 清理某实体的运行时状态（惰性 import core/runtime.js，避免与它静态互引形成循环依赖）。
 * 角色/群聊删除后必须调用：否则 localStorage 里的未读数会永久残留（标题一直挂红点、无法清零）。
 * @param {string} id
 */
function dropRuntime(id) {
  if (!id) return;
  import('./runtime.js')
    .then((m) => {
      if (m && typeof m.dropRuntime === 'function') m.dropRuntime(id);
    })
    .catch(() => {
      /* 忽略 */
    });
}

/* ------------------------------------------------------------------ *
 * 角色卡
 * ------------------------------------------------------------------ */

export const DEFAULT_VOICE = {
  provider: 'webspeech',
  voiceId: '',
  rate: 1,
  pitch: 1,
  autoplay: 'short',
  cache: true,
};

export const DEFAULT_PERSONA = {
  personality: '',
  mbti: '',
  values: '',
  style: '口语',
  catchphrase: '',
  emojiHabit: '',
  particles: '',
  relationship: '朋友',
  addressUser: '你',
  world: '',
  place: '',
  speech: '',
  taboo: '',
};

/**
 * 把任意来源的对象补齐成合法 Character（未知输入的安全网，契约 5.5）
 * @param {object} raw
 * @returns {object}
 */
export function normalizeCharacter(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const now = Date.now();
  const persona = { ...DEFAULT_PERSONA, ...(r.persona && typeof r.persona === 'object' ? r.persona : {}) };
  // 兼容 SillyTavern 等外部字段
  if (!persona.personality && r.description) persona.personality = String(r.description).slice(0, 600);
  if (!persona.world && r.world) persona.world = String(r.world);

  const voice = { ...DEFAULT_VOICE, ...(r.voice && typeof r.voice === 'object' ? r.voice : {}) };
  voice.rate = clamp(voice.rate, 0.5, 2);
  voice.pitch = clamp(voice.pitch, 0.5, 2);
  if (!['webspeech', 'cloud'].includes(voice.provider)) voice.provider = 'webspeech';
  if (!['off', 'short', 'always'].includes(voice.autoplay)) voice.autoplay = 'short';

  const name = String(r.name || r.char_name || '未命名角色').trim() || '未命名角色';

  return {
    id: r.id || createId('c'),
    name,
    avatar: typeof r.avatar === 'string' ? r.avatar : '',
    emoji: r.emoji || firstChar(name),
    color: r.color || '#6c8cff',
    gender: r.gender || '',
    age: r.age == null ? '' : String(r.age),
    job: r.job || '',
    tagline: r.tagline || persona.personality?.slice(0, 40) || '',
    tags: Array.isArray(r.tags) ? r.tags.map(String).filter(Boolean).slice(0, 12) : [],
    group: r.group || '默认',
    pinned: Boolean(r.pinned),
    muted: Boolean(r.muted),
    persona,
    systemPrompt: r.systemPrompt || r.system_prompt || '',
    examples: Array.isArray(r.examples)
      ? r.examples
          .filter((e) => e && typeof e === 'object')
          .map((e) => ({ user: String(e.user || ''), ai: String(e.ai || '') }))
          .slice(0, 12)
      : [],
    authorNote: r.authorNote || r.creator_notes || '',
    // 世界书：关键词触发式设定注入（只在对话里出现关键词时才进提示词，长设定不炸 token）
    lorebook: Array.isArray(r.lorebook)
      ? r.lorebook
          .filter((l) => l && typeof l === 'object')
          .map((l) => ({
            keys: Array.isArray(l.keys)
              ? l.keys.map(String).filter(Boolean)
              : String(l.keys || '')
                  .split(/[,，\s]+/)
                  .filter(Boolean),
            content: String(l.content || ''),
            enabled: l.enabled !== false,
          }))
          .filter((l) => l.keys.length && l.content)
          .slice(0, 60)
      : [],
    affinity: clamp(num(r.affinity, 20), 0, 100),
    greeting: Array.isArray(r.greeting)
      ? r.greeting.map(String).filter(Boolean)
      : r.greeting
        ? [String(r.greeting)]
        : r.first_mes
          ? [String(r.first_mes)]
          : ['……你好。'],
    voice,
    model: r.model && typeof r.model === 'object' ? r.model : null,
    createdAt: num(r.createdAt, now),
    updatedAt: num(r.updatedAt, now),
    version: num(r.version, 1),
    history: Array.isArray(r.history) ? r.history.slice(-20) : [],
  };
}

/** 按 置顶 → 更新时间 排序 */
function sortChars(list) {
  return list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return num(b.updatedAt) - num(a.updatedAt);
  });
}

/** @returns {Promise<object[]>} */
export async function listCharacters() {
  const all = await idb('characters', 'readonly', (s) => s.getAll());
  return sortChars((all || []).map(normalizeCharacter));
}

/** @returns {Promise<object|null>} */
export async function getCharacter(id) {
  if (!id) return null;
  const c = await idb('characters', 'readonly', (s) => s.get(id));
  return c ? normalizeCharacter(c) : null;
}

/**
 * 保存角色（不存在则创建）。会自动补默认字段、更新 updatedAt、压入版本历史。
 * @param {object} char
 * @returns {Promise<object>}
 */
export async function saveCharacter(char) {
  const input = normalizeCharacter(char);
  let previous = null;
  const next = await mutateRecord('characters', input.id, (existing) => {
    if (existing && char?.version != null && char.version !== normalizeCharacter(existing).version) {
      throw new Error('其他页面已修改这个角色，请重新打开角色卡后再保存');
    }
    previous = existing || null;
    input.updatedAt = Date.now();
    if (existing) {
      const prev = normalizeCharacter(existing);
      input.createdAt = prev.createdAt;
      input.version = prev.version + 1;
      input.history = [...prev.history, { at: input.updatedAt, snapshot: stripHistory(prev) }].slice(-20);
    } else {
      input.version = 1;
      input.history = [];
    }
    return input;
  });
  // 同步写一份到电脑本地的文件（core/filestore.js），失败也不影响本地使用
  void mirrorCharacter(next, previous);
  bus.emit('char:changed', next);
  return next;
}

/** 去掉 history 字段，避免快照嵌套爆掉 */
function stripHistory(char) {
  const c = { ...char };
  delete c.history;
  return c;
}

/** 删除角色及其全部消息与记忆（同时把它从所有群聊里摘掉） */
export async function deleteCharacter(id) {
  if (!id) return;
  await idb('characters', 'readwrite', (s) => s.delete(id));
  await clearMessages(id);
  await idb('memory', 'readwrite', (s) => s.delete(id));
  // 运行时状态（未读/好感度）也要清：否则侧栏未读数与标题会永久虚高且无法清零
  void dropRuntime(id);
  void mirrorCharacterDeleted(id);
  // 群聊里不再保留这个空位：否则群里会出现一个永远不说话的头像
  try {
    await pruneGroupMembers(id);
  } catch (err) {
    console.warn('[store] 从群聊里移除角色失败（已忽略）', err && err.message);
  }
  bus.emit('char:deleted', { id });
}

/** 复制角色（含人设，不含聊天记录） */
export async function duplicateCharacter(id) {
  const c = await getCharacter(id);
  if (!c) return null;
  const copy = normalizeCharacter({
    ...c,
    id: createId('c'),
    name: `${c.name} 副本`,
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await idb('characters', 'readwrite', (s) => s.put(copy));
  // 必须镜像写盘：否则下次启动时"以磁盘为准"的回填会把这个副本抹掉（磁盘上没有它）
  void mirrorCharacter(copy);
  bus.emit('char:changed', copy);
  return copy;
}

/**
 * 导入角色卡：兼容本应用导出格式、SillyTavern V2/V1 角色卡、纯 JSON 人设
 * @param {object|string} json
 * @returns {Promise<object>}
 */
export async function importCharacter(json) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch {
      data = { name: '导入的角色', persona: { personality: String(json).slice(0, 2000) } };
    }
  }
  // SillyTavern：{ spec:'chara_card_v2', data:{...} }
  if (data && data.data && typeof data.data === 'object' && (data.spec || data.data.name)) {
    data = data.data;
  }
  // 兼容 char_name / mes_example 等字段
  const merged = {
    ...data,
    name: data.name || data.char_name,
    persona: {
      personality: data.personality || data.description || '',
      world: data.world || data.scenario || data.world_scenario || '',
      style: data.style || '口语',
      catchphrase: data.catchphrase || '',
      ...(data.persona || {}),
    },
    greeting: data.greeting || data.first_mes || data.mes_example,
    examples: data.examples || parseMesExample(data.mes_example),
    lorebook:
      data.lorebook ||
      (data.character_book && Array.isArray(data.character_book.entries)
        ? data.character_book.entries.map((e) => ({ keys: e.keys || [], content: e.content || '', enabled: e.enabled !== false }))
        : []),
  };
  const char = normalizeCharacter({ ...merged, id: createId('c') });
  await idb('characters', 'readwrite', (s) => s.put(char));
  void mirrorCharacter(char);
  bus.emit('char:changed', char);
  return char;
}

/** 解析 SillyTavern 的 <START> 示例对话 */
function parseMesExample(text) {
  if (!text || typeof text !== 'string') return [];
  const blocks = text.split(/<START>/i).map((b) => b.trim()).filter(Boolean);
  const out = [];
  for (const b of blocks.slice(0, 8)) {
    const user = b.match(/\{\{user\}\}\s*[:：]\s*([\s\S]*?)(?=\{\{char\}\}|$)/i);
    const ai = b.match(/\{\{char\}\}\s*[:：]\s*([\s\S]*)/i);
    if (user || ai) out.push({ user: (user ? user[1] : '').trim(), ai: (ai ? ai[1] : '').trim() });
  }
  return out;
}

/** 导出为 SillyTavern V2 角色卡 */
export function toSillyTavern(char) {
  const c = normalizeCharacter(char);
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: c.name,
      description: [c.tagline, c.persona.personality].filter(Boolean).join('\n'),
      personality: c.persona.personality,
      scenario: [c.persona.world, c.persona.place].filter(Boolean).join(' / '),
      first_mes: c.greeting[0] || '',
      mes_example: c.examples.map((e) => `{{user}}: ${e.user}\n{{char}}: ${e.ai}`).join('\n<START>\n'),
      creator_notes: c.authorNote,
      system_prompt: c.systemPrompt,
      post_history_instructions: '',
      tags: c.tags,
      character_book: c.lorebook && c.lorebook.length
        ? {
            name: `${c.name} 的世界书`,
            entries: c.lorebook.map((l) => ({ keys: l.keys, content: l.content, enabled: l.enabled })),
          }
        : undefined,
      creator: 'AI 聊天网站',
      character_version: String(c.version || 1),
      alternate_greetings: c.greeting.slice(1),
      extensions: {
        aichat: {
          emoji: c.emoji,
          color: c.color,
          gender: c.gender,
          age: c.age,
          job: c.job,
          affinity: c.affinity,
          voice: c.voice,
          persona: c.persona,
        },
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 消息
 * ------------------------------------------------------------------ */

function normalizeMessage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const role = ['user', 'assistant', 'system'].includes(r.role) ? r.role : 'assistant';
  return {
    id: r.id || createId('m'),
    charId: r.charId || '',
    role,
    content: typeof r.content === 'string' ? r.content : String(r.content || ''),
    at: num(r.at, Date.now()),
    variants:
      r.variants && Array.isArray(r.variants.list) && r.variants.list.length
        ? { list: r.variants.list.map(String), index: clamp(num(r.variants.index, 0), 0, r.variants.list.length - 1) }
        : null,
    emotion: r.emotion || '',
    status: ['done', 'streaming', 'error'].includes(r.status) ? r.status : 'done',
    model: r.model || '',
    usage: r.usage && typeof r.usage === 'object' ? r.usage : null,
    quoted:
      r.quoted && typeof r.quoted === 'object'
        ? { id: String(r.quoted.id || ''), role: r.quoted.role || 'user', content: String(r.quoted.content || '').slice(0, 300) }
        : null,
    bookmarked: Boolean(r.bookmarked),
    error: r.error || '',
  };
}

/** 按时间升序列出某角色的全部消息 */
function byMessageTime(a, b) {
  return a.at - b.at || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
}

export async function listMessages(charId) {
  if (!charId) return [];
  const rows = await idb('messages', 'readonly', (s) => s.index('charId').getAll(charId));
  return (rows || []).map(normalizeMessage).sort(byMessageTime);
}

/** 界面按索引读取最近一页；完整历史仍由 listMessages 供模型、摘要与导出读取。 */
async function messagePage(storeName, ownerId, opts, normalize) {
  if (!ownerId) return { messages: [], hasMore: false };
  const database = await openDB();
  const ownerKey = storeName === 'messages' ? 'charId' : 'groupId';
  const timeIndex = storeName === 'messages' ? 'char_at' : 'group_at';
  let limit = Math.max(1, Math.floor(num(opts.limit, 100)));
  // 搜索、收藏与引用跳转：按索引计数，一次扩展到目标所在页，不逐页试找。
  if (opts.includeId) {
    const target = await idb(storeName, 'readonly', (s) => s.get(opts.includeId));
    if (target?.[ownerKey] === ownerId) {
      const newer = await idb(storeName, 'readonly', (s) => s.index(timeIndex)
        .count(IDBKeyRange.bound([ownerId, target.at], [ownerId, Infinity])));
      limit = Math.max(limit, newer + 1);
    }
  }
  return new Promise((resolve, reject) => {
    const rows = [];
    const tx = database.transaction(storeName, 'readonly');
    tx.oncomplete = () => resolve({ messages: rows.slice(0, limit).reverse().map(normalize), hasMore: rows.length > limit, limit });
    tx.onabort = () => reject(tx.error || new Error('读取聊天记录失败'));
    tx.onerror = () => {};
    const request = tx.objectStore(storeName).index(timeIndex)
      .openCursor(IDBKeyRange.bound([ownerId, -Infinity], [ownerId, Infinity]), 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      rows.push(cursor.value);
      if (rows.length <= limit) cursor.continue();
    };
  });
}

export function listMessagesPage(charId, opts = {}) {
  return messagePage('messages', charId, opts, normalizeMessage);
}

/** 只取每个会话的末条消息与数量，不把全部正文搬进内存。 */
async function conversationStats(storeName) {
  const database = await openDB();
  const ownerIndex = storeName === 'messages' ? 'charId' : 'groupId';
  const timeIndex = storeName === 'messages' ? 'char_at' : 'group_at';
  const normalize = storeName === 'messages' ? normalizeMessage : normalizeGroupMessage;
  return new Promise((resolve, reject) => {
    const counts = new Map(), recent = [];
    const tx = database.transaction(storeName, 'readonly');
    tx.oncomplete = () => resolve({ counts: Object.fromEntries(counts), recent: recent.sort((a, b) => b.at - a.at) });
    tx.onabort = () => reject(tx.error || new Error('读取会话摘要失败'));
    tx.onerror = () => {};
    const store = tx.objectStore(storeName);
    const request = store.index(ownerIndex).openKeyCursor(null, 'nextunique');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const id = cursor.key;
      store.index(ownerIndex).count(id).onsuccess = (event) => counts.set(id, event.target.result);
      store.index(timeIndex).openCursor(IDBKeyRange.bound([id, -Infinity], [id, Infinity]), 'prev').onsuccess = (event) => {
        if (event.target.result) recent.push(normalize(event.target.result.value));
      };
      cursor.continue();
    };
  });
}

export async function listConversationStats() {
  const [privateStats, groupStats] = await Promise.all([conversationStats('messages'), conversationStats('groupMessages')]);
  return { recent: privateStats.recent, counts: privateStats.counts, groupRecent: groupStats.recent, groupCounts: groupStats.counts };
}

/** 追加一条消息 */
export async function appendMessage(msg) {
  const m = normalizeMessage(msg);
  if (!m.charId) throw new Error('appendMessage 缺少 charId');
  await idb('messages', 'readwrite', (s) => s.put(m));
  void mirrorMessages(m.charId, m);
  bus.emit('msg:appended', m);
  return m;
}

/** 批量追加（导入用，不逐条广播） */
async function appendMessagesBulk(list) {
  if (!list.length) return;
  await idb('messages', 'readwrite', (s) => {
    list.forEach((m) => s.put(normalizeMessage(m)));
  });
}

/** 更新消息字段 */
export async function updateMessage(id, patch) {
  if (!id) return null;
  const next = await mutateRecord('messages', id, (cur) => cur
    ? normalizeMessage({ ...cur, ...patch, id: cur.id, charId: cur.charId }) : null);
  if (!next) return null;
  void mirrorMessages(next.charId, next);
  bus.emit('msg:updated', next);
  return next;
}

/** 删除单条消息 */
export async function deleteMessage(id) {
  if (!id) return;
  const cur = await idb('messages', 'readonly', (s) => s.get(id));
  await idb('messages', 'readwrite', (s) => s.delete(id));
  if (cur && cur.charId) void mirrorMessageDeleted(cur.charId, id);
  bus.emit('msg:updated', { id, deleted: true });
}

/** 批量删除 */
export async function deleteMessages(charId, ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return;
  await idb('messages', 'readwrite', (s) => list.forEach((id) => s.delete(id)));
  void mirrorMessageDeleted(charId, list);
  bus.emit('msg:updated', { charId, deleted: true, ids: list });
}

/** 清空某角色聊天记录（不影响人设） */
export async function clearMessages(charId) {
  if (!charId) return;
  const rows = await idb('messages', 'readonly', (s) => s.index('charId').getAllKeys(charId));
  await idb('messages', 'readwrite', (s) => (rows || []).forEach((k) => s.delete(k)));
  void mirrorMessagesReplace(charId, []);
  bus.emit('msg:updated', { charId, deleted: true, cleared: true });
}

/**
 * 搜索消息
 * @param {string|null} charId null 表示全局
 * @param {string} keyword
 */
export async function searchMessages(charId, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const rows = charId
    ? await idb('messages', 'readonly', (s) => s.index('charId').getAll(charId))
    : await idb('messages', 'readonly', (s) => s.getAll());
  return (rows || [])
    .map(normalizeMessage)
    .filter((m) => m.content.toLowerCase().includes(kw))
    .sort((a, b) => b.at - a.at)
    .slice(0, 200);
}

/** 单条消息 */
export async function getMessage(id) {
  if (!id) return null;
  const m = await idb('messages', 'readonly', (s) => s.get(id));
  return m ? normalizeMessage(m) : null;
}

/** 列出所有有消息的角色（按最后一条消息时间倒序） */
export async function listRecent(charIds) {
  const { recent: out } = await conversationStats('messages');
  if (Array.isArray(charIds)) return out.filter((m) => charIds.includes(m.charId));
  return out;
}

/** 统计每个角色的消息数 */
export async function countByChar() {
  return (await conversationStats('messages')).counts;
}

/* ------------------------------------------------------------------ *
 * 群聊（Group / GroupMessage）
 *
 * 设计要点：
 *   · 群聊是一份**独立的**会话实体：自己的一张表（groups）+ 自己的一条消息流
 *     （groupMessages，按 groupId 索引），与「角色 ↔ 我」的一对一会话彻底分开，
 *     所以建群不会污染任何角色的单人聊天记录。
 *   · 消息里额外带 speakerId / speakerName：群里有多个"助手"，必须知道这句话是谁说的。
 *     冗余存一份 speakerName，是为了角色被删除后历史消息仍能显示发言人。
 *   · 群聊同样走 filestore 镜像落盘（data/db/groups、data/db/groupmsgs），
 *     保持"角色、聊天记录直接存在电脑本地文件里"这一条不变。
 * ------------------------------------------------------------------ */

/** 群聊接话策略（与 core/group.js 的 TURN_MODES 一一对应，字段名冻结） */
export const GROUP_TURN_MODES = ['smart', 'mention', 'round', 'random'];

/** 新建群聊的默认值（设置面板里的"群聊默认项"会覆盖它） */
export const DEFAULT_GROUP = {
  name: '新群聊',
  avatar: '',
  emoji: '💬',
  color: '#6c8cff',
  topic: '',
  members: [],
  pinned: false,
  muted: false,
  autoTalk: true,
  turnMode: 'smart',
  maxAutoTurns: 3,
  autoDelayMs: 900,
  autoVoice: false,
  greeting: [],
  createdAt: 0,
  updatedAt: 0,
  version: 1,
};

/**
 * 把任意来源的对象补齐成合法 Group（未知输入的安全网）
 * @param {object} raw
 * @param {object} [defaults] 新建时的默认项（一般来自 settings.group）
 * @returns {object}
 */
export function normalizeGroup(raw, defaults) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = { ...DEFAULT_GROUP, ...(defaults && typeof defaults === 'object' ? defaults : {}) };
  const now = Date.now();
  const members = Array.isArray(r.members)
    ? [...new Set(r.members.map((m) => String(m || '').trim()).filter(Boolean))]
    : [];
  const name = String(r.name || d.name || '未命名群聊').trim() || '未命名群聊';
  const turnMode = GROUP_TURN_MODES.includes(r.turnMode) ? r.turnMode : d.turnMode;
  const greetingRaw = r.greeting != null ? r.greeting : d.greeting;
  return {
    id: r.id || createId('g'),
    name,
    avatar: typeof r.avatar === 'string' ? r.avatar : '',
    emoji: r.emoji || d.emoji || '💬',
    color: r.color || d.color || '#6c8cff',
    topic: String(r.topic == null ? d.topic || '' : r.topic),
    // 成员上限：与 ui/groupeditor.js 共用 GROUP_MEMBER_LIMIT，避免界面允许 30 人、
    // 保存时被静默截成 24 人（界面提示与实际不一致）
    members: members.slice(0, GROUP_MEMBER_LIMIT),
    memberSince: Object.fromEntries(members.map((id) => [id, num(r.memberSince?.[id])])),
    pinned: Boolean(r.pinned),
    muted: Boolean(r.muted),
    autoTalk: r.autoTalk === undefined ? d.autoTalk !== false : r.autoTalk !== false,
    turnMode,
    maxAutoTurns: clamp(num(r.maxAutoTurns, num(d.maxAutoTurns, 3)), 1, 8),
    autoDelayMs: clamp(num(r.autoDelayMs, num(d.autoDelayMs, 900)), 0, 8000),
    autoVoice: r.autoVoice === undefined ? d.autoVoice === true : r.autoVoice === true,
    // 「让他们自己聊」时每人至少说一次：老群聊没有这个字段，默认按开启处理
    everyoneSpeaks: r.everyoneSpeaks === undefined ? d.everyoneSpeaks !== false : r.everyoneSpeaks !== false,
    /** 禁言：muteAll = 全员禁言（群里谁都不说话，只有你能发消息） */
    muteAll: r.muteAll === true,
    /** 禁言：被单独禁言的成员 id（成员被移出群后，这里残留的 id 会自动丢掉） */
    mutedMembers: Array.isArray(r.mutedMembers)
      ? [...new Set(r.mutedMembers.map((x) => String(x || '').trim()).filter(Boolean))].filter((id) => members.includes(id))
      : [],
    greeting: Array.isArray(greetingRaw)
      ? greetingRaw.map(String).filter(Boolean).slice(0, 6)
      : greetingRaw
        ? [String(greetingRaw)]
        : [],
    createdAt: num(r.createdAt, now),
    updatedAt: num(r.updatedAt, now),
    version: num(r.version, 1),
  };
}

/** 按 置顶 → 更新时间 排序 */
function sortGroups(list) {
  return list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return num(b.updatedAt) - num(a.updatedAt);
  });
}

/** @returns {Promise<object[]>} 全部群聊（已排序） */
export async function listGroups() {
  const all = await idb('groups', 'readonly', (s) => s.getAll());
  return sortGroups((all || []).map((g) => normalizeGroup(g)));
}

/** @returns {Promise<object|null>} */
export async function getGroup(id) {
  if (!id) return null;
  const g = await idb('groups', 'readonly', (s) => s.get(id));
  return g ? normalizeGroup(g) : null;
}

/**
 * 保存群聊（不存在则创建）
 * @param {object} group
 * @param {object} [defaults] 仅新建时使用的默认项
 * @returns {Promise<object>}
 */
export async function saveGroup(group, defaults) {
  const input = normalizeGroup(group, defaults);
  let previous = null;
  const next = await mutateRecord('groups', input.id, (existing) => {
    if (existing && group?.version != null && group.version !== normalizeGroup(existing).version) {
      throw new Error('其他页面已修改这个群，请重新打开群资料后再保存');
    }
    previous = existing || null;
    input.updatedAt = Date.now();
    input.memberSince = Object.fromEntries(input.members.map((id) => [id,
      existing?.members?.includes(id) ? num(existing.memberSince?.[id]) : input.updatedAt,
    ]));
    input.createdAt = existing?.createdAt || input.createdAt;
    input.version = existing ? normalizeGroup(existing).version + 1 : 1;
    return input;
  });
  void mirrorGroup(next, previous);
  bus.emit('group:changed', next);
  return next;
}

/** 只更新 updatedAt（角色发过言之后调用，避免整卡重写带来的版本号膨胀） */
export async function touchGroup(id) {
  if (!id) return null;
  let previous = null;
  const next = await mutateRecord('groups', id, (cur) => {
    previous = cur || null;
    return cur ? { ...normalizeGroup(cur), updatedAt: Date.now() } : null;
  });
  if (!next) return null;
  // 镜像写盘：否则磁盘上的群文件 updatedAt 永远停在"最后一次改资料"，
  // 重启后回填会把侧栏群排序倒回去
  void mirrorGroup(next, previous);
  return next;
}

/** 删除群聊（连带它的全部群消息；不影响任何角色） */
export async function deleteGroup(id) {
  if (!id) return;
  await idb('groups', 'readwrite', (s) => s.delete(id));
  await clearGroupMessages(id);
  void dropRuntime(id);
  void mirrorGroupDeleted(id);
  bus.emit('group:deleted', { id });
}

/** 复制群聊（保留成员与设置，不带聊天记录） */
export async function duplicateGroup(id) {
  const g = await getGroup(id);
  if (!g) return null;
  const copy = normalizeGroup({
    ...g,
    id: createId('g'),
    name: `${g.name} 副本`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await idb('groups', 'readwrite', (s) => s.put(copy));
  void mirrorGroup(copy);
  bus.emit('group:changed', copy);
  return copy;
}

/**
 * 调整群成员（去重 + 保序）
 * @param {string} groupId
 * @param {string[]} add 要加入的角色 id
 * @param {string[]} [remove] 要移除的角色 id
 * @returns {Promise<object|null>} 新群聊对象
 */
export async function setGroupMembers(groupId, add, remove) {
  const g = await getGroup(groupId);
  if (!g) return null;
  const drop = new Set((Array.isArray(remove) ? remove : []).map(String));
  const next = g.members.filter((id) => !drop.has(String(id)));
  for (const id of Array.isArray(add) ? add : []) {
    const s = String(id || '');
    if (s && !next.includes(s)) next.push(s);
  }
  return saveGroup({ ...g, members: next });
}

/** 角色被删除时，把它从所有群聊里摘掉（否则群里会留下一个空位） */
export async function pruneGroupMembers(charId) {
  if (!charId) return 0;
  const groups = await listGroups();
  let n = 0;
  for (const g of groups) {
    if (!g.members.includes(String(charId))) continue;
    await saveGroup({ ...g, members: g.members.filter((m) => m !== String(charId)) });
    n++;
  }
  return n;
}

/* ------------------------------ 群消息 ------------------------------ */

function normalizeGroupMessage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const role = ['user', 'assistant', 'system'].includes(r.role) ? r.role : 'assistant';
  const base = normalizeMessage({ ...r, charId: r.groupId || r.charId || '' });
  return {
    ...base,
    groupId: String(r.groupId || ''),
    charId: String(r.groupId || ''),
    speakerId: String(r.speakerId || ''),
    speakerName: String(r.speakerName || ''),
    toIds: Array.isArray(r.toIds) ? r.toIds.map(String).filter(Boolean).slice(0, 12) : [],
    // null 表示历史记录缺少听众证据；[] 表示明确没有任何角色听到。
    audienceIds: Array.isArray(r.audienceIds) ? [...new Set(r.audienceIds.map(String).filter(Boolean))].slice(0, GROUP_MEMBER_LIMIT) : null,
    /** 是否是"角色主动接话"（而非被用户点名后回应）——用于界面上的小标记 */
    auto: Boolean(r.auto),
    /**
     * 消息来源标记（如 'werewolf' = 狼人杀产生的法官公告/发言）。
     * 界面照常显示、也照常落盘，但**不会进普通群聊的提示词**（见 core/group.js 的 formatTranscript），
     * 否则一局结束后角色会一直以为自己还在玩狼人杀。
     */
    game: r.game ? String(r.game) : '',
    /** 小游戏消息里"局终公告"这类需要留在普通上下文里的（见 core/group.js 的 formatTranscript） */
    keepGame: Boolean(r.keepGame),
  };
}

/** 按时间升序列出某个群的全部消息 */
export async function listGroupMessages(groupId) {
  if (!groupId) return [];
  const rows = await idb('groupMessages', 'readonly', (s) => s.index('groupId').getAll(groupId));
  return (rows || [])
    .map(normalizeGroupMessage)
    .sort(byMessageTime);
}

export function listGroupMessagesPage(groupId, opts = {}) {
  return messagePage('groupMessages', groupId, opts, normalizeGroupMessage);
}

/** 追加一条群消息 */
export async function appendGroupMessage(msg) {
  const m = normalizeGroupMessage(msg);
  if (!m.groupId) throw new Error('appendGroupMessage 缺少 groupId');
  // 只有新发送走这里；导入/磁盘回填保留原听众，绝不按今天的成员补造。
  const group = await getGroup(m.groupId);
  m.audienceIds = group ? group.members.slice() : [];
  await idb('groupMessages', 'readwrite', (s) => s.put(m));
  void mirrorGroupMessages(m.groupId, m);
  bus.emit('gmsg:appended', m);
  return m;
}

/** 批量追加群消息（导入用，不逐条广播） */
async function appendGroupMessagesBulk(list) {
  if (!list.length) return;
  await idb('groupMessages', 'readwrite', (s) => {
    list.forEach((m) => s.put(normalizeGroupMessage(m)));
  });
}

/** 更新群消息字段 */
export async function updateGroupMessage(id, patch) {
  if (!id) return null;
  const next = await mutateRecord('groupMessages', id, (cur) => {
    if (!cur) return null;
    const row = normalizeGroupMessage({ ...cur, ...patch, id: cur.id, groupId: cur.groupId });
    row.audienceIds = Array.isArray(cur.audienceIds) ? cur.audienceIds.slice() : null;
    return row;
  });
  if (!next) return null;
  void mirrorGroupMessages(next.groupId, next);
  bus.emit('gmsg:updated', next);
  return next;
}

/** 删除单条群消息 */
export async function deleteGroupMessage(id) {
  if (!id) return;
  const cur = await idb('groupMessages', 'readonly', (s) => s.get(id));
  await idb('groupMessages', 'readwrite', (s) => s.delete(id));
  if (cur && cur.groupId) void mirrorGroupMessageDeleted(cur.groupId, id);
  bus.emit('gmsg:updated', { id, groupId: (cur && cur.groupId) || '', deleted: true });
}

/** 清空某个群的聊天记录（群资料与成员保留） */
export async function clearGroupMessages(groupId) {
  if (!groupId) return;
  const keys = await idb('groupMessages', 'readonly', (s) => s.index('groupId').getAllKeys(groupId));
  await idb('groupMessages', 'readwrite', (s) => (keys || []).forEach((k) => s.delete(k)));
  void mirrorGroupMessagesReplace(groupId, []);
  bus.emit('gmsg:updated', { groupId, deleted: true, cleared: true });
}

/** 单条群消息 */
export async function getGroupMessage(id) {
  if (!id) return null;
  const m = await idb('groupMessages', 'readonly', (s) => s.get(id));
  return m ? normalizeGroupMessage(m) : null;
}

/** 最近 7 天、最多 12 条跨场景经历；每次从原记录读取，编辑/删除后不会留副本。 */
export async function getRecentExperiences(charId, opts = {}) {
  if (!charId) return [];
  const until = Math.min(Date.now(), num(opts.beforeAt, Date.now()));
  const since = until - RECENT_WINDOW_MS;
  const source = String(opts.source || `private:${charId}`);
  const database = await openDB();
  const readRecent = (storeName, index, range, eligible) => new Promise((resolve, reject) => {
    const rows = [];
    const tx = database.transaction(storeName, 'readonly');
    tx.oncomplete = () => resolve(rows);
    tx.onabort = () => reject(tx.error || new Error('读取近期经历失败'));
    tx.onerror = () => {};
    const request = tx.objectStore(storeName).index(index).openCursor(range, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const m = cursor.value;
      if (experienceContent(m) && eligible(m)) rows.push(m);
      if (rows.length < RECENT_LIMIT) cursor.continue();
    };
  });
  const [privateRows, groupRows, groups, char] = await Promise.all([
    source === `private:${charId}` ? [] : readRecent('messages', 'char_at', IDBKeyRange.bound([charId, since], [charId, until]), () => true),
    readRecent('groupMessages', 'at', IDBKeyRange.bound(since, until), (m) => `group:${m.groupId}` !== source && heardGroupMessage(m, charId)),
    listGroups(), getCharacter(charId),
  ]);
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  return [...privateRows, ...groupRows].map((m) => ({
    ownerId: charId, id: m.id, at: m.at,
    source: m.groupId ? `group:${m.groupId}` : `private:${charId}`,
    sourceName: m.groupId ? `群聊「${groupNames.get(m.groupId) || '已删除的群'}」` : `与你的一对一私聊`,
    speakerName: m.role === 'user' ? (getSettings().user?.name || '用户') : (m.speakerName || char?.name || '你'),
    content: experienceContent(m),
  })).sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id))).slice(-RECENT_LIMIT);
}

/** 每个群的消息数 */
export async function countByGroup() {
  return (await conversationStats('groupMessages')).counts;
}

/** 每个群的最后一条消息（侧栏摘要用） */
export async function listGroupRecent() {
  return (await conversationStats('groupMessages')).recent;
}

/** 搜索群消息（groupId 为 null 时搜全部群） */
export async function searchGroupMessages(groupId, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const rows = groupId
    ? await idb('groupMessages', 'readonly', (s) => s.index('groupId').getAll(groupId))
    : await idb('groupMessages', 'readonly', (s) => s.getAll());
  return (rows || [])
    .map(normalizeGroupMessage)
    .filter((m) => `${m.speakerName} ${m.content}`.toLowerCase().includes(kw))
    .sort((a, b) => b.at - a.at)
    .slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * 收藏夹（私聊 + 群聊合并成一条流）
 *
 * 说明：`bookmarked` 是消息自己的字段（私聊与群聊都有，见 normalizeMessage /
 * normalizeGroupMessage），落盘时跟着消息一起写进 data/db，所以收藏夹**不需要新表**，
 * 也不需要新建索引 —— 收藏是低频动作，全表扫一遍即可（与 searchMessages 同一做法）。
 * 给界面的是一个**统一形状**的列表：名字（好友名 / 群名 / 发言人）由 UI 侧按 id
 * 去角色与群列表里查，store 只管数据。
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} BookmarkItem
 * @property {'char'|'group'} kind 来源：好友私聊 / 群聊
 * @property {string} id 消息 id（跳转与"取消收藏"都用它）
 * @property {number} at 消息时间
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content 消息正文
 * @property {string} charId 私聊会话 id（群聊条目为空串）
 * @property {string} groupId 群聊会话 id（私聊条目为空串）
 * @property {string} speakerId 群聊里的发言人 id（私聊条目为空串）
 * @property {string} speakerName 群聊里的发言人名字（私聊条目为空串）
 * @property {string} game 群聊消息的来源标记（如 'werewolf'，普通消息为空串）
 */

/**
 * 列出全部收藏（私聊 + 群聊），按时间倒序。
 * @returns {Promise<BookmarkItem[]>}
 */
export async function listBookmarks() {
  const [rows, groupRows] = await Promise.all([
    idb('messages', 'readonly', (s) => s.getAll()),
    idb('groupMessages', 'readonly', (s) => s.getAll()),
  ]);

  const out = [];
  for (const raw of rows || []) {
    const m = normalizeMessage(raw);
    if (!m.bookmarked) continue;
    out.push({
      kind: 'char',
      id: m.id,
      at: m.at,
      role: m.role,
      content: m.content,
      charId: m.charId,
      groupId: '',
      speakerId: '',
      speakerName: '',
      game: '',
    });
  }
  for (const raw of groupRows || []) {
    const m = normalizeGroupMessage(raw);
    if (!m.bookmarked) continue;
    out.push({
      kind: 'group',
      id: m.id,
      at: m.at,
      role: m.role,
      content: m.content,
      charId: '',
      groupId: m.groupId,
      speakerId: m.speakerId,
      speakerName: m.speakerName,
      // 狼人杀这类小游戏的消息同样可以收藏：界面用这个标记提示来源
      game: m.game || '',
    });
  }
  return out.sort((a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id)));
}

/** 收藏总数（面板标题里的条数用，不必把正文都取回来） */
export async function countBookmarks() {
  const [rows, groupRows] = await Promise.all([
    idb('messages', 'readonly', (s) => s.getAll()),
    idb('groupMessages', 'readonly', (s) => s.getAll()),
  ]);
  let n = 0;
  for (const raw of rows || []) if (normalizeMessage(raw).bookmarked) n += 1;
  for (const raw of groupRows || []) if (normalizeGroupMessage(raw).bookmarked) n += 1;
  return n;
}

/* ------------------------------------------------------------------ *
 * 记忆库
 * ------------------------------------------------------------------ */

const EMPTY_MEMORY = { summary: '', facts: [], updatedAt: 0, summarizedUpTo: 0 };

/** 读取角色记忆 */
export async function getMemory(charId) {
  if (!charId) return normalizeMemory(EMPTY_MEMORY);
  const m = await idb('memory', 'readonly', (s) => s.get(charId));
  const memory = normalizeMemory(m || EMPTY_MEMORY);
  const cache = new Map();
  const resolve = (source) => {
    const key = sourceKey(source) + ':' + source.signature;
    if (!cache.has(key)) cache.set(key, resolveMemorySource(charId, source));
    return cache.get(key);
  };
  for (const record of memory.factRecords) {
    if (record.status !== 'active' || !record.sources.length) continue;
    const refs = await Promise.all(record.sources.map(resolve));
    if (refs.some((r) => !r.available || r.changed)) record.status = 'stale';
  }
  if (memory.summarySources.length) {
    const refs = await Promise.all(memory.summarySources.map(resolve));
    if (refs.some((r) => !r.available || r.changed)) memory.summaryStatus = 'stale';
  }
  // 只读过滤，不在打开旧聊天时迁移/重写用户存档。
  return normalizeMemory(memory);
}

/** 写入角色记忆 */
export async function saveMemory(charId, mem, opts = {}) {
  if (!charId) return;
  return updateMemoryAtomic(charId, () => mem, opts);
}

async function updateMemoryAtomic(charId, update, opts = {}) {
  const database = await openDB();
  const row = await new Promise((resolve, reject) => {
    const tx = database.transaction('memory', 'readwrite'), store = tx.objectStore('memory');
    let next, failure;
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(failure || tx.error || new Error('记忆保存失败'));
    tx.onerror = () => {};
    const request = store.get(charId);
    request.onsuccess = () => {
      try {
        const previous = normalizeMemory(request.result || EMPTY_MEMORY);
        if (opts.expectedRevision !== undefined && previous.revision !== opts.expectedRevision) {
          const error = new Error('记忆已被更新，本次整理未覆盖新的修改'); error.code = 'memory_conflict'; throw error;
        }
        next = { ...normalizeMemory(update(previous)), charId, updatedAt: Math.max(Date.now(), previous.updatedAt + 1), revision: previous.revision + 1 };
        store.put(next);
      } catch (err) { failure = err; tx.abort(); }
    };
  });
  void mirrorMemory(charId, row);
  bus.emit('memory:changed', { charId });
  return row;
}

export async function resolveMemorySource(charId, source) {
  const isGroup = source?.kind === 'group';
  const message = isGroup ? await getGroupMessage(source.messageId) : await getMessage(source.messageId);
  const allowed = message && experienceContent(message) && (isGroup
    ? message.groupId === source.conversationId && heardGroupMessage(message, charId)
    : message.charId === charId && source.conversationId === charId);
  const group = allowed && isGroup ? await getGroup(source.conversationId) : null;
  return { ...source, available: Boolean(allowed), changed: Boolean(allowed && source.signature !== sourceSignature(message)),
    content: allowed ? experienceContent(message) : '', sourceName: isGroup ? `群聊「${group?.name || '原群聊'}」` : '一对一私聊' };
}

export async function getMemorySource(charId, recordId) {
  const memory = await getMemory(charId);
  const record = memory.factRecords.find((r) => r.id === recordId);
  return record ? Promise.all(record.sources.map((s) => resolveMemorySource(charId, s))) : [];
}

export async function correctMemoryFact(charId, recordId, text) {
  if (!charId) throw new Error('缺少角色');
  return updateMemoryAtomic(charId, (memory) => correctFact(memory, recordId, text));
}

export async function retractMemoryFact(charId, recordId) {
  if (!charId) throw new Error('缺少角色');
  return updateMemoryAtomic(charId, (memory) => retractFact(memory, recordId));
}

/** 确定性游戏结算追加记忆，保留新结构与纠错记录，并避免读后写覆盖。 */
export async function appendGameMemoryFact(charId, text) {
  return updateMemoryAtomic(charId, (memory) => {
    if (memory.factRecords.some((r) => r.text === text && (r.status === 'active' || r.blocked))) return memory;
    const now = Date.now();
    memory.factRecords.push({ id: createId('fact'), text: String(text), origin: 'game', status: 'active',
      sources: [], sourceStatus: 'unverified', createdAt: now, updatedAt: now });
    return memory;
  });
}

/** 重建只读取该角色自己的私聊和有实际听众证据的群消息。 */
export async function getMemoryHistory(charId) {
  const [privateRows, groupRows] = await Promise.all([
    listMessages(charId), idb('groupMessages', 'readonly', (s) => s.getAll()),
  ]);
  return [...privateRows, ...(groupRows || []).filter((m) => heardGroupMessage(m, charId))]
    .filter((m) => experienceContent(m))
    .sort((a, b) => num(a.at) - num(b.at) || String(a.id).localeCompare(String(b.id)));
}

/* ------------------------------------------------------------------ *
 * 设置（localStorage）
 * ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#6c8cff',
  user: { name: '我', avatar: '', persona: '', gender: '' },
  provider: 'deepseek',
  model: 'deepseek-flash',
  apiKeys: {},
  baseUrls: {},
  useProxy: false,
  proxyKeySlot: 'default',
  proxyToken: '',
  // thinking: null = 不下发该字段（跟随 DeepSeek 模型默认）；设置 → 模型 → 生成参数 里可切三态（见 ARCHITECTURE 5.19）
  params: { temperature: 0.85, topP: 1, maxTokens: 1024, presencePenalty: 0, frequencyPenalty: 0, thinking: null },
  presets: [],
  context: {
    maxMessages: 40,
    budgetTokens: 8000,
    summary: true,
    summaryKeep: 12,
    timeAware: true,
    affinity: true,
  },
  typedEffect: true,
  sendKey: 'enter',
  showDebug: false,
  sound: true,
  voice: {
    enabled: true,
    provider: 'webspeech',
    voiceId: '',
    rate: 1,
    pitch: 1,
    autoplay: 'off',
    shortLimit: 60,
    cache: true,
    stt: { enabled: true, lang: 'zh-CN', autoSend: false },
  },
  proactive: { enabled: false, minGapHours: 6, quietStart: 23, quietEnd: 7, maxPerDay: 2 },
  /** 群聊默认项：新建群聊时套用（老群聊不受影响） */
  group: {
    autoTalk: true,
    turnMode: 'smart',
    maxAutoTurns: 3,
    autoDelayMs: 900,
    autoVoice: false,
    /** 「让他们自己聊」时保证每位成员至少说一次（见 core/group.js 的 planSpeakers） */
    everyoneSpeaks: true,
    defaultMembers: 3,
  },
  onboarded: false,
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    // 禁止原型相关键：导入别人给的备份 JSON 时，{"__proto__":{...}} 会通过 setter 换掉原型
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

let settingsCache = null;

/**
 * 多标签页一致性：别的标签页改了设置 / 运行时状态时，本页的进程内缓存必须失效，
 * 否则本页后续写入会拿旧快照整体覆盖回去（表现为"改了没生效"或"好感度倒退"）。
 * 只监听一次，惰性挂载。
 */
let storageListenerBound = false;
function bindStorageListener() {
  if (storageListenerBound || typeof window === 'undefined' || !window.addEventListener) return;
  storageListenerBound = true;
  window.addEventListener('storage', (e) => {
    try {
      if (!e || !e.key) return;
      if (e.key === SETTINGS_KEY) {
        settingsCache = null;
        bus.emit('settings:changed', getSettings());
      } else if (e.key === RUNTIME_KEY) {
        runtimeCache = null;
        bus.emit('runtime:changed', { charId: '', runtime: {} });
      }
    } catch {
      /* 忽略 */
    }
  });
}

/** 读取设置（深拷贝，已与默认值合并） */
export function getSettings() {
  bindStorageListener();
  if (!settingsCache) {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    } catch {
      raw = null;
    }
    settingsCache = raw ? deepMerge(DEFAULT_SETTINGS, raw) : { ...DEFAULT_SETTINGS };
  }
  return JSON.parse(JSON.stringify(settingsCache));
}

/** 合并写入设置 */
export function setSettings(patch, opts = {}) {
  const previous = getSettings();
  const next = deepMerge(previous, patch || {});
  settingsCache = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch (err) {
    storageErrorHandlers.forEach((fn) => fn(err));
  }
  // 只传 settings；运行时状态由 core/runtime.js 的 persistRuntime 单独入队，
  // 二者共用同一个去抖队列，且都在写盘那一刻取最新值（避免旧快照覆盖新好感度）
  if (!opts.localOnly) void mirrorSettings({ settingsChanges: diffChanges(previous, next) });
  bus.emit('settings:changed', next);
  return JSON.parse(JSON.stringify(next));
}

/** 恢复默认设置 */
export function resetSettings() {
  settingsCache = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache));
  } catch {}
  void mirrorSettings({ settings: settingsCache });
  bus.emit('settings:changed', settingsCache);
  return getSettings();
}

/** 取某供应商的 Key（代理模式下返回空串） */
export function apiKeyFor(provider) {
  const s = getSettings();
  if (s.useProxy) return '';
  return s.apiKeys?.[provider] || '';
}

/** 取某供应商的 baseUrl（自定义优先） */
export function baseUrlFor(provider, fallback) {
  const s = getSettings();
  return (s.baseUrls?.[provider] || '').trim() || fallback || '';
}

/* ------------------------------------------------------------------ *
 * 轻量运行时状态（好感度/未读/主动消息计数）—— localStorage，读写频繁
 * ------------------------------------------------------------------ */

/** @type {Record<string, object>} */
let runtimeCache = null;

export function readRuntimeAll() {
  if (!runtimeCache) {
    try {
      runtimeCache = JSON.parse(localStorage.getItem(RUNTIME_KEY) || '{}') || {};
    } catch {
      runtimeCache = {};
    }
  }
  return runtimeCache;
}

export function writeRuntimeAll(all) {
  runtimeCache = all || {};
  try {
    localStorage.setItem(RUNTIME_KEY, JSON.stringify(runtimeCache));
  } catch {}
}

/* ------------------------------------------------------------------ *
 * 给 core/filestore.js 用的本地接口
 *   —— 启动回填时以磁盘文件为准重建本地库，这些函数只动本地、不再镜像回盘，
 *      避免"从盘上读出来又原样写回去"的无谓写放大。
 * ------------------------------------------------------------------ */

/** 把某个角色写进本地库（不镜像） */
export async function putCharacterLocal(char) {
  const c = normalizeCharacter(char);
  await idb('characters', 'readwrite', (s) => s.put(c));
  return c;
}

/** 批量写入消息（不镜像） */
export async function putMessagesLocal(list) {
  const arr = (Array.isArray(list) ? list : []).map(normalizeMessage).filter((m) => m.charId);
  if (arr.length) await appendMessagesBulk(arr);
  return arr.length;
}

/**
 * 把某个群聊写进本地库（不镜像）
 * @param {object} group
 * @param {Set<string>|null} [liveCharIds] 现存角色 id 集合；给了就顺手过滤掉已删除的成员
 */
export async function putGroupLocal(group, liveCharIds) {
  const g = normalizeGroup(group);
  if (liveCharIds instanceof Set) g.members = g.members.filter((m) => liveCharIds.has(m));
  await idb('groups', 'readwrite', (s) => s.put(g));
  return g;
}

/** 批量写入群消息（不镜像） */
export async function putGroupMessagesLocal(list) {
  const arr = (Array.isArray(list) ? list : []).map(normalizeGroupMessage).filter((m) => m.groupId);
  if (arr.length) await appendGroupMessagesBulk(arr);
  return arr.length;
}

/** 只清空浏览器里的数据，不动磁盘文件 */
export async function wipeLocalOnly() {
  await idb('characters', 'readwrite', (s) => s.clear());
  await idb('messages', 'readwrite', (s) => s.clear());
  await idb('memory', 'readwrite', (s) => s.clear());
  await idb('groups', 'readwrite', (s) => s.clear());
  await idb('groupMessages', 'readwrite', (s) => s.clear());
  // 注意：**不要清 runtime**。好感度/情绪/未读存在 localStorage 而不是 IndexedDB，
  // 不属于"本地库回填"的范围；这里清掉会让 filestore 随后的"取较大值合并"永远读到空对象
  //（等于死代码），磁盘 runtime 缺失时就会把聊出来的好感度冲回角色卡初始值。
  // 需要真正清空时走 wipeAll()（它会连带清 runtime 并镜像到磁盘）。
}

/** 启动回填的所有表共用一个事务；任何一条失败时原有浏览器数据整体保留。 */
export async function replaceLocalSnapshot(pack) {
  const characters = pack.characters.map(normalizeCharacter);
  const liveIds = new Set(characters.map((c) => c.id));
  const groups = pack.groups.map((raw) => {
    const g = normalizeGroup(raw);
    g.members = g.members.filter((id) => liveIds.has(id));
    return g;
  });
  const rows = {
    characters,
    messages: pack.messages.map(normalizeMessage),
    memory: pack.memory,
    groups,
    groupMessages: pack.groupMessages.map(normalizeGroupMessage),
  };
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(Object.keys(rows), 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('聊天数据恢复失败，已保留原有数据'));
    tx.onerror = () => {};
    try {
      for (const [name, list] of Object.entries(rows)) {
        const store = tx.objectStore(name);
        store.clear();
        for (const row of list) store.put(row);
      }
    } catch (err) {
      tx.abort();
      reject(err);
    }
  });
}
/* ------------------------------------------------------------------ *
 * 数据管理：导出 / 导入 / 清空 / 统计
 * ------------------------------------------------------------------ */

/**
 * 导出全部（或指定角色）数据为 JSON 备份包
 * @param {string[]} [charIds]
 * @returns {Promise<Blob>}
 */
export async function exportAll(charIds) {
  const allChars = await listCharacters();
  const chars = Array.isArray(charIds) && charIds.length
    ? allChars.filter((c) => charIds.includes(c.id))
    : allChars;
  const ids = new Set(chars.map((c) => c.id));
  const msgs = (await idb('messages', 'readonly', (s) => s.getAll())) || [];
  const memRows = (await idb('memory', 'readonly', (s) => s.getAll())) || [];
  const useRows = (await idb('usage', 'readonly', (s) => s.getAll())) || [];
  const allGroups = (await idb('groups', 'readonly', (s) => s.getAll())) || [];
  const gmsgs = (await idb('groupMessages', 'readonly', (s) => s.getAll())) || [];
  // 指定角色导出时，只带上"成员全在导出范围内"的群聊，避免备份出一个缺人的群
  const groups = Array.isArray(charIds) && charIds.length
    ? allGroups.filter((g) => (g.members || []).every((m) => ids.has(m)))
    : allGroups;
  const groupIds = new Set(groups.map((g) => g.id));

  const pack = {
    app: 'AI 聊天网站',
    format: 'aichat-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      characters: chars.length,
      messages: msgs.filter((m) => ids.has(m.charId)).length,
      groups: groups.length,
      groupMessages: gmsgs.filter((m) => groupIds.has(m.groupId)).length,
    },
    settings: getSettings(),
    runtime: readRuntimeAll(),
    characters: chars,
    messages: msgs.filter((m) => ids.has(m.charId)),
    memory: memRows.filter((m) => ids.has(m.charId)),
    usage: useRows.filter((u) => !u.charId || ids.has(u.charId)),
    groups,
    groupMessages: gmsgs.filter((m) => groupIds.has(m.groupId)),
  };
  return new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
}

/**
 * 导入备份包
 * @param {File|object|string} fileOrJson
 * @param {{merge?:boolean}} [opts] merge=true 时保留现有数据
 * @returns {Promise<{chars:number, messages:number}>}
 */
export async function importAll(fileOrJson, opts = {}) {
  const merge = opts.merge !== false;
  let pack = fileOrJson;
  if (typeof pack === 'string') pack = JSON.parse(pack);
  if (pack instanceof File || (typeof Blob !== 'undefined' && pack instanceof Blob)) {
    const text = await pack.text();
    pack = JSON.parse(text);
  }
  if (!pack || typeof pack !== 'object') throw new Error('备份文件内容无效');

  // 支持单角色卡导入
  if (!pack.characters && (pack.spec || pack.name || pack.data)) {
    const c = await importCharacter(pack);
    return { chars: 1, messages: 0, characters: [c] };
  }
  validateBackup(pack);
  if (!merge) {
    const result = await wipeAll();
    if (!result.ok) throw new Error(result.fileError || '清空失败，已停止导入');
  }

  const chars = Array.isArray(pack.characters) ? pack.characters : [];
  const existing = merge ? new Set((await listCharacters()).map((c) => c.id)) : new Set();
  const idMap = new Map();
  const toSave = [];
  for (const raw of chars) {
    const c = normalizeCharacter(raw);
    // 合并导入时若 id 冲突：换新 id，并记下映射关系（消息/记忆的 charId 也要跟着换）
    if (existing.has(c.id)) {
      const oldId = raw.id;
      c.id = createId('c');
      if (oldId) idMap.set(oldId, c.id);
      c.name = `${c.name}（导入）`;
    }
    toSave.push(c);
  }
  if (toSave.length) {
    await idb('characters', 'readwrite', (s) => toSave.forEach((c) => s.put(c)));
    // 逐个镜像写盘：合并导入时磁盘上还有别的角色，启动回填会以磁盘为准，
    // 不写盘的导入结果下次启动就会消失
    for (const c of toSave) void mirrorCharacter(c);
  }

  const mapId = (id) => idMap.get(id) || id;
  const validIds = new Set(toSave.map((c) => c.id));

  // 消息：charId 跟随角色映射；**合并导入时消息 id 也必须重映射**，
  // 否则 put 会用原 id 覆盖掉被导入角色原有的消息（表现为"原角色消息被搬走"）。
  const messageIdMap = new Map();
  const msgs = (Array.isArray(pack.messages) ? pack.messages : [])
    .map((m) => {
      const nm = normalizeMessage(m);
      const charId = mapId(m.charId);
      const remap = merge && validIds.has(charId) && idMap.has(m.charId);
      const result = { ...nm, charId, id: remap ? createId('m') : nm.id };
      messageIdMap.set(nm.id, result.id);
      return result;
    })
    .filter((m) => validIds.has(m.charId));
  await appendMessagesBulk(msgs);
  // 消息同样要落盘（按角色分组一次提交，避免大量小请求）
  const byCharForMirror = new Map();
  for (const m of msgs) {
    if (!byCharForMirror.has(m.charId)) byCharForMirror.set(m.charId, []);
    byCharForMirror.get(m.charId).push(m);
  }
  for (const [cid, list] of byCharForMirror) void mirrorMessages(cid, list);

  // 群聊：群 id 也做冲突重映射；成员 id 跟随角色映射；成员全丢了的群直接跳过
  const rawGroups = Array.isArray(pack.groups) ? pack.groups : [];
  const existingGroups = merge ? new Set((await listGroups()).map((g) => g.id)) : new Set();
  const groupIdMap = new Map();
  const savedGroups = [];
  for (const raw of rawGroups) {
    const g = normalizeGroup(raw);
    if (existingGroups.has(g.id)) {
      const oldId = raw && raw.id;
      g.id = createId('g');
      if (oldId) groupIdMap.set(oldId, g.id);
      g.name = `${g.name}（导入）`;
    }
    g.memberSince = Object.fromEntries(Object.entries(g.memberSince).map(([id, at]) => [mapId(id), at]));
    g.members = g.members.map((m) => mapId(m)).filter((m) => validIds.has(m));
    // 成员只剩 1 个甚至 0 个也是合法状态（删角色会把人删光），**不能因此丢弃整个群**：
    // 群资料、主题、接话策略以及 groupmsgs/ 里的聊天记录都挂在这个群上，
    // 丢掉它等于把用户建过的群连同记录一起吞掉（"空群备份被跳过"就是这条）。
    await idb('groups', 'readwrite', (s) => s.put(g));
    savedGroups.push(g);
  }
  const groupMessageIdMap = new Map();
  const gmsgs = (Array.isArray(pack.groupMessages) ? pack.groupMessages : [])
    .map((m) => {
      const nm = normalizeGroupMessage(m);
      const groupId = groupIdMap.get(m.groupId) || mapId(m.groupId);
      const id = merge && groupIdMap.has(m.groupId) ? createId('m') : nm.id;
      groupMessageIdMap.set(nm.id, id);
      return {
        ...nm,
        groupId,
        charId: groupId,
        speakerId: nm.speakerId ? mapId(nm.speakerId) : '',
        audienceIds: Array.isArray(nm.audienceIds) ? nm.audienceIds.map(mapId).filter((id) => validIds.has(id)) : null,
        id,
      };
    })
    .filter((m) => savedGroups.some((g) => g.id === m.groupId));
  await appendGroupMessagesBulk(gmsgs);
  // 群消息也必须落盘（按群分组一次提交，避免大量小请求）。
  // 为什么不能只写 IndexedDB：下次启动 syncOnBoot 在"盘上有角色"时会先清空本地库再以盘为准回填，
  // 盘上没有 groupmsgs 文件的群就会被回填成空群 —— 表现就是"导入后能看到，一刷新群消息全消失"。
  // 这里 await 而不是像角色/消息那样 void：导入是用户主动发起的一次性操作，
  // 返回前确保写盘完成，用户立刻刷新也不会丢。
  const byGroupForMirror = new Map();
  for (const m of gmsgs) {
    if (!byGroupForMirror.has(m.groupId)) byGroupForMirror.set(m.groupId, []);
    byGroupForMirror.get(m.groupId).push(m);
  }
  await Promise.all(
    Array.from(byGroupForMirror, ([gid, list]) => mirrorGroupMessages(gid, list))
  );

  // 消息、角色和群的ID全部确定后，再重映射记忆来源；不让导入记忆指向原角色的聊天。
  const mapSource = (source) => ({ ...source,
    conversationId: source.kind === 'group' ? (groupIdMap.get(source.conversationId) || source.conversationId) : mapId(source.conversationId),
    messageId: (source.kind === 'group' ? groupMessageIdMap : messageIdMap).get(source.messageId) || source.messageId,
    speakerId: mapId(source.speakerId),
  });
  for (const raw of Array.isArray(pack.memory) ? pack.memory : []) {
    const cid = mapId(raw.charId);
    if (!validIds.has(cid)) continue;
    const memory = normalizeMemory(raw);
    memory.factRecords = memory.factRecords.map((r) => ({ ...r, sources: r.sources.map(mapSource) }));
    memory.summarySources = memory.summarySources.map(mapSource);
    memory.summaryCursors = Object.fromEntries(Object.entries(memory.summaryCursors).map(([key, cursor]) => {
      const group = key.startsWith('group:');
      const newKey = group ? `group:${groupIdMap.get(key.slice(6)) || key.slice(6)}` : key;
      return [newKey, { ...cursor, id: (group ? groupMessageIdMap : messageIdMap).get(cursor.id) || cursor.id }];
    }));
    await saveMemory(cid, memory);
  }

  // 设置：只在"覆盖导入"且备份包内确实带了设置对象时恢复
  if (!merge && pack.settings && typeof pack.settings === 'object' && !Array.isArray(pack.settings)) {
    setSettings(pack.settings);
  }
  if (pack.runtime && typeof pack.runtime === 'object') {
    const all = readRuntimeAll();
    for (const [k, v] of Object.entries(pack.runtime)) {
      all[groupIdMap.get(k) || mapId(k)] = { ...(v && typeof v === 'object' ? v : {}), updatedAt: Date.now() };
    }
    writeRuntimeAll(all);
    void mirrorRuntime(all);
  }

  toSave.forEach((c) => bus.emit('char:changed', c));
  savedGroups.forEach((g) => {
    void mirrorGroup(g);
    bus.emit('group:changed', g);
  });
  return {
    chars: toSave.length,
    messages: msgs.length,
    characters: toSave,
    groups: savedGroups.length,
    groupMessages: gmsgs.length,
  };
}

/**
 * 清空全部数据（浏览器 IndexedDB + 磁盘 data/db）。
 *
 * 返回值让调用方（设置面板）能区分"真的清干净了"和"浏览器清了但磁盘没清掉"：
 * 以前这里不等磁盘结果、也不返回任何东西，界面于是无条件弹"已清空全部本机数据" ——
 * 磁盘清空失败时旧数据会在下次启动被回填，用户看到的却是成功。
 * @returns {Promise<{ok: boolean, fileOk: boolean, fileError: string}>}
 *   ok=false 只表示"磁盘确实需要清而没清成功"；纯静态部署（文件存储不可用）不算失败。
 */
export async function wipeAll() {
  const wiped = await mirrorWipeAll([]);
  const fileState = fileStatus();
  const diskFailed = (fileState.available === true || fileState.known === true) && wiped !== true;
  if (diskFailed) return { ok: false, fileOk: false, fileError: fileState.error || '磁盘清空失败，浏览器数据已保留' };
  await idb('characters', 'readwrite', (s) => s.clear());
  await idb('messages', 'readwrite', (s) => s.clear());
  await idb('memory', 'readwrite', (s) => s.clear());
  await idb('usage', 'readwrite', (s) => s.clear());
  await idb('ttsCache', 'readwrite', (s) => s.clear());
  await idb('groups', 'readwrite', (s) => s.clear());
  await idb('groupMessages', 'readwrite', (s) => s.clear());
  writeRuntimeAll({});
  bus.emit('char:deleted', { all: true });
  bus.emit('group:deleted', { all: true });
  return {
    ok: !diskFailed,
    fileOk: wiped === true,
    fileError: diskFailed ? fileState.error || '磁盘文件清空失败（原因未知）' : '',
  };
}

/** 数据统计 */
export async function dbStats() {
  const chars = await idb('characters', 'readonly', (s) => s.count());
  const messages = await idb('messages', 'readonly', (s) => s.count());
  const groups = await idb('groups', 'readonly', (s) => s.count());
  const groupMessages = await idb('groupMessages', 'readonly', (s) => s.count());
  let bytes = 0;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      bytes = est.usage || 0;
    }
  } catch {}
  return { chars, messages, groups, groupMessages, bytes };
}

/** 估算某角色聊天记录占用（字符数） */
export async function chatVolume(charId) {
  const rows = await listMessages(charId);
  return rows.reduce((n, m) => n + m.content.length, 0);
}

export { hashCode };
