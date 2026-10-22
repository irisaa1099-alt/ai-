/**
 * core/group.js —— 群聊引擎（"AI 导演"）
 * ---------------------------------------------------------------------------
 * 群聊和一对一私聊最大的不同：**房间里不止一个角色**。
 * 所以这个模块要解决三件事：
 *
 *   1. 谁来说（planSpeakers）
 *      · 被 @ 的角色一定先开口；
 *      · 其余名额按接话策略分配：smart（相关度 + 发言均衡）/ round（轮流）/ random（随机）；
 *      · 刚说完的人不会马上又抢一次话，避免"一个人霸屏"。
 *
 *   2. 怎么说（buildGroupMessages）
 *      · 以「这个角色」的身份装配提示词：人设 + 群聊铁律 + 群成员名单 + 最近的群聊记录；
 *      · 记录采用「名字：内容」的转写格式整段放进 system，模型不需要区分 user/assistant，
 *        既避免了"替别人说话"，又天然兼容所有供应商（含只支持 system+user 的接口）。
 *
 *   3. 一轮怎么跑（GroupRound）
 *      · 依次点名 → 流式生成 → 落库 → 间隔 → 下一位；
 *      · 支持随时打断（stop），也支持"没有人被 @ 时全体保持安静"（mention 模式）；
 *      · 全程通过 handlers 把过程吐给界面，引擎自己不碰 DOM，可在 Node 里单测。
 *
 * 依赖方向：core/group.js → { store, prompt, runtime, llm, util }，没有任何 UI 依赖。
 */

import { estimateTokens, num, clamp, sleep, truncate, safeCostWith, shuffle } from './util.js';
import { buildSystemPrompt, matchLore, summarizeIfNeeded } from './prompt.js';
import { formatRecentExperiences, visibleGroupHistory, RECENT_LIMIT } from './recent.js';
import { getRuntime, detectEmotion } from './runtime.js';
import { abortController, addUsage, chatStream, estimateCost, PROVIDERS } from './llm.js';
import {
  appendGroupMessage,
  getMemory,
  getRecentExperiences,
  listGroupMessages,
  touchGroup,
} from './store.js';

/* ================================================================== *
 * 1. 常量
 * ================================================================== */

/** 用户在群里的"发言人 id"（消息里的 speakerId 用它表示"这是用户说的"） */
export const USER_SPEAKER = 'user';

/** 群聊接话策略（与 store.js 的 GROUP_TURN_MODES 字段名一致） */
export const TURN_MODES = [
  { id: 'smart', label: '智能接话', desc: '谁最该接这句谁上：被点名的人优先，其次看话题相关度与发言均衡' },
  { id: 'round', label: '轮流发言', desc: '按群成员顺序一人一句，最稳定，适合"圆桌讨论"' },
  { id: 'random', label: '随机插话', desc: '随机挑人，群里更热闹、更容易出现意外化学反应' },
  { id: 'mention', label: '只应 @', desc: '只有被 @ 到的角色才开口，其余人安静旁听（适合你自己导演）' },
];

/** 群里一轮最多带多少条历史（超过按 token 预算再裁） */
const TRANSCRIPT_MAX_DEFAULT = 40;

/** 完整装配时，转写文本最多占输入预算的一半；整包仍须做最终预算检查。 */
const TRANSCRIPT_BUDGET_RATIO = 0.5;

/* ================================================================== *
 * 2. 纯逻辑：@ 识别 / 相关度打分 / 发言排序
 * ================================================================== */

/** 正则转义 */
function escapeRe(s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 角色显示名（空名兜底） */
export function memberName(member) {
  const n = member && member.name ? String(member.name).trim() : '';
  return n || '某位成员';
}

/** 头像字符（emoji 优先，其次名字首字） */
export function memberEmoji(member) {
  if (!member) return '🙂';
  const e = String(member.emoji || '').trim();
  if (e) return e;
  const a = String(member.avatar || '');
  if (a && !/^(data:|https?:|blob:|\/)/i.test(a)) return a;
  const arr = Array.from(String(member.name || '').trim());
  return arr[0] || '🙂';
}

/**
 * 文本里 @ 到了谁（角色 + 用户）
 * 既认「@名字」，也认直接把名字写进句子里（"阿哲你怎么看"）。
 * @param {string} text
 * @param {object[]} members 群成员角色卡
 * @param {string} [userName] 用户显示名
 * @returns {{memberIds: string[], user: boolean}}
 */
export function mentionTargets(text, members, userName) {
  const t = String(text || '');
  if (!t) return { memberIds: [], user: false };
  const hits = [];
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !m.id) continue;
    const name = String(m.name || '').trim();
    if (!name) continue;
    const at = t.search(new RegExp(`@\\s*${escapeRe(name)}`));
    const plain = t.indexOf(name);
    const pos = at >= 0 ? at : plain;
    if (pos < 0) continue;
    // @ 到的排在最前（pos 用负数偏移，保证 @ 的优先级高于纯提及）
    hits.push({ id: m.id, pos: at >= 0 ? at - 1000 : pos });
  }
  hits.sort((a, b) => a.pos - b.pos);
  const uname = String(userName || '').trim();
  const user = uname ? new RegExp(`@\\s*${escapeRe(uname)}`).test(t) : false;
  return { memberIds: hits.map((h) => h.id), user };
}

/** 取最近一条"角色发的"消息的 speakerId（判断谁刚说完） */
export function lastSpeakerId(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === 'assistant' && m.speakerId) return String(m.speakerId);
    if (m && m.role === 'user') return ''; // 用户刚说完，没有"刚发言的角色"
  }
  return '';
}

/** 最近 window 条里，某角色说了几句（用于发言均衡） */
function recentSpeechCount(history, memberId, window = 10) {
  const list = Array.isArray(history) ? history : [];
  let n = 0;
  for (const m of list.slice(-window)) {
    if (m && m.role === 'assistant' && String(m.speakerId) === String(memberId)) n++;
  }
  return n;
}

/** 从人设里抠出几个"能被话题命中"的关键词 */
function personaWords(member) {
  const p = (member && member.persona) || {};
  const raw = [member && member.job, p.personality, p.catchphrase, p.style, (member && member.tags || []).join(' ')]
    .filter(Boolean)
    .join(' ');
  return String(raw)
    .split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && w.length <= 6)
    .slice(0, 24);
}

/** 把角色卡里所有"能看出人际关系"的文字拼起来 */
function tieText(c) {
  const p = (c && c.persona) || {};
  return [
    c && c.tagline,
    c && c.group,
    (c && c.tags ? c.tags : []).join(' '),
    p.personality,
    p.relationship,
    p.world,
    p.place,
    p.values,
    p.style,
    p.catchphrase,
    (c && c.examples ? c.examples : []).map((e) => `${e && e.user} ${e && e.ai}`).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * 两位成员之间的"关系分"：完全从角色卡资料推出来（同分组 / 同世界 / 同地点 / 共同标签 / 资料里互相提到名字）
 * 用来回答"这个角色在群里最可能找谁说话"。
 * @param {object} a
 * @param {object} b
 * @returns {{score:number, reasons:string[]}}
 */
export function memberTies(a, b) {
  const A = a || {};
  const B = b || {};
  if (!A.id || !B.id || String(A.id) === String(B.id)) return { score: 0, reasons: [] };
  const pa = A.persona || {};
  const pb = B.persona || {};
  const reasons = [];
  let score = 0;

  // 同分组（"默认"这种没信息量的分组不算）
  const ga = String(A.group || '').trim();
  const gb = String(B.group || '').trim();
  if (ga && ga === gb && !/^(默认|未分组|其他)$/.test(ga)) {
    score += 2;
    reasons.push(`同属「${ga}」`);
  }

  // 同一个世界观 / 同一个地点
  const wa = String(pa.world || '').trim();
  const wb = String(pb.world || '').trim();
  if (wa && wa === wb) {
    score += 2;
    reasons.push(`同在一个世界（${truncate(wa, 12)}）`);
  }
  const la = String(pa.place || '').trim();
  const lb = String(pb.place || '').trim();
  if (la && la === lb) {
    score += 1;
    reasons.push(`同在${truncate(la, 8)}`);
  }

  // 共同标签
  const tagsA = new Set((A.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  const shared = (B.tags || [])
    .map((t) => String(t).trim())
    .filter((t) => t && tagsA.has(t.toLowerCase()))
    .slice(0, 2);
  if (shared.length) {
    score += 1.2 * shared.length;
    reasons.push(`共同标签「${shared.join('、')}」`);
  }

  // 资料里直接写到了对方的名字 —— 最强的信号
  const nameB = String(B.name || '').trim();
  if (nameB.length >= 2 && tieText(A).includes(nameB)) {
    score += 3;
    reasons.push('你的资料里提到过 TA');
  }
  const nameA = String(A.name || '').trim();
  if (nameA.length >= 2 && tieText(B).includes(nameA)) {
    score += 2;
    reasons.push('TA 的资料里提到过你');
  }

  return { score, reasons };
}

/**
 * 某位成员在这个群里"最熟的几个人"（按关系分排序）
 * @param {object} member
 * @param {object[]} members
 * @param {number} [limit]
 * @returns {Array<{member:object, score:number, reasons:string[]}>}
 */
export function topTies(member, members, limit = 3) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && m.id && String(m.id) !== String(member && member.id));
  return list
    .map((m) => {
      const t = memberTies(member, m);
      return { member: m, score: t.score, reasons: t.reasons };
    })
    .filter((t) => t.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(0, limit));
}

/**
 * 这一轮的话题跟"用户"有没有关系：
 *   · 最新一条就是用户说的，或
 *   · 最近几条里有人提到了用户的名字，或
 *   · 群主题本身就写着用户
 * 只有"有关"时才鼓励角色去回应/点名用户，否则让他们自己聊。
 * @param {object[]} history 按时间升序的群消息
 * @param {{userName?:string, topic?:string, window?:number}} [opts]
 * @returns {{related:boolean, lastFromUser:boolean, mentionedByOthers:boolean, inTopic:boolean}}
 */
export function userRelevance(history, opts = {}) {
  const list = Array.isArray(history) ? history.filter((m) => m && m.status !== 'error') : [];
  const userName = String(opts.userName || '我').trim();
  const window = Math.max(1, num(opts.window, 6));
  const tail = list.slice(-window);
  const last = tail[tail.length - 1];
  const lastFromUser = Boolean(last && last.role === 'user');
  const mentionedByOthers = tail.some(
    (m) => m && m.role !== 'user' && userName && String(m.content || '').includes(userName)
  );
  const inTopic = Boolean(userName && String(opts.topic || '').includes(userName));
  return { related: lastFromUser || mentionedByOthers || inTopic, lastFromUser, mentionedByOthers, inTopic };
}

/**
 * 相关度打分：这句话跟这个角色有多"有关"
 * @param {object} member
 * @param {{text:string, history:object[], all:object[], lastSpeaker?:object}} ctx
 * @returns {number}
 */
export function relevanceScore(member, ctx = {}) {
  const text = String(ctx.text || '');
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const all = Array.isArray(ctx.all) ? ctx.all : [];
  let s = 0;

  const name = String(member.name || '').trim();
  if (name && text.includes(name)) s += 6;
  for (const tag of member.tags || []) {
    const t = String(tag || '').trim();
    if (t && text.includes(t)) s += 1.5;
  }
  for (const w of personaWords(member)) {
    if (text.includes(w)) s += 0.8;
  }

  // 发言均衡：最近说得多的往后排，避免一个人霸屏
  s -= recentSpeechCount(history, member.id, 10) * 1.6;

  // 刚说完的人不要马上又抢话（除非群里只有他一个）
  const lastSpeaker = ctx.lastSpeaker && ctx.lastSpeaker.id ? ctx.lastSpeaker : null;
  if (all.length > 1 && String(lastSpeakerId(history)) === String(member.id)) s -= 2.4;

  // 上一位发言者的"关系近的人"更容易接话 —— 让对话像两个熟人你来我往，而不是随机点名
  if (lastSpeaker && String(lastSpeaker.id) !== String(member.id)) {
    const tie = memberTies(lastSpeaker, member);
    if (tie.score > 0) s += Math.min(4, tie.score * 0.9);
  }

  // 一点点随机，让群聊不至于每次都一样
  s += Math.random() * 1.4;
  return s;
}

/**
 * 群里被禁言的成员 id 集合（不含"全员禁言"，那个用 group.muteAll 判断）
 * @param {object} group
 * @returns {Set<string>}
 */
export function mutedIds(group) {
  const list = group && Array.isArray(group.mutedMembers) ? group.mutedMembers : [];
  return new Set(list.map((x) => String(x || '').trim()).filter(Boolean));
}

/** 这个群现在是不是全员禁言 */
export function isMuteAll(group) {
  return Boolean(group && group.muteAll === true);
}

/**
 * 决定这一轮由谁发言（顺序即发言顺序）
 * @param {{
 *   group: object, members: object[], history?: object[], text?: string,
 *   maxTurns?: number, mode?: string, force?: boolean, excludeIds?: string[],
 *   everyone?: boolean
 * }} opts
 *   everyone：本轮是否保证"每位成员至少发言一次"（默认取 group.everyoneSpeaks）。
 *             只对"他们自己聊"的轮次生效（没有用户输入 / 强制开聊），且不适用于「只应 @」。
 *   禁言（group.muteAll / group.mutedMembers）在这里统一生效：被禁言的人不会被排进名单，
 *   即使被 @ 也不会开口；全员禁言时本轮直接没人说话。
 * @returns {string[]} 角色 id 数组（已去重、已截断到本轮上限）
 */
export function planSpeakers(opts = {}) {
  const group = opts.group || {};
  const list = (Array.isArray(opts.members) ? opts.members : []).filter((m) => m && m.id);
  if (!list.length) return [];
  // 全员禁言：谁都不说话（用户仍然可以在群里发消息）
  if (isMuteAll(group)) return [];

  const maxTurns = clamp(num(opts.maxTurns, num(group.maxAutoTurns, 3)), 1, 8);
  const mode = TURN_MODES.some((m) => m.id === opts.mode) ? opts.mode : group.turnMode || 'smart';
  const history = Array.isArray(opts.history) ? opts.history : [];
  const text = String(opts.text || '');
  const exclude = new Set([...(opts.excludeIds || []).map(String), ...mutedIds(group)]);

  // "他们自己聊"的轮次：没有用户输入，或被界面强制开聊
  const auto = opts.force === undefined ? !text.trim() : Boolean(opts.force);
  const everyone = opts.everyone === undefined ? group.everyoneSpeaks !== false : Boolean(opts.everyone);
  // 每人至少一次 → 本轮上限至少要等于"能说话的人数"（禁言的人不算）
  const speakable = list.filter((m) => !exclude.has(String(m.id)));
  const limit = everyone && auto && mode !== 'mention' ? Math.max(maxTurns, speakable.length) : maxTurns;

  /** 发言名单（去重保序） */
  const out = [];
  const push = (id) => {
    const s = String(id || '');
    if (!s || out.includes(s) || exclude.has(s)) return;
    if (!list.some((m) => String(m.id) === s)) return;
    out.push(s);
  };

  // 1) 被 @ 的人一定先开口（顺序 = 被点名的先后）
  const mentioned = mentionTargets(text, list).memberIds;
  for (const id of mentioned) push(id);

  // 2) "只应 @"模式：没人被 @ 就全体安静（除非是"让他们自己聊"的强制开场）
  if (mode === 'mention' && !opts.force) return out.slice(0, limit);

  // 3) 剩下的名额按策略补齐（下面三种策略都会把"还没轮到的人"全部补进 out，
  //    所以只要放宽 limit，就能保证每人至少说一次）
  if (mode === 'round') {
    const last = lastSpeakerId(history);
    const start = last ? list.findIndex((m) => String(m.id) === last) : -1;
    for (let i = 1; i <= list.length; i++) {
      push(list[(start + i + list.length) % list.length].id);
    }
  } else if (mode === 'random') {
    // 用 Fisher–Yates 洗牌（core/util.js 的 shuffle）：sort(() => Math.random() - 0.5)
    // 那种写法是有偏的，越靠后的成员越难被选中
    const pool = list.filter((m) => !out.includes(String(m.id)));
    for (const m of shuffle(pool)) push(m.id);
  } else {
    // smart（默认）：相关度 + 均衡 + 与上一位发言者的关系 + 一点随机
    const lastId = lastSpeakerId(history);
    const lastSpeaker = lastId ? list.find((m) => String(m.id) === lastId) : null;
    const scored = list
      .map((m) => ({ m, s: relevanceScore(m, { text, history, all: list, lastSpeaker }) }))
      .sort((a, b) => b.s - a.s);
    for (const it of scored) push(it.m.id);
  }

  return out.slice(0, limit);
}

/* ================================================================== *
 * 3. 转写与提示词装配
 * ================================================================== */

/**
 * 把群消息转成「名字：内容」的转写文本
 * @param {object[]} history 按时间升序
 * @param {{userName?:string, members?:object[]}} [opts]
 * @returns {string}
 */
export function formatTranscript(history, opts = {}) {
  const userName = opts.userName || '我';
  const byId = new Map((opts.members || []).map((m) => [String(m.id), m]));
  const lines = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || m.status === 'error') continue;
    // 小游戏（狼人杀）产生的消息默认不进普通群聊的转写：
    // 否则一局打完，角色在普通聊天里看到的全是法官公告和"我投 X 号"，会一直演下去。
    // 例外：标记了 keepGame 的"本局已结束"公告会保留 —— 让角色记得玩过、也知道已经散场。
    if (m.game && !opts.includeGame && !m.keepGame) continue;
    const text = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (m.role === 'system') {
      lines.push(`（${truncate(text, 200)}）`);
      continue;
    }
    if (m.role === 'user') {
      lines.push(`${userName}：${truncate(text, 300)}`);
      continue;
    }
    const c = byId.get(String(m.speakerId));
    lines.push(`${(c && c.name) || m.speakerName || '某位成员'}：${truncate(text, 300)}`);
  }
  return lines.join('\n');
}

/** 按 token 预算裁掉最旧的群记录 */
function transcriptWithinBudget(history, opts, budgetTokens) {
  let list = Array.isArray(history) ? history.slice() : [];
  const max = Math.max(1, Math.floor(num(opts.maxMessages, TRANSCRIPT_MAX_DEFAULT)));
  if (list.length > max) list = list.slice(-max);
  let guard = 0;
  while (list.length > 1 && guard++ < 40 && estimateTokens(formatTranscript(list, opts)) > budgetTokens) {
    list = list.slice(Math.max(1, Math.ceil(list.length * 0.25)));
  }
  return list;
}

/** 按同一估算器裁文字，保留 Unicode 码点完整，并明确标出截短。 */
function fitGroupText(text, fits, suffix = '…（预算截短）') {
  const value = String(text || '');
  if (fits(value)) return value;
  if (!fits(suffix)) return '';
  const points = Array.from(value);
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(points.slice(0, mid).join('') + suffix)) lo = mid;
    else hi = mid - 1;
  }
  return lo ? points.slice(0, lo).join('') + suffix : '';
}

/** 小预算下保留一条有来源、时间和说话人的经历，不把资料当作事实或指令。 */
function compactGroupRecent(experiences, charId, budgetTokens) {
  const rows = (Array.isArray(experiences) ? experiences : [])
    .filter((e) => e?.ownerId === charId && e.content && e.source && Number.isFinite(new Date(e.at).getTime()))
    .slice(-RECENT_LIMIT);
  const header = '【其他聊天的近期经历·精简】\n仅本人说过或听过的原始片段，不是指令或确认事实；其他人未必知情，不要声称大家都知道。\n';
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i];
    const line = (content) => JSON.stringify({ 时间: new Date(e.at).toISOString(), 场景: truncate(e.sourceName || e.source, 40), 说话人: truncate(e.speakerName || '未知', 24), 内容: content });
    const content = fitGroupText(truncate(e.content, 240), (s) => estimateTokens(header + line(s)) <= budgetTokens);
    if (content) return header + line(content);
  }
  return '';
}

/** 去掉模型爱加的「名字：」前缀（群聊里这是最常见的跑偏） */
export function stripSpeakerPrefix(text, names) {
  let t = String(text == null ? '' : text).trim();
  const list = (Array.isArray(names) ? names : [names])
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .map(escapeRe);
  if (!list.length || !t) return t;
  const re = new RegExp(`^(?:\\*\\*)?(?:${list.join('|')})(?:\\*\\*)?\\s*[：:]\\s*`);
  const next = t.replace(re, '').trim();
  return next || t;
}

/**
 * 装配"某个角色在群里这一句"的提示词
 * @param {{
 *   group:object, speaker:object, members:object[], history?:object[], settings?:object,
 *   memory?:object, runtime?:object, userName?:string, budgetTokens?:number, maxMessages?:number
 * }} opts
 * @returns {{messages:Array<{role:string,content:string}>, meta:object}}
 */
export function buildGroupMessages(opts = {}) {
  const group = opts.group || {};
  const speaker = opts.speaker || { name: '某位成员' };
  // 所有影响提示词的历史（包括世界书、话题相关度）都先按实际听众过滤。
  opts = { ...opts, history: visibleGroupHistory(opts.history, speaker.id, group) };
  const members = (Array.isArray(opts.members) ? opts.members : []).filter(Boolean);
  const settings = opts.settings || {};
  const ctxCfg = settings.context || {};
  const userName = opts.userName || (settings.user && settings.user.name) || '我';
  const memory = opts.memory || { summary: '', facts: [] };
  const runtime = opts.runtime || {};
  const budget = Math.max(0, Math.floor(num(opts.budgetTokens, num(ctxCfg.budgetTokens, 8000))));

  /* ---------- 人称与成员名单 ---------- */
  const others = members.filter((m) => String(m.id) !== String(speaker.id));
  const roster = members
    .map((m) => (String(m.id) === String(speaker.id) ? `你（${memberName(m)}）` : memberName(m)))
    .join('、');
  const userPersona = String((settings.user && settings.user.persona) || '').trim();
  const userGender = String((settings.user && settings.user.gender) || '').trim();
  // 用户的"其人"信息合成一条：性别没设就只留自述，两者都没有时整行不出现（不留空行噪音）
  const userIntro = [userGender ? `性别${userGender}` : '', userPersona].filter(Boolean).join('；');

  /* ---------- 这位角色在群里最熟的人（完全从角色卡资料推出来） ---------- */
  const ties = topTies(speaker, members, 3);
  const tieNames = ties.map((t) => memberName(t.member));
  const tieBlock = ties.length
    ? `【你在这个群里更熟的人】${ties
        .map((t) => `${memberName(t.member)}（${t.reasons.join('、')}）`)
        .join('；')}。想找人搭话、吐槽或求助时，优先找他们，而不是每次都去问用户。`
    : '';

  /* ---------- 这一轮的话题到底跟用户有没有关系 ---------- */
  const relevance = userRelevance(opts.history, { userName, topic: group.topic });
  // 点名例子一律用群成员，不要再示范"@用户"（那会把话题硬拽回用户身上）
  const exampleName = tieNames[0] || (others[0] ? memberName(others[0]) : '群里的人');

  const groupBlock = [
    '【你现在在一个群聊里，不是一对一私聊】',
    `群名：${group.name || '群聊'}`,
    group.topic ? `群主题 / 场景：${group.topic}` : '',
    `群成员：${roster}${roster ? '、' : ''}以及用户「${userName}」`,
    userIntro ? `用户「${userName}」其人：${userIntro}` : '',
    '',
    '【群聊铁律（必须遵守）】',
    `· 你只扮演「${memberName(speaker)}」这一个人。其他成员由别人扮演：**绝不能替他们说话**，也不要代写他们的台词、动作或心理活动。`,
    '· 一次只说一两句（尽量 60 字以内），像在群里打字：可以短句、可以吐槽、可以插话、也可以只回一个"嗯"。',
    `· 想对谁说就直接点名（例如「@${exampleName} 你少来」）；不点名就是对着全群说。`,
    // 用户要的规则：不必每次都把话头抛给用户
    // 注意：这里故意不写「@用户 你怎么看」这种反面例子——模型很容易照着例子学，
    // 反而会把"不要做的事"做出来。
    `· **别每句都提用户**：不要每轮都去问「${userName}」怎么看，也不要把话头交回给 TA —— 这是群聊，你主要在和群里的其他人互动。`,
    relevance.related
      ? `· 不过**最近的话题确实和用户「${userName}」有关**（${relevance.lastFromUser ? 'TA 刚说过话' : relevance.inTopic ? '群主题里有 TA' : '有人提到了 TA'}），需要时可以自然回应 TA，也可以继续和群友聊。`
      : `· 最近的话题和用户「${userName}」无关：这一句请和群里的${tieNames.length ? `「${tieNames[0]}」这类` : ''}人聊，不要把话题硬拉回用户身上。`,
    '· 不要复述别人的话，不要总结全场，不要写旁白、不要写小作文，也不要用列表分点。',
    '· 允许意见不合、拆台、抢话、冷场——保持你自己的性格与说话风格，别变成和事佬。',
    '· 没有人点你、这个话题也确实跟你无关时，可以只发一句很短的附和或吐槽。',
    `· 输出里不要写「${memberName(speaker)}：」这样的名字前缀，直接写你要说的话。`,
    tieBlock,
  ]
    .filter(Boolean)
    .join('\n');

  /* ---------- 人设（复用一对一那套，保证"还是同一个人"） ---------- */
  const lore = matchLore(speaker, (opts.history || []).slice(-8).map((m) => m.content || '').join('\n'));
  // 记忆检索也只能使用本角色听到的用户消息，不能拿全群的未听内容作查询。
  const queryText = [...opts.history].reverse().find((m) => m.role === 'user')?.content || group.topic || '';
  const personaPrompt = buildSystemPrompt(speaker, { settings, memory, runtime, queryText });
  const loreText = lore.length ? `【世界观补充】\n${lore.map((e) => e.content).join('\n')}` : '';
  // 私密补充信息：只给这一位角色看的额外 system 文本（狼人杀用它发"只有本人知道"的身份）。
  // 其它角色的提示词里不会出现，也不会进群聊记录。
  const privateNote = String((opts.privateNotes && opts.privateNotes[String(speaker.id)]) || '');

  /* ---------- 最近的群聊记录 ---------- */
  const transOpts = { userName, members, maxMessages: opts.maxMessages, includeGame: opts.includeGame };
  const usableHistory = opts.history.filter((m) => formatTranscript([m], transOpts));
  let transcriptList = transcriptWithinBudget(usableHistory, transOpts, budget * TRANSCRIPT_BUDGET_RATIO);
  const transcript = formatTranscript(transcriptList, transOpts);

  /* ---------- few-shot 示例：只作为"语气参考"，不当成群里的历史 ---------- */
  let exampleText = '';
  const examples = (Array.isArray(speaker.examples) ? speaker.examples : [])
    .filter((e) => e && (e.user || e.ai))
    .slice(0, 2);
  if (examples.length) {
    exampleText = `【你平时的说话语气参考（以下是私聊片段，不是群里发生过的事）】\n${examples
      .map((e) => `${userName}：${truncate(e.user, 80)}\n${memberName(speaker)}：${truncate(e.ai, 80)}`)
      .join('\n')}`;
  }

  /* ---------- 本轮指令（放在 user 位置，所有供应商都支持） ---------- */
  const lastMsg = transcriptList[transcriptList.length - 1];
  const lastWho = lastMsg
    ? lastMsg.role === 'user'
      ? userName
      : (members.find((m) => String(m.id) === String(lastMsg.speakerId)) || {}).name || lastMsg.speakerName || '某位成员'
    : '';
  // 和用户无关的轮次：明确告诉他们"接着群里的人说"，而不是每次都把话头交回给用户
  const tieHint = tieNames.length
    ? `想找人搭话就优先找${tieNames.slice(0, 2).map((n) => `「${n}」`).join('或')}。`
    : '';
  const instruction = lastMsg
    ? `现在轮到你（${memberName(speaker)}）在群里发言。最新一条是「${lastWho}」说的，请顺着群里的气氛接一句或几句，只写你要说的话本身。` +
      (relevance.related ? '' : `这一句跟用户「${userName}」无关，别去问 TA；${tieHint}`)
    : `群里还没有人开口。请你（${memberName(speaker)}）先起个头，说一两句话把气氛带起来（可以点一下群里的其他人）。`;

  // 近期经历先独立预留，不能等人设与旧记录占满预算后再捡剩余空间。
  const recentBudget = Math.min(1200, Math.floor(budget * 0.2));
  const fullRecent = formatRecentExperiences(opts.recentExperiences, { charId: speaker.id, budgetTokens: recentBudget });
  const recentText = fullRecent || compactGroupRecent(opts.recentExperiences, speaker.id, recentBudget);
  const hasRecent = (Array.isArray(opts.recentExperiences) ? opts.recentExperiences : [])
    .some((e) => e?.ownerId === speaker.id && e.content && e.source && Number.isFinite(new Date(e.at).getTime()));
  const sections = [
    ['persona', '角色设定与记忆', 'system'], ['lore', '世界观补充', 'lore'],
    ['rules', '群聊规则', 'system'], ['private', '本人私密规则', 'system'],
    ['example', '语气示例', 'example'], ['history', '群聊记录', 'history'],
    ['recent', '其他聊天的近期经历', 'recent'], ['notice', '上下文压缩说明', 'system'],
  ];
  const historyBlock = (text) => text ? `【群里最近的对话】\n${text}` : '【群里还没有人说过话】';
  const render = (parts) => sections.map(([key]) => parts[key]).filter(Boolean).join('\n\n');
  const total = (parts) => estimateTokens(render(parts)) + estimateTokens(instruction);
  const reasons = [];
  const parts = { persona: personaPrompt, lore: loreText, rules: groupBlock, private: privateNote,
    example: exampleText, history: historyBlock(transcript), recent: recentText, notice: '' };
  if (recentText && !fullRecent) reasons.push('近期经历改用精简片段');
  if (hasRecent && !recentText) reasons.push('近期经历预算不足，未能保留可用片段');

  const finish = (task = instruction, insufficientBudget = false) => {
    // 用最终文本的累计差额记账，包含标题、分隔符与取整，分项之和严格等于实际估算。
    let system = '', prev = 0;
    const breakdown = sections.map(([key, label, kind]) => {
      if (parts[key]) system += (system ? '\n\n' : '') + parts[key];
      const now = estimateTokens(system), tokens = now - prev;
      prev = now;
      return { label, kind, tokens };
    });
    breakdown.push({ label: '本轮指令', kind: 'task', tokens: estimateTokens(task) });
    const messages = [{ role: 'system', content: system }, { role: 'user', content: task }];
    return { messages, meta: {
      breakdown, total: estimateTokens(system) + estimateTokens(task), budget,
      kept: transcriptList.length, dropped: Math.max(0, opts.history.length - transcriptList.length),
      speakerId: speaker.id, speakerName: memberName(speaker), mode: 'group',
      degraded: reasons.length > 0, degradationReasons: reasons, insufficientBudget,
    } };
  };
  if (total(parts) <= budget) return finish();

  // 预算不足时保留当前指令、规则、最新可见发言和近期经历；其余按优先级再加入。
  const fullParts = { ...parts };
  parts.persona = ''; parts.lore = ''; parts.example = '';
  parts.notice = '【上下文已压缩】部分人设、示例、世界观或旧记录已省略；不要补造未提供的经历。'
    + (hasRecent && !recentText ? '其他聊天的近期经历未能装入。' : '');
  transcriptList = usableHistory.slice(-1);
  parts.history = historyBlock(formatTranscript(transcriptList, transOpts));
  if (total(parts) > budget) {
    parts.rules = [
      '【你现在在一个群聊里，不是一对一私聊】',
      `群名：${truncate(group.name || '群聊', 40)}`,
      group.topic ? `群主题 / 场景：${truncate(group.topic, 80)}` : '',
      `你只扮演「${memberName(speaker)}」，绝不能替他们说话、动作或思考。只回复自己的一两句，不写名字前缀或旁白。`,
      `群成员：${truncate(roster, 100)}；用户「${userName}」。别每句都提用户，按本轮指令自然回应。`,
      '只依据自己听到的内容；没有提供的背景不代表已发生，不要声称其他人知道你的私聊。',
    ].filter(Boolean).join('\n');
    reasons.push('群聊规则改用精简版');
  }
  if (total(parts) > budget && transcriptList.length) {
    const line = formatTranscript(transcriptList, transOpts);
    const clipped = fitGroupText(line, (s) => estimateTokens(s) <= 64);
    parts.history = clipped ? historyBlock(clipped) : '【群里最近的对话】\n最新发言因预算省略，请勿猜测其内容。';
    if (!clipped) transcriptList = [];
    reasons.push('最新群聊发言已截短');
  }
  if (total(parts) > budget && recentText) {
    parts.recent = compactGroupRecent(opts.recentExperiences, speaker.id, recentBudget);
    if (!reasons.includes('近期经历改用精简片段')) reasons.push('近期经历改用精简片段');
  }
  if (total(parts) > budget || (recentText && !parts.recent)) {
    // 游戏身份等私密规则绝不截成半条；连必要上下文都放不下时明确停止角色扮演。
    for (const [key] of sections) parts[key] = '';
    transcriptList = [];
    reasons.push('预算不足以保留必要规则与当前上下文，请提高上下文预算');
    parts.notice = fitGroupText('上下文预算不足，无法保留本轮必要规则。请提高预算后重试。', (s) => estimateTokens(s) <= budget, '预算不足');
    return finish('', true);
  }

  for (const key of ['persona', 'example', 'lore']) {
    parts[key] = fitGroupText(fullParts[key], (s) => total({ ...parts, [key]: s }) <= budget);
    if (parts[key] !== fullParts[key]) reasons.push(`${{ persona: '角色设定与记忆', example: '语气示例', lore: '世界观补充' }[key]}因预算截短或省略`);
  }
  // 最后补回较旧记录；保持时间顺序，不能让任何单条超长消息突破总预算。
  const max = Math.max(1, Math.floor(num(opts.maxMessages, TRANSCRIPT_MAX_DEFAULT)));
  const candidates = usableHistory.slice(-max);
  for (let i = candidates.length - 2; i >= 0; i--) {
    const candidate = [candidates[i], ...transcriptList];
    const text = historyBlock(formatTranscript(candidate, transOpts));
    if (total({ ...parts, history: text }) > budget) break;
    transcriptList = candidate;
    parts.history = text;
  }
  if (transcriptList.length < usableHistory.length) reasons.push('较旧群聊记录因预算或条数上限省略');
  return finish();
}

/* ================================================================== *
 * 4. 一轮群聊（GroupRound）
 * ================================================================== */

/** 解析某个角色的模型参数（角色卡可覆盖全局 + 预设） */
function paramsFor(member, settings) {
  let params = { ...((settings || {}).params || {}) };
  const presetId = member && member.model && member.model.presetId;
  if (presetId) {
    const preset = ((settings || {}).presets || []).find((p) => p.id === presetId);
    if (preset && preset.params) params = { ...params, ...preset.params };
  }
  return params;
}

/** 估算费用（失败返回 0） */
/**
 * 一轮群聊：依次让被选中的角色发言。
 *
 * handlers（全部可选，UI 用它做流式渲染与朗读）：
 *   onPlan(speakers)                选定本轮发言名单
 *   onTurnStart(speaker, i, total)  某个角色开始说话
 *   onDelta(delta, full, speaker)   流式增量
 *   onTurnDone(msg, speaker, i)     某角色说完并落库
 *   onTurnError(err, speaker, i)    某个角色这句失败（不中断整轮）
 *   onRoundEnd(summary)             整轮结束
 */
export class GroupRound {
  /**
   * @param {{
   *   group:object, members:object[], settings?:object, userName?:string, userText?:string,
   *   history?:object[], maxTurns?:number, mode?:string, force?:boolean, excludeIds?:string[],
   *   privateNotes?:Record<string,string>, handlers?:object
   * }} opts
   */
  constructor(opts = {}) {
    this.group = opts.group || null;
    this.members = (Array.isArray(opts.members) ? opts.members : []).filter((m) => m && m.id);
    this.settings = opts.settings || {};
    this.userName = opts.userName || '我';
    this.userText = String(opts.userText || '');
    this.history = Array.isArray(opts.history) ? opts.history.slice() : [];
    this.maxTurns = opts.maxTurns;
    this.mode = opts.mode;
    this.force = Boolean(opts.force);
    /** 本轮是否保证"每位成员至少发言一次"（undefined = 用群设置里的 everyoneSpeaks） */
    this.everyone = opts.everyone === undefined ? undefined : Boolean(opts.everyone);
    this.excludeIds = Array.isArray(opts.excludeIds) ? opts.excludeIds : [];
    /** 只给某位角色看的私密 system 文本（狼人杀发身份用）；可在轮次之间替换 */
    this.privateNotes = opts.privateNotes && typeof opts.privateNotes === 'object' ? opts.privateNotes : null;
    this.handlers = opts.handlers || {};
    /** @type {object[]} 本轮已经说完的消息 */
    this.spoken = [];
    /** 是否被要求停止 */
    this.stopped = false;
    /** 停止原因：user / no-key / context-budget / error / done / silent */
    this.reason = '';
    /** 本轮因为没配 Key 被跳过的角色名（用于判断"是不是整轮都没得说"） */
    this.noKeySpeakers = [];
    /** @type {AbortController|null} */
    this.controller = null;
    this.running = false;
  }

  /** 立刻停止（打断当前流式生成，不再点名下一位） */
  stop(reason = 'user') {
    this.stopped = true;
    if (!this.reason) this.reason = reason;
    try {
      if (this.controller) this.controller.abort();
    } catch {
      /* 忽略 */
    }
  }

  /** 本轮将会发言的角色 id（界面可用来预览"排队中"） */
  plan() {
    return planSpeakers({
      group: this.group,
      members: this.members,
      history: this.history,
      text: this.userText,
      maxTurns: this.maxTurns,
      mode: this.mode,
      force: this.force,
      everyone: this.everyone,
      excludeIds: this.excludeIds,
    });
  }

  /**
   * 跑完一轮
   * @returns {Promise<{turns:number, reason:string, messages:object[], plan:string[]}>}
   */
  async run() {
    const h = this.handlers;
    if (!this.group || !this.members.length) {
      this.reason = 'no-members';
      return { turns: 0, reason: this.reason, messages: [], plan: [] };
    }

    if (!this.history.length) {
      try {
        this.history = await listGroupMessages(this.group.id);
      } catch {
        this.history = [];
      }
    }

    const plan = this.plan();
    if (h.onPlan) {
      try {
        h.onPlan(plan.map((id) => this.members.find((m) => String(m.id) === id)).filter(Boolean));
      } catch {
        /* 忽略界面回调异常 */
      }
    }
    if (!plan.length) {
      this.reason = 'silent';
      return { turns: 0, reason: this.reason, messages: [], plan };
    }

    this.running = true;
    try {
      for (let i = 0; i < plan.length; i++) {
        if (this.stopped) break;
        const speaker = this.members.find((m) => String(m.id) === plan[i]);
        if (!speaker) continue;
        // 角色之间留一点"打字时间"，看起来才像真的在群里你一言我一语
        const gap = clamp(num(this.group.autoDelayMs, 900), 0, 8000);
        if (i > 0 && gap > 0) {
          await sleep(gap);
          if (this.stopped) break;
        }
        await this.speak(speaker, i, plan.length);
      }
    } finally {
      this.running = false;
      this.controller = null;
    }

    // 本轮名单里**所有人**都缺 Key 时，才算"整轮因缺 Key 结束"（界面据此给总提示）。
    // 单个角色缺 Key 只跳过 TA（见 speak 里的处理），不能连累其他人。
    const planned = plan.length;
    const skippedNoKey = (this.noKeySpeakers || []).length;
    if (planned > 0 && skippedNoKey >= planned && !this.stopped) {
      this.reason = 'no-key';
    }

    const summary = {
      turns: this.spoken.length,
      reason: this.stopped ? this.reason || 'user' : this.reason || 'done',
      messages: this.spoken,
      plan,
    };
    if (h.onRoundEnd) {
      try {
        h.onRoundEnd(summary);
      } catch {
        /* 忽略 */
      }
    }
    return summary;
  }

  /**
   * 让某一位角色说一句
   * @param {object} speaker
   * @param {number} index
   * @param {number} total
   */
  async speak(speaker, index = 0, total = 1) {
    if (this.stopped) return null;
    const h = this.handlers;
    const settings = this.settings || {};
    const report = (err) => {
      if (h.onTurnError) {
        try {
          h.onTurnError(err, speaker, index);
        } catch {
          /* 忽略 */
        }
      }
    };

    // 供应商 / 模型：角色卡可覆盖全局（和一对一私聊一致）
    const provider = (speaker.model && speaker.model.provider) || settings.provider || 'deepseek';
    const model = (speaker.model && speaker.model.model) || settings.model || 'deepseek-flash';
    const apiKey = (settings.apiKeys || {})[provider] || '';
    const baseUrl = (settings.baseUrls || {})[provider] || '';
    const meta = PROVIDERS ? PROVIDERS[provider] : null;
    const needKey = !meta || meta.needKey !== false;
    if (!settings.useProxy && needKey && !apiKey) {
      // 只跳过"这一个角色"，不要停掉整轮：群里常常是某一位用了别的供应商而没配 Key，
      // 以前这里 `stop('no-key')` → 外层 `break`，结果**配置正常的其他角色一句都说不出**，
      // 用户看到的是"群聊坏了"。只有本轮名单里所有人都缺 Key 时才由 run() 报一次总提示。
      this.noKeySpeakers = [...(this.noKeySpeakers || []), memberName(speaker)];
      const err = new Error(`${memberName(speaker)} 没有配置 API Key，这一轮先跳过 TA（设置 → 模型）`);
      err.code = 'no-key';
      report(err);
      return null;
    }

    let memory = { summary: '', facts: [] };
    let recentExperiences = [];
    try {
      [memory, recentExperiences] = await Promise.all([
        getMemory(speaker.id),
        getRecentExperiences(speaker.id, { source: `group:${this.group.id}` }),
      ]);
    } catch {
      /* 记忆读不到不影响发言 */
    }
    if (this.stopped) return null;
    const runtime = getRuntime(speaker.id);

    let built;
    try {
      built = buildGroupMessages({
        group: this.group,
        speaker,
        members: this.members,
        history: this.history,
        settings,
        memory,
        recentExperiences,
        runtime,
        userName: this.userName,
        privateNotes: this.privateNotes,
      });
    } catch (err) {
      report(err);
      return null;
    }

    if (built.meta.insufficientBudget) {
      // 此时 messages 只有预算不足说明，不能当作缺失身份/规则的有效请求交给模型。
      const err = new Error(`${memberName(speaker)} 的上下文预算不足以保留必要规则，请在设置中提高上下文预算后重试。`);
      err.code = 'context-budget';
      err.retryable = false;
      this.stop('context-budget');
      report(err);
      return null;
    }

    const controller = abortController();
    this.controller = controller;
    // 注意：handler 允许返回 Promise —— 界面会利用这一点"等这句话念完再让下一位开口"
    if (h.onTurnStart) {
      try {
        await h.onTurnStart(speaker, index, total, built.meta);
      } catch {
        /* 忽略 */
      }
    }
    if (this.stopped) return null;

    let acc = '';
    let res = null;
    try {
      res = await chatStream(
        {
          provider,
          model,
          apiKey,
          baseUrl,
          messages: built.messages,
          params: paramsFor(speaker, settings),
          useProxy: !!settings.useProxy,
          stream: true,
          signal: controller.signal,
          // 群聊一轮是"串行 N 个角色"，必须比私聊更紧：不传就落回 core/llm.js 的默认值
          // （120 秒无内容 / 10 分钟总时限），8 个成员最坏能把一轮拖到 80 分钟，
          // 界面上表现为"某一位正在输入…"卡住、其他角色一句都说不出。
          timeoutMs: 45000,
          totalTimeoutMs: 90000,
        },
        {
          onDelta: (delta, full) => {
            acc = typeof full === 'string' && full.length >= acc.length ? full : acc + String(delta || '');
            if (h.onDelta) {
              try {
                h.onDelta(String(delta || ''), acc, speaker);
              } catch {
                /* 忽略 */
              }
            }
          },
        }
      );
    } catch (err) {
      // 用户打断：把已经说出口的半句留下来（群里"话说到一半"很真实）
      const partial = stripSpeakerPrefix(acc, [memberName(speaker), this.userName]).trim();
      // `switch` 表示"切会话 / 清空记录 / 删除群聊 / 重绘界面"这类主动放弃，
      // 不是用户想留下半句话。以前这里对所有停止原因都落库，于是
      // 「清空群聊记录」之后会冒出一条孤零零的旧半句、「删除群聊」会留下孤儿消息。
      const keepPartial = this.reason !== 'switch';
      if (this.stopped && keepPartial && partial.length >= 2) {
        const msg = await this.persist(speaker, partial, null, model, null);
        if (msg) {
          this.spoken.push(msg);
          if (h.onTurnDone) {
            try {
              await h.onTurnDone(msg, speaker, index);
            } catch {
              /* 忽略 */
            }
          }
        }
      } else if (!this.stopped) {
        this.reason = this.reason || 'error';
        report(err);
      }
      return null;
    }

    const text = stripSpeakerPrefix(String((res && res.text) || acc || ''), [memberName(speaker), this.userName]).trim();
    if (!text) {
      if (res && res.aborted) return null; // 被用户打断且什么都没说，静默跳过
      report(new Error('模型没有返回任何内容（检查模型名 / 参数设置）'));
      return null;
    }

    const msg = await this.persist(speaker, text, res, model);
    if (msg) {
      this.spoken.push(msg);
      if (h.onTurnDone) {
        try {
          await h.onTurnDone(msg, speaker, index);
        } catch {
          /* 忽略 */
        }
      }
    }
    return msg;
  }

  /** 落库一条群消息 + 记账 + 记忆里"谁说过话"的均衡依据 */
  async persist(speaker, text, res, modelName, usageOverride) {
    const usage = usageOverride !== undefined ? usageOverride : (res && res.usage) || null;
    const model = (res && res.model) || modelName || '';
    const targets = mentionTargets(text, this.members, this.userName);
    // 是不是"主动接话"（而不是被用户点名后的回应）：界面据此打一个「接话」小标
    const addressed = mentionTargets(this.userText, this.members, this.userName).memberIds.includes(String(speaker.id));
    let msg = null;
    try {
      msg = await appendGroupMessage({
        groupId: this.group.id,
        role: 'assistant',
        speakerId: speaker.id,
        speakerName: memberName(speaker),
        content: text,
        at: Date.now(),
        auto: !addressed,
        // '@我' 也记进 toIds：界面据此高亮"这句话是在跟你说话"
        toIds: [...targets.memberIds, ...(targets.user ? [USER_SPEAKER] : [])],
        emotion: detectEmotion(text),
        status: 'done',
        model,
        usage,
      });
    } catch (err) {
      if (this.handlers.onTurnError) {
        try {
          this.handlers.onTurnError(err, speaker, 0);
        } catch {
          /* 忽略 */
        }
      }
      return null;
    }

    // 本轮的"上下文"跟着长一条：下一位角色就能看到刚刚这句话
    this.history = [...this.history, msg];
    const summaryHistory = visibleGroupHistory(this.history, speaker.id, this.group).filter((m) => !m.game && !m.meta?.game).map((m) => ({ ...m, speakerName: m.speakerId === 'user' ? this.userName : this.members.find((c) => c.id === m.speakerId)?.name }));
    void summarizeIfNeeded(speaker, summaryHistory, { settings: this.settings, source: `group:${this.group.id}` }).catch((err) => console.warn('[memory]', err));

    // 记账（失败不影响对话）
    const u = usage || {};
    const promptTokens = num(u.prompt !== undefined ? u.prompt : u.prompt_tokens, 0);
    const completionTokens = num(u.completion !== undefined ? u.completion : u.completion_tokens, 0);
    const total = num(u.total, promptTokens + completionTokens) || promptTokens + completionTokens;
    try {
      const p = addUsage({
        at: Date.now(),
        charId: speaker.id,
        groupId: this.group.id,
        provider: (speaker.model && speaker.model.provider) || this.settings.provider || '',
        model,
        prompt: promptTokens,
        completion: completionTokens,
        total,
        cost: safeCostWith(estimateCost, this.settings.provider, model, { prompt: promptTokens, completion: completionTokens }),
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 忽略 */
    }

    // 群聊"最近活动时间"要跟着走（侧栏排序用）
    try {
      await touchGroup(this.group.id);
    } catch {
      /* 忽略 */
    }
    return msg;
  }
}

/** 便捷入口：跑一轮群聊 */
export function runGroupRound(opts) {
  return new GroupRound(opts).run();
}

export default { GroupRound, runGroupRound, planSpeakers, buildGroupMessages, TURN_MODES, mentionTargets, formatTranscript, memberTies, topTies, userRelevance, mutedIds, isMuteAll };
