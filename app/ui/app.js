/**
 * ui/app.js —— 应用装配、路由、主题、快捷键、启动引导（契约 3.16）
 * ---------------------------------------------------------------------------
 * 导出：export function bootstrap()      // index.html 里 import('./ui/app.js').then(m => m.bootstrap())
 *
 * 职责：
 *   1. 建立三栏外壳（#sidebar / #chatPane / #rightPane）并实现右侧角色卡详情面板。
 *   2. 维护 ctx（契约 3.14）并交给 ui/sidebar.js、ui/chat.js 使用。
 *   3. hash 路由：#/chat/<charId>、#/settings、#/new、#/template、#/。
 *   4. 启动流程：主题 → 角色列表 → 首次引导 → 恢复上次会话 → initProactive → Service Worker。
 *   5. 全局快捷键、事件总线接线、移动端单栏、调试面板。
 *
 * 关于 import 方式：
 *   契约 3.14 只冻结了 renderSidebar/renderChat/openCharacterEditor/openTemplateGallery/openSettings。
 *   本文件额外需要 refreshSidebar / openGlobalSearch / openNewCharacterDialog / refreshMessages。
 *   注：导入/导出/备份入口已按需求移除，底层函数仍保留在 core/store.js 与 ui/editor.js 里备查。
 *   这些"扩展导出"。为了在它们暂时缺失时不让整个应用 link 失败，这三个 UI 模块统一用命名空间导入，
 *   调用前做 typeof 判断并降级 —— 模块一旦落盘即可无缝生效，不需要改本文件。
 * ---------------------------------------------------------------------------
 */

import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { readLS, rightCollapseBtn, rightRestoreBar, writeLS } from './shared.js';
import { toast, confirmDialog, closeTopModal, modal } from './toast.js';
import { openSettings, applyTheme } from './settings.js';
import { fileStatus, syncOnBoot } from '../core/filestore.js';
import * as sidebarMod from './sidebar.js';
import * as chatMod from './chat.js';
import * as groupChatMod from './groupchat.js';
import * as groupEditorMod from './groupeditor.js';
import * as editorMod from './editor.js';
import { bus } from '../core/bus.js';
import {
  getSettings,
  setSettings,
  listCharacters,
  listGroups,
  clearMessages,
  countByChar,
  countByGroup,
  onStorageError,
} from '../core/store.js';
import { getRuntime, markRead, affinityLabel, unreadTotal, initCharacterRuntime, daysSince } from '../core/runtime.js';
import { initProactive } from '../core/proactive.js';
import { throttle, num, firstChar, relTime } from '../core/util.js';
import { speaker } from '../voice/tts.js';

/* ===========================================================================
 * 常量与状态
 * ======================================================================== */

/** 页面标题（未读时会在前面加 (N)） */
const BASE_TITLE = 'AI 好友 · 你的虚拟人设聊天室';

/** 移动端断点（与 styles/app.css 的 @media (max-width: 760px) 保持一致） */
const MOBILE_BREAKPOINT = 760;

/** 上次打开的角色（localStorage 键） */
const LAST_CHAR_KEY = 'aichat.lastChar';

/** 上次打开的群聊（localStorage 键） */
const LAST_GROUP_KEY = 'aichat.lastGroup';

/** 上次打开的是哪一类会话：'char' | 'group' */
const LAST_KIND_KEY = 'aichat.lastKind';

/** 顶栏是否收起（'1' = 收起）。布局偏好只存本机，不进设置，也就不参与云同步/导出 */
const HEAD_COLLAPSED_KEY = 'aichat.ui.headCollapsed';

/** 右栏（角色卡 / 群资料）是否收起 */
const RIGHT_COLLAPSED_KEY = 'aichat.ui.rightCollapsed';

/** @type {object[]} 角色列表缓存 */
let characters = [];

/** @type {object[]} 群聊列表缓存 */
let groups = [];

/** @type {string|null} 当前角色 id */
let currentCharId = null;

/** @type {string|null} 当前群聊 id（与 currentCharId 互斥：中栏一次只显示一个会话） */
let currentGroupId = null;

/** 每个角色的消息数缓存（侧栏摘要与右栏统计用） */
let msgCounts = {};

/** 每个群的消息数缓存 */
let groupCounts = {};

/** @type {object|null} 当前会话的语音队列（由 chat.js 通过 bus 暴露） */
let speechQueue = null;

/** @type {object} 上一份设置快照（用于判断哪些设置变化需要重绘） */
let prevSettings = null;

/** 三栏 DOM 引用 */
let shell = null;
let sidebarPane = null;
let chatPane = null;
let rightPane = null;

/**
 * 布局偏好：顶栏 / 右栏是否收起。
 * 状态存在这里，效果只体现在 `.shell` 的两个 class 上（head-collapsed / no-right），
 * 顶栏与右栏里的开关按钮都只是"发起切换"——它们自己不留状态，所以不会不同步。
 */
let headCollapsed = false;
let rightCollapsed = false;

/** 路由去重：已经处理过的 hash */
let lastRouted = '';
/** 由代码主动改 hash 时置位，避免 hashchange 重复处理 */
let skipRoute = false;

/** 调试面板 */
let debugPanel = null;
let debugBody = null;

/** 是否已经启动过 */
let booted = false;

/** 标题闪烁定时器 */
let titleFlashTimer = null;

/* ===========================================================================
 * 契约 3.14 的 ctx
 * ======================================================================== */

const ctx = {
  openChat,
  openGroup,
  reloadCharacters,
  reloadGroups,
  openGroupEditor,
  rerender,

  /** @returns {object|null} 当前角色对象 */
  get currentChar() {
    return characters.find((c) => c.id === currentCharId) || null;
  },

  /** @returns {string|null} 当前角色 id */
  get currentCharId() {
    return currentCharId;
  },

  /** @returns {object[]} 群聊列表 */
  get groups() {
    return groups;
  },

  /** @returns {object|null} 当前群聊对象 */
  get currentGroup() {
    return groups.find((g) => g.id === currentGroupId) || null;
  },

  /** @returns {string|null} 当前群聊 id */
  get currentGroupId() {
    return currentGroupId;
  },

  /** @returns {object[]} 当前群聊的成员（已解析成角色卡；已被删除的成员自动消失） */
  get groupMembers() {
    const g = groups.find((x) => x.id === currentGroupId);
    if (!g) return [];
    return (g.members || []).map((id) => characters.find((c) => c.id === id)).filter(Boolean);
  },

  /** @returns {number} 当前群聊的消息数 */
  get groupMsgCount() {
    return num(groupCounts[currentGroupId], 0);
  },

  /** @returns {object} 最新设置（深拷贝） */
  get settings() {
    return getSettings();
  },

  /** @returns {object[]} 角色列表 */
  get characters() {
    return characters;
  },

  /** @returns {object|null} 当前会话的语音队列 */
  get speechQueue() {
    return speechQueue;
  },

  /** @returns {boolean} 顶栏是否已收起 */
  get headCollapsed() {
    return headCollapsed;
  },

  /** @returns {boolean} 右栏是否已收起 */
  get rightCollapsed() {
    return rightCollapsed;
  },

  /**
   * 切换顶栏收起状态（顶栏上的按钮和收起后那条细拉手都调它）
   * @returns {boolean} 最新状态：true = 已收起
   */
  toggleChatHead() {
    return setHeadCollapsed(!headCollapsed);
  },

  /**
   * 切换右栏收起状态
   * @returns {boolean} 最新状态：true = 已收起
   */
  toggleRightPane() {
    return setRightCollapsed(!rightCollapsed);
  },
};

/* ===========================================================================
 * 小工具
 * ======================================================================== */

/** 是否移动端窄屏 */
function isMobile() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

/** 读取上次打开的角色 id */
function readLastChar() {
  try {
    return localStorage.getItem(LAST_CHAR_KEY) || '';
  } catch {
    return '';
  }
}

/** 写入上次打开的角色 id */
function writeLastChar(id) {
  try {
    if (id) localStorage.setItem(LAST_CHAR_KEY, id);
    else localStorage.removeItem(LAST_CHAR_KEY);
  } catch {
    /* 忽略：隐私模式下可能不可写 */
  }
}

/** 头像是否是一张图片 */
function isImageAvatar(a) {
  return typeof a === 'string' && /^(data:image\/|https?:\/\/|\.?\/)/.test(a);
}

/** 读取上次打开的群聊 id */
function readLastGroup() {
  try {
    return localStorage.getItem(LAST_GROUP_KEY) || '';
  } catch {
    return '';
  }
}

/** 写入上次打开的群聊 id */
function writeLastGroup(id) {
  try {
    if (id) localStorage.setItem(LAST_GROUP_KEY, id);
    else localStorage.removeItem(LAST_GROUP_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 记住"上次打开的是角色还是群聊"，下次启动才能回到同一个地方 */
function writeLastKind(kind) {
  try {
    localStorage.setItem(LAST_KIND_KEY, String(kind || ''));
  } catch {
    /* 忽略 */
  }
}

function readLastKind() {
  try {
    return localStorage.getItem(LAST_KIND_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * 生成头像节点（图片 / emoji / 名字首字三级回退，契约 2.1）
 * @param {object} char 角色
 * @param {''|'sm'|'lg'|'xl'} size 尺寸
 * @returns {HTMLElement}
 */
function avatarNode(char, size = '') {
  const node = el(`div.avatar${size ? `.${size}` : ''}`);
  const c = char || {};
  if (isImageAvatar(c.avatar)) {
    node.appendChild(el('img', { src: c.avatar, alt: c.name || '头像' }));
  } else if (c.avatar && String(c.avatar).length <= 3) {
    node.textContent = String(c.avatar);
  } else if (c.emoji) {
    node.textContent = String(c.emoji).slice(0, 2);
  } else {
    node.textContent = firstChar(c.name || '?');
  }
  if (c.color) node.style.background = c.color;
  return node;
}

/** 更新页面标题（含未读数） */
function updateTitle() {
  let n = 0;
  try {
    n = unreadTotal();
  } catch {
    n = 0;
  }
  document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}

/** 标题闪烁一次（收到主动消息时） */
function flashTitle() {
  updateTitle();
  if (titleFlashTimer) clearInterval(titleFlashTimer);
  let ticks = 0;
  let on = false;
  titleFlashTimer = setInterval(() => {
    ticks++;
    on = !on;
    const n = unreadTotal();
    document.title = on ? '💬 有新消息' : n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
    if (ticks >= 8) {
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
      updateTitle();
    }
  }, 900);
}

/* ===========================================================================
 * 外壳
 * ======================================================================== */

/** 建立三栏外壳 */
function buildShell() {
  let app = document.getElementById('app');
  if (!app) {
    app = el('div#app');
    document.body.appendChild(app);
  }
  clear(app);

  sidebarPane = el('aside.pane.pane-side#sidebar');
  chatPane = el('main.pane.pane-main#chatPane');
  rightPane = el('aside.pane.pane-right#rightPane');
  // 右栏收起后贴在中栏右边缘的竖拉手：它占外壳网格的第三列（不是绝对定位浮在消息区上），
  // 所以不会压住消息区的滚动条。只在 .shell.no-right 时显示。
  shell = el('div.shell', sidebarPane, chatPane, rightPane, rightRestoreBar(() => setRightCollapsed(false)));
  app.appendChild(shell);
  // 收起状态在开机时就要生效（否则会先闪一下展开态）
  applyLayoutPrefs();
}

/** 清理 index.html 里的加载占位 */
function removeBootOverlay() {
  const boot = document.getElementById('boot');
  if (boot) boot.remove();
}

/* ===========================================================================
 * 左栏（sidebar.js）
 * ======================================================================== */

/** sidebar.js 缺失时的兜底占位（模块落盘后永远不会走到） */
function renderSidebarPlaceholder() {
  clear(sidebarPane);
  sidebarPane.append(
    el(
      'div.side-head',
      // 副标题嵌在 .side-title 里 —— 与 ui/sidebar.js 的品牌块同构（见 app.css 的注释）
      el(
        'div.side-title',
        el('h1', { text: 'AI 好友' }),
        el('div.side-sub', { text: '本地优先的 AI 好友通讯录' })
      )
    ),
    el(
      'div.side-body',
      el(
        'div.empty',
        el('div.big', { text: '📇' }),
        el('h3', { text: '好友列表模块尚未就绪' }),
        el('p.small', { text: 'ui/sidebar.js 还没有加载进来。你仍然可以先进设置或导入角色卡。' }),
        el(
          'div.row.wrap',
          { style: { marginTop: '10px' } },
          el('button.btn.btn-primary', { on: { click: () => newCharacter() } }, icon('plus', 15), el('span', { text: '新建角色' })),
          el('button.btn', { on: { click: () => openSettings('model') } }, icon('settings', 15), el('span', { text: '设置' }))
        )
      )
    )
  );
}

/** 渲染左栏 */
function renderSidebarInto() {
  if (!sidebarPane) return;
  if (typeof sidebarMod.renderSidebar !== 'function') {
    renderSidebarPlaceholder();
    return;
  }
  try {
    clear(sidebarPane);
    sidebarMod.renderSidebar(sidebarPane, ctx);
  } catch (err) {
    console.error('[app] renderSidebar 失败', err);
    renderSidebarPlaceholder();
  }
}

/**
 * 刷新左栏。
 * 注意：sidebar.js 的 refreshSidebar() 只重画"已经渲染过"的列表（内部 refs.root 为空时会直接返回），
 * 所以这里必须先确认左栏确实渲染过；没渲染过就走完整的 renderSidebar()。
 */
function refreshSidebar() {
  if (!sidebarPane) return;
  const rendered = !!sidebarPane.firstChild;
  if (rendered && typeof sidebarMod.refreshSidebar === 'function') {
    try {
      sidebarMod.refreshSidebar();
      return;
    } catch (err) {
      console.error('[app] refreshSidebar 失败', err);
    }
  }
  renderSidebarInto();
}

/* ===========================================================================
 * 中栏（chat.js）
 * ======================================================================== */

/** chat.js 缺失 / 报错时的兜底占位 */
function renderChatPlaceholder(reason) {
  if (!chatPane) return;
  clear(chatPane);
  const char = ctx.currentChar;
  const box = el('div.empty', { style: { flex: '1', justifyContent: 'center' } });
  if (char) {
    box.append(
      avatarNode(char, 'xl'),
      el('h3', { text: `${char.name} 的会话` }),
      el('p.small', { text: reason || '聊天模块（ui/chat.js）尚未就绪。' })
    );
  } else {
    box.append(
      el('div.big', { text: '💬' }),
      el('h3', { text: '欢迎回来' }),
      el('p.small', { text: '从左侧挑一位好友开始聊天，或者新建一个只属于你的角色。' }),
      el(
        'div.row.wrap',
        { style: { marginTop: '12px' } },
        el('button.btn.btn-primary', { on: { click: () => newCharacter() } }, icon('plus', 15), el('span', { text: '新建角色' })),
        el('button.btn', { on: { click: () => openTemplateGallery() } }, icon('sparkles', 15), el('span', { text: '从模板挑一个' }))
      )
    );
  }
  chatPane.appendChild(box);
}

/** 渲染中栏（角色私聊 / 群聊二选一） */
function renderChatInto() {
  if (!chatPane) return;
  // 私聊与群聊使用不同模块，切换前统一结束上一视图的麦克风会话。
  bus.emit('voice:stop-input');

  // ---- 群聊 ----
  if (currentGroupId) {
    if (typeof groupChatMod.renderGroupChat !== 'function') {
      renderChatPlaceholder('群聊模块（ui/groupchat.js）尚未就绪。');
      syncShellLayout();
      return;
    }
    try {
      clear(chatPane);
      groupChatMod.renderGroupChat(chatPane, ctx);
    } catch (err) {
      console.error('[app] renderGroupChat 失败', err);
      renderChatPlaceholder(`群聊区渲染失败：${(err && err.message) || err}`);
    }
    syncShellLayout();
    return;
  }

  // ---- 一对一私聊 ----
  if (typeof chatMod.renderChat !== 'function') {
    renderChatPlaceholder('聊天模块（ui/chat.js）尚未就绪，先看看设置或换一位好友吧。');
    syncShellLayout();
    return;
  }
  try {
    clear(chatPane);
    chatMod.renderChat(chatPane, ctx);
  } catch (err) {
    console.error('[app] renderChat 失败', err);
    renderChatPlaceholder(`聊天区渲染失败：${(err && err.message) || err}`);
  }
  // chat.js 每次 renderChat 都会重写 #chatPane 的内联 style，所以要重新同步一次移动端显隐
  syncShellLayout();
}

/** 刷新消息列表（优先增量刷新） */
function refreshMessages() {
  if (!chatPane) return;

  if (currentGroupId) {
    const rendered = !!chatPane.firstChild;
    if (rendered && typeof groupChatMod.refreshGroupMessages === 'function') {
      try {
        void groupChatMod.refreshGroupMessages();
        return;
      } catch (err) {
        console.error('[app] refreshGroupMessages 失败', err);
      }
    }
    renderChatInto();
    return;
  }

  // chat.js 的 refreshMessages() 要求 renderChat() 已经跑过（内部 listEl 为空时直接返回）
  const rendered = !!chatPane.firstChild;
  if (rendered && typeof chatMod.refreshMessages === 'function') {
    try {
      chatMod.refreshMessages();
      return;
    } catch (err) {
      console.error('[app] refreshMessages 失败', err);
    }
  }
  renderChatInto();
}

/* ===========================================================================
 * 右栏：角色卡详情（契约里没有单独模块，由 app.js 实现）
 * ======================================================================== */

/** 渲染右栏角色卡（选中群聊时改为群资料） */
function renderRightPane() {
  if (!rightPane) return;

  // ---- 群聊：右栏交给 ui/groupchat.js 的「群资料」面板 ----
  if (currentGroupId) {
    try {
      if (typeof groupChatMod.renderGroupPanel === 'function') {
        groupChatMod.renderGroupPanel(rightPane, ctx);
        return;
      }
    } catch (err) {
      console.error('[app] renderGroupPanel 失败', err);
    }
    clear(rightPane);
    rightPane.append(
      el('div.right-head', el('h2', { text: '群资料' }), rightCollapseBtn(() => setRightCollapsed(true))),
      el('div.right-body', el('div.empty', el('div.big', { text: '👥' }), el('h3', { text: '群资料面板暂时不可用' })))
    );
    return;
  }

  clear(rightPane);
  const char = ctx.currentChar;

  if (!char) {
    rightPane.append(
      el('div.right-head', el('h2', { text: '角色卡' }), rightCollapseBtn(() => setRightCollapsed(true))),
      el(
        'div.right-body',
        el(
          'div.empty',
          el('div.big', { text: '📇' }),
          el('h3', { text: '还没有选中好友' }),
          el('p.small', { text: '从左侧点开任意一位好友，这里会显示他的详细设定与关系进度。' })
        )
      )
    );
    return;
  }

  const rt = getRuntime(char.id);
  const affinity = num(rt.affinity, num(char.affinity, 20));
  const count = num(msgCounts[char.id], 0);
  const knownDays = Math.max(1, daysSince(char.createdAt) + 1);
  const p = char.persona || {};

  /* ---------- 头部 ---------- */
  const head = el(
    'div.right-head',
    el('h2', { text: '角色卡' }),
    // 原来是「编辑角色卡」铅笔，按需求换成「收起右栏」的叉：
    // 编辑入口仍然有两条（顶栏的角色卡按钮、正文里的「编辑」按钮）
    rightCollapseBtn(() => setRightCollapsed(true))
  );

  /* ---------- 简介区 ---------- */
  const hero = el(
    'div.card-hero',
    avatarNode(char, 'xl'),
    el('div.nm', { text: char.name }),
    char.tagline ? el('div.tl', { text: char.tagline }) : null,
    el(
      'div.row.wrap',
      { style: { justifyContent: 'center' } },
      char.group ? el('span.chip', { text: char.group }) : null,
      ...(Array.isArray(char.tags) ? char.tags.slice(0, 6).map((t) => el('span.tag', { text: String(t) })) : [])
    )
  );

  /* ---------- 关系进度 ---------- */
  const affinityFill = el('i');
  affinityFill.style.width = `${Math.max(0, Math.min(100, affinity))}%`;
  const relation = el(
    'div.card-section',
    el('h3', { text: '关系' }),
    el(
      'div.kv',
      el('span.k', { text: '好感度' }),
      el('span.v', { text: `${Math.round(affinity)} / 100 · ${affinityLabel(affinity)}` })
    ),
    el('div.affinity-bar', affinityFill),
    el('div.kv', el('span.k', { text: '关系' }), el('span.v', { text: p.relationship || '朋友' })),
    el('div.kv', el('span.k', { text: '称呼你' }), el('span.v', { text: p.addressUser || '你' })),
    el('div.kv', el('span.k', { text: '当前情绪' }), el('span.v', { text: moodZh(rt.mood) }))
  );

  /* ---------- 人设 ---------- */
  const personaRows = [];
  const pushKv = (k, v) => {
    const text = String(v == null ? '' : v).trim();
    if (!text) return;
    personaRows.push(el('div.kv', el('span.k', { text: k }), el('span.v', { text })));
  };
  pushKv('性格', p.personality);
  pushKv('MBTI', p.mbti);
  pushKv('价值观', p.values);
  pushKv('说话风格', p.style);
  pushKv('口头禅', p.catchphrase);
  pushKv('语气助词', p.particles);
  pushKv('表情习惯', p.emojiHabit);
  pushKv('世界观', p.world);
  pushKv('所在地', p.place);
  pushKv('语言习惯', p.speech);
  pushKv('禁区话题', p.taboo);
  const personaSection = el(
    'div.card-section',
    el('h3', { text: '人设' }),
    personaRows.length ? el('div', ...personaRows) : el('div.field-hint', { text: '还没有填写人设细节，点下面的「编辑角色卡」补上，聊天会立刻变得不一样。' })
  );

  /* ---------- 其他信息 ---------- */
  const metaSection = el(
    'div.card-section',
    el('h3', { text: '概况' }),
    el('div.kv', el('span.k', { text: '消息数' }), el('span.v', { text: `${count} 条` })),
    el('div.kv', el('span.k', { text: '认识天数' }), el('span.v', { text: `${knownDays} 天` })),
    el(
      'div.kv',
      el('span.k', { text: '最近聊天' }),
      el('span.v', { text: rt.lastChatAt ? relTime(rt.lastChatAt) : '还没有聊过' })
    ),
    el(
      'div.kv',
      el('span.k', { text: '连续天数' }),
      el('span.v', { text: `${num(rt.streak, 0)} 天` })
    ),
    char.muted ? el('div.kv', el('span.k', { text: '提醒' }), el('span.v', { text: '已开启免打扰' })) : null
  );

  /* ---------- 底部动作 ---------- */
  const actions = el(
    'div.card-actions',
    el('button.btn', { on: { click: () => openCharacterEditor(char) } }, icon('edit', 15), el('span', { text: '编辑' })),
    el(
      'button.btn.btn-danger',
      {
        on: {
          click: async () => {
            const ok = await confirmDialog({
              title: '清空聊天记录',
              message: `确定清空与「${char.name}」的全部聊天记录吗？角色卡设定与记忆会保留，此操作不可撤销。`,
              okText: '清空',
              danger: true,
            });
            if (!ok) return;
            try {
              await clearMessages(char.id);
              await refreshMsgCounts();
              refreshMessages();
              renderRightPane();
              refreshSidebar();
              toast('聊天记录已清空', 'ok');
            } catch (err) {
              toast(`清空失败：${(err && err.message) || err}`, 'error');
            }
          },
        },
      },
      icon('trash', 15),
      el('span', { text: '清空' })
    )
  );

  rightPane.append(head, el('div.right-body', hero, relation, personaSection, metaSection, actions));
}

/** 情绪的中文名 */
function moodZh(mood) {
  const map = {
    happy: '开心',
    sad: '低落',
    angry: '生气',
    worried: '担心',
    shy: '害羞',
    excited: '兴奋',
    neutral: '平静',
  };
  return map[mood] || '平静';
}

/* ===========================================================================
 * 打开角色卡 / 模板库 / 导出（对 editor.js 的软调用）
 * ======================================================================== */

/**
 * 打开角色编辑器；传 null 表示新建
 * @param {object|null} char
 */
function openCharacterEditor(char) {
  if (typeof editorMod.openCharacterEditor === 'function') {
    try {
      editorMod.openCharacterEditor(char || null);
      return;
    } catch (err) {
      toast(`打开角色卡失败：${(err && err.message) || err}`, 'error');
      return;
    }
  }
  toast('角色编辑器（ui/editor.js）尚未就绪', 'warn');
}

/** 新建角色（优先 sidebar.js 的对话框，否则用 editor 的空角色卡） */
function newCharacter() {
  if (typeof sidebarMod.openNewCharacterDialog === 'function') {
    try {
      sidebarMod.openNewCharacterDialog();
      return;
    } catch (err) {
      console.error('[app] openNewCharacterDialog 失败', err);
    }
  }
  openCharacterEditor(null);
}

/** 打开模板库 */
function openTemplateGallery() {
  if (typeof editorMod.openTemplateGallery === 'function') {
    try {
      editorMod.openTemplateGallery();
      return;
    } catch (err) {
      toast(`打开模板库失败：${(err && err.message) || err}`, 'error');
      return;
    }
  }
  toast('模板库（ui/editor.js）尚未就绪', 'warn');
}

/** 打开全局搜索 */
function openGlobalSearch() {
  if (typeof sidebarMod.openGlobalSearch === 'function') {
    try {
      sidebarMod.openGlobalSearch();
      return;
    } catch (err) {
      toast(`打开搜索失败：${(err && err.message) || err}`, 'error');
      return;
    }
  }
  toast('搜索（ui/sidebar.js）尚未就绪', 'warn');
}

/* ===========================================================================
 * 群聊入口（对 ui/groupeditor.js 的软调用）
 * ======================================================================== */

/**
 * 打开「新建群聊 / 编辑群聊」弹层
 * @param {object|null} [group] 传 null / 省略表示新建
 * @returns {void}
 */
function openGroupEditor(group) {
  if (typeof groupEditorMod.openGroupEditor === 'function') {
    try {
      groupEditorMod.openGroupEditor(group || null, {
        onSaved: (saved) => {
          void (async () => {
            await reloadGroups();
            refreshSidebar();
            if (saved && saved.id) await openGroup(saved.id);
          })();
        },
      });
      return;
    } catch (err) {
      toast(`打开群聊设置失败：${(err && err.message) || err}`, 'error');
      return;
    }
  }
  toast('群聊编辑器（ui/groupeditor.js）尚未就绪', 'warn');
}

/* ===========================================================================
 * 路由
 * ======================================================================== */

/**
 * 静默改 hash（不触发重复路由）
 * @param {string} hash 形如 '#/chat/c_xxx'
 */
function setHash(hash) {
  const target = hash || '#/';
  lastRouted = target;
  if ((location.hash || '#/') === target) return;
  skipRoute = true;
  location.hash = target;
  // hashchange 是异步派发的，给它一点时间后再解除屏蔽
  setTimeout(() => {
    skipRoute = false;
  }, 30);
}

/**
 * 打开（或关闭）某个角色的会话
 * @param {string|null} charId
 * @returns {Promise<void>}
 */
async function openChat(charId) {
  let id = charId || null;
  if (id && !characters.some((c) => c.id === id)) id = null;

  // 打开私聊时先把正在跑的群聊停下来，并清掉"当前群"
  if (currentGroupId) {
    try {
      if (typeof groupChatMod.stopGroupRound === 'function') groupChatMod.stopGroupRound('switch');
    } catch {
      /* 忽略 */
    }
  }
  currentGroupId = null;
  currentCharId = id;
  writeLastChar(id);
  writeLastKind(id ? 'char' : '');

  if (id) {
    try {
      markRead(id);
    } catch (err) {
      console.warn('[app] markRead 失败', err);
    }
    const char = ctx.currentChar;
    if (char) initCharacterRuntime(char);
    setHash(`#/chat/${id}`);
  } else {
    setHash('#/');
  }

  renderRightPane();
  renderChatInto();
  refreshSidebar();
  updateTitle();

  // 移动端：进入会话视图（去掉 show-side），回到列表时反过来
  if (shell) {
    if (id) shell.classList.remove('show-side');
    else if (isMobile()) shell.classList.add('show-side');
    syncShellLayout();
  }
}

/**
 * 打开（或关闭）某个群聊
 * @param {string|null} groupId
 * @returns {Promise<void>}
 */
async function openGroup(groupId) {
  let id = groupId || null;
  if (id && !groups.some((g) => g.id === id)) id = null;

  // 离开私聊时要停掉它的流式生成
  if (id) {
    try {
      bus.emit('chat:abort');
      if (typeof groupChatMod.stopGroupRound === 'function') groupChatMod.stopGroupRound('switch');
    } catch {
      /* 忽略 */
    }
  } else if (typeof groupChatMod.stopGroupRound === 'function') {
    try {
      groupChatMod.stopGroupRound('switch');
    } catch {
      /* 忽略 */
    }
  }

  currentGroupId = id;
  if (id) {
    currentCharId = null;
    try {
      markRead(id);
    } catch (err) {
      console.warn('[app] 群聊 markRead 失败', err);
    }
    writeLastGroup(id);
    writeLastKind('group');
    setHash(`#/group/${id}`);
  } else {
    writeLastKind('');
    setHash('#/');
  }

  renderRightPane();
  renderChatInto();
  refreshSidebar();
  updateTitle();

  if (shell) {
    if (id) shell.classList.remove('show-side');
    else if (isMobile()) shell.classList.add('show-side');
    syncShellLayout();
  }
}

/** 处理当前 location.hash */
async function route() {
  if (skipRoute) {
    skipRoute = false;
    return;
  }
  const hash = location.hash || '#/';
  if (hash === lastRouted) return;
  lastRouted = hash;

  const chatMatch = hash.match(/^#\/chat\/(.+)$/);
  if (chatMatch) {
    const id = decodeRouteId(chatMatch[1]);
    if (characters.some((c) => c.id === id)) {
      await openChat(id);
    } else {
      toast('这个好友不存在或已被删除', 'warn');
      await openChat(null);
    }
    return;
  }

  const groupMatch = hash.match(/^#\/group\/(.+)$/);
  if (groupMatch) {
    const id = decodeRouteId(groupMatch[1]);
    if (groups.some((g) => g.id === id)) {
      await openGroup(id);
    } else {
      toast('这个群聊不存在或已被删除', 'warn');
      await openGroup(null);
    }
    return;
  }

  if (/^#\/settings\/?/.test(hash)) {
    lastRouted = '';
    openSettings();
    return;
  }

  if (/^#\/new\/?/.test(hash)) {
    lastRouted = '';
    newCharacter();
    return;
  }

  if (/^#\/template\/?/.test(hash)) {
    lastRouted = '';
    openTemplateGallery();
    return;
  }

  if (/^#\/import\/?/.test(hash)) {
    // 导入入口已随"去掉导入导出备份"一并移除，老书签统一落到模板库
    lastRouted = '';
    openTemplateGallery();
    return;
  }

  // 首页：欢迎空态
  lastRouted = '#/';
  await openChat(null);
}

/* ===========================================================================
 * 角色 / 消息数据
 * ======================================================================== */

/** 重新载入角色列表 */
async function reloadCharacters() {
  try {
    characters = await listCharacters();
  } catch (err) {
    characters = [];
    toast(`读取角色失败：${(err && err.message) || err}`, 'error', 5200);
  }
  // 首次见面时用角色卡里的初始好感度初始化运行时
  for (const c of characters) {
    try {
      initCharacterRuntime(c);
    } catch {
      /* 忽略单个角色的初始化失败 */
    }
  }
  if (currentCharId && !characters.some((c) => c.id === currentCharId)) {
    currentCharId = null;
    writeLastChar(null);
  }
  await refreshMsgCounts();
}

/** 刷新每个角色的消息数（侧栏摘要 / 未读） */
async function refreshMsgCounts() {
  try {
    msgCounts = await countByChar();
  } catch {
    msgCounts = {};
  }
  try {
    groupCounts = await countByGroup();
  } catch {
    groupCounts = {};
  }
  return msgCounts;
}

/** 重新载入群聊列表（成员里已被删除的角色在 ctx.groupMembers 里会自动消失） */
async function reloadGroups() {
  try {
    groups = await listGroups();
  } catch (err) {
    groups = [];
    console.warn('[app] 读取群聊失败', err);
  }
  if (currentGroupId && !groups.some((g) => g.id === currentGroupId)) {
    // 当前群被删掉了：先尝试回到某个角色，否则回首页
    currentGroupId = null;
    writeLastGroup(null);
    writeLastKind('');
  }
  return groups;
}

/* ===========================================================================
 * 重绘
 * ======================================================================== */

/**
 * 局部重绘（契约 3.14）
 * @param {'sidebar'|'chat'|'all'} [part]
 */
function rerender(part) {
  if (part === 'sidebar') {
    refreshSidebar();
    return;
  }
  if (part === 'chat') {
    refreshMessages();
    return;
  }
  refreshSidebar();
  refreshMessages();
  renderRightPane();
}

/* ===========================================================================
 * 调试面板
 * ======================================================================== */

/**
 * 创建 / 显隐右下角调试面板
 * @param {boolean} on
 */
function applyDebugPanel(on) {
  if (!on && !debugPanel) return;
  if (!debugPanel) {
    debugBody = el('pre', { text: '（还没有调用记录）' });
    debugPanel = el(
      'div.debug',
      el(
        'div.d-head',
        el('span', { text: '调试面板 · 最近一轮' }),
        el(
          'button.icon-btn.sm',
          {
            title: '关闭',
            on: {
              click: () => {
                setSettings({ showDebug: false });
                debugPanel.classList.remove('on');
              },
            },
          },
          icon('close', 14)
        )
      ),
      debugBody
    );
    document.body.appendChild(debugPanel);
  }
  debugPanel.classList.toggle('on', !!on);
}

/**
 * 显示最近一轮调用的 token 与模型
 * @param {object} u bus 的 llm:usage 载荷
 */
function onLlmUsage(u) {
  if (!debugPanel || !debugBody) return;
  const lines = [
    `时间      ${new Date().toLocaleTimeString('zh-CN')}`,
    `供应商    ${(u && u.provider) || '-'}`,
    `模型      ${(u && u.model) || '-'}`,
    `prompt    ${num(u && u.prompt, 0)} tokens`,
    `completion${num(u && u.completion, 0)} tokens`,
    `total     ${num(u && u.total, 0)} tokens`,
    `费用      ￥${num(u && u.cost, 0).toFixed(4)}`,
  ];
  debugBody.textContent = lines.join('\n');
}

/* ===========================================================================
 * 事件总线接线
 * ======================================================================== */

/** 绑定总线事件 */
function bindBus() {
  // editor.js 保存新角色后靠这个跳转
  bus.on('app:open-chat', (payload) => {
    const id = typeof payload === 'string' ? payload : payload && payload.id;
    if (!id) return;
    void reloadCharacters().then(() => openChat(id));
  });

  // 搜索命中后跳转到某条消息（兼容字符串与 {id, charId} 两种载荷）
  bus.on('chat:focus-message', (payload) => {
    void focusMessage(payload);
  });

  // 收藏夹等入口跳转到某条**群消息**（载荷 {id, groupId}，与上面那条私聊的对称）
  bus.on('gchat:focus-message', (payload) => {
    void focusGroupMessage(payload);
  });

  // Esc / 停止按钮：取消正在进行的流式生成
  bus.on('chat:abort', () => {
    abortChat();
  });

  bus.on('char:changed', () => {
    void reloadCharacters().then(() => {
      rerender('all');
      updateTitle();
    });
  });

  bus.on('char:deleted', (payload) => {
    void onCharDeleted(payload);
  });

  // 消息变化：节流 300ms 更新侧栏摘要与未读
  const onMsg = throttle(() => {
    void (async () => {
      await refreshMsgCounts();
      refreshSidebar();
      updateTitle();
      if (currentCharId) renderRightPane();
    })();
  }, 300);
  bus.on('msg:appended', onMsg);
  bus.on('msg:updated', onMsg);

  // 群聊：消息/群资料变化同样刷新侧栏摘要与未读（群聊区自己会重画消息流）
  const onGroupMsg = throttle(() => {
    void (async () => {
      await refreshMsgCounts();
      refreshSidebar();
      updateTitle();
      if (currentGroupId) renderRightPane();
    })();
  }, 300);
  bus.on('gmsg:appended', onGroupMsg);
  bus.on('gmsg:updated', onGroupMsg);

  bus.on('group:changed', (g) => {
    void (async () => {
      await reloadGroups();
      refreshSidebar();
      // 中栏由 ui/groupchat.js 自己整块重绘（成员条/顶栏里都嵌了成员信息），
      // 这里只负责侧栏与右栏，避免两边同时重绘打架。
      if (g && currentGroupId === g.id) renderRightPane();
    })();
  });

  bus.on('group:deleted', (payload) => {
    void (async () => {
      await reloadGroups();
      refreshSidebar();
      if (payload && (payload.all || payload.id === currentGroupId)) {
        currentGroupId = null;
        writeLastGroup(null);
        writeLastKind('');
        renderRightPane();
        renderChatInto();
      }
      updateTitle();
    })();
  });

  bus.on('settings:changed', (next) => {
    onSettingsChanged(next);
  });

  // chat.js 通过 bus 暴露当前会话的语音队列
  bus.on('voice:queue', (q) => {
    speechQueue = q || null;
  });

  bus.on('llm:usage', (u) => {
    onLlmUsage(u);
  });

  bus.on('proactive:notify', (payload) => {
    onProactiveNotify(payload);
  });
}

/** 角色被删除 */
async function onCharDeleted(payload) {
  const id = payload && payload.id;
  const all = !!(payload && payload.all);
  const wasCurrent = all || (id && id === currentCharId);
  await reloadCharacters();
  // 角色被删后会被自动摘出所有群聊，群列表与群资料都要跟着刷新
  await reloadGroups();

  if (all || (!characters.length && currentCharId)) {
    currentCharId = null;
    writeLastChar(null);
  }
  if (wasCurrent) {
    await openChat(null);
  } else {
    rerender('all');
  }
  updateTitle();
}

/** 设置变化 */
function onSettingsChanged(next) {
  const s = next && typeof next === 'object' ? next : getSettings();
  applyTheme(s.theme, s.accent);
  applyDebugPanel(!!s.showDebug);

  const prevStt = prevSettings && prevSettings.voice && prevSettings.voice.stt ? prevSettings.voice.stt.lang : '';
  const nextStt = s.voice && s.voice.stt ? s.voice.stt.lang : '';
  const prevVoiceOn = !!(prevSettings && prevSettings.voice && prevSettings.voice.enabled);
  const nextVoiceOn = !!(s.voice && s.voice.enabled);

  // 与语言 / 语音相关的设置变化需要重绘聊天区（输入框的识别语言等）
  if (prevSettings && (prevStt !== nextStt || prevVoiceOn !== nextVoiceOn)) {
    rerender('chat');
  }

  // 角色主动性开关变化时重启定时器（proactive.js 内部会先 stop 再 start）
  const prevProactive = !!(prevSettings && prevSettings.proactive && prevSettings.proactive.enabled);
  const nextProactive = !!(s.proactive && s.proactive.enabled);
  if (prevSettings && prevProactive !== nextProactive) {
    try {
      initProactive(ctx);
    } catch (err) {
      console.warn('[app] initProactive 失败', err);
    }
  }

  prevSettings = s;
}

/**
 * 跳转并高亮某条消息
 * @param {string|{id:string,charId?:string}} payload
 */
async function focusMessage(payload) {
  const id = typeof payload === 'string' ? payload : payload && payload.id;
  const charId = typeof payload === 'object' && payload ? payload.charId : '';
  if (!id) return;

  if (charId && charId !== currentCharId) {
    await openChat(charId);
  } else if (!currentCharId) {
    return; // 没有当前会话，无从定位
  }

  // 等 chat.js 把消息节点渲染出来
  await new Promise((r) => setTimeout(r, 120));

  if (typeof chatMod.focusMessage === 'function') {
    try {
      await chatMod.focusMessage(id);
      return;
    } catch (err) {
      console.warn('[app] chat.focusMessage 失败，改用 DOM 兜底', err);
    }
  }

  const safe = String(id).replace(/["\\]/g, '\\$&');
  const node =
    chatPane.querySelector(`[data-mid="${safe}"]`) ||
    chatPane.querySelector(`[data-id="${safe}"]`) ||
    chatPane.querySelector(`#msg-${safe}`);
  if (!node) return;
  try {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    node.scrollIntoView();
  }
  node.classList.add('flash-highlight');
  setTimeout(() => node.classList.remove('flash-highlight'), 1400);
}

/**
 * 跳到某条**群消息**（收藏夹等入口用；与上面的 focusMessage 对称）
 * @param {{id?:string, groupId?:string}|string} payload
 */
async function focusGroupMessage(payload) {
  const id = typeof payload === 'string' ? payload : payload && payload.id;
  const groupId = typeof payload === 'object' && payload ? payload.groupId : '';
  if (!id) return;

  if (groupId && groupId !== currentGroupId) {
    await openGroup(groupId);
  } else if (!currentGroupId) {
    return; // 没有当前群聊，无从定位
  }

  // 群消息在 openGroup 之后是异步读出来的（见 ui/groupchat.js 的 refreshGroupMessages），
  // 所以这里先让出一拍，真正的"等渲染"交给 focusGroupMessage 自己重试（它最多等 1.2 秒）
  await new Promise((r) => setTimeout(r, 180));
  if (typeof groupChatMod.focusGroupMessage === 'function') {
    try {
      await groupChatMod.focusGroupMessage(id);
    } catch (err) {
      console.warn('[app] groupchat.focusGroupMessage 失败', err);
    }
  }
}

/** 取消正在进行的生成（Esc） */
function abortChat() {
  // 0) 群聊：群里的"排队发言"有自己的打断入口
  if (currentGroupId) {
    const gStop =
      chatPane.querySelector('.gchat-round-btn.busy') ||
      chatPane.querySelector('#groupSendBtn.stop');
    // 注意：只在"正在生成"时才能点发送键（否则会把我刚敲的半句话发出去）
    if (gStop instanceof HTMLElement) {
      gStop.click();
      return true;
    }
    try {
      if (typeof groupChatMod.stopGroupRound === 'function') groupChatMod.stopGroupRound('user');
    } catch {
      /* 忽略 */
    }
    return false;
  }

  // 1) 聊天区里的停止按钮（styles/app.css 里的 .send-btn.stop）
  const stopBtn =
    chatPane.querySelector('.send-btn.stop') ||
    chatPane.querySelector('[data-act="stop"]') ||
    chatPane.querySelector('[data-action="stop"]') ||
    chatPane.querySelector('button[title="停止"]');
  if (stopBtn instanceof HTMLElement) {
    stopBtn.click();
    return true;
  }
  // 2) 退而求其次：停掉正在朗读的语音
  try {
    if (speechQueue && typeof speechQueue.stop === 'function') speechQueue.stop();
  } catch {
    /* 忽略 */
  }
  return false;
}

/** 收到角色主动消息 */
function onProactiveNotify(payload) {
  const name = (payload && payload.name) || (payload && payload.charId && findName(payload.charId)) || '你的好友';
  toast(`${name} 给你发来一条消息`, 'info', 5200);
  flashTitle();
  void (async () => {
    await refreshMsgCounts();
    refreshSidebar();
    updateTitle();
    if (payload && payload.charId === currentCharId) refreshMessages();
  })();
}

/** 由 id 找角色名 */
function findName(id) {
  const c = characters.find((x) => x.id === id);
  return c ? c.name : '';
}

/* ===========================================================================
 * 快捷键
 * ======================================================================== */

/** 全局快捷键帮助弹层 */
function showShortcutHelp() {
  const rows = [
    ['Ctrl / Cmd + K', '全局搜索（跨角色搜消息与角色名）'],
    ['Ctrl / Cmd + N', '新建角色（部分浏览器会占用该组合键）'],
    ['Esc', '关闭最上层弹层；没有弹层时停止生成'],
    ['Ctrl / Cmd + /', '打开这份快捷键帮助'],
  ];
  const list = el('div');
  for (const [k, v] of rows) list.appendChild(el('div.kv', el('span.k', { text: k }), el('span.v', { text: v })));
  modal({
    title: '快捷键',
    body: el('div', list, el('div.field-hint', { text: '提示：移动端没有键盘快捷键，请使用界面上的按钮。' })),
    width: 460,
    actions: [{ text: '知道了', kind: 'primary' }],
  });
}

/** 绑定全局快捷键 */
function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const key = String(e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (mod && key === 'k') {
      e.preventDefault();
      openGlobalSearch();
      return;
    }
    if (mod && key === 'n') {
      e.preventDefault();
      newCharacter();
      return;
    }
    if (mod && (key === '/' || key === '?')) {
      e.preventDefault();
      showShortcutHelp();
      return;
    }
    if (e.key === 'Escape') {
      // 先尝试关闭最上层弹层（toast.js 的弹层自己也会处理 Esc）
      if (closeTopModal()) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) active.blur();
      bus.emit('chat:abort');
    }
  });
}

/* ===========================================================================
 * 移动端 / 视口
 * ======================================================================== */

/** 根据窗口宽度切换单栏 / 三栏 */
function applyViewport() {
  if (!shell) return;
  const mobile = isMobile();
  shell.classList.toggle('mobile', mobile);
  if (!mobile) shell.classList.remove('show-side');
  else if (!currentCharId) shell.classList.add('show-side');
  syncShellLayout();
}

/**
 * 移动端单栏：显式接管两个面板的显隐。
 *
 * 为什么需要这一步：styles/app.css 的
 *   @media (max-width: 760px) { .shell.show-side .pane-main { display: none } }
 * 会被 ui/chat.js 写在 #chatPane 上的**内联** style="display:flex" 覆盖
 * （chat.js 的 STY.chat 常量），结果在手机上查看好友列表时聊天面板依旧占位。
 * app.js 是外壳的拥有者，所以在窄屏下由这里接管两个面板的 display；宽屏不做任何干预，
 * 把内联样式还回去，一切交回 CSS。chat.js 若把该内联 display 去掉，这里就变成无害的幂等操作。
 * @returns {void}
 */
function syncMobilePanes() {
  if (!shell || !sidebarPane || !chatPane) return;
  if (!isMobile()) {
    sidebarPane.style.removeProperty('display');
    chatPane.style.removeProperty('display');
    return;
  }
  const showList = shell.classList.contains('show-side');
  sidebarPane.style.display = showList ? 'flex' : 'none';
  chatPane.style.display = showList ? 'none' : 'flex';
}

/* ---------------------------------------------------------------------------
 * 布局偏好：收起顶栏 / 收起右栏
 *   状态只落在 `.shell` 的两个 class 上：
 *     · .head-collapsed —— 顶栏 display:none，同时露出中栏顶部那条细"拉手"
 *     · .no-right       —— 右栏 display:none，中栏吃掉整行（class 名沿用 CSS 里已有的）
 *   各个开关按钮只负责发起切换、本身不留状态；图标由 CSS 依据这两个 class 切换显示，
 *   文案在 applyLayoutPrefs 里统一同步（按钮每次重绘都是新的，不刷就会写着过期文案）。
 * ------------------------------------------------------------------------ */

/** 把布局偏好写到外壳上（幂等） */
function applyLayoutPrefs() {
  if (!shell) return;
  shell.classList.toggle('head-collapsed', headCollapsed);
  shell.classList.toggle('no-right', rightCollapsed);
  syncToggleTitles();
}

/** 同步"收起 / 展开"按钮的悬停与无障碍文案 */
function syncToggleTitles() {
  const pairs = [
    ['head', '收起顶栏', '展开顶栏', headCollapsed],
    ['right', '收起右栏', '展开右栏', rightCollapsed],
  ];
  for (const [marker, openTitle, shutTitle, shut] of pairs) {
    const title = shut ? shutTitle : openTitle;
    for (const btn of document.querySelectorAll(`[data-toggle="${marker}"]`)) {
      if (btn.title !== title) {
        btn.title = title;
        btn.setAttribute('aria-label', title);
      }
      btn.setAttribute('aria-pressed', shut ? 'true' : 'false');
    }
  }
}

/**
 * 设置顶栏收起状态并落盘
 * @param {boolean} next
 * @returns {boolean} 最新状态（true = 已收起）
 */
function setHeadCollapsed(next) {
  headCollapsed = !!next;
  writeLS(HEAD_COLLAPSED_KEY, headCollapsed ? '1' : '0');
  applyLayoutPrefs();
  return headCollapsed;
}

/**
 * 设置右栏收起状态并落盘
 * @param {boolean} next
 * @returns {boolean} 最新状态（true = 已收起）
 */
function setRightCollapsed(next) {
  rightCollapsed = !!next;
  writeLS(RIGHT_COLLAPSED_KEY, rightCollapsed ? '1' : '0');
  applyLayoutPrefs();
  return rightCollapsed;
}

/** 开机读回布局偏好 */
function readLayoutPrefs() {
  headCollapsed = readLS(HEAD_COLLAPSED_KEY, '') === '1';
  rightCollapsed = readLS(RIGHT_COLLAPSED_KEY, '') === '1';
}

/**
 * 外壳布局变化后的统一收口：窄屏面板显隐 + 布局偏好。
 * 中栏每次重绘都走这里，所以顶栏里新建出来的按钮文案不会失联。
 */
function syncShellLayout() {
  syncMobilePanes();
  applyLayoutPrefs();
}

/** 绑定窗口尺寸变化 */
function bindViewport() {
  window.addEventListener('resize', throttle(applyViewport, 150));
  applyViewport();
}

/* ===========================================================================
 * 首次使用引导
 * ======================================================================== */

/** 展示首次使用引导（.onboard / .onboard-card / .ob-steps，样式已存在） */
function showOnboard() {
  if (document.querySelector('.onboard')) return;

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    const node = document.querySelector('.onboard');
    if (node) node.remove();
    try {
      setSettings({ onboarded: true });
    } catch {
      /* 忽略 */
    }
  };

  const step = (n, title, desc) =>
    el(
      'div.ob-step',
      el('div.n', { text: String(n) }),
      el('div.t', el('b', { text: title }), el('span', { text: `　${desc}` }))
    );

  const overlay = el(
    'div.onboard',
    el(
      'div.onboard-card',
      el('h2', { text: '欢迎来到「AI 好友」' }),
      el('p.ob-sub', {
        text: '这不是一个聊天框，而是一本 AI 好友通讯录：每个角色都有自己的人设、自己的聊天记录，全部住在你自己的浏览器里。',
      }),
      el(
        'div.ob-steps',
        step(1, '选一个内置人设', '内置 30+ 开箱即用的角色（温柔学姐、毒舌同事、悬疑小说家…），挑一个再按需修改。'),
        step(2, '连接本地模型', '双击项目启动脚本准备 Qwen3，在「设置 → 模型」点击「测试连接」，无需 API Key。'),
        step(3, '开始聊天', '回到好友列表点开他就能聊；他会记得你说过的事，也会在久未联系时主动找你。'),
        step(4, '拉个群一起聊', '有两位以上好友后，点左侧「群聊」的 ＋ 建个群；群里的人看得见彼此的发言，会互相接话、吐槽、拆台，你可以旁观也可以插话。')
      ),
      el(
        'div.row.wrap',
        el(
          'button.btn.btn-primary',
          { on: { click: () => { finish(); openTemplateGallery(); } } },
          icon('sparkles', 15),
          el('span', { text: '从模板挑一个好友' })
        ),
        el(
          'button.btn',
          { on: { click: () => { finish(); openSettings('model'); } } },
          icon('key', 15),
          el('span', { text: '看设置怎么填' })
        )
      ),
      el(
        'div',
        { style: { marginTop: '16px', textAlign: 'center' } },
        el('button.btn.btn-ghost.btn-sm', { on: { click: finish } }, el('span', { text: '直接跳过（我先随便看看）' }))
      )
    )
  );
  document.body.appendChild(overlay);
}

/* ===========================================================================
 * PWA / 声音解锁 / 使用时长提醒
 * ======================================================================== */

/** 注册 Service Worker（失败静默） */
function registerSW() {
  if (location.protocol === 'file:') return;
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 忽略：不影响主流程 */
    });
  } catch {
    /* 忽略 */
  }
}

/** 首次用户手势里解锁音频自动播放 */
function bindFirstGesture() {
  const onGesture = () => {
    document.removeEventListener('pointerdown', onGesture, true);
    try {
      void speaker.unlock();
    } catch {
      /* 忽略 */
    }
  };
  document.addEventListener('pointerdown', onGesture, true);
}

/** 使用时长提醒（对应规划文档第十二节「情感依赖」） */
function startUsageReminder() {
  const startedAt = Date.now();
  setInterval(() => {
    const s = getSettings();
    if (s.dependencyReminder === false) return;
    if (Date.now() - startedAt < 90 * 60 * 1000) return;
    const today = new Date().toDateString();
    try {
      if (localStorage.getItem('aichat.dependencyReminded') === today) return;
      localStorage.setItem('aichat.dependencyReminded', today);
    } catch {
      /* 忽略 */
    }
    toast('已经聊了很久啦：起来动一动、喝口水，看看窗外。好友会一直在这里等你。', 'info', 9000);
  }, 60 * 1000);
}

/* ===========================================================================
 * 启动
 * ======================================================================== */

/**
 * 应用启动（index.html 调用）
 * @returns {Promise<void>}
 */
export async function bootstrap() {
  if (booted) return;
  booted = true;

  const initialHash = location.hash || '';

  // 1) 主题与强调色（必须最先，避免白闪）
  prevSettings = getSettings();
  applyTheme(prevSettings.theme, prevSettings.accent);

  // 1b) 设备放不出声时的提示（voice/tts.js 的看门狗会跳过播放，这里告诉用户一声，
  //     否则朗读会悄无声息地略过，看起来像"功能坏了"）。模块内部已限流 10s 一次。
  speaker.onPlaybackSkipped = () => {
    toast('当前设备无法播放语音，已跳过朗读（可检查系统音频输出）', 'warn', 4200);
  };

  // 2) 外壳（先把"顶栏 / 右栏是否收起"的偏好读回来，再建，避免先闪一下展开态）
  readLayoutPrefs();
  buildShell();
  removeBootOverlay();
  bindViewport();
  applyDebugPanel(!!prevSettings.showDebug);

  // 3) 数据：先把电脑本地文件里的角色/聊天记录回填到浏览器数据库（没装 server 或纯静态部署会自动跳过）
  try {
    const sync = await syncOnBoot();
    if (sync.ok && sync.action === 'pull' && sync.chars) {
      toast(`已从本地文件恢复 ${sync.chars} 位好友、${sync.messages} 条消息`, 'ok', 4200);
    } else if (sync.ok && sync.action === 'push' && sync.chars) {
      toast(`已把本地 ${sync.chars} 位好友保存到电脑文件`, 'ok', 4200);
    } else if (!sync.ok && sync.action === 'error') {
      toast(`本地文件同步失败：${sync.error || '未知原因'}（聊天不受影响）`, 'warn', 5200);
    }
  } catch (err) {
    console.warn('[app] 文件同步失败（忽略）', err);
  }

  await reloadCharacters();
  await reloadGroups();

  // 4) 事件与交互
  bindBus();
  bindShortcuts();
  bindFirstGesture();
  startUsageReminder();
  onStorageError((err) => {
    toast(`本地存储异常：${(err && err.message) || err}`, 'error', 5200);
  });

  // 5) 首次使用引导 / 恢复上次会话
  //    注意"上次会话"可能是群聊，所以这里先看 hash，再看 lastKind。
  const groupMatch = initialHash.match(/^#\/group\/(.+)$/);
  const wantedGroup = groupMatch ? decodeRouteId(groupMatch[1]) : '';
  const wantGroup = wantedGroup
    ? groups.some((g) => g.id === wantedGroup)
    : readLastKind() === 'group' && groups.some((g) => g.id === readLastGroup());

  if (!characters.length && !groups.length) {
    if (!prevSettings.onboarded) showOnboard();
    currentCharId = null;
    currentGroupId = null;
    renderSidebarInto();
    renderChatInto();
    renderRightPane();
    updateTitle();
  } else if (wantGroup && (groups.length || wantedGroup)) {
    // 先把左栏渲染一次：sidebar.js 的 refreshSidebar() 只重画已渲染过的列表
    renderSidebarInto();
    await openGroup(wantedGroup || readLastGroup());
    try {
      initProactive(ctx);
    } catch (err) {
      console.warn('[app] initProactive 失败', err);
    }
  } else {
    renderSidebarInto();
    const m = initialHash.match(/^#\/chat\/(.+)$/);
    const wanted = m ? decodeRouteId(m[1]) : '';
    const last = readLastChar();
    const target = characters.some((c) => c.id === wanted)
      ? wanted
      : characters.some((c) => c.id === last)
        ? last
        : characters.length
          ? characters[0].id
          : '';
    if (target) await openChat(target);
    try {
      initProactive(ctx);
    } catch (err) {
      console.warn('[app] initProactive 失败', err);
    }
  }

  // 6) 路由（初始 hash 不是会话时，例如直接打开 #/settings）
  window.addEventListener('hashchange', () => {
    void route();
  });
  if (initialHash && !/^#\/(chat|group)\//.test(initialHash)) {
    lastRouted = '';
    await route();
  }

  // 7) PWA
  registerSW();
  updateTitle();

  // 8) 调试/自动化钩子（无副作用，供 tools/e2e.mjs 与排查问题使用）
  try {
    globalThis.__AICHAT__ = {
      ctx,
      openChat,
      openGroup,
      openGroupEditor,
      get state() {
        return {
          currentCharId,
          currentGroupId,
          characters: characters.slice(),
          groups: groups.slice(),
          settings: getSettings(),
        };
      },
      abort: abortChat,
      rerender,
      fileStatus,
      groupBusy: () => (typeof groupChatMod.isGroupBusy === 'function' ? groupChatMod.isGroupBusy() : false),
    };
  } catch {
    /* 忽略 */
  }
}

export default { bootstrap };

/** 损坏的书签回落到默认会话，不阻止应用启动。 */
function decodeRouteId(value) {
  try { return decodeURIComponent(value); } catch { return ''; }
}
