/**
 * voice/tts.js —— 语音合成（TTS）层
 *
 * 契约：ARCHITECTURE.md 3.12
 *   export class SpeechQueue
 *   export const speaker
 *   export function speakText / stopSpeaking / voiceAvailable / voiceFor / clearVoiceCache
 *
 * 设计要点（来自《语音方案》）：
 *   1. Speaker 抽象：provider === 'webspeech'（浏览器内置）或 'cloud'（OpenAI 兼容 /audio/speech）；
 *   2. 云端失败必须静默降级到浏览器内置（或直接静音），**绝不阻塞对话**；
 *   3. webspeech 有"看门狗定时器"兜底（Chrome 的 onend 有时不触发，会让队列永久卡住）；
 *   4. cloud 走 Web Audio（decodeAudioData + AudioBufferSourceNode），方便接 AnalyserNode 做口型；
 *   5. 缓存：内存 Map + IndexedDB（库 aichat / 表 ttsCache），只缓存云端音频，最多 200 条；
 *   6. 全部 API 在受限环境（无声、无 AudioContext、无 IndexedDB）下都不抛错，只静默降级。
 */
import { getProvider } from '../data/models.js';

/* =====================================================================
   0. 常量与极小工具
   ===================================================================== */

/** IndexedDB 库名 */
const DB_NAME = 'aichat';
/** TTS 缓存表名 */
const TTS_STORE = 'ttsCache';
/** 缓存条数上限（超出按最旧淘汰） */
const CACHE_MAX = 200;
/** 同时进行的云端合成请求上限（别把 10 句一起打给 API） */
const CLOUD_CONCURRENT = 2;
/** 单次朗读的文本上限（Chrome 对超长文本会静默截断） */
const MAX_UTTERANCE_CHARS = 300;
/** 云端音频解码缓存（内存）上限 */
const AUDIO_MEM_MAX = 40;
/** 云端默认音色（voiceId 为空时的兜底） */
const DEFAULT_CLOUD_VOICE = 'alloy';

/**
 * 云端音色**预设**（只是下拉里的常用项，不是白名单）。
 *
 * 音色名完全由供应商定义，所以界面必须允许手填：
 *   · OpenAI 系：alloy / ash / ballad / coral / echo / fable / nova / onyx / sage / shimmer / verse…
 *   · Edge TTS：zh-CN-XiaoxiaoNeural、zh-CN-YunxiNeural、zh-CN-liaoning-XiaobeiNeural…
 *   · MiniMax / 阿里百炼 CosyVoice / 硅基流动 / 本地自建（GPT-SoVITS、CosyVoice、XTTS 克隆音色）…
 * 三者都通过「设置 → 语音 → 云端音色」或「角色卡 → 语音 → 云端音色」填入。
 */
export const CLOUD_VOICE_PRESETS = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'sage'];

/** 云端模型预设（同样是常用项，不是白名单：MiniMax speech-02-hd、cosyvoice-v1 等都可手填） */
export const CLOUD_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];

/**
 * 32 位十六进制字符串哈希（与 core/util.js hashCode 同算法，契约要求缓存 key 用它）。
 * @param {string} s 输入字符串
 * @returns {string} 8 位十六进制哈希
 */
export function hashCode(s) {
  let h = 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 当前环境是否存在浏览器语音合成能力 */
const canSpeak = typeof globalThis !== 'undefined'
  && typeof globalThis.speechSynthesis !== 'undefined'
  && typeof globalThis.SpeechSynthesisUtterance !== 'undefined';

/** 惰性引用语音识别模块（避免静态导入造成循环依赖/加载失败） */
let sttMod = null;

/* =====================================================================
   1. 配置合并：VoiceConfig
   ===================================================================== */

/** 语音默认值（与 ARCHITECTURE 2.3/2.4 一致） */
const VOICE_DEFAULTS = {
  provider: 'webspeech',
  voiceId: '',
  rate: 1,
  pitch: 1,
  autoplay: 'short',
  cache: true,
};

/** 数值范围约束 */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 把角色声线与全局默认合并成完整 VoiceConfig（保证所有字段都有值）。
 * 角色 card/voice 里显式配置的字段优先，其次全局 settings.voice，最后内置默认值。
 * @param {object} [char] 角色卡（Character，可含 voice）
 * @param {object} [settings] 全局设置（Settings，可含 voice）
 * @returns {{ provider: 'webspeech'|'cloud', voiceId: string, rate: number, pitch: number,
 *             autoplay: 'off'|'short'|'always', cache: boolean }}
 */
export function voiceFor(char, settings) {
  const cv = (char && char.voice) || {};
  const gv = (settings && settings.voice) || {};
  const pick = (k) => {
    const v = cv[k];
    if (v !== undefined && v !== null && v !== '') return v;
    const g = gv[k];
    if (g !== undefined && g !== null && g !== '') return g;
    return VOICE_DEFAULTS[k];
  };
  const provider = pick('provider') === 'cloud' ? 'cloud' : 'webspeech';
  const autoplay = pick('autoplay');
  return {
    provider,
    voiceId: String(pick('voiceId') || ''),
    rate: clampNum(pick('rate'), 0.5, 2, VOICE_DEFAULTS.rate),
    pitch: clampNum(pick('pitch'), 0.5, 2, VOICE_DEFAULTS.pitch),
    autoplay: autoplay === 'off' || autoplay === 'always' ? autoplay : 'short',
    cache: pick('cache') !== false,
  };
}

/** 设置快照缓存（异步拉取后填充） */
let settingsCache = null;
/** 是否正在异步拉取设置 */
let settingsLoading = false;
/** 是否已经尝试过拉取设置（失败后不再重试，避免反复 404） */
let settingsTried = false;

/** 设置不可用时的兜底默认值 */
function settingsFallback() {
  return { voice: { ...VOICE_DEFAULTS, stt: { enabled: true, lang: 'zh-CN', autoSend: false } } };
}

/**
 * 读取全局设置（来自 core/store.js 的 getSettings()；不可用时回落内置默认值）。
 * ES Module 的 import() 是异步的，因此这里返回同步快照 + 一个就绪 Promise：
 * 首次调用时快照可能是默认值，但会立刻在后台拉取真实设置，后续调用即为真值。
 * 使用惰性 import 是为了即使 core/ 尚未就绪，本模块也不会整体加载失败。
 * @returns {{ s: object, ready: Promise<object> }} 同步快照 + 异步就绪结果
 */
function readSettings() {
  try {
    // 测试注入点：允许测试脚本用 globalThis.__ttsSettings 覆盖设置（审计工具已白名单，勿当调试残留删除）
    if (typeof globalThis.__ttsSettings === 'object' && globalThis.__ttsSettings) {
      return { s: globalThis.__ttsSettings, ready: Promise.resolve(globalThis.__ttsSettings) };
    }
  } catch (e) { /* 忽略 */ }
  if (!settingsCache && !settingsLoading) settingsLoading = true;
  // core 未就绪时只尝试一次，避免反复 404 打扰控制台
  const p = settingsTried
    ? Promise.resolve(settingsCache || settingsFallback())
    : import('../core/store.js')
      .then((m) => {
        if (m && typeof m.getSettings === 'function') settingsCache = m.getSettings();
        return settingsCache || settingsFallback();
      })
      .catch(() => settingsCache || settingsFallback())
      .finally(() => { settingsLoading = false; settingsTried = true; });
  return { s: settingsCache || settingsFallback(), ready: p };
}

/**
 * 主动预热设置（UI 启动或用户手势时调用，让后续 speak 直接拿到真实配置）。
 * @returns {Promise<object>} 设置对象
 */
export async function primeSettings() {
  settingsTried = false;
  settingsLoading = false;
  settingsReadyPromise = null;
  return (await readSettings().ready) || settingsFallback();
}

/** 设置就绪的共享 Promise（云端合成前 await 它，避免首次调用拿到默认值） */
let settingsReadyPromise = null;

/**
 * 等待设置就绪（返回 core/store.js 的 getSettings() 结果；不可用时返回内置默认值）。
 * 首次调用会触发一次异步读取，得到的是共享 Promise，不会重复拉取。
 * @returns {Promise<object>} 设置对象
 */
export function ensureSettings() {
  if (!settingsReadyPromise) {
    settingsReadyPromise = readSettings().ready.catch(() => settingsCache || settingsFallback());
  }
  return settingsReadyPromise;
}

/**
 * 由全局设置推导出云端 TTS 参数（供应商 / 模型 / 密钥 / 地址 / 是否走代理）。
 *
 * 两条铁律（曾经的 bug：选了非 OpenAI 的供应商时会"请求错服务商 + 发错密钥"）：
 *   1. **密钥只认所选供应商那一把**。拿不到就留空，由调用方给出"缺少密钥"的中文提示；
 *      以前这里会退回 `apiKeys.openai`，于是"选了 Qwen 但没填 Qwen 密钥"时，
 *      真正发出去的是一把 OpenAI 的密钥、打到 Qwen 的地址上（跨供应商泄露 + 上游 401）。
 *   2. **地址同样只认所选供应商**：用户的专用地址 → 用户为这个供应商填的反代地址 →
 *      该供应商的官方地址（`data/models.js` 的 `baseUrl`）。**绝不退回 OpenAI 的地址**，
 *      否则"选了 Qwen 却请求 OpenAI"。custom 且没填地址时返回空串，
 *      由 `fetchCloudAudio()` 明确报错，而不是偷偷打到某个默认供应商。
 *
 * @param {object} [s] 全局设置；不传则取缓存快照
 * @returns {{ provider: string, model: string, apiKey: string, baseUrl: string, useProxy: boolean,
 *             label: string, needKey: boolean }}
 */
export function cloudConfig(s) {
  const settings = s || settingsCache || readSettings().s || {};
  const v = settings.voice || {};
  const provider = String(v.ttsProvider || v.cloudProvider || settings.provider || 'openai');
  const meta = getProvider(provider);
  const model = String(v.ttsModel || v.model || 'gpt-4o-mini-tts');
  const keys = settings.apiKeys || {};
  const urls = settings.baseUrls || {};
  // 语音分区自己的地址（v.baseUrl）优先，其次复用「模型」分区里该供应商的反代地址
  const apiKey = String(v.apiKey || keys[provider] || '');
  const overrideBaseUrl = String(v.baseUrl || urls[provider] || '');
  const baseUrl = String(overrideBaseUrl || meta.baseUrl || '');
  return {
    provider,
    model,
    apiKey,
    baseUrl,
    overrideBaseUrl,
    useProxy: settings.useProxy === true,
    proxyToken: String(settings.proxyToken || ''),
    /** 供应商中文名（错误提示里用） */
    label: String(meta.label || provider),
    /** 该供应商是否必须配密钥（ollama / lmstudio 这类本地服务不需要） */
    needKey: meta.needKey !== false,
  };
}

/**
 * 合成缓存 key：hash(文本 + provider + voiceId + rate + pitch)。
 * @param {string} text 待合成文本
 * @param {{ provider?: string, voiceId?: string, rate?: number, pitch?: number }} cfg 语音配置
 * @returns {string} 缓存 key
 */
export function cacheKey(text, cfg) {
  const c = cfg || {};
  return hashCode([text, c.provider || '', c.voiceId || '', c.rate, c.pitch, c.model || '', c.baseUrl || ''].join('|'));
}

/* =====================================================================
   2. 并发闸门：云端合成最多 CLOUD_CONCURRENT 个并发
   ===================================================================== */

let running = 0;
/** @type {Array<() => void>} 等待中的任务 */
const waiters = [];

/**
 * 带并发上限地执行一个任务（云端合成闸门）。
 * @template T
 * @param {() => Promise<T>} fn 任务函数
 * @returns {Promise<T>} 任务结果
 */
function gate(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          running--;
          const next = waiters.shift();
          if (next) next();
        });
    };
    if (running < CLOUD_CONCURRENT) run();
    else waiters.push(run);
  });
}

/* =====================================================================
   3. IndexedDB：ttsCache（库 aichat）
   ===================================================================== */

/** @type {IDBDatabase|null} */
let db = null;
let dbFailed = false;
/** 内存缓存：key → Blob（LRU，加速重复播放） */
const memCache = new Map();
/** 已合成过的标记（webspeech 不缓存音频，但记录"这段合成过"，避免重复日志/重复请求） */
const synthLog = new Set();

/** IDBRequest → Promise */
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 打开（或复用）缓存数据库。
 *
 * **不能写死版本号**：主库 `aichat` 由 `core/store.js` 以 v2 创建（角色/消息/记忆/用量/群聊 + ttsCache），
 * 这里以前写 `indexedDB.open('aichat', 1)` —— 库已经存在 v2 时，用较低版本打开会直接抛
 * `VersionError`，`dbFailed` 被置位，于是**磁盘缓存永远打不开**：刷新后云端语音全部重新请求，
 * "清空缓存"也只清得掉内存里那一份（用户感觉更慢、还可能多花钱）。
 *
 * 现在不传版本号：库存在就按它当前版本打开（ttsCache 由 store.js 的升级逻辑建好），
 * 库不存在就新建 v1（onupgradeneeded 里补上 ttsCache 表）。
 * @returns {Promise<IDBDatabase|null>} 打不开时返回 null（表示不可用，静默降级）
 */
function openDB() {
  if (db) return Promise.resolve(db);
  if (dbFailed) return Promise.resolve(null);
  if (typeof indexedDB === 'undefined') { dbFailed = true; return Promise.resolve(null); }
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME);
    } catch (e) {
      dbFailed = true;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(TTS_STORE)) {
        const store = d.createObjectStore(TTS_STORE, { keyPath: 'key' });
        store.createIndex('at', 'at', { unique: false });
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      // 极端情况：库里没有这张表（比如这个库是被别的程序建的）。
      // 这里既不能建表（要升版本，会和 store.js 抢版本号），也不能用，
      // 就老老实实当"磁盘缓存不可用"，只走内存缓存 —— 语音照常播，绝不报错。
      if (!d.objectStoreNames.contains(TTS_STORE)) {
        try { d.close(); } catch (e) { /* 忽略 */ }
        dbFailed = true;
        resolve(null);
        return;
      }
      db = d;
      db.onversionchange = () => { try { db.close(); } catch (e) { /* 忽略 */ } db = null; };
      resolve(db);
    };
    req.onerror = () => { dbFailed = true; resolve(null); };
    req.onblocked = () => resolve(null);
  });
}

/**
 * 读取缓存音频。
 * @param {string} key 缓存 key
 * @returns {Promise<Blob|null>} 命中返回音频 Blob
 */
async function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  try {
    const d = await openDB();
    if (!d) return null;
    const tx = d.transaction(TTS_STORE, 'readonly');
    const row = await reqToPromise(tx.objectStore(TTS_STORE).get(key));
    if (row && row.blob) {
      touchMem(key, row.blob);
      return row.blob;
    }
  } catch (e) { /* 缓存读取失败不影响播放 */ }
  return null;
}

/** 写入内存 LRU（超出上限淘汰最旧） */
function touchMem(key, blob) {
  if (memCache.has(key)) memCache.delete(key);
  memCache.set(key, blob);
  while (memCache.size > AUDIO_MEM_MAX) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
}

/**
 * 等待一个读写事务提交（部分实现不派发 oncomplete，用 Promise 形式兜底）。
 * @param {IDBTransaction} tx 事务
 * @returns {Promise<void>} 事务结束（成功或失败）后 resolve
 */
function txDone(tx) {
  return new Promise((resolve) => {
    if (!tx) { resolve(); return; }
    try {
      if (typeof tx.done !== 'undefined') tx.done.then(() => resolve(), () => resolve());
    } catch (e) { /* 忽略 */ }
    try {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (e) { resolve(); }
  });
}

/**
 * 淘汰超出上限的旧记录（按 at 升序删最旧的若干条）。
 * @param {IDBDatabase} d 数据库
 * @returns {Promise<void>}
 */
async function evict(d) {
  try {
    if (!d.objectStoreNames.contains(TTS_STORE)) return;
    const tx = d.transaction(TTS_STORE, 'readwrite');
    const store = tx.objectStore(TTS_STORE);
    const count = Number(await reqToPromise(store.count())) || 0;
    let toDrop = count - CACHE_MAX;
    if (toDrop <= 0) return;
    // 优先用 at 索引按时间升序取最旧的；索引缺失时（旧库）退化为按主键顺序
    const idx = (() => { try { return store.index('at'); } catch (e) { return null; } })();
    await new Promise((resolve) => {
      let cur;
      try {
        cur = idx ? idx.openCursor() : store.openCursor();
      } catch (e) {
        resolve();
        return;
      }
      if (!cur) { resolve(); return; }
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || toDrop <= 0) { resolve(); return; }
        try { store.delete(c.primaryKey); } catch (e) { /* 忽略单条删除失败 */ }
        toDrop--;
        try { c.continue(); } catch (e) { resolve(); }
      };
      cur.onerror = () => resolve();
    });
  } catch (e) { /* 淘汰失败不影响播放 */ }
}

/**
 * 写入缓存（内存 + IndexedDB），并保证落盘条数不超过 200（超出按最旧淘汰）。
 * @param {string} key 缓存 key
 * @param {Blob} blob 音频
 * @returns {Promise<void>}
 */
async function cachePut(key, blob) {
  touchMem(key, blob);
  try {
    const d = await openDB();
    if (!d) return;
    const tx = d.transaction(TTS_STORE, 'readwrite');
    tx.objectStore(TTS_STORE).put({ key, blob, at: Date.now(), size: blob && blob.size ? blob.size : 0 });
    // 等写入提交后再淘汰，保证 count() 能看到这条写入（超限时立即删够，不会越积越多）
    await txDone(tx);
    await evict(d);
  } catch (e) { /* 缓存写入失败不影响播放 */ }
}

/**
 * 统计缓存条数（内存 + IndexedDB 去重）。
 * @returns {Promise<number>} 条数
 */
/* =====================================================================
   4. 音色列表：getVoices() 首次可能为空，必须等 onvoiceschanged
   ===================================================================== */

/** @type {SpeechSynthesisVoice[]} 音色列表缓存 */
let voiceList = [];
/** 音色加载完成的 promise（speaker.voicesReady() 用它等待） */
let voicesReadyResolve = null;
const voicesReadyPromise = new Promise((resolve) => { voicesReadyResolve = resolve; });
let voicesSettled = false;

/** 重新读取系统音色 */
function refreshVoices() {
  if (!canSpeak) {
    if (!voicesSettled) { voicesSettled = true; if (voicesReadyResolve) voicesReadyResolve([]); }
    return [];
  }
  try {
    const list = globalThis.speechSynthesis.getVoices();
    if (list && list.length) {
      voiceList = Array.prototype.slice.call(list);
      if (!voicesSettled) { voicesSettled = true; if (voicesReadyResolve) voicesReadyResolve(voiceList); }
    }
  } catch (e) { /* 忽略：某些环境 getVoices 会抛错 */ }
  return voiceList;
}

/** 首次加载：挂 onvoiceschanged + 几次轮询兜底（部分浏览器不触发该事件） */
function initVoices() {
  if (!canSpeak) return;
  try {
    if (typeof globalThis.speechSynthesis.addEventListener === 'function') {
      globalThis.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    }
    globalThis.speechSynthesis.onvoiceschanged = refreshVoices;
  } catch (e) { /* 忽略 */ }
  refreshVoices();
  // getVoices() 是异步的：首次常常是空数组，稍后重试几次
  [0, 120, 400, 1000, 2500].forEach((ms) => {
    setTimeout(() => {
      refreshVoices();
      // 触发一次"空读"可促使部分浏览器开始加载音色表
      try { globalThis.speechSynthesis.getVoices(); } catch (e) { /* 忽略 */ }
      if (!voicesSettled && ms === 2500) { voicesSettled = true; if (voicesReadyResolve) voicesReadyResolve(voiceList); }
    }, ms);
  });
}

/**
 * 按 voiceId 匹配系统音色：先匹配 voiceURI，再匹配 name，最后按 lang 兜底。
 * @param {string} voiceId 角色卡里的 voiceId
 * @returns {SpeechSynthesisVoice|null} 匹配到的音色
 */
function findVoice(voiceId) {
  if (!canSpeak) return null;
  if (!voiceList.length) refreshVoices();
  const id = String(voiceId || '').trim();
  if (!id) return null;
  const lower = id.toLowerCase();
  let hit = voiceList.find((v) => v && v.voiceURI === id);
  if (!hit) hit = voiceList.find((v) => v && v.name === id);
  if (!hit) hit = voiceList.find((v) => v && String(v.name).toLowerCase() === lower);
  if (!hit) hit = voiceList.find((v) => v && String(v.voiceURI).toLowerCase().indexOf(lower) >= 0);
  return hit || null;
}

/** 取一个中文默认音色（找不到则返回 null，交给浏览器默认） */
function pickDefaultVoice() {
  const zh = voiceList.filter((v) => v && String(v.lang || '').toLowerCase().indexOf('zh') === 0);
  const pool = zh.length ? zh : voiceList;
  return pool.length ? pool[0] : null;
}

/* =====================================================================
   5. Web Audio：AudioContext / AnalyserNode（供云播音与口型动画使用）
   ===================================================================== */

/** @type {AudioContext|null} */
let audioCtx = null;
/** @type {AnalyserNode|null} */
let analyserNode = null;
/** @type {GainNode|null} */
let gainNode = null;
/** 正在播放的云音频源：id → AudioBufferSourceNode */
const activeSources = new Map();
let sourceSeq = 0;
/** 播放期间临时持有的 object URL（播放结束回收） */
const activeUrls = new Set();

/** 浏览器是否具备 Web Audio */
function hasAudioContext() {
  return typeof globalThis !== 'undefined'
    && (typeof globalThis.AudioContext !== 'undefined' || typeof globalThis.webkitAudioContext !== 'undefined');
}

/** 取得（必要时创建）AudioContext，并接好 analyser → gain → destination */
function ensureAudio() {
  if (audioCtx) return audioCtx;
  if (!hasAudioContext()) return null;
  try {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    audioCtx = new Ctor();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1;
    analyserNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);
  } catch (e) {
    audioCtx = null;
    analyserNode = null;
    gainNode = null;
  }
  return audioCtx;
}

/* =====================================================================
   6. 播放实现：webspeech 与 cloud
   ===================================================================== */

/**
 * 估算 webspeech 的最长播放时长（看门狗用）：text.length * 220ms / rate + 1500ms。
 * @param {number} len 文本长度
 * @param {number} rate 语速
 * @returns {number} 毫秒
 */
function watchdogMs(len, rate) {
  const r = clampNum(rate, 0.5, 2, 1);
  const n = Number(len) > 0 ? Number(len) : 0;
  return Math.max(2000, Math.round((n * 220) / r + 1500));
}

/**
 * 用浏览器内置语音合成朗读一段文本。
 * 看门狗兜底：onend 不触发时强制 resolve 并 cancel()，避免队列永久卡住。
 * @param {string} text 文本
 * @param {object} cfg VoiceConfig
 * @param {AbortSignal} [signal] 打断信号
 * @returns {Promise<void>} 播放结束（或被打断/超时）后 resolve，永不 reject
 */
function speakWebSpeech(text, cfg, signal) {
  return new Promise((resolve) => {
    if (!canSpeak) { resolve(); return; }
    const body = String(text || '').slice(0, MAX_UTTERANCE_CHARS);
    if (!body.trim()) { resolve(); return; }

    // 注意：钩子在 Promise 执行器开头取快照，避免 TDZ / 被后续调用改写
    const onStarted = hookStart;
    const onFailed = hookError;
    let done = false;
    let timer = null;
    let u = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (e) { /* 忽略 */ } }
      resolve();
    };
    const hardStop = () => {
      try { globalThis.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
      finish();
    };
    const onAbort = () => hardStop();

    try {
      u = new globalThis.SpeechSynthesisUtterance(body);
      const voice = findVoice(cfg.voiceId) || pickDefaultVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang || 'zh-CN'; } else { u.lang = 'zh-CN'; }
      u.rate = clampNum(cfg.rate, 0.5, 2, 1);
      u.pitch = clampNum(cfg.pitch, 0.5, 2, 1);
      u.volume = 1;
      u.onstart = () => { if (onStarted) { try { onStarted(); } catch (e) { /* 忽略 */ } } };
      u.onend = finish;
      u.onerror = (e) => {
        // interrupted / canceled 属于"被打断"，视为正常结束
        const err = e && e.error;
        if (err && err !== 'interrupted' && err !== 'canceled') {
          if (onFailed) { try { onFailed(new Error('语音合成失败：' + err)); } catch (e2) { /* 忽略 */ } }
        }
        finish();
      };
    } catch (e) {
      if (onFailed) { try { onFailed(e); } catch (e2) { /* 忽略 */ } }
      finish();
      return;
    }

    if (signal) {
      if (signal.aborted) { finish(); return; }
      try { signal.addEventListener('abort', onAbort); } catch (e) { /* 忽略 */ }
    }

    // 看门狗：Chrome 的 onend 有时不触发
    timer = setTimeout(() => {
      try { globalThis.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
      finish();
    }, watchdogMs(body.length, cfg.rate));

    try {
      globalThis.speechSynthesis.speak(u);
      if (globalThis.speechSynthesis.paused) globalThis.speechSynthesis.resume();
    } catch (e) {
      if (onFailed) { try { onFailed(e); } catch (e2) { /* 忽略 */ } }
      finish();
    }
  });
}

/* 播放生命周期钩子（由 speak() 注入，供 SpeechQueue / UI 观察） */
let hookStart = null;
let hookError = null;
let hookEnd = null;

/**
 * 云端合成：请求 OpenAI 兼容 /audio/speech（或 /api/tts 代理），返回音频 Blob。
 *
 * 代理模式必须把**所选供应商与地址**一起交给服务器：`server.mjs` 的 /api/tts 支持
 * `provider` / `baseUrl` / `keySlot`，不送的话它只会用默认的 openai 上游，
 * 于是"设置里选了 Qwen（或填了自建地址）"在代理模式下会被悄悄改成 OpenAI。
 *
 * @param {string} text 文本
 * @param {object} cfg VoiceConfig
 * @param {AbortSignal} [signal] 打断信号
 * @returns {Promise<Blob>} 音频二进制
 */
async function fetchCloudAudio(text, cfg, signal) {
  const c = cloudConfig();
  const voice = String(cfg.voiceId || '').trim() || DEFAULT_CLOUD_VOICE;
  const speed = clampNum(cfg.rate, 0.5, 2, 1);

  let url;
  let headers = { 'Content-Type': 'application/json' };
  let body;
  if (c.useProxy) {
    // 走服务器代理：由 server.mjs 注入密钥，客户端不持有密钥
    url = '/api/tts';
    body = { text, voice, model: c.model, rate: speed, provider: c.provider };
    // 只有用户确实配了地址才覆盖服务端默认值（custom / 自建反代就靠这一句）
    if (c.overrideBaseUrl) body.baseUrl = c.overrideBaseUrl;
    if (c.proxyToken) headers['X-Aichat-Token'] = c.proxyToken;
  } else {
    // 直连模式：先做两个前置校验，把"配错了"讲清楚，而不是让上游甩一个 401/404 回来
    if (!c.baseUrl) {
      throw new Error(`「${c.label}」还没有配置语音接口地址，请在「设置 → 语音」里填写后再试`);
    }
    if (c.needKey && !c.apiKey) {
      throw new Error(`还没有为「${c.label}」配置 API Key：请在「设置 → 模型」里选择该供应商并填入密钥`);
    }
    const base = c.baseUrl.replace(/\/+$/, '');
    url = /\/audio\/speech$/.test(base) ? base : base + '/audio/speech';
    if (c.apiKey) headers.Authorization = 'Bearer ' + c.apiKey;
    body = { model: c.model, input: text, voice, speed };
  }

  // 云端合成也要有超时：供应商不返回时不能一直干等（用户只能按"停止"才能解脱）。
  // 15s 足够合成一整段（长句也就几秒），超时后抛错 → speaker.speak 会按既有策略降级/收尾。
  let sig = signal || null;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    sig = combineSignals(sig, AbortSignal.timeout(15000));
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: sig || undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 120); } catch (e) { /* 忽略 */ }
    throw new Error('TTS ' + res.status + (detail ? ' ' + detail : ''));
  }
  const blob = await res.blob();
  if (!blob || !blob.size) throw new Error('TTS 返回空音频');
  return blob;
}

/**
 * 兼容两代 decodeAudioData 签名（回调式 / Promise 式）。
 * @param {AudioContext} ctx 音频上下文
 * @param {ArrayBuffer} arr 音频数据
 * @returns {Promise<AudioBuffer>} 解码后的音频缓冲
 */
function decodeAudio(ctx, arr) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const ok = (b) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(b); } };
    const bad = (e) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(e || new Error('音频解码失败')); } };
    try {
      const p = ctx.decodeAudioData(arr, ok, bad);
      if (p && typeof p.then === 'function') p.then(ok, bad);
    } catch (e) {
      bad(e);
    }
    // 坏数据 / 极端情况下 decodeAudioData 可能既不回调也不 resolve：超时后 reject，
    // playBlob 的外层 catch 会退到 <audio> 兜底 —— 总比整个朗读链永久挂着好。
    timer = setTimeout(() => bad(new Error('音频解码超时')), 8000);
  });
}

/**
 * "这台设备放不出声"的通知（10s 内只报一次，避免每句都弹）。
 * 由 speaker.onPlaybackSkipped 接收 —— UI 拿它提示用户"当前设备无法播放语音"，
 * 而不是让朗读悄无声息地跳过去（用户会以为功能坏了）。
 * @param {string} reason 原因标记：stalled-clock（音频时钟不走）/ no-metadata（<audio> 拿不到时长）
 * @returns {void}
 */
let lastSkipNoticeAt = 0;
function notifyPlaybackSkipped(reason) {
  const now = Date.now();
  if (now - lastSkipNoticeAt < 10000) return;
  lastSkipNoticeAt = now;
  try {
    if (typeof speaker !== 'undefined' && speaker && typeof speaker.onPlaybackSkipped === 'function') {
      speaker.onPlaybackSkipped(String(reason || 'unknown'));
    }
  } catch (e) { /* 通知失败不影响播放流程 */ }
}

/**
 * 播放一段音频 Blob（优先 Web Audio + AnalyserNode；无 AudioContext 时退化为 <audio>）。
 *
 * **两条路径都带看门狗**（踩过的坑）：有些环境里 `AudioContext.state` 是 `running`、
 * `currentTime` 却几乎不推进（没有音频输出设备 / 远程桌面 / 虚拟机），此时 `src.onended`
 * 永不触发；`<audio>` 也可能"开始播放但永不结束"。没有兜底的话这个 Promise 会永久 pending，
 * `speakText()` 不返回、朗读队列卡在第一句不再往下读。
 * 兜底策略：①按音频时长 + 余量定时 resolve；②音频时钟 600ms 内几乎不走就认为设备不可用，直接略过。
 *
 * @param {Blob} blob 音频
 * @param {AbortSignal} [signal] 打断信号
 * @param {() => boolean} [isStale] 返回 true 表示播放已无需继续（期间被 stop）
 * @returns {Promise<void>} 播放结束、被打断或超时后 resolve
 */
async function playBlob(blob, signal, isStale) {
  const ctx = ensureAudio();
  if (ctx) {
    try {
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* 忽略 */ } }
      const arr = await blob.arrayBuffer();
      const buffer = await decodeAudio(ctx, arr);
      const id = ++sourceSeq;
      if (isStale && isStale()) return;
      await new Promise((resolve) => {
        let done = false;
        let src = null;
        let guard = null;
        let clockPoll = null;
        const clearGuards = () => {
          if (guard) { clearTimeout(guard); guard = null; }
          if (clockPoll) { clearInterval(clockPoll); clockPoll = null; }
        };
        const finish = () => {
          if (done) return;
          done = true;
          clearGuards();
          activeSources.delete(id);
          resolve();
        };
        try {
          src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(analyserNode || gainNode || ctx.destination);
          src.onended = finish;
          activeSources.set(id, src);
          if (signal) {
            const onAbort = () => { try { src.stop(); } catch (e) { /* 忽略 */ } finish(); };
            if (signal.aborted) { onAbort(); return; }
            try { signal.addEventListener('abort', onAbort, { once: true }); } catch (e) { /* 忽略 */ }
          }
          src.start(0);
          // ① 按时长兜底（正常播完 ≈ buffer.duration，留 600ms 余量）
          guard = setTimeout(finish, Math.max(800, Math.round((buffer.duration || 0) * 1000)) + 600);
          // ② 音频时钟不走 → 设备其实没在放，直接略过（否则 onended 永远等不到）
          // 窗口取 1.2s：足够慢启动的设备（蓝牙耳机等）把时钟走起来，又不会让人等太久
          const t0 = ctx.currentTime;
          const w0 = Date.now();
          clockPoll = setInterval(() => {
            if (done) return;
            if (Date.now() - w0 > 1200 && ctx.currentTime - t0 < 0.05) {
              notifyPlaybackSkipped('stalled-clock');
              finish();
            }
          }, 200);
        } catch (e) {
          finish();
        }
      });
      return;
    } catch (e) {
      // 取数据 / 解码失败或超时 → 落到 <audio> 兜底
    }
  }
  // 兜底：<audio> 元素播放（无 AudioContext 的环境）
  await new Promise((resolve) => {
    let url = null;
    let audio = null;
    let done = false;
    let guard = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (guard) { clearTimeout(guard); guard = null; }
      if (audio) { try { audio.pause(); } catch (e) { /* 忽略 */ } }
      if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } activeUrls.delete(url); }
      resolve();
    };
    try {
      url = URL.createObjectURL(blob);
      activeUrls.add(url);
      audio = new Audio(url);
      audio.onended = finish;
      audio.onerror = finish;
      // 看门狗：硬上限兜住"元数据都拿不到"，拿到时长后收紧到 时长 + 800ms
      const armGuard = (ms, reason) => {
        if (guard) clearTimeout(guard);
        guard = setTimeout(() => { if (reason) notifyPlaybackSkipped(reason); finish(); }, ms);
      };
      armGuard(30000, 'no-metadata');
      audio.onloadedmetadata = () => {
        const dur = Number(audio && audio.duration);
        if (!done && isFinite(dur) && dur > 0) armGuard(Math.round(dur * 1000) + 800, '');
      };
      if (signal) {
        if (signal.aborted) { finish(); return; }
        try { signal.addEventListener('abort', finish, { once: true }); } catch (e) { /* 忽略 */ }
      }
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(finish);
    } catch (e) {
      finish();
    }
  });
}

/* =====================================================================
   7. speaker：对外统一的说话者
   ===================================================================== */

/** 当前正在进行的内部打断控制器（stop() 用它让 speak() 立刻 resolve） */
let activeAbort = null;

/**
 * 合并"外部 signal"和"内部 stop 控制器"，得到真正传给 fetch / 播放的打断信号。
 * @param {AbortSignal|null} a 外部信号
 * @param {AbortSignal|null} b 内部信号
 * @returns {AbortSignal|null} 合并后的信号
 */
function combineSignals(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    try { return AbortSignal.any([a, b]); } catch (e) { /* 落到手动桥接 */ }
  }
  const ctrl = new AbortController();
  const relay = () => { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
  try {
    if (a.aborted || b.aborted) relay();
    else {
      a.addEventListener('abort', relay, { once: true });
      b.addEventListener('abort', relay, { once: true });
    }
  } catch (e) { /* 忽略 */ }
  return ctrl.signal;
}

/**
 * 用云端音频朗读；任何失败都会抛出，由 speak() 静默降级到 webspeech。
 * @param {string} text 文本
 * @param {object} cfg VoiceConfig
 * @param {AbortSignal} signal 打断信号
 * @returns {Promise<void>}
 */
async function speakCloud(text, cfg, signal) {
  const key = cacheKey(text, { ...cloudConfig(), voiceId: cfg.voiceId, rate: cfg.rate, pitch: cfg.pitch });
  let blob = cfg.cache === false ? null : await cacheGet(key);
  if (!blob) {
    blob = await gate(() => fetchCloudAudio(text, cfg, signal));
    if (cfg.cache !== false) {
      synthLog.add(key);
      await cachePut(key, blob);
    }
  } else {
    synthLog.add(key);
  }
  if (signal && signal.aborted) return;
  await playBlob(blob, signal, () => (signal ? signal.aborted : false));
}

/**
 * @typedef {object} Speaker
 * @property {(text: string, cfg: object, signal?: AbortSignal) => Promise<void>} speak
 * @property {(sentences: string[]|string, cfg: object) => Promise<void>} [warm]
 * @property {() => void} stop
 * @property {() => void} pause
 * @property {() => void} resume
 * @property {(lang?: string) => Array<{id: string, name: string, lang: string, local: boolean}>} listVoices
 * @property {() => Promise<void>} unlock
 * @property {(text: string, cfg: object) => Promise<void>} test
 */

export const speaker = {
  /**
   * 设备放不出声时的回调（可选）：`(reason) => void`，reason 见 notifyPlaybackSkipped()。
   * UI 挂上它就能提示"当前设备无法播放语音"，而不是静默跳过。
   * @type {((reason: string) => void)|null}
   */
  onPlaybackSkipped: null,

  /**
   * 朗读一段文本，返回的 Promise 在播放结束后 resolve（永不 reject）。
   * cloud 失败会自动静默降级到浏览器内置；内置也不可用时直接 resolve（静音）。
   * @param {string} text 文本
   * @param {object} cfg VoiceConfig
   * @param {AbortSignal} [signal] 打断信号
   * @returns {Promise<void>}
   */
  async speak(text, cfg, signal) {
    const body = String(text == null ? '' : text).trim();
    const conf = cfg || VOICE_DEFAULTS;
    if (!body) return;
    if (signal && signal.aborted) return;

    // 记录"这段已经合成过"（webspeech 不缓存音频，但避免重复日志/重复请求）
    const key = cacheKey(body, { provider: conf.provider, voiceId: conf.voiceId, rate: conf.rate, pitch: conf.pitch });
    synthLog.add(key);

    hookStart = typeof conf.onStart === 'function' ? conf.onStart : null;
    hookError = typeof conf.onError === 'function' ? conf.onError : null;

    // 内部打断控制器：speaker.stop() 即使拿不到外部 signal，也能让本次播放立刻结束
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeAbort = ctrl;
    const sig = combineSignals(signal, ctrl ? ctrl.signal : null);

    try {
      if (conf.provider === 'cloud') {
        try {
          // 确保设置已加载（首次调用时 store.js 的 import 可能还没完成）
          await ensureSettings();
          await speakCloud(body, conf, sig);
          return;
        } catch (e) {
          // 云端失败：静默降级，绝不阻塞对话
          if (hookError) { try { hookError(e); } catch (err) { /* 忽略 */ } }
          if (sig && sig.aborted) return;
          try {
            await speakWebSpeech(body, conf, sig);
            return;
          } catch (e2) {
            return; // 静音降级
          }
        }
      }
      try {
        await speakWebSpeech(body, conf, sig);
      } catch (e) {
        if (hookError) { try { hookError(e); } catch (err) { /* 忽略 */ } }
      }
    } finally {
      if (activeAbort === ctrl) activeAbort = null;
    }
  },

  /**
   * 预取：提前把文本送去合成（云端会进缓存与内存，webspeech 只记标记）。
   * 失败一律静默忽略 —— 预取永远不该影响播放。
   * @param {string[]|string} sentences 句子或句子数组
   * @param {object} cfg VoiceConfig
   * @returns {Promise<void>}
   */
  async warm(sentences, cfg) {
    const conf = cfg || VOICE_DEFAULTS;
    if (conf.provider !== 'cloud' || conf.cache === false) return;
    const list = Array.isArray(sentences) ? sentences : [sentences];
    for (const raw of list) {
      const text = String(raw == null ? '' : raw).trim();
      if (!text) continue;
      const key = cacheKey(text, { provider: 'cloud', voiceId: conf.voiceId, rate: conf.rate, pitch: conf.pitch });
      if (synthLog.has(key)) continue; // 已在合成/已合成过，不重复打接口
      synthLog.add(key);
      try {
        const cached = await cacheGet(key);
        if (cached) continue;
        const blob = await gate(() => fetchCloudAudio(text, conf));
        await cachePut(key, blob);
      } catch (e) {
        synthLog.delete(key); // 预取失败：放开标记，真正播放时会重试或降级
      }
    }
  },

  /**
   * 立即停止当前播放（打断 / barge-in）。同时清空 webspeech 队列与云音频源。
   * @returns {void}
   */
  stop() {
    try { if (canSpeak) globalThis.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    // 停掉所有正在播放的云音频
    activeSources.forEach((src) => { try { src.stop(); } catch (e) { /* 忽略 */ } });
    activeSources.clear();
    activeUrls.forEach((url) => { try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } });
    activeUrls.clear();
    if (activeAbort) { try { activeAbort.abort(); } catch (e) { /* 忽略 */ } activeAbort = null; }
  },

  /**
   * 暂停播放：webspeech 用原生 pause()，cloud 用 AudioContext.suspend()。
   * @returns {void}
   */
  pause() {
    try { if (canSpeak) globalThis.speechSynthesis.pause(); } catch (e) { /* 忽略 */ }
    try { if (audioCtx && audioCtx.state === 'running') audioCtx.suspend(); } catch (e) { /* 忽略 */ }
  },

  /**
   * 继续播放。
   * @returns {void}
   */
  resume() {
    try { if (canSpeak && globalThis.speechSynthesis.paused) globalThis.speechSynthesis.resume(); } catch (e) { /* 忽略 */ }
    try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { /* 忽略 */ }
  },

  /**
   * 列出可用音色（默认只列中文；中文为空时返回全部）。
   * getVoices() 首次可能返回空数组：此时返回当前（可能为空的）列表，
   * 并在后台挂 onvoiceschanged，之后可用 speaker.voicesReady() 等待加载完成。
   * @param {string} [lang='zh'] 语言前缀
   * @returns {Array<{ id: string, name: string, lang: string, local: boolean }>}
   */
  listVoices(lang = 'zh') {
    if (!canSpeak) return [];
    if (!voiceList.length) refreshVoices();
    const prefix = String(lang || '').toLowerCase();
    const all = voiceList.slice();
    let pool = prefix ? all.filter((v) => v && String(v.lang || '').toLowerCase().indexOf(prefix) === 0) : all;
    if (!pool.length) pool = all;
    return pool.map((v) => ({
      id: v.voiceURI || v.name || '',
      name: v.name || v.voiceURI || '',
      lang: v.lang || '',
      local: v.localService !== false,
    }));
  },

  /**
   * 等待系统音色加载完成（getVoices() 是异步的）。
   * @returns {Promise<Array<{ id: string, name: string, lang: string, local: boolean }>>} 音色列表
   */
  voicesReady() {
    return voicesReadyPromise.then(() => speaker.listVoices('zh')).catch(() => []);
  },

  /**
   * 在用户手势里解锁自动播放策略：创建/恢复 AudioContext 并播放 0.05 秒静音缓冲。幂等。
   * @returns {Promise<void>}
   */
  async unlock() {
    try {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* 忽略 */ } }
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.05)), ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gainNode || ctx.destination);
      try { src.start(0); } catch (e) { /* 忽略 */ }
    } catch (e) {
      // 无 AudioContext 的环境：静默忽略
    }
  },

  /**
   * 试听（设置面板用）。等价于 speak()，但会强制走一次 unlock。
   * @param {string} text 文本
   * @param {object} cfg VoiceConfig
   * @returns {Promise<void>}
   */
  async test(text, cfg) {
    try {
      await speaker.unlock();
      await speaker.speak(text, cfg);
    } catch (e) {
      // 试听失败不抛错
    }
  },

  /**
   * 暴露音频上下文与分析节点（供口型/表情动画使用）。
   * @returns {{ ctx: AudioContext, analyser: AnalyserNode }|null} 不可用时返回 null
   */
  getAnalyser() {
    try {
      const ctx = ensureAudio();
      if (!ctx || !analyserNode) return null;
      return { ctx, analyser: analyserNode };
    } catch (e) {
      return null;
    }
  },

  /** @returns {boolean} 当前是否正在播放（尽力而为） */
  get speaking() {
    try {
      if (activeSources.size) return true;
      if (canSpeak && globalThis.speechSynthesis.speaking) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  },
};

/* =====================================================================
   8. SpeechQueue：串行播放 + 预取 + 代际号打断
   ===================================================================== */

export class SpeechQueue {
  /**
   * @param {Speaker} spk 说话者（通常是 speaker）
   * @param {object} cfg VoiceConfig
   * @param {{ onSentence?: (text: string, i: number) => void, onStart?: () => void,
   *           onEnd?: () => void, onError?: (e: any) => void }} [handlers] 回调
   * @param {(text: string) => void} [prefetch] 自定义预取函数，默认用 spk.warm
   */
  constructor(spk, cfg, handlers = {}, prefetch = null) {
    this._spk = spk || speaker;
    this._cfg = cfg || VOICE_DEFAULTS;
    this._h = handlers || {};
    this._prefetch = typeof prefetch === 'function'
      ? prefetch
      : (text) => { try { if (this._spk && typeof this._spk.warm === 'function') void this._spk.warm(text, this._cfg); } catch (e) { /* 忽略 */ } };
    /** @type {string[]} 待播句子 */
    this._q = [];
    /** 是否有 pump 循环在跑 */
    this._busy = false;
    /** 代际号：stop() 递增，旧回调/carry-over 自动失效 */
    this._gen = 0;
    /** 已交给播放的句序号 */
    this._i = 0;
    /** idle() 的等待者 */
    this._idleResolvers = [];
  }

  /**
   * 追加句子并立刻开始播放（播第 1 句时预取后 2 句）。
   * @param {string[]} sentences 句子数组
   * @returns {void}
   */
  push(sentences) {
    if (!sentences || !sentences.length) return;
    const list = Array.isArray(sentences) ? sentences : [sentences];
    const clean = list.filter((s) => typeof s === 'string' && s.trim());
    if (!clean.length) return;
    this._q.push(...clean);
    this._warmAhead();
    void this._pump();
  }

  /**
   * 打断：清空队列、递增代际号（使正在 await 的旧 pump 失效）、停止播放。
   * @returns {void}
   */
  stop() {
    this._gen++;
    this._q = [];
    this._busy = false;
    try { if (this._spk && typeof this._spk.stop === 'function') this._spk.stop(); } catch (e) { /* 忽略 */ }
    this._settleIdle();
  }

  /** @returns {boolean} 是否正在播放（队列正在串行朗读） */
  get speaking() {
    return this._busy;
  }

  /** @returns {number} 待播句数 */
  get pending() {
    return this._q.length;
  }

  /**
   * 返回一个在"队列播完"后 resolve 的 Promise（用于 UI 收尾，如去掉气泡高亮）。
   * @returns {Promise<void>}
   */
  idle() {
    if (!this._busy && !this._q.length) return Promise.resolve();
    return new Promise((resolve) => {
      this._idleResolvers.push(resolve);
    });
  }

  /** 预取队列前 2 句 */
  _warmAhead() {
    try {
      this._q.slice(0, 2).forEach((s) => this._prefetch(s));
    } catch (e) { /* 预取失败静默 */ }
  }

  /** 通知 idle() 的等待者 */
  _settleIdle() {
    const list = this._idleResolvers;
    this._idleResolvers = [];
    if (list) list.forEach((fn) => { try { fn(); } catch (e) { /* 忽略 */ } });
  }

  /** 串行播放循环 */
  async _pump() {
    if (this._busy) return;
    this._busy = true;
    const my = this._gen;
    let started = false;
    while (this._q.length && my === this._gen) {
      const text = this._q.shift();
      this._warmAhead();
      const i = this._i++;
      // onStart 总是先于第一句的 onSentence 触发（UI 用它记录"首次出声"）
      if (!started) {
        started = true;
        if (this._h.onStart) { try { this._h.onStart(); } catch (e) { /* 忽略 */ } }
      }
      if (this._h.onSentence) { try { this._h.onSentence(text, i); } catch (e) { /* 回调异常不影响队列 */ } }
      try {
        await this._spk.speak(text, this._cfg);
      } catch (e) {
        // 单句失败：静默跳过，继续下一句
        if (this._h.onError) { try { this._h.onError(e); } catch (err) { /* 忽略 */ } }
      }
    }
    // 只有"当前代"的 pump 才能复位忙标志，避免打断后新一轮被旧的 finally 误清
    if (my === this._gen) {
      this._busy = false;
      if (started && this._h.onEnd) { try { this._h.onEnd(); } catch (e) { /* 忽略 */ } }
      this._settleIdle();
    }
  }
}

/* =====================================================================
   9. 便捷 API（契约 3.12 的其余导出）
   ===================================================================== */

/**
 * 单句朗读（不排队）。
 * @param {string} text 文本
 * @param {object} cfg VoiceConfig
 * @returns {Promise<void>} 播放结束后 resolve
 */
export function speakText(text, cfg) {
  return speaker.speak(text, cfg).catch(() => {});
}

/**
 * 立刻停止所有朗读。
 * @returns {void}
 */
export function stopSpeaking() {
  try { speaker.stop(); } catch (e) { /* 忽略 */ }
}

/**
 * 检测语音能力。
 * @returns {{ tts: boolean, stt: boolean }} tts = 是否支持语音合成；stt = 是否支持语音识别
 */
export function voiceAvailable() {
  let tts = false;
  let stt = false;
  try { tts = canSpeak; } catch (e) { tts = false; }
  try {
    stt = typeof globalThis !== 'undefined'
      && (typeof globalThis.SpeechRecognition !== 'undefined' || typeof globalThis.webkitSpeechRecognition !== 'undefined');
  } catch (e) { stt = false; }
  if (!stt && sttMod && typeof sttMod.sttAvailable === 'function') {
    try { stt = sttMod.sttAvailable(); } catch (e) { /* 忽略 */ }
  }
  return { tts: !!tts, stt: !!stt };
}

/**
 * 清空语音缓存（内存 + IndexedDB）。
 * @returns {Promise<number>} 被清理的条数
 */
export async function clearVoiceCache() {
  let n = 0;
  try {
    const d = await openDB();
    if (d) {
      const tx = d.transaction(TTS_STORE, 'readwrite');
      n = Number(await reqToPromise(tx.objectStore(TTS_STORE).count())) || 0;
      await reqToPromise(tx.objectStore(TTS_STORE).clear());
    } else {
      n = memCache.size;
    }
  } catch (e) {
    n = n || memCache.size;
  }
  memCache.clear();
  synthLog.clear();
  return n;
}

/* =====================================================================
   10. 初始化（模块加载即执行，全部 try 包裹，任何环境都不抛错）
   ===================================================================== */

try {
  initVoices();
  // 惰性挂上 stt 模块引用（仅用于 voiceAvailable 的更精确判断）
  import('./stt.js').then((m) => { sttMod = m; }).catch(() => { /* 忽略 */ });
} catch (e) { /* 忽略：受限环境 */ }

export default speaker;
