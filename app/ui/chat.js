import { LOCAL_MODEL, LOCAL_BASE_URL } from '../core/local-model.js';
/**
 * ui/chat.js —— 中间栏：消息流 / 输入区 / 流式对话 / 多版本 / 语音（契约 3.14）
 *
 * 产品定位：这不是"一个聊天工具"，而是"一个住在浏览器里的好友"。
 * 因此这里的每一个细节都服务于沉浸感：打字机、"正在输入…"、日期分割线、
 * 时间感知（"你们上次聊天是昨天"）、边写边说的语音、可回溯的多版本回复。
 *
 * 对外导出（契约冻结）：
 *   renderChat(root, ctx)    渲染整个聊天区到 root（切换角色时由 ui/app.js 重新调用）
 *   refreshMessages()        重新渲染消息流（外部可调用）
 *   openSearchDialog()       会话内搜索
 *   appendLocalNotice(text)  插入一条系统提示气泡（不落库）
 *
 * 约束：原生 ES Module / 零依赖 / 零构建 / 不用 alert / 不把用户输入拼进 innerHTML。
 */

import { bus } from '../core/bus.js';
import {
  appendMessage,
  clearMessages,
  deleteCharacter,
  deleteMessage,
  getMemory,
  getRecentExperiences,
  getCharacter,
  listMessages,
  listMessagesPage,
  saveCharacter,
  searchMessages,
  updateMessage,
} from '../core/store.js';
import {
  affinityLabel,
  bumpAffinity,
  detectEmotion,
  gapDescription,
  getRuntime,
  initCharacterRuntime,
  markRead,
  setMood,
  touchChat,
} from '../core/runtime.js';
import { buildMessages, summarizeIfNeeded } from '../core/prompt.js';
import { abortController, addUsage, chatStream, estimateCost, llmErrors } from '../core/llm.js';
import { createSplitter } from '../voice/splitter.js';
import { SpeechQueue, speakText, speaker, stopSpeaking, voiceFor } from '../voice/tts.js';
import { createRecognizer, sttAvailable } from '../voice/stt.js';
import { openCharacterEditor } from './editor.js';
import { autoGrow, clear, el, isNearBottom, mount, on, scrollToBottom } from './dom.js';
import { avatarNode, ctxCall, fillAvatar, headRestoreBar, readLS, removeLS, twoStateIconBtn, writeLS } from './shared.js';
import { icon } from './icons.js';
import { createHistoryPager, reconcileMessageList } from './message-list.js';
import { actionSheet, confirmDialog, modal, promptDialog, toast } from './toast.js';
import {
  clamp,
  copyText,
  createId,
  debounce,
  download,
  estimateTokens,
  fmtDate,
  fmtDay,
  fmtTime,
  isSameDay,
  num,
  pick,
  relTime,
  stripMarkdown,
  timeContext,
  truncate,
  safeCostWith,
} from '../core/util.js';
/* ================================================================== *
 * 1. 常量
 * ================================================================== */

/** 临时气泡的伪消息 id（不落库，仅用于 DOM 定位） */
const STREAM_ID = '__stream';

/** 消息操作栏按钮定义：{ act, iconName, title, when(msg, isLastAssistant) } */
const MSG_ACTIONS = [
  { act: 'copy', ic: 'copy', title: '复制' },
  { act: 'speak', ic: 'speaker', title: '朗读这条' },
  { act: 'quote', ic: 'quote', title: '引用回复' },
  { act: 'edit', ic: 'edit', title: '编辑', only: 'user' },
  { act: 'regen', ic: 'refreshCw', title: '重新生成', only: 'lastAssistant' },
  { act: 'bookmark', ic: 'bookmark', title: '收藏' },
  { act: 'del', ic: 'trash', title: '删除' },
];

/** 情绪 → 中文标签（消息底部的"开心"之类） */
const EMOTION_LABEL = {
  happy: '开心',
  sad: '难过',
  angry: '生气',
  shy: '害羞',
  excited: '兴奋',
  worried: '担心',
  neutral: '平静',
};

/** 快捷短语 / 常用表达（点击插入输入框） */
const PHRASES = [
  { text: '/me ', label: '/me 动作' },
  { text: '/ooc ', label: '/ooc 出戏指令' },
  { text: '/roll 1d20', label: '/roll 掷骰' },
  { text: '嗨，在忙吗？', label: '打招呼' },
  { text: '刚刚是我不好，对不起。', label: '道歉' },
  { text: '其实……我一直很喜欢你。', label: '表白' },
  { text: '然后呢然后呢？快继续说！', label: '催更' },
  { text: '早点睡，别熬夜了，晚安。', label: '晚安' },
  { text: '你今天也太可爱了吧。', label: '夸夸' },
  { text: '（沉默了一会儿）', label: '留白' },
];

/** 命令帮助表 */
const CMD_HELP = [
  ['/me 动作', '以动作形式发送（渲染成灰色斜体动作行）'],
  ['/ooc 指令', '出戏指令：作为系统消息注入本轮上下文'],
  ['/roll [NdM]', '掷骰，例如 /roll 2d6'],
  ['/regen', '重新生成上一条回复（保留为多版本）'],
  ['/retry', '重试失败的最后一条消息'],
  ['/stop', '停止正在生成的回复'],
  ['/clear', '清空当前角色的聊天记录'],
  ['/help', '查看这条帮助'],
];

/**
 * 只保留少量"结构性"内联样式（布局兜底）。
 * 视觉样式一律交给 styles/app.css 里的类名：.chat-head / .chat-body / .msg / .bub /
 * .msg-tools / .quoted-bar / .chat-foot / .chat-foot-bar / .pill / .variant-nav ...
 * 这样样式表是唯一的视觉来源，不会和内联样式打架。
 */
const STY = {
  chat: 'display:flex;flex-direction:column;height:100%;min-height:0;position:relative;overflow:hidden',
  list: 'flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column',
};

/* ================================================================== *
 * 2. 模块状态（同一个页面同时只有一个聊天面板）
 * ================================================================== */

/** @type {HTMLElement|null} 面板根节点 */
let rootEl = null;
/** @type {object|null} ui/app.js 传入的上下文 */
let ctxRef = null;

/** @type {HTMLElement|null} */
let headEl = null;
let avatarEl = null;
let statusEl = null;
let statusDot = null;
let backBtn = null;
let voiceBtn = null;
let listEl = null;
let inputEl = null;
let sendBtn = null;
let micBtn = null;
let jumpBtn = null;
let footEl = null;
let phrasePanel = null;
let hintEl = null;
let hintCtxEl = null;
let timeHintEl = null;
let quoteBarEl = null;
let sttLiveEl = null;

/** @type {object[]} 当前会话消息（时间升序，与 IndexedDB 同步） */
let messages = [];
const historyPager = createHistoryPager(listMessagesPage);
/** @type {Array<{id:string,text:string,at:number}>} 本地提示（不落库，仅本次会话可见） */
let notices = [];
/** 落库事件的延迟刷新；主动刷新时取消，避免回复结束后又重画一次 */
const scheduleRefresh = debounce(() => {
  void refreshMessages();
}, 220);
/** 历史 token 估算（输入框提示用） */
let contextTokens = 0;
/** @type {{id:string,role:string,content:string}|null} 当前引用 */
let quoted = null;
/** 是否正在生成回复 */
let busy = false;
/** @type {object|null} 流式 + 打字机状态 */
let stream = null;
/** 当前异步生成任务的身份；旧任务的 finally 不得清掉新任务的忙状态。 */
let activeGeneration = null;
/** 语音状态：{ queue, splitter, mode, enabled, chars, limit, cfg } */
let speech = { queue: null, splitter: null, mode: 'off', enabled: false, chars: 0, limit: 60, cfg: null };
/** 正在朗读的消息 id（STREAM_ID 表示流式临时气泡） */
let speakingMsgId = '';
/** @type {ReturnType<typeof setInterval>|null} 时间感知提示的定时刷新 */
let clockTimer = null;
/** 移动端返回按钮的显隐监听（窄屏才挂） */
let backWatcher = null;
/** @type {MediaQueryList|null} */
let mediaWatcher = null;
/** 语音输入状态 */
const sttState = { rec: null, base: '', final: '', active: false };
/** 是否已挂载 bus 订阅 */
let wired = false;
/** 防止开场白并发写入 */
let greetingBusy = false;

/** 草稿延迟写盘（每个角色一个草稿 key） */
const saveDraftSoon = debounce((charId, text) => {
  if (!charId) return;
  if (text) writeLS(`aichat.draft.${charId}`, text);
  else removeLS(`aichat.draft.${charId}`);
}, 350);

/* ================================================================== *
 * 3. 小工具
 * ================================================================== */

/**
 * 读 localStorage（受限环境静默返回默认值）
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
/** 写 localStorage */
/** 删 localStorage */
/** 当前角色对象（可能为 null） */
function curChar() {
  return ctxRef && ctxRef.currentChar ? ctxRef.currentChar : null;
}

/** 当前角色 id（可能为空串） */
function curId() {
  return (ctxRef && ctxRef.currentCharId) || '';
}

/** 当前设置（ctx 给的是 getter，每次取最新值） */
function curSettings() {
  return (ctxRef && ctxRef.settings) || {};
}

/** 角色主题色 */
function charColor(char) {
  return (char && char.color) || '#6c8cff';
}

/** 我方显示名 */
function userName() {
  const s = curSettings();
  return (s.user && s.user.name) || '我';
}

/** 朗读开关的 localStorage 键 */
function voiceKey(charId) {
  return `aichat.voiceOn.${charId}`;
}

/** 是否开启该角色的朗读（默认开） */
function voiceOnFor(charId) {
  return readLS(voiceKey(charId), '1') !== '0';
}

/** 情绪英文 → 中文 */
function emotionLabel(e) {
  return EMOTION_LABEL[e] || '';
}

/** 模型名瘦身显示（去掉过长的日期后缀） */
function shortModel(m) {
  const t = String(m || '');
  return t.length > 26 ? `${t.slice(0, 24)}…` : t;
}

/** 文件名安全化 */
function safeName(s) {
  return String(s || '角色').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '角色';
}

/** 左侧返回（移动端） */
function backToList() {
  if (ctxRef && typeof ctxRef.openChat === 'function') ctxRef.openChat(null);
}

/** 重新载入角色列表 + 刷新侧边栏 */
async function reloadChars() {
  try {
    if (ctxRef && typeof ctxRef.reloadCharacters === 'function') await ctxRef.reloadCharacters();
  } catch {
    /* 忽略 */
  }
  try {
    if (ctxRef && typeof ctxRef.rerender === 'function') ctxRef.rerender('sidebar');
  } catch {
    /* 忽略 */
  }
}

/**
 * 构造头像节点（有图用图，没图用 emoji / 首字）
 * 结构对齐 styles/app.css 的 .avatar 系列。
 * @param {object} char
 * @param {'sm'|'lg'|'xl'|''} size sm=32px、空=40px、lg=56px、xl=76px
 * @param {boolean} [presence] 是否带在线小圆点
 * @returns {HTMLElement}
 */
/** 填充头像内容（切换角色时复用同一个容器） */
/**
 * 更新移动端返回按钮的显隐（契约：宽度 < 760px 才出现）。
 * 与 ui/app.js 的 MOBILE_BREAKPOINT(760) 保持一致；监听只挂一次，
 * 这样从宽屏缩到窄屏 / 横竖屏切换时也能立刻出现。
 */
function syncBackButton() {
  if (!backBtn) return;
  let narrow = false;
  try {
    narrow = window.innerWidth < 760;
  } catch {
    narrow = false;
  }
  backBtn.style.display = narrow ? '' : 'none';

  if (!backWatcher) {
    backWatcher = () => syncBackButton();
    try {
      window.addEventListener('resize', backWatcher);
      window.addEventListener('orientationchange', backWatcher);
    } catch {
      /* 忽略 */
    }
    try {
      mediaWatcher = window.matchMedia('(max-width: 759.98px)');
      if (mediaWatcher.addEventListener) mediaWatcher.addEventListener('change', backWatcher);
    } catch {
      /* 忽略 */
    }
  }
}

/** 简单的图标按钮（extraClass 支持多个类名，空格分隔） */
function iconBtn(name, title, onClick, size = 18, extraClass = '') {
  const btn = el(
    'button.icon-btn',
    { type: 'button', title, attr: { 'aria-label': title }, on: { click: onClick } },
    icon(name, size)
  );
  if (extraClass) {
    String(extraClass)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => btn.classList.add(c));
  }
  return btn;
}

/** 状态行文案：在线 · 好感度 亲近 68 / 消息免打扰 */
function statusText(char) {
  if (!char) return '';
  if (char.muted) return '消息免打扰';
  const rt = getRuntime(char.id);
  const v = Math.round(num(rt.affinity, 0));
  return `在线 · 好感度 ${affinityLabel(v)} ${v}`;
}

/** 时间感知提示："现在是晚上 21:14，你们上次聊天是昨天" */
function timeHintText(char) {
  if (!char) return '';
  const tc = timeContext();
  const hh = String(tc.hour).padStart(2, '0');
  const mm = String(tc.minute).padStart(2, '0');
  const rt = getRuntime(char.id);
  let gap = '这是你们的第一次对话。';
  if (rt.lastChatAt) {
    const d = gapDescription(rt.lastChatAt);
    gap = d.endsWith('。') ? d.slice(0, -1) : d;
  }
  return `现在是${tc.partOfDay} ${hh}:${mm}，${gap}`;
}

/** 时间感知里的"上次聊天"用相对时间再补一嘴（工具函数保留给搜索面板使用） */
function lastSeenText(ts) {
  return ts ? relTime(ts) : '还没有聊过';
}

/**
 * 安全的错误文案（中文）
 * @param {any} err
 * @returns {string}
 */
function humanizeError(err) {
  const msg = String((err && err.message) || err || '');
  if ((err && err.name === 'AbortError') || /abort/i.test(msg)) return '已停止生成。';
  try {
    if (llmErrors && typeof llmErrors.humanize === 'function') {
      const t = llmErrors.humanize(err);
      if (t) return String(t);
    }
  } catch {
    /* 忽略：humanize 内部异常不应影响主流程 */
  }
  return msg || '生成失败，请稍后重试。';
}

/* ================================================================== *
 * 4. 对外导出
 * ================================================================== */

/**
 * 渲染整个聊天区（契约 3.14）。
 * 切换角色时 ui/app.js 会重新调用本函数，因此这里会重置所有会话级状态。
 * @param {HTMLElement} root 容器（会被清空并填充）
 * @param {object} ctx ui/app.js 提供的上下文
 */
export function renderChat(root, ctx) {
  if (!root) return;
  scheduleRefresh.cancel();
  // 先停掉上一轮：流式、朗读、语音输入、定时器
  stopStream(true, true);
  stopStt(true);
  resetSpeech();
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }

  ctxRef = ctx || null;
  rootEl = root;
  messages = [];
  historyPager.reset();
  notices = [];
  contextTokens = 0;
  quoted = null;
  speakingMsgId = '';
  greetingBusy = false;

  wireBus();
  clear(root);
  root.classList.add('chat');
  root.setAttribute('style', STY.chat);

  const char = curChar();
  if (!char) {
    renderPlaceholder(root);
    return;
  }

  initCharacterRuntime(char);
  markRead(char.id);

  headEl = buildHead(char);
  // 顶栏收起时露出的细拉手：平时 display:none，由 .shell.head-collapsed 打开；
  // 窄屏时它左半边还会带一个「返回列表」（顶栏里的返回键跟着顶栏一起被收起了）
  const restoreBar = headRestoreBar(() => ctxCall(ctxRef, 'toggleChatHead'), backToList);
  listEl = el('div.chat-body', { style: STY.list, attr: { 'aria-label': '消息列表' } });
  // 滚动时切换"回到最新"按钮
  listEl.addEventListener('scroll', () => syncJumpButton(), { passive: true });
  jumpBtn = el(
    'button.chat-jump',
    { type: 'button', title: '回到最新', attr: { 'aria-label': '回到最新' }, on: { click: () => scrollToBottom(listEl, true) } },
    icon('chevron-down', 18)
  );
  const composer = buildComposer(char);
  mount(root, headEl, restoreBar, listEl, composer, jumpBtn);
  bindListEvents();
  syncBackButton();

  loadConversation(char).catch((err) => console.warn('[chat] 载入会话失败', err));
  updateHint();

  // 时间感知每分钟刷新一次（"现在是晚上 21:14" 要跟着走）
  clockTimer = setInterval(() => {
    if (!rootEl || !rootEl.isConnected || !timeHintEl) return;
    const c = curChar();
    if (c) timeHintEl.textContent = timeHintText(c);
  }, 60000);
}

/**
 * 重新渲染消息流（契约 3.14）。外部（侧边栏 / 主动消息 / 设置面板）可调用。
 * @returns {Promise<void>}
 */
export async function refreshMessages(opts = {}) {
  scheduleRefresh.cancel();
  const charId = curId();
  if (!ctxRef || !listEl || !charId) return;
  // 面板已被替换（切到了群聊）：模块级的 bus 订阅仍在，但不能再对已分离的 DOM 做重绘
  if (rootEl && !rootEl.isConnected) return;
  let list = messages;
  try {
    list = await historyPager.read(charId, opts);
    if (!list) return;
  } catch (err) {
    // 读取失败时保留当前内存中的消息，至少不让界面空白
    console.warn('[chat] 读取消息失败', err);
  }
  // 期间可能已经切换了会话
  if (curId() !== charId) return;
  const follow = isNearBottom(listEl, 260);
  const scrollTop = listEl.scrollTop;
  messages = Array.isArray(list) ? list : [];
  renderMessages();
  if (follow) scrollToBottom(listEl, false);
  else listEl.scrollTop = scrollTop;
  updateHint();
}

/**
 * 插入一条系统提示气泡（不落库，契约 3.14）。
 * @param {string} text
 */
export function appendLocalNotice(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return;
  notices.push({ id: createId('n'), text: t, at: Date.now() });
  if (listEl) {
    const follow = isNearBottom(listEl, 200);
    renderMessages();
    if (follow) scrollToBottom(listEl, true);
  }
}

/**
 * 搜索结果片段：把命中处用 <mark> 高亮。
 * 全部用 el() 组装文本节点，绝不拼接 innerHTML（用户内容不解析为 HTML）。
 * @param {string} text 消息原文
 * @param {string} kw 关键词
 * @returns {HTMLElement}
 */
function snippetNode(text, kw) {
  const src = String(text || '');
  const k = String(kw || '');
  const wrap = el('div.h-text');
  const klow = k.toLowerCase();
  const low = src.toLowerCase();
  const first = klow ? low.indexOf(klow) : -1;
  const from = first > 40 ? first - 40 : 0;
  const body = src.slice(from, from + 200);

  if (from > 0) wrap.appendChild(el('span', { text: '…' }));
  if (!klow) {
    wrap.appendChild(el('span', { text: body }));
  } else {
    const lowBody = body.toLowerCase();
    let i = 0;
    let guard = 0;
    while (i <= body.length && guard++ < 500) {
      const j = lowBody.indexOf(klow, i);
      if (j < 0) {
        if (i < body.length) wrap.appendChild(el('span', { text: body.slice(i) }));
        break;
      }
      if (j > i) wrap.appendChild(el('span', { text: body.slice(i, j) }));
      wrap.appendChild(el('mark', { text: body.slice(j, j + k.length) }));
      i = j + k.length;
    }
  }
  if (from + 200 < src.length) wrap.appendChild(el('span', { text: '…' }));
  return wrap;
}

/**
 * 会话内搜索（契约 3.14）。
 * 关键词 → searchMessages → 结果列表 → 点击滚动并闪烁高亮。
 */
export function openSearchDialog() {
  const charId = curId();
  const char = curChar();
  if (!charId || !char) {
    toast('先打开一位好友的会话，再搜索聊天记录', 'warn');
    return;
  }

  const input = el('input.input', {
    type: 'search',
    placeholder: `在 ${char.name} 的聊天记录里搜索…`,
  });
  const summary = el('div.muted.small', { text: '输入关键词开始搜索' });
  const results = el('div.search-results');
  const body = el('div', el('div.search-bar', input), summary, results);

  const m = modal({
    title: `会话内搜索 · ${char.name}`,
    body,
    width: 580,
    actions: [{ text: '关闭' }],
  });

  /**
   * 渲染一条搜索结果（.hit + .h-main/.h-top/.h-text）
   * @param {object} msg
   * @param {string} kw
   */
  const hit = (msg, kw) => {
    const roleName = msg.role === 'user' ? userName() : msg.role === 'assistant' ? char.name : '系统';
    const avatar = avatarNode(msg.role === 'user' ? { name: userName(), avatar: (curSettings().user || {}).avatar || '🙂' } : char, 'sm');
    return el(
      'button.hit',
      {
        type: 'button',
        on: {
          click: () => {
            m.close();
            setTimeout(() => focusMessage(msg.id), 160);
          },
        },
      },
      avatar,
      el(
        'div.h-main',
        el(
          'div.h-top',
          el('b', { text: roleName }),
          el('span', { text: fmtDate(msg.at) }),
          el('span', { text: lastSeenText(msg.at) })
        ),
        snippetNode(msg.content, kw)
      )
    );
  };

  const runSearch = async () => {
    const kw = String(input.value || '').trim();
    clear(results);
    if (!kw) {
      summary.textContent = '输入关键词开始搜索';
      return;
    }
    summary.textContent = '搜索中…';
    let list = [];
    try {
      list = await searchMessages(charId, kw);
    } catch (err) {
      summary.textContent = '搜索失败，请重试';
      console.warn('[chat] 搜索失败', err);
      return;
    }
    if (curId() !== charId) return;
    summary.textContent = list.length ? `找到 ${list.length} 条` : '没有找到匹配的消息';
    for (const msg of list.slice(0, 80)) results.appendChild(hit(msg, kw));
    if (!list.length) {
      results.appendChild(el('div.muted.small', { text: '换个词试试，或者搜角色的口头禅？' }));
    }
  };

  const debounced = debounce(runSearch, 240);
  input.addEventListener('input', () => debounced());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      debounced.cancel();
      runSearch();
    }
  });
  setTimeout(() => input.focus(), 80);
}

/* ================================================================== *
 * 5. 顶部栏
 * ================================================================== */

/**
 * 构建顶部栏（结构对齐 styles/app.css 的 .chat-head）
 * @param {object} char
 * @returns {HTMLElement}
 */
function buildHead(char) {
  backBtn = iconBtn('arrow-left', '返回列表', backToList, 20, 'chat-back');
  avatarEl = avatarNode(char, '', true);
  avatarEl.style.cursor = 'pointer';
  avatarEl.addEventListener('click', () => openEditor(char));

  statusDot = el('span.status-dot', { class: char.muted ? 'off' : '' });
  statusEl = el('span', { text: statusText(char), class: 'chat-status-text' });
  const nameEl = el('div.chat-head-name', { text: char.name });
  const main = el(
    'div.chat-head-main',
    nameEl,
    el('div.chat-head-status', statusDot, statusEl)
  );

  voiceBtn = iconBtn(voiceOnFor(char.id) ? 'speaker' : 'speaker-off', '朗读开关', () => toggleVoice());
  const tools = el(
    'div.chat-head-tools',
    iconBtn('search', '搜索聊天记录', () => openSearchDialog()),
    voiceBtn,
    iconBtn('user', '角色卡', () => openEditor(char)),
    // 收起顶栏：整条让给消息区，中栏顶部留一条细拉手可以再拉开
    // （右栏的开关在右栏自己右上角，是个叉；收起后中栏右边缘会出现竖拉手）
    twoStateIconBtn('chevron-up', 'chevron-down', '收起顶栏', () => ctxCall(ctxRef, 'toggleChatHead'), 'head'),
    iconBtn('more', '更多', () => openMoreMenu(char))
  );

  return el('header.chat-head', backBtn, avatarEl, main, tools);
}

/** 就地刷新顶部栏（好感度、免打扰、朗读开关变化时用） */
function renderHead(char) {
  if (!char) return;
  if (statusEl) statusEl.textContent = statusText(char);
  if (statusDot) statusDot.classList.toggle('off', !!char.muted);
  if (avatarEl) fillAvatar(avatarEl, char);
  if (voiceBtn) {
    clear(voiceBtn);
    voiceBtn.appendChild(icon(voiceOnFor(char.id) ? 'speaker' : 'speaker-off', 18));
  }
  if (timeHintEl) timeHintEl.textContent = timeHintText(char);
}

/** 打开角色卡编辑器（右栏 / 弹层由 editor.js 负责） */
function openEditor(char) {
  try {
    openCharacterEditor(char || null);
  } catch (err) {
    toast(`打开角色卡失败：${(err && err.message) || err}`, 'error');
  }
}

/** 朗读开关（按角色记忆） */
function toggleVoice() {
  const char = curChar();
  if (!char) return;
  const next = !voiceOnFor(char.id);
  writeLS(voiceKey(char.id), next ? '1' : '0');
  if (!next) {
    // 关掉朗读时立刻打断正在念的内容
    if (speech.queue) {
      try {
        speech.queue.stop();
      } catch {
        /* 忽略 */
      }
    }
    stopSpeaking();
    clearSpeakingHighlight();
    speakingMsgId = '';
  }
  renderHead(char);
  toast(next ? '已开启朗读' : '已关闭朗读', 'info');
}

/** 更多菜单：清空 / 导出 / 置顶 / 免打扰 / 编辑 / 删除 */
function openMoreMenu(char) {
  actionSheet({
    title: char.name,
    items: [
      { text: '编辑角色卡', icon: 'edit', onClick: () => openEditor(char) },
      { text: char.pinned ? '取消置顶' : '置顶该好友', icon: 'pin', onClick: () => togglePin() },
      { text: char.muted ? '取消免打扰' : '消息免打扰', icon: char.muted ? 'bell' : 'belloff', onClick: () => toggleMute() },
      { text: '导出聊天为 JSON', icon: 'download', onClick: () => exportChat('json') },
      { text: '导出聊天为 Markdown', icon: 'download', onClick: () => exportChat('md') },
      { text: '清空聊天记录', icon: 'trash', danger: true, onClick: () => clearChat() },
      { text: '删除角色', icon: 'trash', danger: true, onClick: () => removeChar() },
    ],
  });
}

/* ================================================================== *
 * 6. 消息流渲染
 * ================================================================== */

/** 无角色时的占位 */
function renderPlaceholder(root) {
  headEl = null;
  avatarEl = null;
  statusEl = null;
  statusDot = null;
  backBtn = null;
  voiceBtn = null;
  listEl = null;
  inputEl = null;
  sendBtn = null;
  micBtn = null;
  jumpBtn = null;
  footEl = null;
  phrasePanel = null;
  hintEl = null;
  hintCtxEl = null;
  timeHintEl = null;
  quoteBarEl = null;
  sttLiveEl = null;
  mount(
    root,
    el(
      'div.empty',
      el('div.big', { text: '💬' }),
      el('h3', { text: '还没有选择好友' }),
      el('div.muted.small', { text: '从左侧通讯录里点一个名字，开始你们的对话。' })
    )
  );
}

/** 渲染整个消息流（消息 + 本地提示 + 日期分割线 + 流式临时气泡） */
function renderMessages() {
  if (!listEl) return;
  const entries = historyPager.olderEntry(listEl, refreshMessages);
  const char = curChar() || {};
  const profile = JSON.stringify([char.name, char.avatar, char.emoji, char.color, curSettings().user?.name, curSettings().user?.avatar]);

  // 历史 token 估算（供输入框上方提示）
  contextTokens = 0;
  for (const m of messages) contextTokens += estimateTokens(m.content || '');

  if (!messages.length && !notices.length) {
    entries.push({ key: 'empty', value: profile, create: renderEmpty });
    if (stream?.node) entries.push({ key: 'stream', node: stream.node });
    reconcileMessageList(listEl, entries);
    return;
  }

  const items = messages
    .map((m) => ({ kind: 'msg', at: num(m.at, Date.now()), msg: m }))
    .concat(notices.map((n) => ({ kind: 'notice', at: num(n.at, Date.now()), notice: n })))
    .sort((a, b) => a.at - b.at);

  let prevAt = 0;
  const lastAssistantId = findLastAssistantId();
  for (const item of items) {
    if (!prevAt || !isSameDay(prevAt, item.at)) {
      const day = fmtDay(item.at);
      entries.push({ key: `day:${day}`, value: day, create: () => el('div.day-line', { text: day }) });
    }
    prevAt = item.at;
    if (item.kind === 'notice') entries.push({ key: `n:${item.notice.id}`, value: item.notice.text, create: () => renderNotice(item.notice) });
    else entries.push({ key: `m:${item.msg.id}`, value: JSON.stringify(item.msg) + profile + (item.msg.id === lastAssistantId) + (speakingMsgId === item.msg.id), create: () => renderMessage(item.msg, lastAssistantId) });
  }

  // 流式中的临时气泡永远在最下方
  if (stream?.node) entries.push({ key: 'stream', node: stream.node });
  reconcileMessageList(listEl, entries);
  syncJumpButton();
}

/** 空会话：大 emoji + 名字 + tagline + 开场建议（结构对齐 .empty / .suggest） */
function renderEmpty() {
  const char = curChar();
  if (!char) return el('div');
  const box = el('div.empty');
  box.appendChild(el('div.big', { text: char.emoji || '🙂' }));
  box.appendChild(el('h3', { text: char.name }));
  if (char.tagline) box.appendChild(el('div.muted.small', { text: char.tagline }));
  box.appendChild(el('div.muted.small', { text: '你们还没有聊过，从下面的一句话开始吧。' }));

  const sugs = el('div.suggest');
  for (const text of suggestionsFor(char)) {
    sugs.appendChild(
      el('button.sug-btn', {
        type: 'button',
        text,
        dataset: { act: 'suggest', text },
        title: '点一下填进输入框',
      })
    );
  }
  box.appendChild(sugs);
  return box;
}

/**
 * 根据角色标签生成开场建议
 * @param {object} char
 * @returns {string[]}
 */
function suggestionsFor(char) {
  const out = [`${char.name}，在忙吗？`, '今天过得怎么样？'];
  for (const tag of (char.tags || []).slice(0, 2)) out.push(`聊聊你的「${tag}」吧`);
  out.push('给我讲讲你的故事');
  return out.slice(0, 4);
}

/** 本地提示（不落库）：复用系统消息样式 */
function renderNotice(notice) {
  return el('div.msg.sys.local-notice', { text: notice.text });
}

/** 系统消息（/ooc、/roll 等）：居中灰字 */
function renderSystemMessage(msg) {
  return el('div.msg.sys', { dataset: { mid: msg.id } }, el('span', { text: msg.content || '' }));
}

/**
 * 渲染单条消息
 * @param {object} msg
 * @param {string} lastAssistantId 最后一条 assistant 消息 id（"重新生成"只对它开放）
 * @returns {HTMLElement}
 */
function renderMessage(msg, lastAssistantId = '') {
  const char = curChar();
  if (!char) return el('div');
  if (msg.role === 'system') return renderSystemMessage(msg);

  const isUser = msg.role === 'user';
  const isAction = isUser && /^\/me\s+/i.test(msg.content || '');
  const isError = msg.status === 'error';
  const row = el('div.msg', {
    dataset: { mid: msg.id },
    class: [
      isUser ? 'me' : 'ai',
      isAction ? 'action' : '',
      msg.bookmarked ? 'bookmarked' : '',
      speakingMsgId === msg.id ? 'speaking' : '',
    ]
      .filter(Boolean)
      .join(' '),
    // 角色主题色：样式表里 .msg.ai .bub 用它画左侧细竖线
    style: { '--char-color': charColor(char) },
  });

  // 头像：我方用全局用户头像（设置 → 我的资料），角色用角色头像
  // 用户头像可能是图片 / emoji / 空（空则回退 🙂）：不能传 emoji:'🙂'，
  // 否则 entityEmoji 会优先取它，用户设的 emoji 头像永远显示不出来。
  const avatar = isUser
    ? avatarNode({ name: userName(), avatar: (curSettings().user || {}).avatar || '🙂' }, 'sm')
    : avatarNode(char, 'sm');
  avatar.classList.add('msg-av');
  row.appendChild(avatar);

  const col = el('div.msg-wrap');

  // 引用块（在气泡上方，点击跳回原消息）
  if (msg.quoted && msg.quoted.content) {
    const q = msg.quoted;
    const who = q.role === 'user' ? userName() : q.role === 'assistant' ? char.name : '系统';
    col.appendChild(
      el('div.quoted-block', {
        dataset: { act: 'goto', goto: q.id || '' },
        title: '点击跳转到原消息',
        text: `${who}：${truncate(q.content, 60)}`,
      })
    );
  }

  // 气泡
  const bubbleText = isAction ? String(msg.content).replace(/^\/me\s+/i, '') : msg.content || '';
  const bubble = el('div.bub', { class: isError ? 'error' : '' });

  if (isError) {
    // 失败的消息：错误文案 + 重试按钮（内容为空时直接用错误文案占位）
    if (bubbleText) {
      bubble.appendChild(el('div.bubble-text', { text: bubbleText }));
      bubble.appendChild(
        el('div.bubble-text.error-text', { class: 'muted', text: msg.error || '生成失败' })
      );
    } else {
      bubble.appendChild(
        el('div.bubble-text.error-text', { class: 'muted', text: msg.error || '生成失败' })
      );
    }
    bubble.appendChild(
      el('button.link-btn.retry-btn', {
        type: 'button',
        text: '重试',
        class: 'btn btn-sm',
        dataset: { act: 'retry' },
      })
    );
  } else {
    bubble.appendChild(el('div.bubble-text', { text: bubbleText }));
  }
  col.appendChild(bubble);

  // 多版本切换：◀ 2/3 ▶
  const v = msg.variants;
  if (v && Array.isArray(v.list) && v.list.length > 1) {
    const idx = clamp(num(v.index, 0), 0, v.list.length - 1);
    const varBtn = (act, ic, title) =>
      el(
        'button.icon-btn',
        { type: 'button', title, attr: { 'aria-label': title }, dataset: { act } },
        icon(ic, 14)
      );
    col.appendChild(
      el(
        'div.variant-nav',
        varBtn('var-prev', 'chevron-left', '上一个版本'),
        el('span', { text: `${idx + 1}/${v.list.length}` }),
        varBtn('var-next', 'chevron-right', '下一个版本')
      )
    );
  }

  // 元信息：时间 / 情绪 / 模型 / token
  const meta = el('div.msg-meta');
  meta.appendChild(el('span.msg-time', { text: fmtTime(msg.at) }));
  if (!isUser) {
    if (msg.emotion && emotionLabel(msg.emotion)) {
      meta.appendChild(el('span.emo.msg-emotion', { text: emotionLabel(msg.emotion) }));
    }
    if (msg.model) meta.appendChild(el('span.msg-model', { text: shortModel(msg.model), title: msg.model }));
    if (msg.usage && num(msg.usage.total, 0) > 0) {
      meta.appendChild(el('span.msg-usage', { text: `${Math.round(num(msg.usage.total))} tokens` }));
    }
  }
  if (msg.bookmarked) meta.appendChild(el('span.msg-mark', { text: '★ 已收藏' }));
  col.appendChild(meta);

  // 操作按钮
  col.appendChild(buildActions(msg, { isUser, isLastAssistant: msg.id === lastAssistantId }));

  row.appendChild(col);
  return row;
}

/**
 * 构建消息操作栏（.msg-tools；按钮只带 data-act，统一走消息流的点击委托）
 * 显隐由样式表控制：桌面 hover 出现，移动端（hover:none）常显。
 * @param {object} msg
 * @param {{isUser:boolean,isLastAssistant:boolean}} flags
 * @returns {HTMLElement}
 */
function buildActions(msg, flags) {
  const bar = el('div.msg-tools');
  for (const a of MSG_ACTIONS) {
    if (a.only === 'user' && !flags.isUser) continue;
    if (a.only === 'lastAssistant' && !flags.isLastAssistant) continue;
    if (msg.status === 'error' && a.act === 'regen') continue;
    const active = a.act === 'bookmark' && msg.bookmarked;
    const ic = active ? 'bookmark-on' : a.ic;
    bar.appendChild(
      el(
        'button.icon-btn.msg-act',
        {
          type: 'button',
          title: a.title,
          class: active ? 'on' : '',
          attr: { 'aria-label': a.title },
          dataset: { act: a.act },
        },
        icon(ic, 15)
      )
    );
  }
  return bar;
}

/** 找到最后一条 assistant 消息 id（"重新生成"只对它开放） */
function findLastAssistantId() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id;
  }
  return '';
}

/** 消息流事件委托（所有按钮共用一个入口） */
function bindListEvents() {
  if (!listEl) return;
  on(listEl, 'click', '[data-act]', (e, target) => {
    const act = target.dataset.act;
    if (act === 'suggest') {
      insertText(target.dataset.text || '');
      return;
    }
    if (act === 'goto') {
      focusMessage(target.dataset.goto || '');
      return;
    }
    const row = target.closest('[data-mid]');
    const id = row ? row.dataset.mid : '';
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    switch (act) {
      case 'copy':
        copyMessage(msg);
        break;
      case 'speak':
        speakMessage(msg);
        break;
      case 'quote':
        quoteMessage(msg);
        break;
      case 'edit':
        editMessage(msg);
        break;
      case 'regen':
        regenerate(msg);
        break;
      case 'retry':
        retryMessage(msg);
        break;
      case 'bookmark':
        toggleBookmark(msg);
        break;
      case 'del':
        removeMessage(msg);
        break;
      case 'var-prev':
        switchVariant(msg, -1);
        break;
      case 'var-next':
        switchVariant(msg, 1);
        break;
      default:
        break;
    }
  });
}

/**
 * "回到最新"悬浮按钮的显隐（样式表用 .chat-jump.on 控制显示）
 * 与"只在接近底部时自动跟随"配合：用户翻看历史时按钮出现。
 */
function syncJumpButton() {
  if (!jumpBtn || !listEl) return;
  const near = isNearBottom(listEl, 180);
  jumpBtn.classList.toggle('on', !near);
}

/**
 * 滚动到某条消息并闪烁高亮。
 * 导出给 `ui/app.js` 用（搜索命中、收藏夹跳转都走它；app.js 里另有一份 DOM 兜底）。
 * @param {string} id
 */
export async function focusMessage(id) {
  if (!id || !listEl) return;
  if (!messages.some((m) => m.id === id)) await refreshMessages({ includeId: id });
  const nodes = listEl.querySelectorAll('[data-mid]');
  let node = null;
  for (const n of nodes) {
    if (n.dataset.mid === id) {
      node = n;
      break;
    }
  }
  if (!node) {
    toast('这条消息不在当前会话里', 'warn');
    return;
  }
  node.classList.add('flash-highlight');
  try {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    node.scrollIntoView();
  }
  setTimeout(() => node.classList.remove('flash-highlight'), 1800);
}

/* ================================================================== *
 * 7. 消息操作
 * ================================================================== */

/** 复制消息文本 */
async function copyMessage(msg) {
  const ok = await copyText(msg.content || '');
  toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'ok' : 'error');
}

/** 引用回复：输入框上方出现引用条 */
function quoteMessage(msg) {
  quoted = { id: msg.id, role: msg.role, content: msg.content || '' };
  renderQuoteBar();
  if (inputEl) inputEl.focus();
}

/** 编辑我方消息 */
async function editMessage(msg) {
  const next = await promptDialog({
    title: '编辑消息',
    label: '改完按 Ctrl/Cmd + Enter 保存',
    value: msg.content || '',
    multiline: true,
  });
  if (next == null || next === msg.content) return;
  try {
    await updateMessage(msg.id, { content: next });
    await refreshMessages();
    toast('已更新', 'ok');
  } catch (err) {
    toast(`保存失败：${(err && err.message) || err}`, 'error');
  }
}

/** 收藏 / 取消收藏 */
async function toggleBookmark(msg) {
  try {
    await updateMessage(msg.id, { bookmarked: !msg.bookmarked });
    await refreshMessages();
    toast(msg.bookmarked ? '已取消收藏' : '已收藏这条消息', 'ok');
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

/** 删除单条消息 */
async function removeMessage(msg) {
  const ok = await confirmDialog({
    title: '删除这条消息？',
    message: '删除后无法恢复（角色卡与其它消息不受影响）。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteMessage(msg.id);
    await refreshMessages();
  } catch (err) {
    toast(`删除失败：${(err && err.message) || err}`, 'error');
  }
}

/**
 * 多版本切换
 * @param {object} msg
 * @param {number} dir -1 上一个 / 1 下一个
 */
async function switchVariant(msg, dir) {
  const v = msg.variants;
  if (!v || !Array.isArray(v.list) || v.list.length < 2) return;
  const n = v.list.length;
  const idx = (((num(v.index, 0) + dir) % n) + n) % n;
  try {
    await updateMessage(msg.id, { variants: { list: v.list, index: idx }, content: v.list[idx] });
    await refreshMessages();
  } catch (err) {
    toast(`切换版本失败：${(err && err.message) || err}`, 'error');
  }
}

/** 重新生成（走多版本：旧内容保留在 variants.list 里） */
async function regenerate(msg) {
  if (busy) {
    toast('正在生成中，先点停止或等它说完', 'warn');
    return;
  }
  if (msg.status === 'error') {
    retryMessage(msg);
    return;
  }
  await generateReply({ mode: 'regen', target: msg, userText: lastUserTextBefore(msg) });
}

/** 重试失败的消息 */
async function retryMessage(msg) {
  if (busy) {
    toast('正在生成中，先点停止或等它说完', 'warn');
    return;
  }
  await generateReply({ mode: 'retry', target: msg, userText: lastUserTextBefore(msg) });
}

/**
 * 取某条消息之前最近的一条用户消息文本（情绪识别 / 提示词用）
 * @param {object} msg
 * @returns {string}
 */
function lastUserTextBefore(msg, history = messages) {
  const idx = history.findIndex((m) => m.id === msg.id);
  const from = idx < 0 ? history.length : idx;
  for (let i = from - 1; i >= 0; i--) {
    if (history[i].role === 'user') return history[i].content || '';
  }
  return '';
}

/* ================================================================== *
 * 8. 输入区
 * ================================================================== */

/**
 * 构建输入区（结构对齐 .chat-foot / .input-row / .input-side / .chat-foot-bar）
 * @param {object} char
 * @returns {HTMLElement}
 */
function buildComposer(char) {
  footEl = el('div.chat-foot');

  // 引用条（.quoted-bar + .q-text，紧贴输入框上方）
  quoteBarEl = el('div.quoted-bar', { style: 'display:none' });
  footEl.appendChild(quoteBarEl);

  inputEl = el('textarea.composer-input', {
    id: 'composerInput',
    rows: 1,
    placeholder: `和 ${char.name} 说点什么…`,
    attr: { 'aria-label': `给 ${char.name} 发消息` },
  });
  inputEl.value = readLS(`aichat.draft.${char.id}`, '');
  inputEl.addEventListener('input', () => {
    saveDraftSoon(char.id, inputEl.value);
    updateHint();
  });
  inputEl.addEventListener('keydown', onComposerKey);
  autoGrow(inputEl, 180);

  // 语音输入中的实时文字（红色 pill）
  sttLiveEl = el('span.pill.rec.stt-live', { style: 'display:none' });
  // 输入框上方与底部提示条的三个 pill
  hintEl = el('span.pill', { text: '约 0 tokens' });
  hintCtxEl = el('span.pill', { text: '上下文 0/40 条' });
  timeHintEl = el('span.pill.time-hint', { text: timeHintText(char) });

  const phraseBtn = iconBtn('smile', '快捷短语 / 常用表达', () => togglePhrases());
  micBtn = iconBtn('mic', '语音输入', () => toggleStt(), 18, 'mic-btn');
  const clearBtn = iconBtn('close', '清空输入', () => clearInputText(), 16);
  sendBtn = el(
    'button.btn.btn-primary.send-btn',
    {
      id: 'sendBtn',
      type: 'button',
      title: '发送',
      attr: { 'aria-label': '发送' },
      on: { click: () => (busy ? stopStream(false) : sendCurrent()) },
    },
    icon('send', 18)
  );
  updateSendBtn();

  const side = el('div.input-side', phraseBtn, micBtn, clearBtn, sendBtn);
  // 输入框"上方"：token 预估 + 上下文预算（契约要求）
  // .above-input 只给这一条加下边距：否则它会紧贴输入框，被边框和聚焦光晕压住
  footEl.appendChild(el('div.chat-foot-bar.above-input', hintEl, hintCtxEl));
  footEl.appendChild(el('div.input-row', inputEl, side));

  // 快捷短语面板（.phrase-panel，默认收起）
  phrasePanel = el('div.phrase-panel', { style: 'display:none' });
  footEl.appendChild(phrasePanel);

  // 底部提示：语音识别实时文字 + 角色时间感知
  footEl.appendChild(el('div.chat-foot-bar', sttLiveEl, timeHintEl));

  renderQuoteBar();
  return footEl;
}

/** 发送键：settings.sendKey === 'enter' | 'mod-enter' */
function onComposerKey(e) {
  // 中文输入法组词中的回车不算发送
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape' && quoted) {
    quoted = null;
    renderQuoteBar();
    return;
  }
  if (e.key !== 'Enter') return;
  const s = curSettings();
  const modSend = s.sendKey === 'mod-enter';
  const withMod = e.ctrlKey || e.metaKey;
  if (modSend ? withMod : !e.shiftKey && !withMod) {
    e.preventDefault();
    sendCurrent();
  }
}

/** 引用条渲染（.quoted-bar + .q-text） */
function renderQuoteBar() {
  if (!quoteBarEl) return;
  clear(quoteBarEl);
  if (!quoted) {
    quoteBarEl.style.display = 'none';
    return;
  }
  quoteBarEl.style.display = '';
  const char = curChar();
  const who = quoted.role === 'user' ? userName() : quoted.role === 'assistant' ? (char ? char.name : '角色') : '系统';
  quoteBarEl.appendChild(el('span', { text: `引用 ${who}：`, class: 'muted' }));
  quoteBarEl.appendChild(el('span.q-text', { text: truncate(quoted.content, 80) }));
  quoteBarEl.appendChild(
    iconBtn('close', '取消引用', () => {
      quoted = null;
      renderQuoteBar();
    }, 14)
  );
}

/** 输入框下方的 token / 上下文提示（.chat-foot-bar .pill） */
function updateHint() {
  if (!hintEl || !hintCtxEl) return;
  const s = curSettings();
  const max = num((s.context || {}).maxMessages, 40);
  const budget = num((s.context || {}).budgetTokens, 8000);
  const draft = inputEl ? estimateTokens(inputEl.value || '') : 0;
  const total = draft + contextTokens;
  hintEl.textContent = `约 ${total} tokens`;
  hintEl.title = `输入约 ${draft} tokens + 历史约 ${contextTokens} tokens（估算值）`;
  hintEl.classList.toggle('warn', budget > 0 && total > budget);
  hintCtxEl.textContent = `上下文 ${messages.length}/${max} 条`;
}

/** 发送按钮在"发送/停止"之间切换 */
function updateSendBtn() {
  if (!sendBtn) return;
  clear(sendBtn);
  sendBtn.appendChild(icon(busy ? 'stop' : 'send', 18));
  sendBtn.classList.toggle('stop', busy);
  const title = busy ? '停止生成' : '发送';
  sendBtn.title = title;
  sendBtn.setAttribute('aria-label', title);
}

/** 清空输入框内容（保留其它状态） */
function clearInputText() {
  if (!inputEl) return;
  inputEl.value = '';
  inputEl.style.height = '';
  saveDraftSoon.cancel && saveDraftSoon.cancel();
  removeLS(`aichat.draft.${curId()}`);
  updateHint();
  inputEl.focus();
}

/** 发送完成后清空输入 + 引用 + 草稿 */
function clearInputAfterSend(charId) {
  // 必须撤掉挂起的去抖写盘：否则最后一次按键的 350ms 定时器会在清空之后触发，
  // 把"刚发出去的那句话"又写回 aichat.draft.<charId>，刷新后回填到输入框。
  saveDraftSoon.cancel();
  if (inputEl) {
    inputEl.value = '';
    inputEl.style.height = '';
  }
  removeLS(`aichat.draft.${charId}`);
  quoted = null;
  renderQuoteBar();
  updateHint();
}

/**
 * 在光标处插入文本（快捷短语 / 开场建议用）
 * @param {string} text
 */
function insertText(text) {
  if (!inputEl) return;
  const t = String(text == null ? '' : text);
  const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : inputEl.value.length;
  const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : inputEl.value.length;
  const before = inputEl.value.slice(0, start);
  const after = inputEl.value.slice(end);
  const space = before && !/\s$/.test(before) ? ' ' : '';
  const next = before + space + t + after;
  inputEl.value = next;
  const pos = (before + space + t).length;
  try {
    inputEl.setSelectionRange(pos, pos);
  } catch {
    /* 忽略 */
  }
  inputEl.focus();
  inputEl.style.height = '';
  inputEl.dispatchEvent(new Event('input'));
}

/** 快捷短语面板（.phrase-panel，点击展开/收起） */
function togglePhrases() {
  if (!phrasePanel) return;
  const show = phrasePanel.style.display === 'none';
  clear(phrasePanel);
  phrasePanel.style.display = show ? '' : 'none';
  if (!show) return;
  for (const p of PHRASES) {
    phrasePanel.appendChild(
      el('button.chip.phrase-chip', {
        type: 'button',
        text: p.label,
        title: p.text,
        on: { click: () => insertText(p.text) },
      })
    );
  }
}

/* ================================================================== *
 * 9. 发送 / 命令 / 流式对话
 * ================================================================== */

/** 点击"发送"：先解析命令，再决定是否请求模型 */
async function sendCurrent() {
  const char = curChar();
  if (!char || !inputEl) return;
  const raw = String(inputEl.value || '').trim();
  if (!raw) {
    toast('写点什么再发送吧', 'warn');
    return;
  }

  const makeQuote = () =>
    quoted ? { id: quoted.id, role: quoted.role, content: truncate(quoted.content, 120) } : null;

  // 命令优先：即使正在生成，/stop、/help 这类控制命令也必须能用
  if (raw[0] === '/') {
    const cmd = await runCommand(raw, char);
    if (cmd.action === 'handled') {
      clearInputAfterSend(char.id);
      return;
    }
    if (busy) {
      toast('正在回复中，可以点停止打断它', 'warn');
      return;
    }
    const quoteRef = makeQuote();
    clearInputAfterSend(char.id);
    await doSend(char, cmd.content || raw, quoteRef);
    return;
  }

  if (busy) {
    toast('正在回复中，可以点停止打断它', 'warn');
    return;
  }
  const quoteRef = makeQuote();
  clearInputAfterSend(char.id);
  await doSend(char, raw, quoteRef);
}

/**
 * 命令系统（契约：/me /ooc /roll /clear /help /stop /regen /retry）
 * @param {string} raw 原始输入
 * @param {object} char
 * @returns {Promise<{action:'handled'|'send', content?:string}>}
 */
async function runCommand(raw, char) {
  if (raw[0] !== '/') return { action: 'send' };
  const m = raw.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
  if (!m) return { action: 'send' };
  const cmd = String(m[1] || '').toLowerCase();
  const arg = String(m[2] || '').trim();

  switch (cmd) {
    case 'me':
      if (!arg) {
        toast('用法：/me 动作描述，例如 /me 揉了揉眼睛', 'warn');
        return { action: 'handled' };
      }
      // 内容保留 /me 前缀：模型能看懂，渲染时转成灰色动作行
      return { action: 'send', content: `/me ${arg}` };

    case 'ooc':
      if (!arg) {
        toast('用法：/ooc 出戏指令，例如 /ooc 请用更短的句子回答', 'warn');
        return { action: 'handled' };
      }
      await insertSystemMessage(char.id, `（出戏指令）${arg}`);
      toast('出戏指令已记录，本轮起生效', 'ok');
      return { action: 'handled' };

    case 'roll': {
      const { dice, faces, rolls, total } = rollDice(arg);
      await insertSystemMessage(char.id, `🎲 ${dice}：${rolls.join(' + ')} = ${total}`);
      return { action: 'handled' };
    }

    case 'clear':
      // clearChat() 内部带确认弹层，这里不要再确认一次
      await clearChat();
      return { action: 'handled' };

    case 'help':
      showCommandHelp();
      return { action: 'handled' };

    case 'stop':
      stopStream(false);
      return { action: 'handled' };

    case 'regen': {
      const last = (await listMessages(curId())).reverse().find((x) => x.role === 'assistant');
      if (!last) {
        toast('还没有可以重新生成的回复', 'warn');
        return { action: 'handled' };
      }
      regenerate(last);
      return { action: 'handled' };
    }

    case 'retry': {
      const err = (await listMessages(curId())).reverse().find((x) => x.status === 'error');
      if (!err) {
        toast('没有失败的回复需要重试', 'warn');
        return { action: 'handled' };
      }
      retryMessage(err);
      return { action: 'handled' };
    }

    default:
      toast(`未知命令 /${cmd}，输入 /help 查看可用命令`, 'warn');
      return { action: 'handled' };
  }
}

/**
 * 掷骰：解析 NdM
 * @param {string} arg
 * @returns {{dice:string, faces:number, rolls:number[], total:number}}
 */
function rollDice(arg) {
  const m = String(arg || '').match(/^(\d{0,2})d(\d{1,3})$/i);
  const n = m ? clamp(num(m[1], 1) || 1, 1, 20) : 1;
  const faces = m ? clamp(num(m[2], 20) || 20, 2, 1000) : 20;
  const rolls = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = 1 + Math.floor(Math.random() * faces);
    rolls.push(v);
    total += v;
  }
  return { dice: `${n}d${faces}`, faces, rolls, total };
}

/** 插入一条 system 消息（落库：会作为上下文的一部分注入本轮） */
async function insertSystemMessage(charId, text) {
  try {
    await appendMessage({ charId, role: 'system', content: text, at: Date.now() });
    await refreshMessages();
    scrollToBottom(listEl, true);
  } catch (err) {
    toast(`保存失败：${(err && err.message) || err}`, 'error');
  }
}

/** 命令帮助弹层 */
function showCommandHelp() {
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  for (const [cmd, desc] of CMD_HELP) {
    list.appendChild(
      el(
        'div',
        { style: 'display:flex;gap:10px;align-items:baseline' },
        el('code', {
          text: cmd,
          style: 'flex:0 0 108px;color:var(--accent,#6c8cff);font-size:13px',
        }),
        el('span', { text: desc, style: 'font-size:13px;color:var(--dim,#8b93a7)' })
      )
    );
  }
  modal({ title: '命令帮助', body: list, width: 460, actions: [{ text: '知道了', kind: 'primary' }] });
}

/**
 * 落库用户消息并立即渲染，然后请求模型
 * @param {object} char
 * @param {string} content
 * @param {{id:string,role:string,content:string}|null} quoteRef
 */
async function doSend(char, content, quoteRef) {
  const charId = char.id;
  try {
    await appendMessage({ charId, role: 'user', content, quoted: quoteRef, at: Date.now() });
  } catch (err) {
    // 入库失败时把用户刚打的话**放回输入框与草稿**。
    // send() 是"先清空再保存"，以前这里只弹个 toast 就 return，那句话就凭空没了，用户得重打一遍。
    restoreFailedSend(charId, content, quoteRef);
    toast(`消息保存失败：${(err && err.message) || err}（内容已留在输入框）`, 'error', 5000);
    return;
  }
  touchChat(charId);
  markRead(charId);
  await refreshMessages();
  if (isNearBottom(listEl, 300)) scrollToBottom(listEl, true);
  if (inputEl) inputEl.focus();
  if (curId() !== charId) return;
  await generateReply({ mode: 'new', userText: content, char });
}

/**
 * 发送失败后的兜底：把原文写回输入框与草稿，并恢复引用条。
 * @param {string} charId
 * @param {string} content 用户原本要发的内容
 * @param {{id:string,role:string,content:string}|null} quoteRef 当时的引用
 */
function restoreFailedSend(charId, content, quoteRef) {
  try {
    // 先撤掉挂起的去抖写盘，避免它把空的输入框写进草稿
    saveDraftSoon.cancel();
    if (inputEl) {
      inputEl.value = content;
      autoGrow(inputEl);
    }
    if (charId) writeLS(`aichat.draft.${charId}`, content);
    quoted = quoteRef || null;
    renderQuoteBar();
    updateHint();
  } catch (e) {
    /* 恢复失败也不能盖掉错误提示 */
  }
}

/** 解析本轮模型参数（角色可覆盖模型 / 预设） */
function resolveParams(char) {
  const s = curSettings();
  let params = { ...(s.params || {}) };
  const presetId = char && char.model && char.model.presetId;
  if (presetId) {
    const preset = (s.presets || []).find((p) => p.id === presetId);
    if (preset && preset.params) params = { ...params, ...preset.params };
  }
  return params;
}

/**
 * 组装本轮历史（重生成 / 重试时截断到目标消息之前）
 * @param {string} mode
 * @param {object|null} target
 * @returns {object[]}
 */
function historyFor(mode, target, history) {
  if (!target || (mode !== 'regen' && mode !== 'retry')) return history.slice();
  const idx = history.findIndex((m) => m.id === target.id);
  return idx < 0 ? history.slice() : history.slice(0, idx);
}

/**
 * 流式生成核心流程（契约 5.1）
 * @param {{mode:'new'|'regen'|'retry', target?:object, userText?:string, char?:object}} opts
 * @returns {Promise<void>}
 */
async function generateReply(opts) {
  const char = opts.char || curChar();
  const charId = char ? char.id : '';
  if (!char || !charId || curId() !== charId || busy || !listEl) return;

  const s = curSettings();
  const mode = opts.mode || 'new';
  const target = opts.target || null;
  let userText = String(opts.userText || '');

  const provider = 'ollama';
  const model = LOCAL_MODEL;
  const apiKey = '';
  const baseUrl = LOCAL_BASE_URL;

  busy = true;
  updateSendBtn();

  const st = createStreamState(char);
  stream = st;
  activeGeneration = st;
  listEl.appendChild(st.node);
  if (isNearBottom(listEl, 300)) scrollToBottom(listEl, false);

  // 语音：边写边说（失败绝不影响文字）
  startSpeech(char);

  try {
    const [memory, recentExperiences, fullHistory] = await Promise.all([
      getMemory(charId),
      getRecentExperiences(charId, { beforeAt: mode === 'new' ? undefined : target?.at }),
      listMessages(charId),
    ]);
    // 停止操作可能发生在 getMemory 尚未返回时；此时还没有 AbortController。
    if (activeGeneration !== st || stream !== st) return;
    if (target && (mode === 'regen' || mode === 'retry')) userText = lastUserTextBefore(target, fullHistory);
    const runtime = getRuntime(charId);
    const budgetTokens = num((s.context || {}).budgetTokens, 8000);
    const built = buildMessages(char, historyFor(mode, target, fullHistory), {
      settings: s,
      memory,
      recentExperiences,
      runtime,
      budgetTokens,
    });
    const sendList = built && Array.isArray(built.messages) ? built.messages : [];
    if (!sendList.length) throw new Error('上下文装配为空，检查一下角色卡设置');
    st.meta = built.meta || null;

    const controller = typeof abortController === 'function' ? abortController() : new AbortController();
    st.controller = controller;

    const res = await chatStream(
      {
        provider,
        model,
        apiKey,
        baseUrl,
        messages: sendList,
        params: resolveParams(char),
        useProxy: true,
        stream: true,
        signal: controller.signal,
        // 显式给上限：不传就落回 core/llm.js 的默认值（120 秒无内容 / **10 分钟**总时限），
        // 一次私聊回复最坏会把界面占住 10 分钟。这里收紧到"90 秒没新内容 / 3 分钟总时限"。
        timeoutMs: 90000,
        totalTimeoutMs: 180000,
      },
      {
        onDelta: (delta, full) => onStreamDelta(st, delta, full),
        onError: (err) => {
          st.err = err || new Error('流式请求失败');
        },
      }
    );

    await finalizeStream(st, res, { mode, target, char, charId, userText, provider, model });
  } catch (err) {
    if (stream === st) handleStreamError(st, err, { mode, target, charId });
  } finally {
    // stopStream releases its own state immediately; only this generation may finish it.
    if (activeGeneration === st) {
      if (stream === st) {
        cancelTyping(st);
        removeStreamNode(st);
        stream = null;
      }
      activeGeneration = null;
      busy = false;
      updateSendBtn();
    }
  }
}

/**
 * 创建流式临时气泡（不落库）
 * 结构：.msg.ai > .avatar.sm.msg-av + .msg-wrap > .bub.streaming
 * @param {object} char
 * @returns {object}
 */
function createStreamState(char) {
  const textEl = el('div.bubble-text', { style: 'display:none' });
  const dotsEl = el('div.typing-dots', { title: '正在输入…' }, el('i'), el('i'), el('i'));
  const avatar = avatarNode(char, 'sm');
  avatar.classList.add('msg-av');
  const node = el(
    'div.msg.ai.msg-streaming.msg-enter',
    { dataset: { mid: STREAM_ID }, style: { '--char-color': charColor(char) } },
    avatar,
    el(
      'div.msg-wrap',
      el('div.bub.streaming', dotsEl, textEl),
      el('div.msg-meta', el('span', { text: '正在回复…' }))
    )
  );
  return {
    char,
    node,
    textEl,
    dotsEl,
    full: '',
    shown: 0,
    done: false,
    raf: 0,
    settle: null,
    err: null,
    controller: null,
    persisting: false,
    meta: null,
  };
}

/**
 * 收到流式片段：更新缓冲 + 打字机 + 断句朗读
 * @param {object} st
 * @param {string} delta
 * @param {string} full
 */
function onStreamDelta(st, delta, full) {
  if (stream !== st) return;
  const d = typeof delta === 'string' ? delta : '';
  if (typeof full === 'string' && full.length >= st.full.length) st.full = full;
  else if (d) st.full += d;

  feedSpeech(d, st.full);

  const s = curSettings();
  if (s.typedEffect === false) {
    st.shown = st.full.length;
    paintStream(st);
    if (st.done) settleTyping(st);
    return;
  }
  if (!st.raf) st.raf = requestAnimationFrame(() => pumpTyped(st));
}

/**
 * 打字机泵：每帧 2~4 字（长回复会按剩余量加速，保证不落后）
 * @param {object} st
 */
function pumpTyped(st) {
  st.raf = 0;
  if (stream !== st) return;
  const total = st.full.length;
  if (st.shown >= total) {
    if (st.done) settleTyping(st);
    return;
  }
  const remain = total - st.shown;
  const step = clamp(Math.ceil(remain / 24), 2, 4);
  st.shown = Math.min(total, st.shown + step);
  paintStream(st);
  if (st.shown >= total) {
    if (st.done) settleTyping(st);
    return;
  }
  st.raf = requestAnimationFrame(() => pumpTyped(st));
}

/** 把当前应显示的文本画到临时气泡上 */
function paintStream(st) {
  if (!st.textEl) return;
  const t = st.full.slice(0, st.shown);
  st.textEl.textContent = t;
  st.textEl.style.display = t ? '' : 'none';
  if (st.dotsEl) st.dotsEl.style.display = t ? 'none' : '';
  if (listEl && isNearBottom(listEl, 220)) listEl.scrollTop = listEl.scrollHeight;
}

/** 打字机追平后 resolve（等它追上再落库，避免文字"跳一下"） */
function settleTyping(st) {
  const fn = st.settle;
  st.settle = null;
  if (typeof fn === 'function') fn();
}

/** 取消打字机 */
function cancelTyping(st) {
  if (st.raf) {
    cancelAnimationFrame(st.raf);
    st.raf = 0;
  }
  if (st.settleTimer) {
    clearTimeout(st.settleTimer);
    st.settleTimer = 0;
  }
  // 必须先 resolve 再清空：finalizeStream 正在 await 这个 Promise，
  // 直接置 null 会让它永远挂起（回复不落库、finally 不执行）
  const settle = st.settle;
  st.settle = null;
  if (typeof settle === 'function') settle();
}

/** 移除临时气泡 */
function removeStreamNode(st) {
  if (st && st.node && st.node.parentNode) st.node.parentNode.removeChild(st.node);
}

/**
 * 流式成功收尾：落库 + 多版本 + 情绪/好感度/用量 + 语音收尾
 * @param {object} st
 * @param {{text?:string,usage?:object,model?:string,aborted?:boolean}} res
 * @param {object} info
 * @returns {Promise<void>}
 */
async function finalizeStream(st, res, info) {
  if (stream !== st) return;
  st.done = true;

  const text = String((res && res.text) || st.full || '').trim();
  if (!text) {
    if (st.err) throw st.err;
    if (res && res.aborted) {
      // 用户主动停止：不落库，仅提示
      cancelTyping(st);
      removeStreamNode(st);
      stream = null;
      flushSpeech(true);
      appendLocalNotice('已停止生成。');
      return;
    }
    throw new Error('模型没有返回任何内容（检查模型名 / 参数设置）');
  }

  st.full = text;
  st.done = true;
  // 等打字机追平。注意两个坑：
  //   ① 标签页隐藏时 requestAnimationFrame 不触发，会永远等下去 → 回复不落库、
  //      busy 一直为 true，切回前台才补；所以带兜底定时器（按剩余字数估算）。
  //   ② 关闭打字机效果时没必要等。
  const typed = curSettings().typedEffect !== false;
  if (typed && !document.hidden && st.shown < text.length) {
    await new Promise((resolve) => {
      st.settle = resolve;
      if (!st.raf) st.raf = requestAnimationFrame(() => pumpTyped(st));
      const rest = text.length - st.shown;
      st.settleTimer = setTimeout(() => {
        st.settleTimer = 0;
        if (st.settle) {
          st.settle = null;
          st.shown = text.length;
          paintStream(st);
          resolve();
        }
      }, Math.min(4000, 200 + rest * 4));
    });
  }
  if (st.settleTimer) {
    clearTimeout(st.settleTimer);
    st.settleTimer = 0;
  }
  if (stream !== st) return;

  const usage = (res && res.usage) || null;
  const modelName = (res && res.model) || info.model || '';
  const emotion = detectEmotion(text);
  const now = Date.now();
  let finalMsg = null;

  st.persisting = true;
  try {
    if (info.mode === 'regen' && info.target) {
      // 多版本：把新回复追加进 variants.list 并切到最新（契约 5.2）
      const t = info.target;
      const list =
        t.variants && Array.isArray(t.variants.list) && t.variants.list.length
          ? t.variants.list.slice()
          : [t.content || ''];
      if (list[list.length - 1] !== text) list.push(text);
      finalMsg = await updateMessage(t.id, {
        content: text,
        variants: { list, index: list.length - 1 },
        emotion,
        model: modelName,
        usage,
        status: 'done',
        error: '',
        updatedAt: now,
      });
    } else if (info.mode === 'retry' && info.target) {
      finalMsg = await updateMessage(info.target.id, {
        content: text,
        emotion,
        model: modelName,
        usage,
        status: 'done',
        error: '',
        updatedAt: now,
      });
    } else {
      finalMsg = await appendMessage({
        charId: info.charId,
        role: 'assistant',
        content: text,
        at: now,
        emotion,
        model: modelName,
        usage,
        status: 'done',
      });
    }
  } catch (err) {
    toast(`消息保存失败：${(err && err.message) || err}`, 'error');
  }

  if (finalMsg) {
    const settings = curSettings();
    void Promise.all([getCharacter(info.charId), listMessages(info.charId)])
      .then(([character, history]) => character && summarizeIfNeeded(character, history, { settings }))
      .catch((err) => console.warn('[memory]', err));
  }

  // 保存期间用户可能已停止旧请求并在另一个会话开始新请求。
  if (activeGeneration !== st || stream !== st) return;

  cancelTyping(st);
  removeStreamNode(st);
  stream = null;

  // 语音：把断句器里最后一句补上
  flushSpeech(false);

  // 情绪 / 好感度 / 用量 / 已读
  const userMood = detectEmotion(info.userText || '');
  try {
    setMood(info.charId, userMood);
  } catch {
    /* 忽略 */
  }
  try {
    bumpAffinity(info.charId, affinityDelta(text, userMood));
  } catch {
    /* 忽略 */
  }
  // 用量统计：llm.addUsage 要的是"摊平"的字段（prompt/completion/total/cost），不是 usage 对象
  const u = usage || {};
  const promptTokens = num(u.prompt !== undefined ? u.prompt : u.prompt_tokens, 0);
  const completionTokens = num(u.completion !== undefined ? u.completion : u.completion_tokens, 0);
  const totalTokens = num(u.total, promptTokens + completionTokens) || promptTokens + completionTokens;
  addUsageSafe({
    at: now,
    charId: info.charId,
    provider: info.provider,
    model: modelName,
    prompt: promptTokens,
    completion: completionTokens,
    total: totalTokens,
    cost: safeCostWith(estimateCost, info.provider, modelName, { prompt: promptTokens, completion: completionTokens }),
  });
  try {
    touchChat(info.charId);
    markRead(info.charId);
  } catch {
    /* 忽略 */
  }

  await refreshMessages();
  // 朗读还在继续时，把高亮挪到真正落库的那条消息上
  if (finalMsg && speech.queue && speech.queue.speaking) highlightSpeaking(finalMsg.id);
  else if (!speech.queue || !speech.queue.speaking) clearSpeakingHighlight();
}

/**
 * 流式失败：临时气泡转成 status:'error' 的落库消息 + 重试按钮
 * @param {object} st
 * @param {any} err
 * @param {{mode:string,target:object|null,charId:string}} info
 */
function handleStreamError(st, err, info) {
  cancelTyping(st);
  removeStreamNode(st);
  stream = null;
  stopSpeechAll();

  const msg = humanizeError(err);
  if (info.mode === 'retry' && info.target) {
    updateMessage(info.target.id, { status: 'error', error: msg }).then(() => refreshMessages()).catch(() => {});
  } else if (info.mode === 'regen' && info.target) {
    // 重新生成失败：保留原来的回复，只给提示
    appendLocalNotice(`重新生成失败：${msg}`);
  } else {
    appendMessage({
      charId: info.charId,
      role: 'assistant',
      content: '',
      status: 'error',
      error: msg,
      at: Date.now(),
    })
      .then(() => refreshMessages())
      .catch(() => {});
  }
  toast(msg, 'error', 5000);
}

/**
 * 停止生成：abort + 停朗读
 * @param {boolean} silent 是否静默（切换会话时用）
 * @param {boolean} [keepPartial] 是否把已生成的部分保留下来
 */
function stopStream(silent, keepPartial = true) {
  const st = stream;
  // 注意：st.done 表示"模型已经把话说完、正在逐字显示"。
  // 这种情况必须落完整正文（st.full），否则网络收完但打字机还没追上的那几秒里
  // 用户一按停止，后半段回复就被永久丢掉了。
  const partial = st ? (st.done ? st.full : st.full.slice(0, Math.max(0, st.shown))).trim() : '';
  const ownerId = (st && st.char && st.char.id) || curId();

  if (st) {
    cancelTyping(st);
    if (st.controller) {
      try {
        st.controller.abort();
      } catch {
        /* 忽略 */
      }
    }
    removeStreamNode(st);
    stream = null;
  }
  stopSpeechAll();
  if (busy) {
    busy = false;
    updateSendBtn();
  }

  // 用户手动停止时保留已经说出口的半句，别让它白白消失
  if (st && keepPartial && !st.persisting && partial.length >= 2 && ownerId) {
    appendMessage({
      charId: ownerId,
      role: 'assistant',
      content: partial,
      at: Date.now(),
      status: 'done',
      emotion: detectEmotion(partial),
    })
      .then(() => refreshMessages())
      .catch(() => {});
  }
  if (activeGeneration === st) activeGeneration = null;

  if (!silent) appendLocalNotice(st ? '已停止生成。' : '当前没有正在生成的回复。');
}

/** 情绪分档：正面涨得快、中性涨得慢、负面略微回落（与 core/runtime.js 的 detectEmotion 取值对应） */
const POSITIVE_MOODS = ['happy', 'excited', 'shy'];
const NEGATIVE_MOODS = ['sad', 'angry', 'worried'];

/**
 * 好感度增量：先按情绪定档，回复长度只对正向加成生效
 *   · 正面（开心 / 激动 / 害羞）：+2，回复够长再 +1 → +3
 *   · 中性：+1，回复够长再 +1 → +2
 *   · 负面（难过 / 生气 / 担心）：-1（略微回落，长回复也不抵消）
 * @param {string} text 角色这一轮的回复
 * @param {string} mood 由你这条消息识别出的情绪
 * @returns {number} 增量，可能为负
 */
function affinityDelta(text, mood) {
  if (NEGATIVE_MOODS.includes(mood)) return -1;
  const long = String(text || '').length >= 60;
  if (POSITIVE_MOODS.includes(mood)) return long ? 3 : 2;
  return long ? 2 : 1;
}

/** 用量累计（失败静默，不影响对话） */
function addUsageSafe(record) {
  try {
    const p = addUsage(record);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 忽略 */
  }
}

/** 费用估算（失败返回 0） */
/* ================================================================== *
 * 10. 语音（TTS / 边写边说 / 单条朗读）
 * ================================================================== */

/** 重置语音状态 */
function resetSpeech() {
  speech = { queue: null, splitter: null, mode: 'off', enabled: false, chars: 0, limit: 60, cfg: null };
}

/**
 * 是否应该朗读这次回复
 * @param {object} char
 * @returns {{cfg:object, mode:string, limit:number}|null}
 */
function speechPlan(char) {
  const s = curSettings();
  if (!char) return null;
  if (s.voice && s.voice.enabled === false) return null;
  if (!voiceOnFor(char.id)) return null; // 顶部语音开关
  let cfg = null;
  try {
    cfg = voiceFor(char, s);
  } catch {
    cfg = null;
  }
  if (!cfg) return null;
  const mode = cfg.autoplay || 'off';
  if (mode === 'off') return null;
  return { cfg, mode, limit: Math.max(10, num((s.voice || {}).shortLimit, 60)) };
}

/**
 * 开始"边写边说"：断句器 + SpeechQueue
 * @param {object} char
 */
function startSpeech(char) {
  const plan = speechPlan(char);
  if (!plan) {
    resetSpeech();
    return;
  }
  let queue = null;
  queue = new SpeechQueue(
    speaker,
    plan.cfg,
    {
      onStart: () => {
        if (speech.queue !== queue) return;
        speakingMsgId = STREAM_ID;
        highlightSpeaking(STREAM_ID);
      },
      onEnd: () => {
        if (speech.queue !== queue) return;
        speakingMsgId = '';
        clearSpeakingHighlight();
      },
      onError: () => {
        /* 语音失败静默：绝不阻塞文字 */
      },
    }
  );
  speech = {
    queue,
    splitter: createSplitter(),
    mode: plan.mode,
    enabled: true,
    chars: 0,
    limit: plan.limit,
    cfg: plan.cfg,
  };
}

/**
 * 把流式片段喂给断句器（实现"角色边写边说"）
 * @param {string} delta
 * @param {string} fullText
 */
function feedSpeech(delta, fullText) {
  if (!speech.enabled || !speech.queue) return;
  const d = String(delta || '');
  try {
    if (speech.mode === 'short') {
      // 只读"短回复"：一旦超过阈值就收手（避免把长篇大论念出来）
      const len = String(fullText || '').length;
      if (len > speech.limit) {
        speech.enabled = false;
        speech.queue.stop();
        return;
      }
    }
    if (!d || !speech.splitter) return;
    const sentences = speech.splitter.push(d);
    if (sentences && sentences.length) speech.queue.push(sentences);
  } catch {
    /* 语音失败静默 */
  }
}

/**
 * 收尾：把断句器里剩下的残句补上
 * @param {boolean} silent 是否直接丢弃（停止生成时）
 */
function flushSpeech(silent) {
  const q = speech.queue;
  const sp = speech.splitter;
  speech.splitter = null;
  if (silent || !q || !sp) return;
  try {
    const rest = sp.flush();
    if (rest && rest.length && speech.enabled) q.push(rest);
  } catch {
    /* 忽略 */
  }
}

/** 停止一切朗读 */
function stopSpeechAll() {
  if (speech.queue) {
    try {
      speech.queue.stop();
    } catch {
      /* 忽略 */
    }
  }
  speech.splitter = null;
  speech.enabled = false;
  stopSpeaking();
  clearSpeakingHighlight();
  speakingMsgId = '';
}

/** 高亮正在朗读的气泡 */
function highlightSpeaking(id) {
  if (!listEl) return;
  clearSpeakingHighlight();
  const nodes = listEl.querySelectorAll('[data-mid]');
  for (const n of nodes) {
    if (n.dataset.mid === id) {
      n.classList.add('speaking');
      break;
    }
  }
}

/** 清除朗读高亮 */
function clearSpeakingHighlight() {
  if (!listEl) return;
  listEl.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
}

/**
 * 手动朗读某条消息（再点一次停止）
 * @param {object} msg
 */
async function speakMessage(msg) {
  const char = curChar();
  if (!char) return;
  if (speakingMsgId === msg.id) {
    stopSpeechAll();
    return;
  }
  stopSpeechAll();
  const text = stripMarkdown(msg.content || '').trim();
  if (!text) {
    toast('这条消息没有可朗读的内容', 'warn');
    return;
  }
  let cfg = null;
  try {
    cfg = voiceFor(char, curSettings());
  } catch {
    cfg = null;
  }
  speakingMsgId = msg.id;
  highlightSpeaking(msg.id);
  try {
    await speakText(text, cfg);
  } catch {
    /* 语音失败静默 */
  } finally {
    if (speakingMsgId === msg.id) {
      speakingMsgId = '';
      clearSpeakingHighlight();
    }
  }
}

/* ================================================================== *
 * 11. 语音输入（STT）
 * ================================================================== */

/** 语音输入按钮：点击开始 / 再次点击结束 */
function toggleStt() {
  if (sttState.rec) {
    stopStt(false);
    return;
  }
  if (!sttAvailable()) {
    toast('当前浏览器不支持语音输入，换 Chrome / Edge 试试', 'warn', 4000);
    return;
  }
  const s = curSettings();
  const lang = ((s.voice || {}).stt || {}).lang || 'zh-CN';
  sttState.base = inputEl && inputEl.value ? String(inputEl.value).replace(/\s+$/, '') : '';
  sttState.final = '';
  try {
    sttState.rec = createRecognizer({
      lang,
      interim: true,
      onResult: onSttResult,
      onEnd: () => stopStt(true),
      // 静默 8 秒自动收工（stt.js 的看门狗），给用户一个明确交代，别让"正在听…"一直挂着
      onSilence: () => {
        toast('好一会儿没听到你说话，已停止录音', 'warn', 3000);
        stopStt(true);
      },
      onError: (err) => {
        toast(`语音识别出错：${(err && err.message) || err || '未知错误'}`, 'error');
        stopStt(true);
      },
    });
    sttState.rec.start();
    setSttUi(true);
  } catch (err) {
    sttState.rec = null;
    setSttUi(false);
    toast(`无法启动语音识别：${(err && err.message) || err}`, 'error');
  }
}

/**
 * 识别结果。
 * 注意：voice/stt.js 的 onResult 回调给的是**本次片段**（每段 final 之后内部计数会清零，
 * interim 也只在同一轮里累积），所以这里必须自己把片段累加起来。
 * @param {string} text 片段文本
 * @param {boolean} isFinal 是否为最终片段
 */
function onSttResult(text, isFinal) {
  const t = String(text || '').trim();
  if (!t) return;

  if (!isFinal) {
    // 实时预览：已确认的片段 + 本轮临时文本
    if (sttLiveEl) {
      sttLiveEl.style.display = '';
      clear(sttLiveEl);
      sttLiveEl.appendChild(el('span.pulse', { text: '●' }));
      sttLiveEl.appendChild(el('span', { text: joinSpeech(sttState.final, t) }));
    }
    return;
  }

  sttState.final = joinSpeech(sttState.final, t);
  const composed = joinSpeech(sttState.base, sttState.final);
  if (inputEl) {
    inputEl.value = composed;
    inputEl.dispatchEvent(new Event('input'));
    inputEl.focus();
  }
  if (sttLiveEl) {
    sttLiveEl.style.display = 'none';
    clear(sttLiveEl);
  }
  const s = curSettings();
  if (((s.voice || {}).stt || {}).autoSend) {
    stopStt(true);
    sendCurrent();
  }
}

/** 拼接语音片段：中文直接相连，英文之间补一个空格 */
function joinSpeech(a, b) {
  const s = String(a == null ? '' : a);
  const t = String(b == null ? '' : b);
  if (!s) return t;
  if (!t) return s;
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  if (cjk.test(s.slice(-1)) || cjk.test(t[0])) return s + t;
  return `${s} ${t}`;
}

/**
 * 停止语音输入
 * @param {boolean} silent
 */
function stopStt(silent) {
  const rec = sttState.rec;
  sttState.rec = null;
  if (rec) {
    try {
      rec.stop();
    } catch {
      /* 忽略 */
    }
  } else if (!silent) {
    // 用户点击"结束"但本来就没在录音
    toast('当前没有在录音', 'info');
  }
  setSttUi(false);
}

/** 语音输入 UI（.chat-foot.recording 红边 + 麦克风 .pulse + 实时文字 pill） */
function setSttUi(active) {
  sttState.active = !!active;
  if (footEl) footEl.classList.toggle('recording', !!active);
  if (micBtn) {
    micBtn.classList.toggle('pulse', !!active);
    clear(micBtn);
    micBtn.appendChild(icon(active ? 'mic-off' : 'mic', 18));
    micBtn.title = active ? '结束语音输入' : '语音输入';
  }
  if (!active && sttLiveEl) {
    sttLiveEl.style.display = 'none';
    clear(sttLiveEl);
  }
}

/* ================================================================== *
 * 12. 会话级操作（开场白 / 清空 / 导出 / 置顶 / 免打扰 / 删除）
 * ================================================================== */

/** 载入会话：消息 + 开场白 */
async function loadConversation(char) {
  const charId = char.id;
  try {
    const page = await historyPager.read(charId);
    if (!page) return;
    if (!ctxRef || curId() !== charId) return;
    messages = page;
  } catch (err) {
    messages = [];
    toast(`读取聊天记录失败：${(err && err.message) || err}`, 'error');
  }
  if (!ctxRef || curId() !== charId) return;
  await ensureGreeting(char);
  renderMessages();
  updateHint();
  // 立即定位到最后一条：同步滚一次（首帧画出来时就已经在底部，不会先闪一下顶部），
  // rAF 里再补一次——字体/头像可能在这一帧之后才把高度撑开。
  scrollToBottom(listEl, false);
  requestAnimationFrame(() => {
    if (listEl) scrollToBottom(listEl, false);
  });
  markRead(charId);
  if (inputEl) inputEl.focus();
}

/**
 * 空会话的开场白：只在"首次进入且无消息"时落库一条随机 greeting
 * @param {object} char
 */
async function ensureGreeting(char) {
  if (!char || greetingBusy) return;
  if (messages.length) return;
  if (readLS(`aichat.greeted.${char.id}`, '') === '1') return;
  const greet = pick(Array.isArray(char.greeting) ? char.greeting.filter(Boolean) : []);
  if (!greet) return;
  greetingBusy = true;
  writeLS(`aichat.greeted.${char.id}`, '1');
  try {
    const m = await appendMessage({
      charId: char.id,
      role: 'assistant',
      content: String(greet),
      at: Date.now(),
      emotion: 'neutral',
      status: 'done',
    });
    if (curId() === char.id) messages.push(m);
  } catch {
    /* 开场白失败不阻塞 */
  } finally {
    greetingBusy = false;
  }
}

/** 清空当前角色的聊天记录 */
async function clearChat() {
  const char = curChar();
  if (!char) return;
  const ok = await confirmDialog({
    title: '清空聊天记录',
    message: `将删除与 ${char.name} 的全部聊天记录（人设与好感度保留），此操作不可撤销。`,
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  stopStream(true, false);
  stopStt(true);
  try {
    await clearMessages(char.id);
  } catch (err) {
    toast(`清空失败：${(err && err.message) || err}`, 'error');
    return;
  }
  messages = [];
  notices = [];
  await refreshMessages();
  appendLocalNotice('聊天记录已清空。');
  toast('聊天记录已清空', 'ok');
}

/**
 * 导出该角色的聊天记录
 * @param {'json'|'md'} kind
 */
async function exportChat(kind) {
  const char = curChar();
  if (!char) return;
  const messages = await listMessages(char.id);
  if (!messages.length) {
    toast('还没有聊天记录可以导出', 'warn');
    return;
  }
  const base = safeName(char.name);
  if (kind === 'md') {
    const lines = [`# 与 ${char.name} 的聊天记录`, '', `导出时间：${fmtDate(Date.now())}　共 ${messages.length} 条`, ''];
    for (const m of messages) {
      const who = m.role === 'user' ? userName() : m.role === 'assistant' ? char.name : '系统';
      lines.push(`**${who}**（${fmtDate(m.at)}）`, '', m.content || '', '');
    }
    download(`${base}-聊天记录.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
    toast('已导出 Markdown', 'ok');
    return;
  }
  const pack = {
    app: 'AI 聊天网站',
    format: 'aichat-chat',
    version: 1,
    exportedAt: new Date().toISOString(),
    character: { id: char.id, name: char.name, emoji: char.emoji, color: char.color },
    runtime: getRuntime(char.id),
    count: messages.length,
    messages,
  };
  download(`${base}-聊天记录.json`, JSON.stringify(pack, null, 2), 'application/json');
  toast('已导出 JSON', 'ok');
}

/** 置顶 / 取消置顶 */
async function togglePin() {
  const char = curChar();
  if (!char) return;
  try {
    const saved = await saveCharacter({ ...char, pinned: !char.pinned });
    await reloadChars();
    renderHead(saved);
    toast(saved.pinned ? '已置顶' : '已取消置顶', 'ok');
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

/** 免打扰 / 取消免打扰 */
async function toggleMute() {
  const char = curChar();
  if (!char) return;
  try {
    const saved = await saveCharacter({ ...char, muted: !char.muted });
    await reloadChars();
    renderHead(saved);
    toast(saved.muted ? '已开启消息免打扰' : '已关闭消息免打扰', 'ok');
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

/** 删除角色（连带聊天记录与记忆） */
async function removeChar() {
  const char = curChar();
  if (!char) return;
  const ok = await confirmDialog({
    title: '删除角色',
    message: `确定要删除「${char.name}」吗？该角色的聊天记录与记忆会一起删除，且无法恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  stopStream(true, false);
  stopStt(true);
  stopSpeechAll();
  try {
    await deleteCharacter(char.id);
  } catch (err) {
    toast(`删除失败：${(err && err.message) || err}`, 'error');
    return;
  }
  await reloadChars();
  toast('角色已删除', 'ok');
  if (ctxRef && typeof ctxRef.openChat === 'function') ctxRef.openChat(null);
  else if (ctxRef && typeof ctxRef.rerender === 'function') ctxRef.rerender('all');
}

/* ================================================================== *
 * 13. bus 订阅（全局只挂一次，回调里按当前会话过滤）
 * ================================================================== */

function wireBus() {
  if (wired) return;
  wired = true;

  bus.on('msg:appended', (m) => {
    if (!rootEl || !listEl) return;
    if (!m || !m.charId || m.charId === curId()) scheduleRefresh();
  });

  bus.on('msg:updated', (m) => {
    if (!rootEl || !listEl) return;
    // 单条更新可能不带 charId（如删除事件），此时保守刷新
    if (!m || !m.charId || m.charId === curId()) scheduleRefresh();
  });

  bus.on('runtime:changed', (p) => {
    if (!p || p.charId !== curId()) return;
    renderHead(curChar());
  });

  bus.on('char:changed', (c) => {
    if (!c || c.id !== curId()) return;
    renderHead(c);
  });

  bus.on('settings:changed', (next) => {
    if (!rootEl || !(rootEl.isConnected || rootEl.parentNode)) return;
    renderHead(curChar());
    updateHint();
    // 设置 → 我的资料 改了昵称/头像：历史消息上的"我"要立刻跟着换，
    // 否则要等到下次发消息才更新（看起来就像"改了没生效"）。
    const up = (next && next.user) || {};
    const changed = !userProfileCache || userProfileCache.name !== up.name || userProfileCache.avatar !== up.avatar;
    userProfileCache = { name: up.name, avatar: up.avatar };
    if (changed && !busy) scheduleRefresh();
  });
}

/** 上一次渲染时的用户资料（设置里改了昵称/头像时用它判断要不要重画消息列表） */
let userProfileCache = null;
