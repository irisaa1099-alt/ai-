/**
 * ui/groupchat.js —— 中间栏：群聊界面（多角色同屏 + 角色之间互相对话）
 * ---------------------------------------------------------------------------
 * 和 ui/chat.js 的一对一会话相比，这里多了三样东西，也是本文件的存在意义：
 *
 *   1. 每句话都要"认人"：群里有多个 AI，气泡上必须写清楚是谁说的，
 *      头像/竖线/名字颜色都取那个角色自己的主题色；
 *   2. 一次发言要"排队"：被 @ 的人先回，其余角色按策略依次接话，
 *      界面上表现为「林晚正在输入…」→ 落成气泡 → 阿哲接着输入 → ……
 *   3. 要能"只看他们聊"：圆桌模式让角色自己往下聊，你可以完全旁观，
 *      也可以随时插一句把话题掰回来。
 *
 * 对外导出：
 *   renderGroupChat(root, ctx)        渲染整个群聊区（切换群时由 ui/app.js 调用）
 *   refreshGroupMessages()            重画消息流
 *   renderGroupPanel(root, ctx)       右栏的「群资料」
 *   stopGroupRound(reason?)           打断正在进行的群聊
 *   isGroupBusy()                     是否正在生成
 *   openGroupSearchDialog()           群内搜索
 *
 * 约束：原生 ES Module / 零依赖 / 不 alert / 不把用户输入拼进 innerHTML。
 */

import { bus } from '../core/bus.js';
import {
  appendGroupMessage,
  clearGroupMessages,
  deleteGroup,
  deleteGroupMessage,
  duplicateGroup,
  getGroupMessage,
  listGroupMessages,
  listGroupMessagesPage,
  saveGroup,
  searchGroupMessages,
  updateGroupMessage,
} from '../core/store.js';
import { markRead, touchChat, getRuntime, affinityLabel } from '../core/runtime.js';
import { GroupRound, TURN_MODES, mentionTargets } from '../core/group.js';
import { llmErrors } from '../core/llm.js';
import { createSplitter } from '../voice/splitter.js';
import { SpeechQueue, speakText, speaker, stopSpeaking, voiceFor } from '../voice/tts.js';
import { createRecognizer, sttAvailable } from '../voice/stt.js';
import { openGroupEditor, openMemberPicker } from './groupeditor.js';
import { openWerewolfPanel, refreshWerewolfUi, stopWerewolf, werewolfActive, submitUserText, awaitingSpeech } from './werewolf.js';
import { autoGrow, clear, el, isNearBottom, mount, on, scrollToBottom } from './dom.js';
import { avatarNode, ctxCall, headRestoreBar, readLS, removeLS, rightCollapseBtn, twoStateIconBtn, writeLS } from './shared.js';
import { icon } from './icons.js';
import { createHistoryPager, reconcileMessageList } from './message-list.js';
import { actionSheet, confirmDialog, modal, toast } from './toast.js';
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
  relTime,
  sleep,
  stripMarkdown,
  truncate,
} from '../core/util.js';

/* ================================================================== *
 * 1. 常量与样式兜底
 * ================================================================== */

/** 流式临时气泡的伪 id */
const STREAM_ID = '__gstream';

/** 群聊命令帮助（与单聊的 CMD_HELP 对齐，去掉群聊里没有意义的项） */
const CMD_HELP = [
  ['/me 动作', '以动作形式发送（渲染成灰色斜体动作行），例如 /me 给每人倒了杯茶'],
  ['/ooc 指令', '出戏指令：插入一条系统消息，本轮起生效，例如 /ooc 让对话更简短'],
  ['/roll [NdM]', '掷骰，例如 /roll 2d6'],
  ['/again', '让最近说过话的那位角色再说一句'],
  ['/stop', '停止正在生成的一轮'],
  ['/clear', '清空本群聊天记录'],
  ['/help', '查看这条帮助'],
];

/**
 * 插入一条系统消息（落库：会作为本轮上下文的一部分注入）。
 * 群聊的 system 消息由 renderMessage 渲染成居中灰字。
 * @param {object} g
 * @param {string} text
 */
async function insertGroupSystem(g, text) {
  const view = groupViewToken;
  try {
    const msg = await appendGroupMessage({
      groupId: g.id,
      role: 'system',
      speakerId: '',
      speakerName: '',
      content: text,
      at: Date.now(),
    });
    if (!ownsGroupView(g.id, view)) return;
    messages.push(msg);
    await refreshGroupMessages();
  } catch (err) {
    toast(`记录失败：${(err && err.message) || err}`, 'error');
  }
}

/** 掷骰（与单聊同规则：畸形的写法一律按 1d20 处理，避免 0 面骰之类的死循环） */
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
  return { dice: `${n}d${faces}`, rolls, total };
}

/** 命令帮助弹层 */
function showCommandHelp() {
  const list = el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } });
  for (const [cmd, desc] of CMD_HELP) {
    list.appendChild(
      el(
        'div',
        { style: { display: 'flex', gap: '10px', 'align-items': 'baseline' } },
        el('code', { text: cmd, style: { 'flex': '0 0 108px', color: 'var(--accent, #6c8cff)', 'font-size': '13px' } }),
        el('span', { text: desc, style: { 'font-size': '13px', color: 'var(--dim, #8b93a7)' } })
      )
    );
  }
  modal({
    title: '群聊命令',
    body: el(
      'div',
      list,
      el('div.field-hint', {
        text: '提示：@某位角色可以让他优先接话；不写 @ 时由群聊策略决定谁来接。',
      })
    ),
    width: 520,
    actions: [{ text: '知道了', kind: 'primary' }],
  });
}

/**
 * 处理群聊命令。
 * @param {string} raw 输入原文
 * @param {object} g
 * @returns {Promise<{action:'send'|'handled', content?:string}>}
 */
async function runCommand(raw, g) {
  const view = groupViewToken;
  if (raw[0] !== '/') return { action: 'send' };
  const m = raw.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
  if (!m) return { action: 'send' };
  const cmd = String(m[1] || '').toLowerCase();
  const arg = String(m[2] || '').trim();

  switch (cmd) {
    case 'me':
      if (!arg) {
        toast('用法：/me 动作描述，例如 /me 给每人倒了杯茶', 'warn');
        return { action: 'handled' };
      }
      // 保留 /me 前缀：模型能看懂，界面渲染成动作行（与单聊一致）
      return { action: 'send', content: `/me ${arg}` };

    case 'ooc':
      if (!arg) {
        toast('用法：/ooc 出戏指令，例如 /ooc 让对话更简短', 'warn');
        return { action: 'handled' };
      }
      await insertGroupSystem(g, `（出戏指令）${arg}`);
      toast('出戏指令已记录，本轮起生效', 'ok');
      return { action: 'handled' };

    case 'roll': {
      const { dice, rolls, total } = rollDice(arg);
      await insertGroupSystem(g, `🎲 ${dice}：${rolls.join(' + ')} = ${total}`);
      return { action: 'handled' };
    }

    case 'again': {
      const last = (await listGroupMessages(g.id)).reverse().find((m) => m.role === 'assistant');
      if (!ownsGroupView(g.id, view)) return { action: 'handled' };
      if (!last) {
        toast('还没有角色说过话', 'warn');
        return { action: 'handled' };
      }
      await againSpeaker(last);
      return { action: 'handled' };
    }

    case 'stop':
      stopGroupRound('user');
      toast('已停止本轮', 'ok');
      return { action: 'handled' };

    case 'clear':
      await clearChat();
      return { action: 'handled' };

    case 'help':
      showCommandHelp();
      return { action: 'handled' };

    default:
      toast(`不认识命令 /${cmd}，输入 /help 看可用命令`, 'warn', 4200);
      return { action: 'handled' };
  }
}

/** 最近一条"角色说的"消息（用于「再说一句」与 /again，不受最后一条是谁影响） */
function findLastAssistant() {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && String(m.id) !== STREAM_ID) return m;
  }
  return null;
}

/** 消息操作按钮（比私聊少几个：群聊里"重新生成整轮"没有意义） */
const MSG_ACTIONS = [
  { act: 'copy', ic: 'copy', title: '复制' },
  { act: 'speak', ic: 'speaker', title: '用 TA 的声音念一遍' },
  { act: 'again', ic: 'refreshCw', title: '让 TA 再说一句', only: 'lastAssistant' },
  { act: 'bookmark', ic: 'bookmark', title: '收藏' },
  { act: 'del', ic: 'trash', title: '删除' },
];

/** 表情标签 */
const EMOTION_LABEL = {
  happy: '开心',
  sad: '难过',
  angry: '生气',
  shy: '害羞',
  excited: '兴奋',
  worried: '担心',
  neutral: '平静',
};

const STY = {
  chat: 'display:flex;flex-direction:column;height:100%;min-height:0;position:relative;overflow:hidden',
  list: 'flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column',
};

/* ================================================================== *
 * 2. 模块状态
 * ================================================================== */

let rootEl = null;
let ctxRef = null;
/** 切走再切回同一群也属于新视图，旧发送不能继续操作它。 */
let groupViewToken = {};

function ownsGroupView(groupId, token) {
  return token === groupViewToken && group?.id === groupId &&
    ctxRef?.currentGroup?.id === groupId && Boolean(inputEl?.isConnected);
}

/** @type {object|null} 当前群聊 */
let group = null;
/** @type {object[]} 当前群成员（角色卡） */
let members = [];
/** @type {object[]} 当前群的消息（时间升序） */
let messages = [];
const historyPager = createHistoryPager(listGroupMessagesPage);
/** @type {Array<{id:string,text:string,at:number}>} 本地提示 */
let notices = [];

let headEl = null;
let listEl = null;
let inputEl = null;
let sendBtn = null;
let roundBtn = null;
let jumpBtn = null;
let footEl = null;
let membersEl = null;
let roundBarEl = null;
let planEl = null;
let hintEl = null;
let sttLiveEl = null;
let voiceBtn = null;

/** 上一次渲染时的用户资料（设置里改了昵称/头像时用它判断要不要重画消息列表） */
let userProfileCache = null;

/** 狼人杀在聊天页里的两个插槽：圆桌条位置的 HUD + 输入框上方的操作条 */
let wwHudEl = null;
let wwActionEl = null;
/** 输入框原始占位符（狼人杀轮到你发言时会临时改掉，结束后要还原） */
let composerPlaceholder = '';

/**
 * 草稿延迟写盘（每个群一个草稿 key）。
 * 注意：必须放在模块作用域，这样"发送/清空"时才能 .cancel() 掉挂起的写入——
 * 否则最后一次按键的 350ms 定时器会在清空之后触发，把刚发出去的话又写回草稿，
 * 刷新后回填到输入框（单聊 chat.js 的 saveDraftSoon 同理）。
 */
let pendingGroupDraftId = '';
const saveGroupDraftSoon = debounce((groupId, text) => {
  pendingGroupDraftId = '';
  if (!groupId) return;
  if (text) writeLS(`aichat.groupDraft.${groupId}`, text);
  else removeLS(`aichat.groupDraft.${groupId}`);
}, 350);

function cancelGroupDraftWrite(groupId) {
  if (pendingGroupDraftId !== groupId) return;
  saveGroupDraftSoon.cancel();
  pendingGroupDraftId = '';
}

/** 发送 / 清空输入时：撤掉挂起的去抖写入 + 删掉该群草稿（两件事缺一不可） */
function dropGroupDraft(groupId) {
  cancelGroupDraftWrite(groupId);
  if (groupId) removeLS(`aichat.groupDraft.${groupId}`);
}

/** 旧视图发送已成功：只删除仍是发送原文的旧草稿，不动重开后的同群视图。 */
function dropSentGroupDraft(groupId, text, sourceInput) {
  if (ctxRef?.currentGroup?.id === groupId && inputEl !== sourceInput) return;
  if (sourceInput.value !== text || readLS(`aichat.groupDraft.${groupId}`, '') !== text) return;
  dropGroupDraft(groupId);
}

/** 是否正在生成（整轮） */
let busy = false;
/** @type {GroupRound|null} 正在跑的一轮 */
let activeRound = null;
/** 用于阻止已停止的旧轮次回调操作当前会话的全局 DOM。 */
let activeRoundToken = null;
/** @type {object|null} 当前流式气泡状态 */
let stream = null;
/** 正在朗读的消息 id */
let speakingMsgId = '';
/** 语音状态：{ queue, splitter, cfg, speakerId } */
let speech = { queue: null, splitter: null, cfg: null, speakerId: '' };
/** 语音输入状态 */
const sttState = { rec: null, session: null, base: '', final: '', active: false };
let wired = false;
let clockTimer = null;

/* ================================================================== *
 * 3. 小工具
 * ================================================================== */

/** 当前设置 */
function curSettings() {
  return (ctxRef && ctxRef.settings) || {};
}

/** 用户显示名 */
function userName() {
  const s = curSettings();
  return (s.user && s.user.name) || '我';
}

/** 用户头像配置 */
function userAvatar() {
  const s = curSettings();
  // 头像可能是一张图、一个 emoji，或什么都没设（回退到 🙂）。
  // 注意：不能再传 emoji:'🙂'，否则 entityEmoji 会优先取它，设置的 emoji 头像永远显示不出来。
  return { name: userName(), avatar: (s.user || {}).avatar || '🙂' };
}

/** 是不是图片头像 */
/** 成员主题色 */
function colorOf(member) {
  return (member && member.color) || '#6c8cff';
}

/** 头像节点（图片 > emoji > 首字） */
/** 叠在一起的成员头像（群头像） */
function stackAvatar(list, size = '') {
  const box = el(`span.gstack${size ? `.${size}` : ''}`);
  for (const m of (list || []).slice(0, 3)) {
    box.appendChild(avatarNode(m, '', colorOf(m)));
  }
  if (!list || !list.length) box.appendChild(el('span.avatar', { text: '💬' }));
  return box;
}

/** 图标按钮 */
function iconBtn(name, title, onClick, size = 18, extraClass = '') {
  const btn = el(
    'button.icon-btn',
    { type: 'button', title, attr: { 'aria-label': title }, on: { click: onClick } },
    icon(name, size)
  );
  if (extraClass) String(extraClass).split(/\s+/).filter(Boolean).forEach((c) => btn.classList.add(c));
  return btn;
}

/**
 * 出错文案。
 * 必须走 core/llm.js 的 llmErrors.humanize()：否则用户看到的是
 * "Failed to fetch" / "AUTH 401 unauthorized" 这类原始英文，
 * 而单聊面板给的是"API Key 无效或未配置，请到「设置 → 模型」检查"这种可操作的中文提示。
 */
function humanize(err) {
  const msg = String((err && err.message) || err || '');
  if ((err && err.name === 'AbortError') || /abort/i.test(msg) || /取消/.test(msg)) return '已停止。';
  // 群聊自己造的"缺 Key"提示已经是给人看的中文，不要再套一层「请求失败：」
  if (err && err.code === 'no-key') return msg;
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

/** 群成员里按 id 找角色 */
function memberById(id) {
  return members.find((m) => String(m.id) === String(id)) || null;
}

/** 群聊语音开关（按群记忆） */
function voiceKey(groupId) {
  return `aichat.voiceOn.group.${groupId}`;
}

function voiceOnFor(groupId) {
  return readLS(voiceKey(groupId), '1') !== '0';
}

/** 从 ctx 里同步当前群（app.js 是数据源头） */
function syncFromCtx() {
  group = (ctxRef && ctxRef.currentGroup) || null;
  members = (ctxRef && ctxRef.groupMembers) || [];
  return group;
}

/**
 * 取当前群 / 当前成员。
 *
 * 为什么要这层包装：右栏「群资料」可能先于中栏被渲染（app.js 的 openGroup 顺序是
 * 先 renderRightPane 再 renderChatInto），那一刻模块级的 group/members 还是空的，
 * 而右栏上的按钮（"让他们聊"、清空、删除…）只能依赖模块状态。
 * 所以这里在拿不到时按需从 ctx 重新同步一次，避免"点了没反应"。
 */
function curGroup() {
  if (!group && ctxRef && ctxRef.currentGroup) syncFromCtx();
  return group;
}

function curMembers() {
  if (!members.length && ctxRef && ctxRef.groupMembers) syncFromCtx();
  return members;
}

/* ================================================================== *
 * 4. 主渲染
 * ================================================================== */

/**
 * 渲染群聊界面
 * @param {HTMLElement} root
 * @param {object} ctx ui/app.js 的上下文
 */
export function renderGroupChat(root, ctx) {
  if (!root) return;
  groupViewToken = {};
  stopGroupRound('switch');
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
  speakingMsgId = '';
  stream = null;
  wireBus();

  clear(root);
  root.classList.add('chat', 'gchat');
  root.setAttribute('style', STY.chat);

  const g = syncFromCtx();
  if (!g) {
    renderPlaceholder(root);
    return;
  }

  markRead(g.id);
  headEl = buildHead(g);
  membersEl = buildMemberStrip(g);
  // 顶栏收起时露出的细拉手（群成员条也会一起收起，见 app.css 的 .head-collapsed 规则）；
  // 窄屏时它左半边还会带一个「返回列表」（顶栏里的返回键跟着顶栏一起被收起了）
  const restoreBar = headRestoreBar(() => ctxCall(ctxRef, 'toggleChatHead'), backToList);
  listEl = el('div.chat-body.gchat-body', { style: STY.list, attr: { 'aria-label': '群聊消息列表' } });
  listEl.addEventListener('scroll', () => syncJumpButton(), { passive: true });
  jumpBtn = el(
    'button.chat-jump',
    { type: 'button', title: '回到最新', attr: { 'aria-label': '回到最新' }, on: { click: () => scrollToBottom(listEl, true) } },
    icon('chevron-down', 18)
  );
  const composer = buildComposer(g);
  mount(root, headEl, membersEl, restoreBar, listEl, composer, jumpBtn);
  bindListEvents();
  syncBackButton();
  // 中栏刚被整体重建过（切群 / 改群资料 / 删角色都会走这里），HUD 与操作条容器是空的，
  // 而它们的内容只由 ui/werewolf.js 通过 bus 推来 —— 必须让那边重推一次，
  // 否则狼人杀进行中时"轮到你操作"的按钮会消失，引擎却还在等你。
  try {
    refreshWerewolfUi(g.id);
  } catch (err) {
    console.error('[groupchat] 重推狼人杀 HUD 失败', err);
  }

  loadConversation(g).catch((err) => console.warn('[groupchat] 载入群聊失败', err));

  clockTimer = setInterval(() => {
    if (!rootEl || !rootEl.isConnected) return;
    syncRoundBar();
  }, 30000);
}

/** 没有群时的占位 */
function renderPlaceholder(root) {
  headEl = null;
  listEl = null;
  inputEl = null;
  sendBtn = null;
  roundBtn = null;
  jumpBtn = null;
  footEl = null;
  membersEl = null;
  roundBarEl = null;
  planEl = null;
  hintEl = null;
  wwHudEl = null;
  wwActionEl = null;
  voiceBtn = null;
  sttLiveEl = null;
  mount(
    root,
    el(
      'div.empty',
      el('div.big', { text: '👥' }),
      el('h3', { text: '还没有选择群聊' }),
      el('div.muted.small', { text: '在左侧「群聊」里点一个群，或者新建一个把好友拉进来一起聊。' })
    )
  );
}

/** 重新载入消息并重画 */
export async function refreshGroupMessages(opts = {}) {
  const g = group || syncFromCtx();
  const view = groupViewToken;
  if (!ctxRef || !listEl || !g) return;
  // 面板已被替换（切回了单聊）：不要再对已分离的 DOM 做重绘
  if (rootEl && !rootEl.isConnected) return;
  let list = messages;
  try {
    list = await historyPager.read(g.id, opts);
    if (!list) return;
  } catch (err) {
    console.warn('[groupchat] 读取群消息失败', err);
  }
  if (!ownsGroupView(g.id, view)) return;
  const follow = isNearBottom(listEl, 260);
  const scrollTop = listEl.scrollTop;
  messages = Array.isArray(list) ? list : [];
  renderMessages();
  if (follow) scrollToBottom(listEl, false);
  else listEl.scrollTop = scrollTop;
  updateHint();
}

/** 插入本地提示（不落库） */
export function appendGroupNotice(text, cls) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return;
  const n = { id: createId('n'), text: t, at: Date.now(), cls: cls ? String(cls) : '' };
  if (!listEl) {
    notices.push(n);
    return;
  }
  const follow = isNearBottom(listEl, 200);
  // 列表里已经有内容时只把这一条画上去，避免高频提示反复重建整份聊天记录。
  // 会话还是空的时候（刚清空记录）仍旧走整绘：那条路要负责把"空会话"占位移掉。
  if (messages.length || notices.length) appendItemIncremental({ kind: 'notice', at: n.at, notice: n });
  else {
    notices.push(n);
    renderMessages();
  }
  if (follow) scrollToBottom(listEl, true);
}

/* ================================================================== *
 * 5. 顶部栏 / 成员条
 * ================================================================== */

function buildHead(g) {
  const backBtn = iconBtn('arrow-left', '返回群聊列表', () => backToList(), 20, 'chat-back');
  const stack = stackAvatar(members, 'lg');
  const nameEl = el('div.chat-head-name', { text: g.name });
  const status = el('div.chat-head-status', el('span.status-dot'), el('span', { text: statusText(g) }));
  const main = el('div.chat-head-main', nameEl, status);

  voiceBtn = iconBtn(voiceOnFor(g.id) ? 'speaker' : 'speaker-off', '群里自动朗读（每个角色用自己的声音）', () => toggleVoice());
  const tools = el(
    'div.chat-head-tools',
    iconBtn('user-plus', '拉人进群', () => openMemberPicker(g, () => onGroupChanged())),
    iconBtn('search', '搜索群聊记录', () => openGroupSearchDialog()),
    voiceBtn,
    iconBtn('edit', '群资料', () => openGroupEditor(g, { onSaved: () => onGroupChanged() })),
    // 收起顶栏：整条让给聊天区（群成员条会跟着一起藏起来）
    // （右栏的开关在群资料面板自己右上角，是个叉；收起后中栏右边缘会出现竖拉手）
    twoStateIconBtn('chevron-up', 'chevron-down', '收起顶栏', () => ctxCall(ctxRef, 'toggleChatHead'), 'head'),
    iconBtn('more', '更多', () => openMoreMenu(g))
  );

  return el('header.chat-head.gchat-head', backBtn, stack, main, tools);
}

/** 顶栏状态文案 */
function statusText(g) {
  const mode = TURN_MODES.find((m) => m.id === g.turnMode);
  const parts = [`${members.length} 位成员`];
  if (g.autoTalk === false) parts.push('仅回应 @');
  else parts.push(mode ? mode.label : '智能接话');
  if (g.muted) parts.push('免打扰');
  return parts.join(' · ');
}

/** 成员条：一眼看到"这个群里有谁"，点一下直接去私聊 */
function buildMemberStrip(g) {
  const strip = el('div.gchat-members', { attr: { 'aria-label': '群成员' } });
  for (const m of members) {
    const color = colorOf(m);
    const muted = isMuted(g, m.id);
    const chip = el(
      'button.gchat-member',
      {
        type: 'button',
        class: muted ? 'muted-member' : '',
        title: muted
          ? `${m.name} 已被禁言（不会在群里说话）；点一下可以私聊`
          : `和 ${m.name} 私聊（长按可把他移出群）`,
        style: { '--char-color': color },
        on: { click: () => openPrivate(m) },
      },
      avatarNode(m, 'sm', color),
      el('span.gchat-member-name', { text: m.name })
    );
    // 长按 / 右键：把他移出群
    let timer = null;
    const clearPress = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    chip.addEventListener('touchstart', () => {
      clearPress();
      timer = setTimeout(() => void kickMember(g, m), 550);
    }, { passive: true });
    chip.addEventListener('touchend', clearPress, { passive: true });
    chip.addEventListener('touchcancel', clearPress, { passive: true });
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void kickMember(g, m);
    });
    strip.appendChild(chip);
  }
  strip.appendChild(
    el(
      'button.gchat-member.gchat-add',
      { type: 'button', title: '拉人进群', on: { click: () => openMemberPicker(g, () => onGroupChanged()) } },
      el('span.avatar.sm.gchat-add-av', icon('plus', 15)),
      el('span.gchat-member-name', { text: '拉人' })
    )
  );
  return strip;
}

/** 去私聊某位成员（app.js 会切到一对一会话） */
function openPrivate(member) {
  if (ctxRef && typeof ctxRef.openChat === 'function') {
    stopGroupRound('switch');
    void Promise.resolve(ctxRef.openChat(member.id)).catch(() => {});
  }
}

/** 这位成员在当前群里是否被禁言（全员禁言时所有人都是） */
function isMuted(g, id) {
  if (!g) return false;
  if (g.muteAll === true) return true;
  return (g.mutedMembers || []).map(String).includes(String(id));
}

/** 切换某位成员的禁言状态并保存 */
async function toggleMemberMute(g, member) {
  if (!g || !member) return;
  const cur = new Set((g.mutedMembers || []).map(String));
  const on = !cur.has(String(member.id));
  if (on) cur.add(String(member.id));
  else cur.delete(String(member.id));
  try {
    await saveGroup({ ...g, mutedMembers: [...cur] });
    toast(on ? `已禁言 ${member.name}：TA 不会再在群里说话` : `已解除 ${member.name} 的禁言`, 'ok', 3600);
    await onGroupChanged();
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

/** 把成员移出群 */
async function kickMember(g, member) {
  const ok = await confirmDialog({
    title: `把 ${member.name} 移出群聊？`,
    message: 'TA 之前说过的话会留在群聊记录里，之后不会再参与这个群。',
    okText: '移出',
    danger: true,
  });
  if (!ok) return;
  try {
    const next = (g.members || []).filter((id) => String(id) !== String(member.id));
    if (next.length < 2) {
      toast('群聊至少需要 2 位角色，可以先拉个人再移出', 'warn', 4200);
      return;
    }
    await saveGroup({ ...g, members: next });
    toast(`已把 ${member.name} 移出群聊`, 'ok');
    await onGroupChanged();
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

/**
 * 群资料变化后的收尾：重新载入 ctx 数据，然后整块重绘中栏。
 *
 * 为什么要整块重绘中栏（而不是只让 app.js rerender）：顶栏的成员叠头像、
 * 成员条、输入框占位符里都嵌着群名/成员，成员一变就必须重建这些节点。
 */
async function onGroupChanged() {
  try {
    if (ctxRef && typeof ctxRef.reloadGroups === 'function') await ctxRef.reloadGroups();
  } catch {
    /* 忽略 */
  }
  // 中栏：整块重建（成员条 / 顶栏 / 占位符都会跟着更新）
  if (rootEl && group && document.body.contains(rootEl)) {
    renderGroupChat(rootEl, ctxRef);
  }
  // 右栏与侧栏交给 app.js 统一处理
  if (ctxRef && typeof ctxRef.rerender === 'function') ctxRef.rerender('all');
}

/** 返回列表（移动端） */
function backToList() {
  stopGroupRound('switch');
  if (ctxRef && typeof ctxRef.openGroup === 'function') void ctxRef.openGroup(null);
}

/** 语音总开关 */
function toggleVoice() {
  const g = curGroup();
  if (!g) return;
  const next = !voiceOnFor(g.id);
  writeLS(voiceKey(g.id), next ? '1' : '0');
  if (!next) {
    stopSpeechAll();
  }
  if (voiceBtn) {
    clear(voiceBtn);
    voiceBtn.appendChild(icon(next ? 'speaker' : 'speaker-off', 18));
  }
  toast(next ? '已开启群内朗读（每个角色用自己的声音）' : '已关闭群内朗读', 'info');
}

/** 更多菜单 */
function openMoreMenu(g) {
  actionSheet({
    title: g.name,
    items: [
      { text: '编辑群资料 / 成员', icon: 'edit', onClick: () => openGroupEditor(g, { onSaved: () => onGroupChanged() }) },
      { text: '拉人进群', icon: 'user-plus', onClick: () => openMemberPicker(g, () => onGroupChanged()) },
      { text: '让他们自己聊一轮', icon: 'theater', onClick: () => void startRound({ force: true }) },
      { text: g.pinned ? '取消置顶' : '置顶该群', icon: 'pin', onClick: () => void togglePin(g) },
      { text: g.muted ? '取消免打扰' : '消息免打扰', icon: g.muted ? 'bell' : 'belloff', onClick: () => void toggleMute(g) },
      { text: '复制这个群（只复制成员与设置）', icon: 'copy', onClick: () => void duplicate(g) },
      { text: '导出群聊记录（Markdown）', icon: 'download', onClick: () => exportChat('md') },
      { text: '导出群聊记录（JSON）', icon: 'download', onClick: () => exportChat('json') },
      { text: '清空群聊记录', icon: 'trash', danger: true, onClick: () => void clearChat() },
      { text: '删除群聊', icon: 'trash', danger: true, onClick: () => void removeGroup() },
    ],
  });
}

async function togglePin(g) {
  try {
    const saved = await saveGroup({ ...g, pinned: !g.pinned });
    toast(saved.pinned ? '已置顶' : '已取消置顶', 'ok');
    await onGroupChanged();
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

async function toggleMute(g) {
  try {
    const saved = await saveGroup({ ...g, muted: !g.muted });
    toast(saved.muted ? '已开启消息免打扰' : '已关闭消息免打扰', 'ok');
    await onGroupChanged();
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

async function duplicate(g) {
  try {
    const copy = await duplicateGroup(g.id);
    toast(copy ? `已复制出「${copy.name}」` : '复制失败', copy ? 'ok' : 'error');
    await onGroupChanged();
  } catch (err) {
    toast(`复制失败：${(err && err.message) || err}`, 'error');
  }
}

async function removeGroup() {
  const g = curGroup();
  if (!g) return;
  const ok = await confirmDialog({
    title: '删除群聊',
    message: `确定删除「${g.name}」吗？群聊记录会一起删除（角色本身和他们的私聊记录都不受影响），此操作不可撤销。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  stopGroupRound('switch');
  // 这个群正在玩狼人杀：先停局并清掉存档，否则删完群存档还在，
  // 而且引擎会继续往一个已经不存在的群写法官公告（孤儿消息）。
  if (werewolfActive(g.id)) {
    try {
      stopWerewolf(g);
    } catch (err) {
      console.error('[groupchat] 删除群前结束狼人杀失败', err);
    }
  }
  try {
    await deleteGroup(g.id);
    toast('群聊已删除', 'ok');
    if (ctxRef && typeof ctxRef.openGroup === 'function') await ctxRef.openGroup(null);
    else await onGroupChanged();
  } catch (err) {
    toast(`删除失败：${(err && err.message) || err}`, 'error');
  }
}

async function clearChat() {
  const g = curGroup();
  if (!g) return;
  // 对局进行中不允许清记录：群消息清了但引擎的 state.log 还在拼进提示词，
  // 角色会引用"你看不到的信息"（法官公告、别人的发言在它那边还在）。
  if (werewolfActive(g.id)) {
    toast('这个群正在玩狼人杀，先结束这一局再清空记录', 'warn', 4200);
    return;
  }
  const ok = await confirmDialog({
    title: '清空群聊记录',
    message: `将删除「${g.name}」里的全部聊天记录（群成员与设置保留），此操作不可撤销。`,
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  stopGroupRound('switch');
  try {
    await clearGroupMessages(g.id);
  } catch (err) {
    toast(`清空失败：${(err && err.message) || err}`, 'error');
    return;
  }
  messages = [];
  notices = [];
  await refreshGroupMessages();
  appendGroupNotice('群聊记录已清空。');
  toast('群聊记录已清空', 'ok');
}

/** 导出群聊记录 */
async function exportChat(kind) {
  const g = curGroup();
  if (!g) return;
  const messages = await listGroupMessages(g.id);
  if (!messages.length) {
    toast('还没有聊天记录可以导出', 'warn');
    return;
  }
  const base = String(g.name || '群聊').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '群聊';
  if (kind === 'md') {
    const lines = [
      `# ${g.name} · 群聊记录`,
      '',
      g.topic ? `> ${g.topic}` : '',
      `成员：${members.map((m) => m.name).join('、')}　共 ${messages.length} 条　导出时间：${fmtDate(Date.now())}`,
      '',
    ].filter((x) => x !== '');
    for (const m of messages) {
      const who = m.role === 'user' ? userName() : m.role === 'system' ? '系统' : m.speakerName || '成员';
      lines.push(`**${who}**（${fmtDate(m.at)}）`, '', m.content || '', '');
    }
    download(`${base}-群聊记录.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
    toast('已导出 Markdown', 'ok');
    return;
  }
  const pack = {
    app: 'AI 聊天网站',
    format: 'aichat-group-chat',
    version: 1,
    exportedAt: new Date().toISOString(),
    group: { id: g.id, name: g.name, emoji: g.emoji, topic: g.topic, members: g.members },
    memberNames: members.map((m) => ({ id: m.id, name: m.name })),
    count: messages.length,
    messages,
  };
  download(`${base}-群聊记录.json`, JSON.stringify(pack, null, 2), 'application/json');
  toast('已导出 JSON', 'ok');
}

/* ================================================================== *
 * 6. 消息流
 * ================================================================== */

function renderMessages() {
  if (!listEl) return;
  const entries = historyPager.olderEntry(listEl, refreshGroupMessages);
  const profile = JSON.stringify([members.map((m) => [m.id, m.name, m.avatar, m.emoji, m.color]), curSettings().user?.name, curSettings().user?.avatar]);

  if (!messages.length && !notices.length) {
    entries.push({ key: 'empty', value: profile, create: renderEmpty });
    if (stream?.node) entries.push({ key: 'stream', node: stream.node });
    reconcileMessageList(listEl, entries);
    syncJumpButton();
    return;
  }

  const items = messages
    .map((m) => ({ kind: 'msg', at: num(m.at, Date.now()), msg: m }))
    .concat(notices.map((n) => ({ kind: 'notice', at: num(n.at, Date.now()), notice: n })))
    .sort((a, b) => a.at - b.at);

  let prevAt = 0;
  let last = null;
  for (const it of items) {
    if (!prevAt || !isSameDay(prevAt, it.at)) {
      const day = fmtDay(it.at);
      entries.push({ key: `day:${day}`, value: day, create: () => el('div.day-line', { text: day }) });
    }
    prevAt = it.at;
    if (it.kind === 'notice') {
      const cls = it.notice.cls ? `div.msg.sys.local-notice.${it.notice.cls}` : 'div.msg.sys.local-notice';
      entries.push({ key: `n:${it.notice.id}`, value: it.notice.text + cls, create: () => el(cls, { text: it.notice.text }) });
      continue;
    }
    const previous = last;
    entries.push({ key: `m:${it.msg.id}`, value: JSON.stringify(it.msg) + profile + JSON.stringify([previous?.role, previous?.speakerId]) + (speakingMsgId === it.msg.id), create: () => renderMessage(it.msg, previous) });
    last = it.msg;
  }
  if (stream?.node) entries.push({ key: 'stream', node: stream.node });
  reconcileMessageList(listEl, entries);
  syncJumpButton();
}

/**
 * 只把最新的一条消息 / 本地提示画到列表末尾，**不整块重绘**。
 *
 * 为什么必须有它：renderMessages() 是 `clear(listEl)` 之后整列表重建。
 * 高频消息走增量插入，可以保留现有节点和滚动位置，也省掉重建开销。
 * 普通群聊靠 buildHandlers().onTurnDone 走的就是这条增量路（所以它不跳）；
 * 狼人杀**不走 GroupRound**，它的消息是从 store 的 gmsg:appended 事件来的，
 * 早先会落到 scheduleRefresh() → 整块重绘，于是每条法官公告/发言都跳一下。
 *
 * 入列也在这里做（调用方**不要**自己 push）：只有先看旧的条目才能判断要不要补日期分割线。
 * 只适用于"新条目在所有条目之后"的情况；会话刚被清空等场景请调用方自己走 renderMessages()。
 * @param {{kind:'msg'|'notice', at:number, msg?:object, notice?:object}} item
 */
function appendItemIncremental(item) {
  if (item.kind === 'notice') notices.push(item.notice);
  else messages.push(item.msg);
  renderMessages();
}

/** 空会话：列出成员 + 开场建议 */
function renderEmpty() {
  const g = group;
  if (!g) return el('div');
  const box = el('div.empty');
  box.appendChild(stackAvatar(members, 'lg'));
  box.appendChild(el('h3', { text: g.name }));
  box.appendChild(
    el('div.muted.small', {
      text: g.topic || `${members.map((m) => m.name).join('、')} 都在群里。`,
    })
  );
  box.appendChild(
    el('div.muted.small', {
      text: '你可以说句话让某个人回（@名字），也可以点下面的「让他们自己聊」——他们会自己找话题。',
    })
  );

  const sugs = el('div.suggest');
  const first = members[0];
  const second = members[1];
  const ideas = [
    '大家好呀，今天想聊点什么？',
    first ? `@${first.name} 最近在忙什么？` : '',
    second && first ? `@${first.name} 和 @${second.name} 你们俩怎么看对方？` : '',
    '我们来玩个游戏吧：每人说一件今天最离谱的事。',
  ].filter(Boolean);
  for (const text of ideas.slice(0, 4)) {
    sugs.appendChild(
      el('button.sug-btn', {
        type: 'button',
        text: truncate(text, 26),
        title: text,
        dataset: { act: 'suggest', text },
      })
    );
  }
  box.appendChild(sugs);
  box.appendChild(
    el(
      'div.row.wrap',
      { style: { 'justify-content': 'center', 'margin-top': '10px' } },
      el(
        'button.btn.btn-primary.btn-sm',
        { type: 'button', on: { click: () => void startRound({ force: true }) } },
        icon('theater', 14),
        el('span', { text: '让他们自己聊' })
      ),
      el(
        'button.btn.btn-sm',
        { type: 'button', on: { click: () => openMemberPicker(group, () => onGroupChanged()) } },
        icon('user-plus', 14),
        el('span', { text: '再拉个人' })
      )
    )
  );
  return box;
}

/**
 * 渲染单条群消息
 * @param {object} msg
 * @param {object|null} prev 上一条消息（连续同一个人的消息可以合并显示头像）
 */
function renderMessage(msg, prev = null) {
  if (msg.role === 'system') {
    return el('div.msg.sys', { dataset: { mid: msg.id } }, el('span', { text: msg.content || '' }));
  }

  const isUser = msg.role === 'user';
  const speaker = isUser ? userAvatar() : memberById(msg.speakerId) || { name: msg.speakerName || '成员', emoji: '🙂' };
  const color = isUser ? 'var(--accent, #6c8cff)' : colorOf(speaker);
  const sameAsPrev = Boolean(prev && prev.role === msg.role && String(prev.speakerId || '') === String(msg.speakerId || ''));
  const mentionMe = Array.isArray(msg.toIds) && msg.toIds.includes('user');

  const row = el('div.msg.gmsg', {
    dataset: { mid: msg.id },
    class: [
      isUser ? 'me' : 'ai',
      sameAsPrev ? 'cont' : '',
      mentionMe ? 'mention-me' : '',
      msg.bookmarked ? 'bookmarked' : '',
      speakingMsgId === msg.id ? 'speaking' : '',
    ]
      .filter(Boolean)
      .join(' '),
    style: { '--char-color': color },
  });

  row.appendChild(avatarNode(speaker, 'sm', isUser ? null : color)).classList.add('msg-av');

  const col = el('div.msg-wrap');

  // 群里必须写清楚"这是谁说的"（连续同一个人的消息只在第一条写名字）
  if (!isUser) {
    const nameRow = el(
      'div.gmsg-name',
      el('b', { text: speaker.name || '成员' }),
      mentionMe ? el('span.gmsg-at', { text: '对你说' }) : null,
      msg.auto ? el('span.gmsg-auto', { text: '接话' }) : null
    );
    if (!sameAsPrev) col.appendChild(nameRow);
  }

  // /me 动作行：斜体灰字，去掉 /me 前缀（与单聊的渲染保持一致）
  const isAction = isUser && /^\/me\s+/i.test(msg.content || '');
  const bubble = el('div.bub', { class: isAction ? 'bubble-action' : '' });
  bubble.appendChild(
    el('div.bubble-text', { text: isAction ? String(msg.content).replace(/^\/me\s+/i, '') : msg.content || '' })
  );
  if (isAction) {
    bubble.style.background = 'transparent';
    bubble.style.borderStyle = 'dashed';
    bubble.style.color = 'var(--dim, #8b93a7)';
    bubble.style.fontStyle = 'italic';
  }
  col.appendChild(bubble);

  // @ 了谁
  const ats = (msg.toIds || []).filter((id) => id !== 'user').map((id) => (memberById(id) || {}).name).filter(Boolean);
  if (ats.length) {
    col.appendChild(el('div.gmsg-targets', el('span', { text: `→ ${ats.map((n) => `@${n}`).join(' ')}` })));
  }

  const meta = el('div.msg-meta');
  meta.appendChild(el('span.msg-time', { text: fmtTime(msg.at) }));
  if (!isUser) {
    if (msg.emotion && EMOTION_LABEL[msg.emotion]) meta.appendChild(el('span.emo.msg-emotion', { text: EMOTION_LABEL[msg.emotion] }));
    if (msg.usage && num(msg.usage.total, 0) > 0) meta.appendChild(el('span.msg-usage', { text: `${Math.round(num(msg.usage.total))} tokens` }));
  }
  if (msg.bookmarked) meta.appendChild(el('span.msg-mark', { text: '★ 已收藏' }));
  col.appendChild(meta);

  col.appendChild(buildActions(msg));
  row.appendChild(col);
  return row;
}

/** 消息操作栏 */
function buildActions(msg) {
  const bar = el('div.msg-tools');
  // 原来要求"必须是数组最后一条"——用户发完消息没人接、或这一轮出错/被停止时，
  // 所有 AI 气泡的"再说一句"都会消失。改为"最近一条角色消息"才给按钮。
  const lastAssistant = findLastAssistant();
  const isLastAssistant = msg.role === 'assistant' && lastAssistant && lastAssistant.id === msg.id;
  for (const a of MSG_ACTIONS) {
    if (a.only === 'lastAssistant' && !isLastAssistant) continue;
    if (msg.role === 'user' && a.act === 'again') continue;
    const active = a.act === 'bookmark' && msg.bookmarked;
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
        icon(active ? 'bookmark-on' : a.ic, 15)
      )
    );
  }
  return bar;
}

/** 消息流事件委托 */
function bindListEvents() {
  if (!listEl) return;
  on(listEl, 'click', '[data-act]', (e, target) => {
    const act = target.dataset.act;
    if (act === 'suggest') {
      insertText(target.dataset.text || '');
      return;
    }
    const row = target.closest('[data-mid]');
    const id = row ? row.dataset.mid : '';
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    switch (act) {
      case 'copy':
        void copyMessage(msg);
        break;
      case 'speak':
        void speakMessage(msg);
        break;
      case 'bookmark':
        void toggleBookmark(msg);
        break;
      case 'again':
        void againSpeaker(msg);
        break;
      case 'del':
        void removeMessage(msg);
        break;
      default:
        break;
    }
  });
}

async function copyMessage(msg) {
  const ok = await copyText(msg.content || '');
  toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'ok' : 'error');
}

async function toggleBookmark(msg) {
  try {
    const m = await getGroupMessage(msg.id);
    if (!m) return;
    await updateGroupMessage(msg.id, { bookmarked: !m.bookmarked });
    await refreshGroupMessages();
    toast(m.bookmarked ? '已取消收藏' : '已收藏这条消息', 'ok');
  } catch (err) {
    toast(`操作失败：${(err && err.message) || err}`, 'error');
  }
}

async function removeMessage(msg) {
  const ok = await confirmDialog({
    title: '删除这条群消息？',
    message: '删除后无法恢复（群聊与角色本身不受影响）。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteGroupMessage(msg.id);
    await refreshGroupMessages();
  } catch (err) {
    toast(`删除失败：${(err && err.message) || err}`, 'error');
  }
}

/** 让刚才说话的那位再说一句（只让他一个人开口） */
async function againSpeaker(msg) {
  if (busy) {
    toast('正在生成中，先等一下或点停止', 'warn');
    return;
  }
  const speaker = memberById(msg.speakerId);
  if (!speaker) {
    toast('这位角色已经不在群里了', 'warn');
    return;
  }
  await startRound({ only: speaker.id, userText: '' });
}

/* ================================================================== *
 * 7. 输入区 + 圆桌控制
 * ================================================================== */

function buildComposer(g) {
  footEl = el('div.chat-foot');

  // 圆桌控制条：让他们自己聊 / 本轮几个人 / 排队预览
  roundBtn = el(
    'button.btn.btn-sm.gchat-round-btn',
    {
      type: 'button',
      title: '不让角色自己聊，只回应你的 @',
      on: { click: () => void toggleAutoTalk(g) },
    },
    icon('theater', 14),
    el('span', { text: g.autoTalk === false ? '仅应 @' : '自动接话' })
  );
  planEl = el('span.gchat-plan', { attr: { 'aria-label': '本轮发言顺序' } });
  // 狼人杀进行中时，这条圆桌条会换成游戏 HUD（见 mountWerewolfHud）
  wwHudEl = el('div.ww-hud', { style: { display: 'none' } });
  roundBarEl = el('div.gchat-roundbar', roundBtn, planEl, wwHudEl);
  footEl.appendChild(roundBarEl);

  inputEl = el('textarea.composer-input', {
    id: 'groupComposerInput',
    rows: 1,
    placeholder: `在「${g.name}」里说点什么…（输入 @ 可以点名）`,
    attr: { 'aria-label': `在 ${g.name} 里发消息` },
  });
  inputEl.value = readLS(`aichat.groupDraft.${g.id}`, '');
  composerPlaceholder = inputEl.placeholder;
  inputEl.addEventListener('input', () => {
    pendingGroupDraftId = g.id;
    saveGroupDraftSoon(g.id, inputEl.value);
    updateHint();
  });
  inputEl.addEventListener('keydown', onComposerKey);
  autoGrow(inputEl, 180);

  sttLiveEl = el('span.pill.rec.stt-live', { style: 'display:none' });
  hintEl = el('span.pill', { text: '约 0 tokens' });

  const atBtn = iconBtn('at', '点名某个人', () => void insertMention());
  const micBtn = iconBtn('mic', '语音输入', () => toggleStt(), 18, 'mic-btn');
  const clearBtn = iconBtn('close', '清空输入', () => clearInputText(), 16);
  sendBtn = el(
    'button.btn.btn-primary.send-btn',
    {
      id: 'groupSendBtn',
      type: 'button',
      title: '发送（Enter）',
      attr: { 'aria-label': '发送' },
      on: { click: () => (busy ? stopGroupRound('user') : void sendCurrent(g)) },
    },
    icon('send', 18)
  );

  const side = el('div.input-side', atBtn, micBtn, clearBtn, sendBtn);
  // .above-input：这一条在输入框上方，需要与输入框留出缝隙（见 app.css）
  footEl.appendChild(el('div.chat-foot-bar.above-input', hintEl));
  // 狼人杀"轮到你"的操作条就长在这里（发言直接用下面的输入框）
  wwActionEl = el('div.ww-actionbar', { style: { display: 'none' } });
  footEl.appendChild(wwActionEl);
  footEl.appendChild(el('div.input-row', inputEl, side));
  footEl.appendChild(el('div.chat-foot-bar', sttLiveEl));

  setTimeout(() => syncRoundBar(), 0);
  return footEl;
}

/** 发送键行为（与设置里的 sendKey 保持一致） */
function onComposerKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  const s = curSettings();
  const modSend = s.sendKey === 'mod-enter';
  const withMod = e.ctrlKey || e.metaKey;
  if (modSend ? withMod : !e.shiftKey && !withMod) {
    e.preventDefault();
    if (!busy) void sendCurrent(group);
  }
}

/** @ 点名：列出群成员 + 用户自己 */
async function insertMention() {
  const items = curMembers().map((m) => ({
    text: `@${m.name}`,
    icon: 'user',
    onClick: () => insertText(`@${m.name} `),
  }));
  items.push({ text: `@${userName()}（你自己）`, icon: 'user', onClick: () => insertText(`@${userName()} `) });
  actionSheet({ title: '点名', items });
}

function insertText(text) {
  if (!inputEl) return;
  const t = String(text == null ? '' : text);
  const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : inputEl.value.length;
  const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : inputEl.value.length;
  const before = inputEl.value.slice(0, start);
  const after = inputEl.value.slice(end);
  const space = before && !/\s$/.test(before) ? ' ' : '';
  inputEl.value = before + space + t + after;
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

function clearInputText() {
  if (!inputEl) return;
  inputEl.value = '';
  inputEl.style.height = '';
  dropGroupDraft(group ? group.id : '');
  updateHint();
  inputEl.focus();
}

/** 输入框下方的 token 提示 */
function updateHint() {
  if (!hintEl) return;
  const draft = inputEl ? estimateTokens(inputEl.value || '') : 0;
  const hist = messages.reduce((n, m) => n + estimateTokens(m.content || ''), 0);
  hintEl.textContent = `约 ${draft + hist} tokens`;
  hintEl.title = `输入约 ${draft} tokens + 群聊记录约 ${hist} tokens（估算值，实际按预算裁剪）`;
}

/** 刷新圆桌控制条与发送按钮 */
function syncRoundBar() {
  const g = curGroup();
  if (!roundBarEl || !g) return;
  const muteAll = g.muteAll === true;
  // 狼人杀进行中：圆桌条让位给游戏 HUD（HUD 内容由 ui/werewolf.js 通过 bus 推过来）
  const ww = werewolfActive(g.id);
  if (wwHudEl) wwHudEl.style.display = ww ? 'flex' : 'none';
  if (roundBtn) roundBtn.style.display = ww ? 'none' : '';
  if (planEl) planEl.style.display = ww ? 'none' : '';
  const mutedCount = (g.mutedMembers || []).length;
  if (roundBtn) {
    clear(roundBtn);
    roundBtn.appendChild(icon(busy ? 'stop' : 'theater', 14));
    roundBtn.appendChild(el('span', { text: busy ? '停下' : g.autoTalk === false ? '仅应 @' : '自动接话' }));
    roundBtn.title = busy ? '停止这一轮' : '切换：角色是否自动接话（关掉=只有被 @ 的人回你）';
    roundBtn.classList.toggle('busy', busy);
  }
  if (planEl) {
    if (busy && activeRound) {
      const plan = activeRound.plan().map((id) => (memberById(id) || {}).name).filter(Boolean);
      clear(planEl);
      planEl.appendChild(el('span', { text: '本轮：' }));
      plan.forEach((n, i) => {
        if (i) planEl.appendChild(el('span.gchat-arrow', { text: '→' }));
        planEl.appendChild(el('span.gchat-who', { text: n }));
      });
      planEl.appendChild(
        el('button.link-btn', {
          type: 'button',
          text: '停止',
          style: { 'margin-left': '8px' },
          on: { click: () => stopGroupRound('user') },
        })
      );
    } else {
      clear(planEl);
      planEl.appendChild(
        el('span', {
          text: muteAll
            ? '全员禁言中：角色都不会发言（可在群资料 → ✏️ 里解除）'
            : g.autoTalk === false
              ? `只有被 @ 到的角色会回你${mutedCount ? `（已禁言 ${mutedCount} 位）` : ''}`
              : `说一句，角色们会依次接话；也可以让他们自己聊${mutedCount ? `（已禁言 ${mutedCount} 位）` : ''}`,
        })
      );
    }
  }
  if (sendBtn) {
    clear(sendBtn);
    sendBtn.appendChild(icon(busy ? 'stop' : 'send', 18));
    sendBtn.classList.toggle('stop', busy);
    sendBtn.title = busy ? '停止生成' : '发送（Enter）';
    sendBtn.setAttribute('aria-label', busy ? '停止生成' : '发送');
  }
}

/** 切换"自动接话 / 仅应 @" */
async function toggleAutoTalk(g) {
  if (busy) {
    stopGroupRound('user');
    return;
  }
  try {
    const saved = await saveGroup({ ...g, autoTalk: g.autoTalk === false });
    toast(saved.autoTalk ? '已打开：角色会自己接着聊' : '已关闭：只有被 @ 的角色才回你', 'info', 3800);
    await onGroupChanged();
  } catch (err) {
    toast(`切换失败：${(err && err.message) || err}`, 'error');
  }
}

/* ================================================================== *
 * 8. 发送 / 群聊生成
 * ================================================================== */

/** 发送一条群消息 → 触发一轮角色发言 */
async function sendCurrent(g) {
  if (!g || !inputEl) return;
  const view = groupViewToken;
  const sourceInput = inputEl;
  const draft = String(sourceInput.value || '');
  const raw = draft.trim();
  if (!raw) {
    toast('写点什么再发送吧', 'warn');
    return;
  }
  if (busy) {
    toast('角色们还在说，可以点停止打断', 'warn');
    return;
  }
  // 狼人杀：轮到你发言/遗言时，这句话交给引擎（发言会作为你的群消息发出）；
  // 其它时候不许插话，避免把普通聊天混进对局（规则里出局/不到你说话时都不能发言）。
  if (werewolfActive(g.id)) {
    if (submitUserText(raw)) {
      inputEl.value = '';
      inputEl.style.height = '';
      dropGroupDraft(g.id);
      updateHint();
      return;
    }
    if (!awaitingSpeech()) {
      toast('狼人杀进行中：现在轮不到你说话，等法官叫你', 'warn', 3600);
      return;
    }
  }
  // 命令系统：/me /ooc /roll /again /stop /clear /help
  // 异步保存期间若切群，原文仍有自己的草稿，失败恢复不必碰新会话输入框。
  writeLS(`aichat.groupDraft.${g.id}`, draft);
  const cmdResult = await runCommand(raw, g);
  if (cmdResult.action === 'handled') {
    if (!ownsGroupView(g.id, view)) {
      dropSentGroupDraft(g.id, draft, sourceInput);
      return;
    }
    inputEl.value = '';
    inputEl.style.height = '';
    dropGroupDraft(g.id);
    updateHint();
    return;
  }
  const content = cmdResult.content || raw;

  try {
    const msg = await appendGroupMessage({
      groupId: g.id,
      role: 'user',
      speakerId: '',
      speakerName: userName(),
      content,
      at: Date.now(),
    });
    // 消息已保存到发送时的群；切走后不清新视图草稿，也不在新群启动回复。
    if (!ownsGroupView(g.id, view)) {
      dropSentGroupDraft(g.id, draft, sourceInput);
      return;
    }
    messages.push(msg);
  } catch (err) {
    // 入库失败时**不能**把用户刚打的话清掉：以前是先清空输入框与草稿、再保存，
    // 保存失败就只剩一个 toast，用户得重打一遍。现在失败时把原文放回去。
    restoreFailedGroupSend(g.id, content, view);
    const hint = ownsGroupView(g.id, view) ? '内容已留在输入框' : '请回原群查看草稿';
    toast(`消息保存失败：${(err && err.message) || err}（${hint}）`, 'error', 5000);
    return;
  }
  // 只有真的存好了才清空输入框（与草稿）
  inputEl.value = '';
  inputEl.style.height = '';
  dropGroupDraft(g.id);
  updateHint();
  touchChat(g.id);
  await refreshGroupMessages();
  if (!ownsGroupView(g.id, view)) return;
  if (isNearBottom(listEl, 320)) scrollToBottom(listEl, true);
  await startRound({ userText: content });
}

/**
 * 群消息发送失败后的兜底：把原文写回输入框与草稿。
 * @param {string} groupId
 * @param {string} content 用户原本要发的内容
 */
function restoreFailedGroupSend(groupId, content, view) {
  try {
    if (!ownsGroupView(groupId, view)) {
      // 新视图可能已经写了新草稿；只在原群尚无草稿时保存失败的原文。
      if (!readLS(`aichat.groupDraft.${groupId}`, '')) writeLS(`aichat.groupDraft.${groupId}`, content);
      return;
    }
    // 先撤掉挂起的去抖写盘，免得它把"空输入框"写进草稿
    cancelGroupDraftWrite(groupId);
    if (inputEl) {
      inputEl.value = content;
      autoGrow(inputEl);
    }
    if (groupId) writeLS(`aichat.groupDraft.${groupId}`, content);
    updateHint();
  } catch (e) {
    /* 恢复失败也不能盖掉错误提示 */
  }
}

/**
 * 跑一轮群聊
 * @param {{userText?:string, force?:boolean, only?:string, turns?:number}} opts
 */
async function startRound(opts = {}) {
  const g = curGroup();
  if (!g) return;
  if (busy) {
    // 上一轮还在说：明确告诉用户，而不是默默什么都没发生
    toast('角色们还在说，先等一下或点停止', 'warn');
    return;
  }
  if (members.length < 1) {
    toast('这个群还没有成员', 'warn');
    return;
  }

  // 狼人杀进行中：普通"自动接话 / 让他们聊"会和法官流程抢话，直接拒绝（狼人杀自己的发言不经这里）
  if (werewolfActive(g.id)) {
    toast('这一局狼人杀还在进行中，先玩完或结束它再让角色自由聊天', 'warn', 4600);
    return;
  }

  // 全员禁言：角色一个都不说话，但你自己仍然可以往群里发消息
  if (g.muteAll === true) {
    toast('这个群现在是「全员禁言」，角色不会发言；可在群资料 → ✏️ 里解除', 'warn', 4600);
    return;
  }

  // 只让某一个人说话（"让 TA 再说一句"）
  if (opts.only) {
    const speaker = memberById(opts.only);
    if (!speaker) return;
    if (isMuted(g, speaker.id)) {
      toast(`${speaker.name} 已被禁言，先解禁再让 TA 说话`, 'warn', 4200);
      return;
    }
    const token = {};
    const round = new GroupRound({
      group: g,
      members: [speaker],
      settings: curSettings(),
      userName: userName(),
      userText: String(opts.userText || ''),
      history: [], // 引擎在 run() 中读取完整历史，界面分页不截断上下文。
      maxTurns: 1,
      mode: 'round',
      force: true,
      handlers: buildHandlers(g, token),
    });
    busy = true;
    activeRound = round;
    activeRoundToken = token;
    syncRoundBar();
    try {
      await round.run();
    } finally {
      if (activeRound === round) {
        busy = false;
        activeRound = null;
        activeRoundToken = null;
        syncRoundBar();
        await afterRound(g, round);
      }
    }
    return;
  }

  // 圆桌模式：角色自己找话题（没有任何用户输入）
  const auto = Boolean(opts.force) || !String(opts.userText || '').trim();
  // 上限必须是 8：与 core/store.js 的 clamp(..., 1, 8)、群编辑器/设置里的下拉一致。
  // 这里原来是 6，导致用户把"一轮最多"设成 7 或 8 时，实际只会走 6 个角色。
  const turns = clamp(num(opts.turns, num(g.maxAutoTurns, 3)), 1, 8);

  // 你 @ 了被禁言的人：说清楚为什么 TA 没回，而不是默默无视
  if (!auto && opts.userText) {
    const mutedHit = mentionTargets(String(opts.userText), members).memberIds
      .filter((id) => isMuted(g, id))
      .map((id) => (memberById(id) || {}).name)
      .filter(Boolean);
    if (mutedHit.length) toast(`${mutedHit.join('、')} 已被禁言，本轮不会开口`, 'warn', 4200);
  }

  const token = {};
  const round = new GroupRound({
    group: g,
    members,
    settings: curSettings(),
    userName: userName(),
    userText: String(opts.userText || ''),
    history: [],
    maxTurns: turns,
    // 「只应 @」模式下由界面强制开聊时，仍然要能挑到人，所以 mode 退回配置的接话策略
    mode: g.autoTalk === false && !opts.force ? 'mention' : g.turnMode,
    force: auto,
    handlers: buildHandlers(g, token),
  });
  busy = true;
  activeRound = round;
  activeRoundToken = token;
  syncRoundBar();

  try {
    await round.run();
  } catch (err) {
    console.warn('[groupchat] 群聊生成失败', err);
    toast(humanize(err), 'error', 5000);
  } finally {
    if (activeRound === round) {
      busy = false;
      activeRound = null;
      activeRoundToken = null;
      syncRoundBar();
      await afterRound(g, round);
    }
  }
}

/** 一轮结束后：刷新、未读、提示 */
async function afterRound(g, round) {
  await refreshGroupMessages();
  if (isNearBottom(listEl, 320)) scrollToBottom(listEl, true);
  const reason = round ? round.reason : '';
  if (reason === 'silent' && round && round.spoken.length === 0) {
    appendGroupNotice('这一轮没有人被 @，所以大家都安静着（当前是「只应 @」模式）。');
  } else if (round && round.spoken.length) {
    markRead(g.id);
    try {
      if (ctxRef && typeof ctxRef.reloadGroups === 'function') await ctxRef.reloadGroups();
      if (ctxRef && typeof ctxRef.rerender === 'function') ctxRef.rerender('sidebar');
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 把引擎的事件接到界面上（流式气泡 + 语音）
 * @param {object} g
 */
function buildHandlers(g, token) {
  return {
    onPlan: (speakers) => {
      if (activeRoundToken !== token) return;
      if (!planEl) return;
      clear(planEl);
      planEl.appendChild(el('span', { text: '本轮：' }));
      speakers.forEach((s, i) => {
        if (i) planEl.appendChild(el('span.gchat-arrow', { text: '→' }));
        planEl.appendChild(el('span.gchat-who', { text: s.name }));
      });
    },
    onTurnStart: (speaker, i, total, meta) => {
      if (activeRoundToken !== token) return;
      stream = createStreamNode(speaker, i + 1, total);
      if (listEl) {
        listEl.appendChild(stream.node);
        if (isNearBottom(listEl, 320)) scrollToBottom(listEl, false);
      }
      startSpeechFor(speaker, g);
    },
    onDelta: (delta, full) => {
      if (activeRoundToken !== token) return;
      if (!stream) return;
      stream.full = full;
      // 群聊不做打字机（多个角色排队时，跟上节奏比逐字动画更重要）
      stream.textEl.textContent = full;
      stream.textEl.style.display = full ? '' : 'none';
      if (stream.dotsEl) stream.dotsEl.style.display = full ? 'none' : '';
      feedSpeech(delta, full);
      if (listEl && isNearBottom(listEl, 220)) listEl.scrollTop = listEl.scrollHeight;
    },
    onTurnDone: async (msg) => {
      if (activeRoundToken !== token) return;
      flushSpeech(false);
      if (stream) {
        removeStreamNode(stream);
        stream = null;
      }
      const follow = listEl && isNearBottom(listEl, 320);
      appendItemIncremental({ kind: 'msg', at: msg.at, msg });
      if (follow) scrollToBottom(listEl, true);
      updateHint();
      // 开了群内朗读时：等这一句念完，再让下一位开口（否则会抢话）
      await waitSpeech();
    },
    onTurnError: (err) => {
      if (activeRoundToken !== token) return;
      if (stream) {
        removeStreamNode(stream);
        stream = null;
      }
      const text = humanize(err);
      if (text && text !== '已停止。') toast(text, 'error', 4200);
    },
  };
}

/** 创建"某个角色正在输入"的临时气泡 */
function createStreamNode(speaker, index, total) {
  const color = colorOf(speaker);
  const textEl = el('div.bubble-text', { style: 'display:none' });
  const dotsEl = el('div.typing-dots', { title: '正在输入…' }, el('i'), el('i'), el('i'));
  const node = el(
    'div.msg.ai.gmsg.msg-streaming.msg-enter',
    { dataset: { mid: STREAM_ID }, style: { '--char-color': color } },
    avatarNode(speaker, 'sm', color),
    el(
      'div.msg-wrap',
      el(
        'div.gmsg-name',
        el('b', { text: speaker.name }),
        el('span.gmsg-auto', { text: total > 1 ? `第 ${index}/${total} 位` : '正在输入…' })
      ),
      el('div.bub.streaming', dotsEl, textEl)
    )
  );
  node.firstChild.classList.add('msg-av');
  return { node, textEl, dotsEl, full: '', speaker };
}

function removeStreamNode(st) {
  if (st && st.node && st.node.parentNode) st.node.parentNode.removeChild(st.node);
}

/** 打断当前这一轮 */
export function stopGroupRound(reason = 'user') {
  if (activeRound) {
    activeRound.stop(reason);
    activeRound = null;
    activeRoundToken = null;
  }
  if (stream) {
    removeStreamNode(stream);
    stream = null;
  }
  stopSpeechAll();
  if (busy) {
    busy = false;
    syncRoundBar();
  }
}

/** 是否正在生成（app.js 的 Esc / 停止按钮用） */
export function isGroupBusy() {
  return busy;
}

/* ================================================================== *
 * 9. 语音：每个角色用自己的声线
 * ================================================================== */

function resetSpeech() {
  speech = { queue: null, splitter: null, cfg: null, speakerId: '' };
}

/**
 * 这一轮要不要朗读（用说话者自己的声线）
 * 三道闸门：全局语音开着 → 这个群的朗读开关开着 → 该角色的自动朗读策略不是 off
 * @param {object} speaker
 * @param {object} g
 */
function speechPlan(speaker, g) {
  const s = curSettings();
  if (s.voice && s.voice.enabled === false) return null;
  if (!voiceOnFor(g.id)) return null;
  let cfg = null;
  try {
    cfg = voiceFor(speaker, s);
  } catch {
    cfg = null;
  }
  if (!cfg || cfg.autoplay === 'off') return null;
  return { cfg, mode: cfg.autoplay };
}

function startSpeechFor(character, g) {
  stopSpeechAll();
  const plan = speechPlan(character, g);
  if (!plan) return;
  let queue = null;
  queue = new SpeechQueue(
    speaker,
    plan.cfg,
    {
      onStart: () => {
        if (speech.queue !== queue) return;
        speakingMsgId = STREAM_ID;
      },
      onEnd: () => {
        if (speech.queue !== queue) return;
        speakingMsgId = '';
      },
      onError: () => {
        /* 语音失败静默：绝不阻塞群聊 */
      },
    }
  );
  // shortLimit 从设置里取（与单聊一致），原来这里硬编码 60，用户改了设置对群聊无效
  const shortLimit = num(curSettings().voice && curSettings().voice.shortLimit, 60);
  speech = { queue, splitter: createSplitter(), cfg: plan.cfg, mode: plan.mode, chars: 0, speakerId: character.id, shortLimit };
}

function feedSpeech(delta, full) {
  if (!speech.queue || !speech.splitter) return;
  try {
    if (speech.mode === 'short' && String(full || '').length > num(speech.shortLimit, 60)) {
      speech.queue.stop();
      speech.splitter = null;
      return;
    }
    const sentences = speech.splitter.push(String(delta || ''));
    if (sentences && sentences.length) speech.queue.push(sentences);
  } catch {
    /* 忽略 */
  }
}

function flushSpeech(silent) {
  const q = speech.queue;
  const sp = speech.splitter;
  speech.splitter = null;
  if (silent || !q || !sp) return;
  try {
    const rest = sp.flush();
    if (rest && rest.length) q.push(rest);
  } catch {
    /* 忽略 */
  }
}

/** 等这一句念完再让下一位角色开口（实现"群里一个个说"的感觉） */
async function waitSpeech() {
  const q = speech.queue;
  if (!q) return;
  try {
    await q.idle();
  } catch {
    /* 忽略 */
  }
}

function stopSpeechAll() {
  if (speech.queue) {
    try {
      speech.queue.stop();
    } catch {
      /* 忽略 */
    }
  }
  speech.splitter = null;
  speech.queue = null;
  stopSpeaking();
  speakingMsgId = '';
}

/** 手动朗读某条群消息（用说话者自己的声音） */
async function speakMessage(msg) {
  if (speakingMsgId === msg.id) {
    stopSpeechAll();
    await refreshGroupMessages();
    return;
  }
  stopSpeechAll();
  const text = stripMarkdown(msg.content || '').trim();
  if (!text) {
    toast('这条消息没有可朗读的内容', 'warn');
    return;
  }
  const speaker = msg.role === 'user' ? null : memberById(msg.speakerId);
  let cfg = null;
  try {
    cfg = voiceFor(speaker || { voice: null }, curSettings());
  } catch {
    cfg = null;
  }
  speakingMsgId = msg.id;
  await refreshGroupMessages();
  try {
    await speakText(text, cfg);
  } catch {
    /* 静默 */
  } finally {
    if (speakingMsgId === msg.id) {
      speakingMsgId = '';
      await refreshGroupMessages();
    }
  }
}

/* ================================================================== *
 * 10. 语音输入
 * ================================================================== */

function toggleStt() {
  if (sttState.rec) {
    stopStt(false);
    return;
  }
  const s = curSettings();
  if (((s.voice || {}).stt || {}).enabled === false) {
    toast('语音输入已关闭，请在设置中开启', 'info');
    return;
  }
  if (!sttAvailable()) {
    toast('当前浏览器不支持语音输入，换 Chrome / Edge 试试', 'warn', 4000);
    return;
  }
  const lang = ((s.voice || {}).stt || {}).lang || 'zh-CN';
  const sourceInput = inputEl;
  const groupId = group && group.id;
  const session = {};
  sttState.session = session;
  const ownsInput = () => sttState.session === session && inputEl === sourceInput
    && sourceInput && sourceInput.isConnected && group && group.id === groupId
    && ((curSettings().voice || {}).stt || {}).enabled !== false;
  sttState.base = inputEl && inputEl.value ? String(inputEl.value).replace(/\s+$/, '') : '';
  sttState.final = '';
  try {
    const rec = createRecognizer({
      lang,
      interim: true,
      onResult: (text, isFinal) => { if (ownsInput()) onSttResult(text, isFinal); },
      onEnd: () => { if (sttState.rec === rec) stopStt(true); },
      // 静默 8 秒自动收工（stt.js 的看门狗）
      onSilence: () => {
        if (sttState.rec !== rec) return;
        toast('好一会儿没听到你说话，已停止录音', 'warn', 3000);
        stopStt(true);
      },
      onError: (err) => {
        if (sttState.rec !== rec) return;
        toast(`语音识别出错：${(err && err.message) || err || '未知错误'}`, 'error');
        stopStt(true);
      },
    });
    sttState.rec = rec;
    rec.start();
    setSttUi(sttState.rec === rec && rec.listening);
  } catch (err) {
    stopStt(true);
    toast(`无法启动语音识别：${(err && err.message) || err}`, 'error');
  }
}

function onSttResult(text, isFinal) {
  const t = String(text || '').trim();
  if (!t) return;
  if (!isFinal) {
    if (sttLiveEl) {
      sttLiveEl.style.display = '';
      clear(sttLiveEl);
      sttLiveEl.appendChild(el('span.pulse', { text: '●' }));
      sttLiveEl.appendChild(el('span', { text: joinSpeech(sttState.final, t) }));
    }
    return;
  }
  sttState.final = joinSpeech(sttState.final, t);
  if (inputEl) {
    inputEl.value = joinSpeech(sttState.base, sttState.final);
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
    void sendCurrent(group);
  }
}

function joinSpeech(a, b) {
  const s = String(a == null ? '' : a);
  const t = String(b == null ? '' : b);
  if (!s) return t;
  if (!t) return s;
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  if (cjk.test(s.slice(-1)) || cjk.test(t[0])) return s + t;
  return `${s} ${t}`;
}

function stopStt(silent) {
  const rec = sttState.rec;
  sttState.rec = null;
  if (silent) sttState.session = null;
  if (rec) {
    try {
      rec.stop();
    } catch {
      /* 忽略 */
    }
  } else if (!silent) {
    toast('当前没有在录音', 'info');
  }
  setSttUi(false);
}

function setSttUi(active) {
  sttState.active = !!active;
  if (footEl) footEl.classList.toggle('recording', !!active);
  if (!active && sttLiveEl) {
    sttLiveEl.style.display = 'none';
    clear(sttLiveEl);
  }
}

/* ================================================================== *
 * 11. 载入 / 跳转 / 移动端
 * ================================================================== */

async function loadConversation(g) {
  try {
    const page = await historyPager.read(g.id);
    if (!page || !group || group.id !== g.id) return;
    messages = page;
  } catch (err) {
    messages = [];
    toast(`读取群聊记录失败：${(err && err.message) || err}`, 'error');
  }
  if (!group || group.id !== g.id) return;
  renderMessages();
  updateHint();
  // 立即定位到最后一条：同步滚一次（首帧就在底部），rAF 里再补一次防布局抖动
  scrollToBottom(listEl, false);
  requestAnimationFrame(() => {
    if (listEl) scrollToBottom(listEl, false);
  });
  markRead(g.id);
  if (inputEl) inputEl.focus();
}

function syncJumpButton() {
  if (!jumpBtn || !listEl) return;
  jumpBtn.classList.toggle('on', !isNearBottom(listEl, 180));
}

/** 移动端返回按钮：窄屏才显示 */
let backWatcherBound = false;

function syncBackButton() {
  if (!headEl) return;
  const btn = headEl.querySelector('.chat-back');
  if (!btn) return;
  const apply = () => {
    try {
      btn.style.display = window.innerWidth < 760 ? '' : 'none';
    } catch {
      btn.style.display = 'none';
    }
  };
  apply();
  if (!backWatcherBound) {
    backWatcherBound = true;
    try {
      window.addEventListener('resize', () => {
        if (!headEl) return;
        const b = headEl.querySelector('.chat-back');
        if (!b) return;
        b.style.display = window.innerWidth < 760 ? '' : 'none';
      });
    } catch {
      /* 忽略 */
    }
  }
}

/* ================================================================== *
 * 12. 群内搜索
 * ================================================================== */

export function openGroupSearchDialog() {
  const g = curGroup();
  if (!g) {
    toast('先打开一个群聊再搜索', 'warn');
    return;
  }
  const input = el('input.input', { type: 'search', placeholder: `在「${g.name}」的群聊记录里搜索…` });
  const summary = el('div.muted.small', { text: '输入关键词开始搜索' });
  const results = el('div.search-results');
  const m = modal({
    title: `群内搜索 · ${g.name}`,
    body: el('div', el('div.search-bar', input), summary, results),
    width: 580,
    actions: [{ text: '关闭' }],
  });

  const run = debounce(async () => {
    const kw = String(input.value || '').trim();
    clear(results);
    if (!kw) {
      summary.textContent = '输入关键词开始搜索';
      return;
    }
    summary.textContent = '搜索中…';
    let list = [];
    try {
      list = await searchGroupMessages(g.id, kw);
    } catch (err) {
      summary.textContent = '搜索失败，请重试';
      return;
    }
    summary.textContent = list.length ? `找到 ${list.length} 条` : '没有找到匹配的消息';
    for (const msg of list.slice(0, 80)) {
      const who = msg.role === 'user' ? userName() : msg.speakerName || '成员';
      results.appendChild(
        el(
          'button.hit',
          {
            type: 'button',
            on: {
              click: () => {
                m.close();
                setTimeout(() => focusMessage(msg.id), 140);
              },
            },
          },
          avatarNode(msg.role === 'user' ? userAvatar() : memberById(msg.speakerId) || { name: who }, 'sm'),
          el('div.h-main', el('div.h-top', el('b', { text: who }), el('span', { text: relTime(msg.at) })), el('div.h-text', { text: truncate(msg.content, 90) }))
        )
      );
    }
  }, 240);

  input.addEventListener('input', () => run());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run.flush && run.flush();
    }
  });
  setTimeout(() => input.focus(), 80);
}

/** 找到某条消息的气泡节点（找不到返回 null） */
function messageNode(id) {
  if (!id || !listEl) return null;
  for (const n of listEl.querySelectorAll('[data-mid]')) {
    if (n.dataset.mid === id) return n;
  }
  return null;
}

/** 高亮并滚到某个气泡 */
function flashNode(node) {
  if (!node) return;
  node.classList.add('flash-highlight');
  try {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    node.scrollIntoView();
  }
  setTimeout(() => node.classList.remove('flash-highlight'), 1800);
}

/** 高亮并滚动到某条消息（同步：群内搜索用，消息已经渲染好了） */
async function focusMessage(id) {
  if (!id || !listEl) return;
  if (!messages.some((m) => m.id === id)) await refreshGroupMessages({ includeId: id });
  const node = messageNode(id);
  if (!node) {
    toast('这条消息不在当前群聊里', 'warn');
    return;
  }
  flashNode(node);
}

/**
 * 高亮并滚动到某条群消息（**对外的跳转入口**：收藏夹、其它模块跳进来时用）。
 * 与群内搜索的差别：这里可能是"刚切完群"，消息还在异步读取、还没渲染完，
 * 所以先重试几次再判定"不在这个群里" —— 否则用户看到的是莫名其妙的失败提示。
 * @param {string} id
 * @returns {Promise<boolean>} 是否定位到
 */
export async function focusGroupMessage(id) {
  if (!id || !listEl) return false;
  for (let i = 0; i < 8; i += 1) {
    const node = messageNode(id);
    if (node) {
      flashNode(node);
      return true;
    }
    await sleep(150);
  }
  toast('这条消息不在当前群聊里', 'warn');
  return false;
}

/* ================================================================== *
 * 13. 右栏：群资料
 * ================================================================== */

/**
 * 右栏的群资料面板（由 ui/app.js 在选中群聊时调用）
 * @param {HTMLElement} root
 * @param {object} ctx
 */
export function renderGroupPanel(root, ctx) {
  if (!root) return;
  const prevCtx = ctxRef;
  if (ctx) ctxRef = ctx;
  const g = (ctx && ctx.currentGroup) || group;
  const list = (ctx && ctx.groupMembers) || members;
  // 按钮回调要在这个函数返回之后才执行，那时 ctxRef 已经被还原成 prevCtx，
  // 所以闭包里单独留一份 ctx（第一次渲染时 prevCtx 还是 null）。
  const panelCtx = ctx || ctxRef;
  clear(root);

  if (!g) {
    root.append(
      el('div.right-head', el('h2', { text: '群聊' }), rightCollapseBtn(() => ctxCall(ctxRef, 'toggleRightPane'))),
      el('div.right-body', el('div.empty', el('div.big', { text: '👥' }), el('h3', { text: '还没有选中群聊' })))
    );
    return;
  }

  const msgCount = (ctx && ctx.groupMsgCount) || 0;
  const mode = TURN_MODES.find((x) => x.id === g.turnMode);

  const head = el(
    'div.right-head',
    el('h2', { text: '群资料' }),
    // 原来是「编辑群资料」铅笔，按需求换成「收起右栏」的叉：
    // 编辑入口仍然有两条（顶栏的 edit、下面正文里的「编辑群资料 / 成员」）
    rightCollapseBtn(() => ctxCall(ctxRef, 'toggleRightPane'))
  );

  const hero = el(
    'div.card-hero',
    stackAvatar(list, 'xl'),
    el('div.nm', { text: g.name }),
    g.topic ? el('div.tl', { text: g.topic }) : el('div.tl', { text: `${list.length} 位成员` }),
    el(
      'div.row.wrap',
      { style: { 'justify-content': 'center' } },
      el('span.chip', { text: mode ? mode.label : '智能接话' }),
      g.muteAll === true
        ? el('span.chip', { style: { color: 'var(--warn, #e0b341)' }, text: '全员禁言' })
        : null,
      g.muteAll !== true && (g.mutedMembers || []).length
        ? el('span.chip', { title: '这些角色不会在群里说话', text: `已禁言 ${(g.mutedMembers || []).length} 位` })
        : null,
      g.muted ? el('span.chip', { text: '免打扰' }) : null,
      g.pinned ? el('span.chip', { text: '已置顶' }) : null
    )
  );

  /* ---------- 成员 ---------- */
  const memberRows = list.map((m) => {
    const rt = getRuntime(m.id);
    const aff = Math.round(num(rt.affinity, num(m.affinity, 20)));
    const muted = isMuted(g, m.id);
    return el(
      'div.gp-member',
      {
        class: muted ? 'muted-member' : '',
        on: { click: () => openPrivate(m) },
        title: `点击和 ${m.name} 私聊`,
      },
      avatarNode(m, 'sm', colorOf(m)),
      el(
        'div.gp-member-main',
        el(
          'div.gp-member-name',
          el('b', { text: m.name }),
          muted && g.muteAll !== true ? el('span.chip', { text: '已禁言' }) : null,
          el('span.small.muted', { text: m.job ? ` · ${m.job}` : '' })
        ),
        el('div.small.muted', { text: `${m.tagline || (m.tags || []).slice(0, 3).join('/') || '（没有简介）'}　好感度 ${aff}·${affinityLabel(aff)}` })
      ),
      el(
        'button.icon-btn.sm',
        {
          type: 'button',
          title: g.muteAll === true ? '全员禁言中，先去解除' : muted ? `解除 ${m.name} 的禁言` : `禁言 ${m.name}`,
          disabled: g.muteAll === true,
          on: {
            click: (e) => {
              e.stopPropagation();
              if (g.muteAll === true) {
                toast('当前是「全员禁言」，先关掉它再单独调整', 'warn', 4200);
                return;
              }
              void toggleMemberMute(g, m);
            },
          },
        },
        icon(muted ? 'speaker-off' : 'speaker', 14)
      ),
      el(
        'button.icon-btn.sm',
        {
          type: 'button',
          title: '移出群聊',
          on: {
            click: (e) => {
              e.stopPropagation();
              void kickMember(g, m);
            },
          },
        },
        icon('close', 14)
      )
    );
  });
  const memberSection = el(
    'div.card-section',
    el('h3', { text: `成员（${list.length}）` }),
    memberRows.length ? el('div', ...memberRows) : el('div.field-hint', { text: '这个群还没有成员，点下面的「拉人进群」加两位。' }),
    el(
      'div.row.wrap',
      { style: { 'margin-top': '10px' } },
      el('button.btn.btn-sm', { type: 'button', on: { click: () => openMemberPicker(g, () => onGroupChanged()) } }, icon('user-plus', 14), el('span', { text: '拉人进群' })),
      el(
        'button.btn.btn-sm',
        { type: 'button', on: { click: () => void startRound({ force: true }) } },
        icon('theater', 14),
        el('span', { text: '让他们聊' })
      )
    )
  );

  /* ---------- 接话设置 ---------- */
  const modeChips = el('div.row.wrap');
  for (const x of TURN_MODES) {
    modeChips.appendChild(
      el('button.chip', {
        type: 'button',
        text: x.label,
        title: x.desc,
        class: x.id === g.turnMode ? 'on' : '',
        on: {
          click: async () => {
            try {
              await saveGroup({ ...g, turnMode: x.id });
              toast(`接话策略：${x.label}`, 'ok');
              await onGroupChanged();
            } catch (err) {
              toast(`保存失败：${(err && err.message) || err}`, 'error');
            }
          },
        },
      })
    );
  }
  const settingSection = el(
    'div.card-section',
    el('h3', { text: '怎么聊' }),
    el('div.kv', el('span.k', { text: '自动接话' }), el('span.v', { text: g.autoTalk === false ? '关闭（只应 @）' : '开启' })),
    // 「一轮最多」在"每人至少说一次"开启时其实是下限：人比它多就按人数来
    el(
      'div.kv',
      el('span.k', { text: '一轮最多' }),
      el('span.v', {
        text:
          g.everyoneSpeaks !== false
            ? `${g.maxAutoTurns} 位角色（自己聊时全员轮流）`
            : `${g.maxAutoTurns} 位角色`,
      })
    ),
    el('div.kv', el('span.k', { text: '角色间隔' }), el('span.v', { text: `${(num(g.autoDelayMs, 900) / 1000).toFixed(1)} 秒` })),
    el('div.kv', el('span.k', { text: '群内朗读' }), el('span.v', { text: voiceOnFor(g.id) ? '开启（各角色自己的声线）' : '关闭' })),
    el('div.field-label', { text: '接话策略', style: { 'margin-top': '8px' } }),
    modeChips
  );

  /* ---------- 概况 ---------- */
  const statSection = el(
    'div.card-section',
    el('h3', { text: '概况' }),
    el('div.kv', el('span.k', { text: '群消息' }), el('span.v', { text: `${msgCount} 条` })),
    el('div.kv', el('span.k', { text: '创建于' }), el('span.v', { text: fmtDate(g.createdAt) })),
    el('div.kv', el('span.k', { text: '最近活跃' }), el('span.v', { text: g.updatedAt ? relTime(g.updatedAt) : '还没有聊过' }))
  );

  const actions = el(
    'div.card-actions',
    el(
      // .btn-werewolf：橙色强调（见 base.css），这是右栏里唯一"开一局游戏"的动作
      'button.btn.btn-werewolf',
      {
        type: 'button',
        title: `6~13 名玩家（群成员 + 你）可开一局狼人杀（当前 ${list.length} 位成员 + 你 = ${list.length + 1} 人）`,
        on: { click: () => openWerewolfPanel(g, panelCtx) },
      },
      icon('theater', 15),
      el('span', { text: werewolfActive(g.id) ? '狼人杀（进行中）' : '狼人杀' })
    ),
    el('button.btn', { type: 'button', on: { click: () => openGroupEditor(g, { onSaved: () => onGroupChanged() }) } }, icon('edit', 15), el('span', { text: '编辑' })),
    el(
      'button.btn.btn-danger',
      { type: 'button', on: { click: () => void clearChat() } },
      icon('trash', 15),
      el('span', { text: '清空' })
    )
  );

  root.append(head, el('div.right-body', hero, memberSection, settingSection, statSection, actions));
  ctxRef = prevCtx;
}

/* ================================================================== *
 * 14. bus 订阅
 * ================================================================== */

function wireBus() {
  if (wired) return;
  wired = true;
  bus.on('voice:stop-input', () => stopStt(true));

  const scheduleRefresh = debounce(() => {
    void refreshGroupMessages();
  }, 220);

  bus.on('gmsg:appended', (m) => {
    if (!listEl || !m || !group || m.groupId !== group.id) return;
    // 正在跑这一轮时，气泡由 onTurnDone 自己插入（增量、不跳动），这里不要再整块重绘
    if (busy) return;
    // 自己已经手动插入过节点，避免重复渲染
    if (messages.some((x) => x.id === m.id)) return;
    // 狼人杀的消息同样必须**增量插入**：它不走 GroupRound（busy 一直是 false），
    // 早先每条法官公告/发言都会走下面的 scheduleRefresh → renderMessages 整块重绘，
    // 导致现有节点被替换、滚动位置跳动。
    if (m.game === 'werewolf') {
      // 引擎刚说的那句，落库前正画在临时流式气泡上（见下面的 werewolf:speech 订阅）：真消息到了就换掉它
      if (stream && stream.ww) {
        removeStreamNode(stream);
        stream = null;
      }
      const follow = isNearBottom(listEl, 320);
      appendItemIncremental({ kind: 'msg', at: m.at, msg: m });
      updateHint();
      if (follow) scrollToBottom(listEl, true);
      return;
    }
    scheduleRefresh();
  });

  bus.on('gmsg:updated', (m) => {
    if (!listEl) return;
    if (!m || !m.groupId || !group || m.groupId === group.id) scheduleRefresh();
  });

  // 狼人杀：HUD（圆桌条位置）与操作条（输入框上方）都由 ui/werewolf.js 推过来
  bus.on('werewolf:hud', (payload) => {
    if (!wwHudEl) return;
    clear(wwHudEl);
    if (!payload || payload.off) {
      wwHudEl.style.display = 'none';
      syncRoundBar();
      return;
    }
    if (Array.isArray(payload.nodes)) wwHudEl.append(...payload.nodes);
    wwHudEl.style.display = 'flex';
    if (roundBtn) roundBtn.style.display = 'none';
    if (planEl) planEl.style.display = 'none';
  });

  // 狼人杀"公开发言"的流式增量（ui/werewolf.js 转发 core 的 emitSpeechLive）：
  // 复用普通群聊的临时气泡（"正在输入…" + 文字一段段长出来），
  // 让狼人杀的发言观感与普通群聊一致 —— 早先引擎把整段攒完才落库，句子是一整个蹦出来的。
  // 气泡里的文字已经由 core 的 liveSpeechPreview 裁成"能直接看的正文"，与最终那条消息一致。
  bus.on('werewolf:speech', (payload) => {
    const clearLive = () => {
      if (stream && stream.ww) {
        removeStreamNode(stream);
        stream = null;
      }
    };
    if (!listEl || !group) return;
    // off：这一轮没有发言 / 游戏被结束 / 切到了别的群 —— 收掉气泡
    if (!payload || payload.off || payload.text == null) {
      clearLive();
      return;
    }
    // 推的不是当前这个群（别的群还有一局在跑）：绝不能把气泡画到这里
    if (payload.groupId && String(payload.groupId) !== String(group.id)) return;
    // 正在跑普通群聊的一轮：那个气泡不归我们管，别去动它
    if (stream && !stream.ww) return;

    const text = String(payload.text);
    // 换了个人说话就换一个气泡（正常流程里上一位的真消息落库时已经把它换掉了，这里是兜底）
    if (stream && stream.ww && String(stream.wwPlayerId || '') !== String(payload.playerId || '')) clearLive();
    if (!stream) {
      const speaker = memberById(payload.playerId) || { name: payload.name || '成员' };
      stream = createStreamNode(speaker);
      stream.ww = true;
      stream.wwPlayerId = String(payload.playerId || '');
      listEl.appendChild(stream.node);
      if (isNearBottom(listEl, 320)) scrollToBottom(listEl, false);
    }
    stream.full = text;
    stream.textEl.textContent = text;
    stream.textEl.style.display = text ? '' : 'none';
    if (stream.dotsEl) stream.dotsEl.style.display = text ? 'none' : '';
    if (isNearBottom(listEl, 220)) listEl.scrollTop = listEl.scrollHeight;
  });

  // 狼人杀"只给你看"的即时反馈（预言家查验结果 / 女巫用药 / 你自己的死因）
  bus.on('werewolf:private', (payload) => {
    const text = payload && payload.text ? String(payload.text) : '';
    if (!text) return;
    appendGroupNotice(`🔒 ${text}`, 'ww-private');
  });

  bus.on('werewolf:action', (payload) => {
    if (!wwActionEl) return;
    clear(wwActionEl);
    const speech = Boolean(payload && payload.speech);
    if (!payload || payload.off) {
      wwActionEl.style.display = 'none';
      if (inputEl && composerPlaceholder) inputEl.placeholder = composerPlaceholder;
      return;
    }
    if (Array.isArray(payload.nodes)) wwActionEl.append(...payload.nodes);
    wwActionEl.style.display = 'flex';
    if (inputEl && payload.placeholder) inputEl.placeholder = payload.placeholder;
    else if (inputEl && composerPlaceholder) inputEl.placeholder = composerPlaceholder;
    // 轮到你发言：把焦点给输入框，直接在聊天页说
    if (speech && inputEl) {
      try {
        inputEl.focus();
      } catch {
        /* 忽略 */
      }
    }
  });

  // 设置 → 我的资料 改了昵称/头像：群聊里"我"的发言要立刻换头像/名字
  bus.on('settings:changed', (next) => {
    if (((next && next.voice || {}).stt || {}).enabled === false) stopStt(true);
    if (!listEl || busy) return;
    const up = (next && next.user) || {};
    const changed = !userProfileCache || userProfileCache.name !== up.name || userProfileCache.avatar !== up.avatar;
    userProfileCache = { name: up.name, avatar: up.avatar };
    if (changed) scheduleRefresh();
  });

  bus.on('group:changed', (g) => {
    if (!g || !group || g.id !== group.id) return;
    void (async () => {
      await onGroupChanged();
    })();
  });

  bus.on('group:deleted', (p) => {
    if (!group) return;
    if (p && (p.all || p.id === group.id)) {
      if (ctxRef && typeof ctxRef.openGroup === 'function') void ctxRef.openGroup(null);
    }
  });

  // chat.js 也会广播语音队列；这里只负责把群里的队列登记上去，便于 Esc 打断
  bus.on('chat:abort', () => stopGroupRound('user'));
}

export default {
  renderGroupChat,
  refreshGroupMessages,
  renderGroupPanel,
  stopGroupRound,
  isGroupBusy,
  openGroupSearchDialog,
  appendGroupNotice,
};
