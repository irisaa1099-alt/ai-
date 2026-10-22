import { diffChanges } from './sync.js';
/**
 * 角色运行时状态（契约 3.7）：好感度、情绪、未读、主动消息节流。
 * 存 localStorage（读写频繁、体积小），与角色卡本体（IndexedDB）分离。
 */
import { bus } from './bus.js';
import { clamp, num, isSameDay } from './util.js';
import { readRuntimeAll, writeRuntimeAll } from './store.js';

const DEFAULT_RT = {
  affinity: 20,
  updatedAt: 0,
  mood: 'neutral',
  lastChatAt: null,
  lastSeenAt: null,
  streak: 0,
  lastStreakDay: '',
  lastProactiveAt: 0,
  proactiveCount: 0,
  proactiveDay: '',
  unread: 0,
};

/**
 * 取某角色的运行时状态（不存在的字段自动补默认值）
 * @param {string} charId
 * @returns {object}
 */
/**
 * 运行时状态落盘（惰性 import core/filestore.js，避免加载期循环依赖）。
 * 不落盘的话：好感度只活在 localStorage 里，浏览器数据一被清理 / 换个浏览器打开，
 * 就会退回角色卡上的初始值 —— 这正是"重启后好感度归零"的直接原因。
 * @param {object} all
 */
function persistRuntime(changes) {
  import('./filestore.js')
    .then((m) => {
      if (m && typeof m.mirrorSettings === 'function') return m.mirrorSettings({ runtimeChanges: changes });
      return undefined;
    })
    .catch(() => {
      /* 没有本地文件服务时静默跳过（纯浏览器模式本来就没有落盘） */
    });
}

export function getRuntime(charId) {
  const all = readRuntimeAll();
  const cur = all[charId] || {};
  return { ...DEFAULT_RT, ...cur };
}

/**
 * 写入运行时状态（部分字段）
 * @param {string} charId
 * @param {object} patch
 */
export function setRuntime(charId, patch) {
  if (!charId) return { ...DEFAULT_RT };
  const all = readRuntimeAll();
  const previous = all[charId] || {};
  const next = { ...DEFAULT_RT, ...(all[charId] || {}), ...(patch || {}) };
  next.affinity = clamp(next.affinity, 0, 100);
  next.updatedAt = Math.max(Date.now(), num((all[charId] || {}).updatedAt, 0) + 1);
  all[charId] = next;
  writeRuntimeAll(all);
  persistRuntime(diffChanges(previous, next, [charId]));
  bus.emit('runtime:changed', { charId, runtime: next });
  return next;
}

/**
 * 好感度增减
 * @param {string} charId
 * @param {number} delta
 * @returns {number} 新好感度
 */
export function bumpAffinity(charId, delta) {
  const cur = getRuntime(charId);
  const next = clamp(cur.affinity + num(delta), 0, 100);
  setRuntime(charId, { affinity: next });
  return next;
}

/** 好感度文字标签 */
export function affinityLabel(v) {
  const n = clamp(v, 0, 100);
  if (n < 15) return '陌生';
  if (n < 35) return '认识';
  if (n < 55) return '熟络';
  if (n < 75) return '亲近';
  if (n < 92) return '交心';
  return '心意相通';
}

/** 好感度对应的语气提示（注入提示词，让关系有进展感） */
export function affinityTone(v) {
  const n = clamp(v, 0, 100);
  if (n < 15) return '保持礼貌的距离感，话不多，不会主动透露私事。';
  if (n < 35) return '客气但随意，会回应但不深入。';
  if (n < 55) return '像普通朋友一样自然，偶尔开个玩笑。';
  if (n < 75) return '明显亲近，会主动关心对方，愿意分享自己的事。';
  if (n < 92) return '很亲密，说话带依赖感，会惦记对方的近况。';
  return '非常深的羁绊，把对方当成最重要的人，语气温柔而笃定。';
}

/** 删除某实体的运行时状态（角色/群聊被删除后调用，否则未读数会永久残留且无法清零） */
export function dropRuntime(id) {
  if (!id) return;
  const all = readRuntimeAll();
  if (!(id in all)) return;
  delete all[id];
  writeRuntimeAll(all);
  persistRuntime([{ path: [id], remove: true }]);
  bus.emit('runtime:changed', { charId: id, runtime: null });
}

/** 标记已读 */
export function markRead(charId) {
  if (!charId) return;
  const cur = getRuntime(charId);
  const patch = { unread: 0, lastSeenAt: Date.now() };
  // 连续聊天天数
  const today = new Date().toDateString();
  if (cur.lastStreakDay !== today) {
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    patch.streak = cur.lastStreakDay === yest.toDateString() ? num(cur.streak) + 1 : 1;
    patch.lastStreakDay = today;
  }
  setRuntime(charId, patch);
}

/** 未读总数 */
export function unreadTotal() {
  const all = readRuntimeAll();
  return Object.values(all).reduce((n, r) => n + num(r?.unread), 0);
}

/** 未读数（单角色） */
export function unreadOf(charId) {
  return num(getRuntime(charId).unread);
}

/** 增加未读 */
export function addUnread(charId, n = 1) {
  const cur = getRuntime(charId);
  return setRuntime(charId, { unread: num(cur.unread) + n });
}

/** 用角色卡的初始好感度初始化（首次见面时） */
export function initCharacterRuntime(char) {
  if (!char || !char.id) return;
  const all = readRuntimeAll();
  if (all[char.id]) return getRuntime(char.id);
  all[char.id] = { ...DEFAULT_RT, affinity: clamp(num(char.affinity, 20), 0, 100), updatedAt: Date.now() };
  writeRuntimeAll(all);
  persistRuntime([{ path: [char.id], value: all[char.id] }]);
  bus.emit('runtime:changed', { charId: char.id, runtime: all[char.id] });
  return all[char.id];
}

/** 记录一次对话（更新 lastChatAt 与连续天数） */
export function touchChat(charId) {
  if (!charId) return;
  const cur = getRuntime(charId);
  const today = new Date().toDateString();
  const patch = { lastChatAt: Date.now(), lastSeenAt: Date.now() };
  if (cur.lastStreakDay !== today) {
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    patch.streak = cur.lastStreakDay === yest.toDateString() ? num(cur.streak) + 1 : 1;
    patch.lastStreakDay = today;
  }
  setRuntime(charId, patch);
}

const EMOTION_RULES = [
  { mood: 'angry', re: /(生气|愤怒|烦死|讨厌你|滚|气死|受不了|别烦|恶心|恼火)/ },
  { mood: 'sad', re: /(难过|伤心|哭|委屈|失落|孤独|寂寞|抑郁|崩溃|想死|累了|emo)/i },
  { mood: 'worried', re: /(担心|焦虑|害怕|紧张|压力|睡不着|失眠|怎么办|慌)/ },
  { mood: 'happy', re: /(开心|高兴|太好了|哈哈|嘿嘿|嘻嘻|爽|棒|爱你|谢谢|喜欢)/ },
  { mood: 'shy', re: /(害羞|不好意思|脸红|羞|别看我|讨厌啦)/ },
  { mood: 'excited', re: /(太棒了|冲|激动|期待|迫不及待|！！！|awsl)/i },
];

/**
 * 从用户文本粗略识别情绪
 * @param {string} text
 * @returns {'neutral'|'happy'|'sad'|'angry'|'worried'|'shy'|'excited'}
 */
export function detectEmotion(text) {
  const t = String(text || '');
  if (!t) return 'neutral';
  for (const rule of EMOTION_RULES) {
    if (rule.re.test(t)) return rule.mood;
  }
  return 'neutral';
}

/** 设置角色当前情绪 */
export function setMood(charId, mood) {
  return setRuntime(charId, { mood: mood || 'neutral' });
}

/** 距离某时间过了几天（无值返回 -1） */
export function daysSince(ts) {
  if (!ts) return -1;
  const diff = Date.now() - num(ts);
  if (diff < 0) return 0;
  return Math.floor(diff / 86400000);
}

/** 是否处于免打扰时段 */
export function inQuietHours(quietStart, quietEnd) {
  const h = new Date().getHours();
  const s = num(quietStart, 23);
  const e = num(quietEnd, 7);
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e; // 跨午夜
}

/** 今天是否还能发主动消息 */
export function canProactiveToday(charId, maxPerDay) {
  const rt = getRuntime(charId);
  const today = new Date().toDateString();
  if (rt.proactiveDay !== today) return true;
  return num(rt.proactiveCount) < num(maxPerDay, 2);
}

/** 记录一次主动消息 */
export function noteProactive(charId) {
  const rt = getRuntime(charId);
  const today = new Date().toDateString();
  const count = rt.proactiveDay === today ? num(rt.proactiveCount) + 1 : 1;
  return setRuntime(charId, { lastProactiveAt: Date.now(), proactiveCount: count, proactiveDay: today });
}

/** 距离天数 → 情感化描述（用于时间感知提示词） */
export function gapDescription(ts) {
  const d = daysSince(ts);
  if (d < 0) return '这是你们的第一次对话。';
  if (d === 0) return '你们今天已经聊过了。';
  if (d === 1) return '你们上次聊天是昨天。';
  if (d < 7) return `你们已经 ${d} 天没聊天了。`;
  if (d < 30) return `你们已经 ${Math.floor(d / 7)} 周没聊天了。`;
  return `你们已经 ${Math.floor(d / 30)} 个月没联系了。`;
}

export { isSameDay };
