/**
 * ui/sidebar.js —— 左侧「AI 好友通讯录」（契约 3.14）
 *
 * 目标：让左侧列表看起来像一个社交软件的好友列表，而不是一个功能菜单。
 * - 顶部：应用标题 + 图标工具条（新建 / 全局搜索 / 模板库 / 设置 / 主题）
 * - 中部：即时过滤搜索框 + 分组折叠 + 好友行（头像 / 名字 / 时间 / 摘要 / 未读）
 * - 底部：本地文件保存状态行（数据自动落盘到 data/db，不再有导入 / 导出 / 备份入口）
 *
 * 约定与边界：
 * - 本模块不持有业务数据，数据一律来自 core/store.js 与 core/runtime.js。
 *   只在模块级 cache 里缓存异步索引（每个角色的最后一条消息、消息总数），
 *   bus 事件到达时失效并重取。
 * - 全部 DOM 用 ui/dom.js 的 el() 构建，用户内容一律走文本节点（防 XSS）。
 * - 视觉：以语义 class 暴露给 styles/app.css 换肤；关键布局与「角色主题色」这类
 *   动态值以内联样式 + CSS 变量回退写出，保证即使样式表缺失也依然像一个好友列表。
 * - 模块顶层不访问 document / localStorage（第一次渲染时才惰性读取）。
 */

import { bus } from '../core/bus.js';
import {
  saveCharacter,
  deleteCharacter,
  duplicateCharacter,
  listCharacters,
  listConversationStats,
  searchMessages,
  setSettings,
  listGroups,
  saveGroup,
  deleteGroup,
} from '../core/store.js';
import { fileStatus } from '../core/filestore.js';
import { openSyncConflict } from './sync-conflicts.js';
import { unreadOf, unreadTotal, markRead } from '../core/runtime.js';
import { debounce, throttle, relTime, truncate, firstChar, num } from '../core/util.js';
import { el, mount } from './dom.js';
import { isImageAvatar } from './shared.js';
import { icon } from './icons.js';
import { toast, confirmDialog, modal } from './toast.js';
import {
  openCharacterEditor,
  openTemplateGallery,
} from './editor.js';
import { openGroupEditor, openMemberPicker } from './groupeditor.js';
import { openFavorites } from './favorites.js';
import { openSettings } from './settings.js';

/* ------------------------------------------------------------------ *
 * 一、设计令牌与内联样式
 *     —— 颜色统一走 CSS 变量（styles/base.css 定义），并带回退值：
 *        换肤只需覆盖变量，缺样式表时也不会变成白板。
 * ------------------------------------------------------------------ */

/** 颜色令牌（与契约 §4 的色板一致） */
const T = {
  bg: 'var(--bg, #0f1115)',
  panel: 'var(--panel, #171a21)',
  panel2: 'var(--panel-2, #1e222b)',
  line: 'var(--line, #2a2f3a)',
  text: 'var(--text, #e7e9ee)',
  dim: 'var(--dim, #8b93a7)',
  accent: 'var(--accent, #6c8cff)',
  ok: 'var(--ok, #4ec9a8)',
  warn: 'var(--warn, #e0b341)',
  danger: 'var(--danger, #ff6b6b)',
};

/**
 * 内联样式只保留「CSS 拿不到的信息」：
 * - 角色主题色这类每个角色都不同的动态值（头像底色 / 文字色）；
 * - 长按 / 右键临时展开快捷操作时的 display。
 * 其余视觉一律交给 styles/base.css 与 styles/app.css
 * （.side-head / .side-title / .side-search / .side-body / .group-head / .friend /
 *   .avatar / .friend-main / .friend-preview / .friend-flags / .friend-acts / .side-foot），
 * 这样换肤只需改 CSS 变量，不会和样式表互相打架。
 */
const S = {
  /** 保险：app.css 的 .pane / .pane-side 已提供同样布局，缺样式表时也不至于塌掉 */
  root: { display: 'flex', 'flex-direction': 'column', height: '100%', 'min-height': '0' },
  /** 置顶小标（放在 .avatar 圆内，避免被 overflow:hidden 裁掉） */
  pin: {
    position: 'absolute',
    top: '1px',
    right: '1px',
    color: 'var(--accent, #6c8cff)',
    background: 'var(--panel, #171a21)',
    'border-radius': '50%',
    padding: '1px',
    display: 'inline-flex',
    'line-height': '0',
  },
};

/** 把 #rgb / #rrggbb 转成低透明度 rgba（头像底色用角色主题色） */
function alpha(color, a) {
  const s = String(color == null ? '' : color).trim();
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return s || 'transparent';
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* ------------------------------------------------------------------ *
 * 二、模块级状态
 * ------------------------------------------------------------------ */

const COLLAPSE_KEY = 'aichat.groups.collapsed';

/** 「群聊」这一整块是否折叠（与好友分组共用 COLLAPSE_KEY，用特殊名字区分） */
const GROUP_SECTION = '__群聊__';

/** 最近一次渲染的 root / ctx（refreshSidebar 需要它） */
const refs = {
  /** @type {HTMLElement|null} */
  root: null,
  /** @type {any} */
  ctx: null,
  /** @type {HTMLElement|null} */
  listHost: null,
  /** @type {HTMLElement|null} */
  footHost: null,
  /** @type {HTMLElement|null} */
  headHost: null,
  /** @type {HTMLInputElement|null} */
  searchInput: null,
};

/** 本地过滤关键词（跨重绘保留） */
let keyword = '';

/** @type {Set<string>|null} 折叠的分组名（惰性从 localStorage 读取） */
let collapsedGroups = null;

/** 异步数据缓存 */
const cache = {
  ready: false,
  loading: false,
  /** 加载中又有新请求 → 完成后再补一次 */
  pending: false,
  /** @type {object[]|null} 角色列表（以 store 为准，避免 ctx.characters 还没刷新时显示旧数据） */
  chars: null,
  /** @type {Map<string, object>} charId → 最后一条消息 */
  lastMsg: new Map(),
  /** @type {Record<string, number>} charId → 消息数 */
  counts: {},
  /** @type {object[]|null} 群聊列表 */
  groups: null,
  /** @type {Map<string, object>} groupId → 最后一条群消息 */
  lastGroupMsg: new Map(),
  /** @type {Record<string, number>} groupId → 群消息数 */
  groupCounts: {},
};

let subscribed = false;

/* ------------------------------------------------------------------ *
 * 三、小工具
 * ------------------------------------------------------------------ */

/** ctx.characters / ctx.currentCharId 既可能是 getter 也可能是函数，两种都兼容 */
function ctxChars(ctx) {
  // 优先用自己从 store 拉到的那份：
  // 本地操作（置顶/免打扰/删除/复制）与其它模块保存角色后，ctx.characters 可能还没刷新完，
  // 直接用 store 的结果可避免列表短暂显示过期数据；ctx.characters 作为兜底与首屏来源。
  if (Array.isArray(cache.chars)) return cache.chars;
  const v = ctx ? ctx.characters : null;
  const list = typeof v === 'function' ? v.call(ctx) : v;
  return Array.isArray(list) ? list : [];
}

function ctxCharId(ctx) {
  const v = ctx ? ctx.currentCharId : null;
  return typeof v === 'function' ? v.call(ctx) : v || null;
}

/** 群聊列表（优先用自己拉的那份，原因同 ctxChars） */
function ctxGroups(ctx) {
  if (Array.isArray(cache.groups)) return cache.groups;
  const v = ctx ? ctx.groups : null;
  const list = typeof v === 'function' ? v.call(ctx) : v;
  return Array.isArray(list) ? list : [];
}

/** 当前群聊 id */
function ctxGroupId(ctx) {
  const v = ctx ? ctx.currentGroupId : null;
  return typeof v === 'function' ? v.call(ctx) : v || null;
}

/** 打开群聊（软调用） */
function ctxOpenGroup(ctx, id) {
  if (!ctx || typeof ctx.openGroup !== 'function') return;
  try {
    Promise.resolve(ctx.openGroup(id)).catch((err) => console.warn('[sidebar] openGroup 失败', err));
  } catch (err) {
    console.warn('[sidebar] openGroup 抛错', err);
  }
}

function ctxSettings(ctx) {
  const v = ctx ? ctx.settings : null;
  return (typeof v === 'function' ? v.call(ctx) : v) || {};
}

/** 安全调 ctx.openChat（吞掉异常，避免未处理的 Promise 拒绝） */
function ctxOpenChat(ctx, id) {
  if (ctx && typeof ctx.openChat === 'function') {
    try {
      Promise.resolve(ctx.openChat(id)).catch((err) => console.warn('[sidebar] openChat 失败', err));
    } catch (err) {
      console.warn('[sidebar] openChat 抛错', err);
    }
  }
}

/**
 * 让 app.js 重新加载角色列表（ctx.characters 是应用侧的权威数据）。
 * @returns {Promise<void>} 可在本地操作后 await，确保重绘读到的是新数据
 */
function ctxReload(ctx) {
  if (!ctx || typeof ctx.reloadCharacters !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(ctx.reloadCharacters()).then(
      () => undefined,
      (err) => console.warn('[sidebar] 重新加载角色失败', err)
    );
  } catch (err) {
    console.warn('[sidebar] reloadCharacters 抛错', err);
    return Promise.resolve();
  }
}

/** 折叠状态（惰性读 localStorage，顶层不访问） */
function collapsed() {
  if (!collapsedGroups) {
    collapsedGroups = new Set();
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
      if (Array.isArray(raw)) raw.forEach((n) => collapsedGroups.add(String(n)));
    } catch {
      /* 忽略：损坏的本地状态 */
    }
  }
  return collapsedGroups;
}

function persistCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed()]));
  } catch {
    /* 忽略 */
  }
}

/** 是否是图片头像（dataURL 或 http(s) 链接） */
/** 头像里显示的字（emoji 优先，其次名字首字） */
function avatarText(c) {
  const emoji = String(c.emoji == null ? '' : c.emoji).trim();
  if (emoji) return emoji;
  return firstChar(c.name);
}

/** 摘要文本：压掉换行、自己发的加「我：」前缀 */
function previewText(c) {
  const last = cache.lastMsg.get(c.id);
  if (!last) return String(c.tagline == null ? '' : c.tagline) || '还没有聊过，打个招呼吧';
  const body = truncate(String(last.content || '').replace(/\s+/g, ' ').trim() || '（空消息）', 18);
  if (last.role === 'user') return `我：${body}`;
  if (last.role === 'system') return `系统：${body}`;
  return body;
}

/** 最后活动时间 */
function lastTime(c) {
  const last = cache.lastMsg.get(c.id);
  if (last && last.at) return relTime(last.at);
  return c.updatedAt ? relTime(c.updatedAt) : '';
}

/** 排序：置顶 → 最后消息时间倒序 → updatedAt 倒序 */
function sortFriends(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  const ta = cache.lastMsg.get(a.id) ? num(cache.lastMsg.get(a.id).at) : 0;
  const tb = cache.lastMsg.get(b.id) ? num(cache.lastMsg.get(b.id).at) : 0;
  if (ta !== tb) return tb - ta;
  return num(b.updatedAt) - num(a.updatedAt);
}

/** 分组顺序：默认 → 其余按名称 */
function sortGroupNames(a, b) {
  const DA = '默认';
  if (a === b) return 0;
  if (a === DA) return -1;
  if (b === DA) return 1;
  return a.localeCompare(b, 'zh-Hans-CN');
}

/** 多关键词模糊匹配（名字 / 简介 / 标签 / emoji） */
function matchesKeyword(c, kw) {
  if (!kw) return true;
  const hay = [c.name, c.tagline, c.emoji, Array.isArray(c.tags) ? c.tags.join(' ') : '']
    .map((s) => String(s == null ? '' : s))
    .join(' ')
    .toLowerCase();
  return kw
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

/* ------------------------------------------------------------------ *
 * 四、异步数据（角色列表 / 最后一条消息 / 消息总数）
 * ------------------------------------------------------------------ */

function invalidate() {
  cache.ready = false;
  ensureData();
}

/** 本地操作收尾：等 app.js 换新 ctx.characters → 重取索引 → 立刻重绘 */
async function afterMutation(ctx) {
  await ctxReload(ctx);
  invalidate();
  refreshSidebar();
}

const scheduleInvalidate = throttle(invalidate, 320);
const scheduleRefresh = throttle(() => refreshSidebar(), 200);
/** 只重绘底栏（本地文件状态变化时用，避免打断列表与搜索） */
const scheduleFootRefresh = throttle(() => renderFoot(), 200);

async function ensureData() {
  if (cache.loading) {
    // 正在加载：标记一下，等这轮结束后补一次，避免拿到旧快照就收工
    cache.pending = true;
    return;
  }
  if (cache.ready) return;
  cache.loading = true;
  try {
    const [chars, groups, stats] = await Promise.all([
      listCharacters(),
      listGroups(),
      listConversationStats(),
    ]);
    const { recent, counts, groupRecent, groupCounts } = stats;
    if (Array.isArray(chars)) cache.chars = chars;
    const map = new Map();
    // listRecent() 已按时间倒序，每个角色第一条即最新一条
    for (const m of recent || []) {
      if (m && m.charId && !map.has(m.charId)) map.set(m.charId, m);
    }
    cache.lastMsg = map;

    if (Array.isArray(groups)) cache.groups = groups;
    const gmap = new Map();
    for (const m of groupRecent || []) {
      if (m && m.groupId && !gmap.has(m.groupId)) gmap.set(m.groupId, m);
    }
    cache.lastGroupMsg = gmap;
    cache.groupCounts = groupCounts || {};
    cache.counts = counts || {};
    cache.ready = true;
  } catch (err) {
    console.warn('[sidebar] 读取角色/消息索引失败', err);
  } finally {
    cache.loading = false;
    refreshSidebar();
    if (cache.pending) {
      cache.pending = false;
      ensureData();
    }
  }
}

/** 订阅总线：数据类事件重取索引，运行时类事件只重绘 */
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  bus.on('msg:appended', scheduleInvalidate);
  bus.on('msg:updated', scheduleInvalidate);
  bus.on('char:changed', scheduleInvalidate);
  bus.on('char:deleted', scheduleInvalidate);
  // 群聊：消息与群资料变化都要重取索引（群名/成员数/摘要都会变）
  bus.on('gmsg:appended', scheduleInvalidate);
  bus.on('gmsg:updated', scheduleInvalidate);
  bus.on('group:changed', scheduleInvalidate);
  bus.on('group:deleted', scheduleInvalidate);
  bus.on('runtime:changed', scheduleRefresh);
  // 本地文件读写状态变化时只重绘底栏那一行（不打断列表与搜索框）
  bus.on('filestore:status', () => scheduleFootRefresh());
}

/* ------------------------------------------------------------------ *
 * 五、渲染
 * ------------------------------------------------------------------ */

export function renderSidebar(root, ctx) {
  if (!root) return;
  refs.root = root;
  if (ctx) refs.ctx = ctx;
  ensureSubscribed();

  // 顶部（标题 + 工具条 + 搜索框）、列表、底栏 —— 结构与 app.css 的选择器一一对应
  refs.searchInput = null;
  refs.headHost = buildHead();
  refs.listHost = el('div.side-body');
  refs.footHost = el('div.side-foot');

  // 布局保险：与 app.css 的 .pane / .pane-side 取值一致，
  // 这样即使 app.js 的容器没有加 .pane 类，.side-body 的 flex:1 也能正常滚动
  Object.assign(root.style, S.root);

  mount(root, refs.headHost, refs.listHost, refs.footHost);
  syncThemeButton();

  renderList();
  renderFoot();
  ensureData();
}

/**
 * 外部数据变化后重绘（只重画列表与底栏，不打断搜索框输入）
 */
export function refreshSidebar() {
  if (!refs.root || !document.body.contains(refs.root)) return;
  renderList();
  renderFoot();
}

/* ------------------------------ 顶部 ------------------------------ */

function buildHead() {
  const tools = el('div.side-tools');
  tools.appendChild(toolButton('plus', '新建角色 (Ctrl/Cmd+N)', () => openNewCharacterDialog()));
  tools.appendChild(toolButton('users', '新建群聊（拉好友一起聊）', () => openGroupDialog(refs.ctx, null)));
  tools.appendChild(toolButton('search', '全局搜索 (Ctrl/Cmd+K)', () => openGlobalSearch()));
  // 收藏夹：与"全局搜索"同一类"翻旧账"的入口，所以放在它旁边（数据来自 core/store.js 的 listBookmarks）
  tools.appendChild(toolButton('bookmark', '收藏夹（收藏过的对话）', () => openFavorites()));
  tools.appendChild(toolButton('sparkles', '模板库', () => openTemplateGallery()));
  tools.appendChild(toolButton('settings', '设置', () => openSettings()));
  const themeBtn = toolButton('moon', '切换深色 / 亮色', () => toggleTheme());
  themeBtn.dataset.role = 'theme';
  tools.appendChild(themeBtn);

  // 侧栏头部三段：品牌块（标题 + 副标题）→ 入口工具条 → 搜索框。
  // 标题不再和工具条抢同一行：288px 侧栏减去左右留白只剩 264px，7 个 34px 的入口
  // 放不下（会被 flex-wrap 折到第二行，还顶到栅格线外），所以让标题与副标题先合成
  // 一个整行的"品牌块"，工具条再另起一行等宽铺满（见 app.css 的 .side-head .side-tools）。
  return el(
    'div.side-head',
    el(
      'div.side-title',
      el('h1', el('span', { text: 'AI 好友' })),
      el('div.side-sub', { text: '本地优先 · 数据只在你的浏览器里' })
    ),
    tools,
    buildSearchBar()
  );
}

/** 顶栏图标按钮（外观由 base.css 的 .icon-btn 提供；尺寸 17 要与 app.css 的 --tool-icon 一致） */

function toolButton(iconName, title, onClick) {
  const btn = el(
    'button.icon-btn',
    { type: 'button', title, style: S.iconBtn, on: { click: onClick } },
    icon(iconName, 17)
  );
  btn.addEventListener('mouseenter', () => {
    btn.style.color = T.text;
    btn.style.background = T.panel2;
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.color = T.dim;
    btn.style.background = 'transparent';
  });
  return btn;
}

/* ------------------------------ 搜索框 ------------------------------ */

/**
 * 打开群聊编辑器。
 * 优先走 app.js 的 ctx.openGroupEditor：它保存完会自动重新载入群列表，
 * 并在"新建"时直接把界面切到新群；只有它不可用时才直接调 ui/groupeditor.js。
 * @param {any} ctx
 * @param {object|null} group 传 null 表示新建
 */
function openGroupDialog(ctx, group) {
  if (ctx && typeof ctx.openGroupEditor === 'function') {
    try {
      ctx.openGroupEditor(group || null);
      return;
    } catch (err) {
      console.warn('[sidebar] ctx.openGroupEditor 失败，降级为直接打开编辑器', err);
    }
  }
  openGroupEditor(group || null, {
    onSaved: (g) => {
      void (async () => {
        try {
          if (ctx && typeof ctx.reloadGroups === 'function') await ctx.reloadGroups();
        } catch {
          /* 忽略 */
        }
        invalidate();
        if (group) refreshSidebar();
        else ctxOpenGroup(ctx, g && g.id);
      })();
    },
  });
}

function buildSearchBar() {
  const input = el('input', {
    type: 'search',
    placeholder: '搜索好友 / 群聊',
    value: keyword,
    'aria-label': '搜索好友或群聊',
  });
  refs.searchInput = input;

  const run = debounce(() => {
    keyword = String(input.value || '').trim();
    renderList();
  }, 220);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      keyword = '';
      renderList();
    }
  });

  // .side-search 由 app.css 定位放大镜图标（.ic 绝对定位 + input 左内边距）
  return el('div.side-search', icon('search', 15), input);
}

/* ------------------------------ 列表 ------------------------------ */

/**
 * renderList 会整块重建 .side-body 的内容（mount → clear），而**被清空的滚动容器 scrollTop 必然归零**
 * （实测：先设 scrollTop=300，再移除全部子节点，立刻变 0；把节点原样加回去也回不来）。
 * 所以每次重绘都等于"列表回到顶部"——点分组折叠 / 展开时最明显。
 * 这里用「滚动锚点」把位置跨重绘保留下来：
 * - 重绘前记下视口内第一个真实行元素（.group 分组块 / .friend 好友行 / 群聊行）相对容器顶边的偏移；
 * - 重绘后找到同一个元素，按它挪动了多少反推 scrollTop 该补偿多少。
 * 这样折叠视口上方的分组时，视线锁定的那一行不会跟着跳。
 * @returns {{key: string, offset: number, scrollTop: number}|null}
 */
function captureScrollAnchor() {
  const box = scrollBox();
  if (!box || box.scrollTop <= 0) return null;
  const boxTop = box.getBoundingClientRect().top;
  const anchor = Array.from(box.querySelectorAll('[data-key]')).find(
    (n) => n.getBoundingClientRect().bottom > boxTop
  );
  if (!anchor) return null;
  const key = anchor.dataset.key;
  if (!key) return null;
  return { key, offset: anchor.getBoundingClientRect().top - boxTop, scrollTop: box.scrollTop };
}

/**
 * 按锚点还原滚动位置。
 * @param {{key: string, offset: number, scrollTop: number}|null} anchor captureScrollAnchor() 的返回值
 */
function restoreScrollAnchor(anchor) {
  const box = scrollBox();
  if (!box) return;
  if (!anchor) {
    // 重绘前本来就在顶部：清空后 scrollTop 已经是 0，不用管
    if (box.scrollTop) box.scrollTop = 0;
    return;
  }
  if (!anchor.key) {
    box.scrollTop = anchor.scrollTop;
    return;
  }

  const apply = () => {
    // 重绘可能让 refs.listHost 指向新节点，所以每帧重新取一次
    const el2 = scrollBox();
    if (!el2) return;
    const boxTop2 = el2.getBoundingClientRect().top;
    const target = Array.from(el2.querySelectorAll('[data-key]')).find((n) => n.dataset.key === anchor.key);
    if (!target) {
      // 锚点行没了（所属分组被折叠、被搜索过滤或角色被删）→ 退回原来的滚动位置
      el2.scrollTop = anchor.scrollTop;
      return;
    }
    const delta = target.getBoundingClientRect().top - boxTop2 - anchor.offset;
    if (delta) el2.scrollTop += delta;
    // 还原后锚点仍不在视口里，说明上面腾出的空间不够（比如顶部分组整块折叠了）——
    // 至少把它拉回原来的高度，而不是让用户盯着列表顶部
    const shifted = target.getBoundingClientRect().top - el2.getBoundingClientRect().top;
    if (shifted < -1 || shifted > el2.clientHeight) el2.scrollTop += shifted - anchor.offset;
  };

  apply();
  // 图片头像等"重绘后才定格尺寸"的元素可能让布局在下一帧再动一次，那时再校正一回
  requestAnimationFrame(apply);
}

/** 列表滚动容器：真源是 refs.listHost，但整栏重绘后 refs 可能已经指向脱离文档的旧节点 */
function scrollBox() {
  if (refs.listHost && document.body.contains(refs.listHost)) return refs.listHost;
  const root = refs.root;
  const found = root && document.body.contains(root) ? root.querySelector('.side-body') : null;
  if (found) refs.listHost = found;
  return found;
}

function renderList() {
  const host = refs.listHost;
  if (!host) return;
  const anchor = captureScrollAnchor();
  const ctx = refs.ctx;
  const chars = ctxChars(ctx);
  const groups = ctxGroups(ctx);
  const searching = Boolean(keyword);

  if (!chars.length && !groups.length) {
    mount(host, buildEmptyState());
    restoreScrollAnchor(anchor);
    return;
  }

  const nodes = [];

  // ---------- 群聊区（永远排在好友上面：它是"多人客厅"，比私聊更像是门面） ----------
  const filteredGroups = groups.filter((g) => matchesGroupKeyword(g, keyword, chars));
  if (filteredGroups.length || !searching) {
    nodes.push(buildGroupSection(filteredGroups, ctx, searching));
  }

  // ---------- 好友 ----------
  const filtered = chars.filter((c) => matchesKeyword(c, keyword));
  if (!chars.length) {
    nodes.push(buildEmptyState());
  } else if (!filtered.length) {
    if (!searching || !filteredGroups.length) {
      nodes.push(
        el(
          'div.empty',
          el('div.big', { text: '🔍' }),
          el('h3', { text: '没有匹配的好友' }),
          el('p', { text: `换个关键词试试：「${keyword}」没有命中名字、简介或标签。` })
        )
      );
    }
  } else {
    const activeId = ctxCharId(ctx);
    // 分组
    const byGroup = new Map();
    for (const c of filtered.slice().sort(sortFriends)) {
      const g = String(c.group == null ? '' : c.group).trim() || '默认';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(c);
    }

    for (const name of [...byGroup.keys()].sort(sortGroupNames)) {
      const items = byGroup.get(name);
      const isCollapsed = !searching && collapsed().has(name);

      const head = el(
        'button.group-head',
        {
          type: 'button',
          class: isCollapsed ? 'collapsed' : '',
          title: isCollapsed ? `展开「${name}」` : `折叠「${name}」`,
          on: {
            click: () => {
              const set = collapsed();
              if (set.has(name)) set.delete(name);
              else set.add(name);
              persistCollapsed();
              renderList();
            },
          },
        },
        // 图标固定用 chevron-down，折叠时由 .group-head.collapsed .ic 旋转 -90°
        icon('chevron-down', 13),
        el('span', { text: name }),
        el('span.count', { text: String(items.length) })
      );

      nodes.push(
        el(
          'div.group',
          { dataset: { group: name, key: `group:${name}` } },
          head,
          isCollapsed ? null : el('div.group-body', items.map((c) => buildFriendRow(c, ctx, activeId)))
        )
      );
    }
  }

  mount(host, nodes);
  restoreScrollAnchor(anchor);
}

/* ------------------------------ 群聊区 ------------------------------ */

/** 群聊的关键词匹配（群名 / 主题 / 成员名） */
function matchesGroupKeyword(g, kw, chars) {
  if (!kw) return true;
  const names = (g.members || [])
    .map((id) => (chars.find((c) => c.id === id) || {}).name || '')
    .join(' ');
  const hay = [g.name, g.topic, g.emoji, names].map((s) => String(s == null ? '' : s)).join(' ').toLowerCase();
  return kw
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

/** 群聊区（可折叠 + 新建按钮） */
function buildGroupSection(list, ctx, searching) {
  const isCollapsed = !searching && collapsed().has(GROUP_SECTION);
  const activeId = ctxGroupId(ctx);

  const toggle = el(
    'button.group-head-toggle',
    {
      type: 'button',
      title: isCollapsed ? '展开群聊' : '折叠群聊',
      on: {
        click: () => {
          const set = collapsed();
          if (set.has(GROUP_SECTION)) set.delete(GROUP_SECTION);
          else set.add(GROUP_SECTION);
          persistCollapsed();
          renderList();
        },
      },
    },
    icon('chevron-down', 13),
    el('span', { text: '群聊' }),
    el('span.count', { text: String(list.length) })
  );

  const addBtn = el(
    'button.icon-btn.sm',
    {
      type: 'button',
      title: '新建群聊（把好友拉进来一起聊）',
      dataset: { role: 'new-group' },
      on: {
        click: (e) => {
          e.stopPropagation();
          openGroupDialog(refs.ctx, null);
        },
      },
    },
    icon('plus', 14)
  );

  const head = el('div.group-head.gchat-group-head', { class: isCollapsed ? 'collapsed' : '' }, toggle, addBtn);

  const body = isCollapsed ? null : el('div.group-body', list.map((g) => buildGroupRow(g, ctx, activeId)));

  return el('div.group.gchat-group-block', { dataset: { group: GROUP_SECTION, key: 'gchat-section' }, title: '群聊' }, head, body);
}

/** 侧栏里的一个群聊行（复用 .friend 的排版，额外用 .gchat-row 做群特有点缀） */
function buildGroupRow(g, ctx, activeId) {
  const id = String(g.id);
  const active = Boolean(activeId) && String(activeId) === id;
  const color = g.color || 'var(--accent, #6c8cff)';
  const unread = unreadOf(id);
  const memberCount = (g.members || []).length;

  // 群徽 + 成员数角标：角标挂在圆的右下沿（圆外），所以必须包一层容器——
  // .avatar 带 overflow:hidden（为了裁图片头像），会让角标被切成月牙（只露出内侧一小块）。
  // 置顶小标 S.pin 是特意放在圆"内"的，不受影响。
  const avatar = el(
    'div.gchat-av-wrap',
    el(
      'div.avatar.gchat-av',
      {
        title: String(g.name || ''),
        style: { background: alpha(color, 0.18), border: `1px solid ${alpha(color, 0.5)}`, color },
      },
      el('span', { text: g.emoji || '💬' }),
      g.pinned ? el('span.friend-pin', { style: S.pin, title: '已置顶' }, icon('pin', 11)) : null
    ),
    el('span.gchat-av-count', { text: String(memberCount), title: `${memberCount} 位成员` })
  );

  const flags = el(
    'div.friend-flags',
    g.muted ? el('span', { title: '已免打扰' }, icon('belloff', 13)) : null,
    unread > 0
      ? g.muted
        ? el('span.badge.muted', { title: `${unread} 条未读（已免打扰）` })
        : el('span.badge', { text: unread > 99 ? '99+' : String(unread), title: `${unread} 条未读` })
      : null
  );

  const preview = groupPreview(g);
  const row = el(
    'div.friend.gchat-row',
    {
      class: active ? 'on' : '',
      dataset: { id, gid: id, active: active ? '1' : '0', pinned: g.pinned ? '1' : '0', key: `gchat:${id}` },
      on: {
        click: () => {
          setActionsVisible(row, false);
          openGroupRow(ctx, id);
        },
        contextmenu: (e) => {
          e.preventDefault();
          setActionsVisible(row, true);
        },
      },
    },
    avatar,
    el(
      'div.friend-main',
      el(
        'div.friend-top',
        el('div.friend-name', { text: String(g.name || '未命名群聊') }),
        el('div.friend-time', { text: groupTime(g) })
      ),
      el('div.friend-preview', el('span', { text: preview, title: preview }), flags)
    ),
    buildGroupRowActions(g, ctx)
  );

  row.__acts = row.childNodes[row.childNodes.length - 1];

  let pressTimer = null;
  const clearPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };
  row.addEventListener(
    'touchstart',
    () => {
      clearPress();
      pressTimer = setTimeout(() => setActionsVisible(row, true), 520);
    },
    { passive: true }
  );
  row.addEventListener('touchend', clearPress, { passive: true });
  row.addEventListener('touchmove', clearPress, { passive: true });
  row.addEventListener('touchcancel', clearPress, { passive: true });
  row.addEventListener('mouseleave', () => setActionsVisible(row, false));

  return row;
}

/** 群聊摘要：谁说的 + 内容 */
function groupPreview(g) {
  const last = cache.lastGroupMsg.get(String(g.id));
  if (!last) return String(g.topic || '').trim() || '还没有人说话，进去起个头吧';
  const body = truncate(String(last.content || '').replace(/\s+/g, ' ').trim() || '（空消息）', 16);
  const who = last.role === 'user' ? '我' : last.role === 'system' ? '系统' : last.speakerName || '成员';
  return `${who}：${body}`;
}

/** 群聊行的最后活动时间 */
function groupTime(g) {
  const last = cache.lastGroupMsg.get(String(g.id));
  if (last && last.at) return relTime(last.at);
  return g.updatedAt ? relTime(g.updatedAt) : '';
}

/** 群聊行右侧操作：置顶 / 免打扰 / 拉人 / 编辑 / 删除 */
function buildGroupRowActions(g, ctx) {
  const stop = (fn) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    fn();
  };
  return el(
    'div.friend-acts',
    { on: { click: (e) => e.stopPropagation() } },
    miniButton('pin', g.pinned ? '取消置顶' : '置顶群聊', stop(() => void toggleGroupPin(g, ctx)), Boolean(g.pinned)),
    miniButton('belloff', g.muted ? '取消免打扰' : '群消息免打扰', stop(() => void toggleGroupMute(g, ctx)), Boolean(g.muted)),
    miniButton('user-plus', '拉人进群', stop(() => openMemberPicker(g, () => invalidate()))),
    miniButton('edit', '编辑群资料', stop(() => openGroupDialog(refs.ctx, g))),
    miniButton('trash', '删除群聊', stop(() => void removeGroup(g, ctx)))
  );
}

function openGroupRow(ctx, id) {
  if (!id) return;
  markRead(id);
  ctxOpenGroup(ctx, id);
  refreshSidebar();
}

async function toggleGroupPin(g, ctx) {
  try {
    await saveGroup({ ...g, pinned: !g.pinned });
    toast(g.pinned ? '已取消置顶' : '已置顶', 'ok');
    await afterMutation(ctx);
  } catch (err) {
    console.warn('[sidebar] 群置顶失败', err);
    toast('操作失败，请重试', 'error');
  }
}

async function toggleGroupMute(g, ctx) {
  try {
    await saveGroup({ ...g, muted: !g.muted });
    toast(g.muted ? '已取消免打扰' : '已设为免打扰', 'ok');
    await afterMutation(ctx);
  } catch (err) {
    console.warn('[sidebar] 群免打扰失败', err);
    toast('操作失败，请重试', 'error');
  }
}

async function removeGroup(g, ctx) {
  const ok = await confirmDialog({
    title: '删除群聊',
    message: `确定删除「${g.name}」吗？群聊记录会一起删除，角色本身与他们的私聊不受影响。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const wasActive = String(ctxGroupId(ctx) || '') === String(g.id);
    await deleteGroup(g.id);
    toast('群聊已删除', 'ok');
    await afterMutation(ctx);
    if (wasActive && ctx && typeof ctx.openGroup === 'function') ctxOpenGroup(ctx, null);
  } catch (err) {
    console.warn('[sidebar] 删除群聊失败', err);
    toast('删除失败，请重试', 'error');
  }
}

/** 空状态：一个角色都没有时 */
function buildEmptyState() {
  return el(
    'div.empty',
    el('div.big', { text: '🌙' }),
    el('h3', { text: '还没有好友' }),
    el('p', { text: '内置了各种开箱人设，挑一个先聊起来吧。有了两位以上，就能拉个群让他们互相聊。' }),
    el(
      'button.btn.btn-primary.btn-block',
      { type: 'button', on: { click: () => openTemplateGallery() } },
      el('span', { text: '从模板创建第一个好友' })
    ),
    el(
      'button.btn.btn-ghost.btn-block',
      { type: 'button', on: { click: () => openCharacterEditor(null) } },
      el('span', { text: '自己捏一个' })
    ),
    el(
      'button.btn.btn-ghost.btn-block',
      { type: 'button', on: { click: () => openGroupDialog(refs.ctx, null) } },
      icon('users', 14),
      el('span', { text: '新建群聊' })
    )
  );
}

/** 单行好友 */
function buildFriendRow(c, ctx, activeId) {
  const id = c.id;
  const active = Boolean(activeId) && String(activeId) === String(id);
  const color = c.color || 'var(--accent, #6c8cff)';
  const unread = unreadOf(id);
  const muted = Boolean(c.muted);

  // 头像：图片 > emoji > 名字首字；底色/边框取角色主题色（CSS 拿不到，必须内联）
  const avatar = el(
    'div.avatar',
    {
      title: String(c.name || ''),
      style: { background: alpha(color, 0.18), border: `1px solid ${alpha(color, 0.5)}`, color },
    },
    isImageAvatar(c.avatar)
      ? el('img', { src: c.avatar, alt: String(c.name || '') })
      : el('span', { text: avatarText(c) }),
    c.pinned ? el('span.friend-pin', { style: S.pin, title: '已置顶' }, icon('pin', 11)) : null
  );

  // 右侧：免打扰图标 + 未读角标（免打扰时用灰点 .badge.muted）
  const flags = el(
    'div.friend-flags',
    muted ? el('span', { title: '已免打扰' }, icon('belloff', 13)) : null,
    unread > 0
      ? muted
        ? el('span.badge.muted', { title: `${unread} 条未读（已免打扰）` })
        : el('span.badge', { text: unread > 99 ? '99+' : String(unread), title: `${unread} 条未读` })
      : null
  );

  const preview = previewText(c);
  const row = el(
    'div.friend',
    {
      class: active ? 'on' : '',
      dataset: { id: String(id), active: active ? '1' : '0', pinned: c.pinned ? '1' : '0', key: `friend:${id}` },
      on: {
        click: () => {
          setActionsVisible(row, false);
          openFriend(ctx, id);
        },
        contextmenu: (e) => {
          e.preventDefault();
          setActionsVisible(row, true);
        },
      },
    },
    avatar,
    el(
      'div.friend-main',
      el(
        'div.friend-top',
        el('div.friend-name', { text: String(c.name || '未命名角色') }),
        el('div.friend-time', { text: lastTime(c) })
      ),
      el('div.friend-preview', el('span', { text: preview, title: preview }), flags)
    ),
    buildRowActions(c, ctx)
  );

  row.__acts = row.childNodes[row.childNodes.length - 1];

  // 移动端长按 / 右键唤出快捷操作；桌面悬停由 app.css 的 .friend:hover .friend-acts 负责
  let pressTimer = null;
  const clearPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };
  row.addEventListener(
    'touchstart',
    () => {
      clearPress();
      pressTimer = setTimeout(() => setActionsVisible(row, true), 520);
    },
    { passive: true }
  );
  row.addEventListener('touchend', clearPress, { passive: true });
  row.addEventListener('touchmove', clearPress, { passive: true });
  row.addEventListener('touchcancel', clearPress, { passive: true });
  row.addEventListener('mouseleave', () => setActionsVisible(row, false));

  return row;
}

/** 长按 / 右键时用内联 display 展开；清空内联后交回 CSS 的悬停规则 */
function setActionsVisible(row, visible) {
  const box = row ? row.__acts : null;
  if (!box) return;
  box.style.display = visible ? 'flex' : '';
}


/** 好友行右侧的快捷操作：置顶 / 免打扰 / 编辑 / 复制 / 删除 */
function buildRowActions(c, ctx) {
  const stop = (fn) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    fn();
  };

  return el(
    'div.friend-acts',
    { on: { click: (e) => e.stopPropagation() } },
    miniButton('pin', c.pinned ? '取消置顶' : '置顶', stop(() => togglePin(c, ctx)), Boolean(c.pinned)),
    miniButton('belloff', c.muted ? '取消免打扰' : '免打扰', stop(() => toggleMute(c, ctx)), Boolean(c.muted)),
    miniButton('edit', '编辑角色卡', stop(() => openCharacterEditor(c))),
    miniButton('copy', '复制一份角色', stop(() => duplicate(c, ctx))),
    miniButton('trash', '删除角色', stop(() => remove(c, ctx)))
  );
}

/** 行内小图标按钮：外观走 base.css 的 .icon-btn.sm，active 表示该状态已开启 */
function miniButton(iconName, title, onClick, active) {
  return el(
    `button.icon-btn.sm${active ? '.active' : ''}`,
    { type: 'button', title, on: { click: onClick } },
    icon(iconName, 14)
  );
}


/* ------------------------------ 行操作 ------------------------------ */

function openFriend(ctx, id) {
  if (!id) return;
  markRead(id); // 打开会话即视为已读（幂等，app.js 再标一次也没关系）
  ctxOpenChat(ctx, id);
  refreshSidebar();
}

async function togglePin(c, ctx) {
  try {
    await saveCharacter({ ...c, pinned: !c.pinned });
    toast(c.pinned ? '已取消置顶' : '已置顶', 'ok');
    await afterMutation(ctx);
  } catch (err) {
    console.warn('[sidebar] 置顶失败', err);
    toast('操作失败，请重试', 'error');
  }
}

async function toggleMute(c, ctx) {
  try {
    await saveCharacter({ ...c, muted: !c.muted });
    toast(c.muted ? '已取消免打扰' : '已设为免打扰', 'ok');
    await afterMutation(ctx);
  } catch (err) {
    console.warn('[sidebar] 免打扰失败', err);
    toast('操作失败，请重试', 'error');
  }
}

async function duplicate(c, ctx) {
  try {
    const copy = await duplicateCharacter(c.id);
    if (!copy) throw new Error('复制失败');
    toast(`已复制出「${copy.name}」`, 'ok');
    await afterMutation(ctx);
  } catch (err) {
    console.warn('[sidebar] 复制角色失败', err);
    toast('复制失败，请重试', 'error');
  }
}

async function remove(c, ctx) {
  const ok = await confirmDialog({
    title: '删除好友',
    message: `确定删除「${c.name}」吗？TA 的聊天记录会一并删除，且无法恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const wasActive = String(ctxCharId(ctx) || '') === String(c.id);
    await deleteCharacter(c.id);
    toast('已删除', 'ok');
    await afterMutation(ctx);
    if (wasActive) ctxOpenChat(ctx, null);
  } catch (err) {
    console.warn('[sidebar] 删除失败', err);
    toast('删除失败，请重试', 'error');
  }
}

/* ------------------------------ 底栏 ------------------------------ */

function renderFoot() {
  const host = refs.footHost;
  if (!host) return;
  const ctx = refs.ctx;
  const charCount = ctxChars(ctx).length;
  const groupCount = ctxGroups(ctx).length;
  const msgCount =
    Object.values(cache.counts || {}).reduce((n, v) => n + num(v), 0) +
    Object.values(cache.groupCounts || {}).reduce((n, v) => n + num(v), 0);
  const unread = unreadTotal();

  mount(
    host,
    el(
      'span',
      el('b', { text: String(charCount) }),
      ' 位好友 · ',
      el('b', { text: String(groupCount) }),
      ' 个群聊 · ',
      el('b', { text: String(msgCount) }),
      ' 条消息 · ',
      el('b', { text: String(unread) }),
      ' 未读'
    ),
    el('span.spacer'),
    renderStoreLine()
  );
}

/**
 * 底栏的"本地文件"状态行：让用户确认角色确实已经写进电脑里的文件
 * —— 对应需求「直接保存在电脑本地文件，关掉程序也不会消失」。
 * @returns {HTMLElement}
 */
function renderStoreLine() {
  const st = fileStatus();
  let iconName = 'check';
  let text = '保存状态未知';
  let title = '';
  if (st.status === 'ok' && st.available) {
    iconName = 'check';
    text = '已保存到电脑文件';
    title = st.dir ? `保存目录：${st.dir}` : '角色与聊天记录已写入本地文件';
  } else if (st.status === 'syncing') {
    iconName = 'refreshCw';
    text = '正在读写本地文件…';
  } else if (st.status === 'error') {
    iconName = 'bell';
    text = st.conflict ? '资料有冲突（点击处理）' : '文件写入失败（点击查看）';
    title = st.error || '';
  } else {
    iconName = 'shield';
    text = '仅浏览器内存储';
    title = '没有检测到本地文件服务：请用 node server.mjs 启动，数据才会保存到电脑文件里';
  }
  return el(
    'button.btn.btn-sm.store-line',
    {
      type: 'button',
      title,
      on: {
        click: () => {
          if (st.conflict) { void openSyncConflict(); return; }
          if (title) toast(title, st.status === 'error' ? 'error' : 'info', 5200);
          else toast('角色与聊天记录已写入电脑本地文件', 'ok');
        },
      },
    },
    icon(iconName, 13),
    el('span', { text })
  );
}

/** 底栏小按钮（外观走 base.css 的 .btn.btn-sm） */
function footButton(iconName, label, onClick) {
  return el(
    'button.btn.btn-sm',
    { type: 'button', title: label, on: { click: onClick } },
    icon(iconName, 13),
    el('span', { text: label })
  );
}

/* ------------------------------------------------------------------ *
 * 六、主题切换
 * ------------------------------------------------------------------ */

/** 解析主题：auto 跟随系统 */
function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function syncThemeButton() {
  const head = refs.headHost;
  if (!head) return;
  const btn = head.querySelector('[data-role="theme"]');
  if (!btn) return;
  const next = resolveTheme(ctxSettings(refs.ctx).theme) === 'dark' ? 'light' : 'dark';
  btn.title = next === 'light' ? '切换到亮色' : '切换到深色';
  mount(btn, icon(next === 'light' ? 'sun' : 'moon', 17));
}

function toggleTheme() {
  const cur = resolveTheme(ctxSettings(refs.ctx).theme);
  const next = cur === 'dark' ? 'light' : 'dark';
  try {
    setSettings({ theme: next });
  } catch (err) {
    console.warn('[sidebar] 保存主题失败', err);
  }
  document.documentElement.dataset.theme = next;
  syncThemeButton();
}

/* ------------------------------------------------------------------ *
 * 七、对外动作：新建 / 全局搜索
 * ------------------------------------------------------------------ */

/**
 * 新建角色：先问「从模板」还是「从零开始」
 */
export function openNewCharacterDialog() {
  const m = modal({
    title: '新建好友',
    width: 460,
    body: el(
      'div.new-char',
      { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } },
      choiceCard('sparkles', '从模板创建', '内置人设库，一键套用再慢慢改', T.accent, () => {
        m.close();
        openTemplateGallery();
      }),
      choiceCard('user', '从零开始', '空白角色卡，自己捏一个人出来', T.ok, () => {
        m.close();
        openCharacterEditor(null);
      })
    ),
    actions: [],
  });
  return m;
}

function choiceCard(iconName, title, desc, color, onClick) {
  const card = el(
    'button.choice-card',
    {
      type: 'button',
      style: {
        display: 'flex',
        'align-items': 'center',
        gap: '12px',
        width: '100%',
        padding: '12px 14px',
        background: T.panel2,
        border: `1px solid ${T.line}`,
        'border-radius': '12px',
        color: T.text,
        cursor: 'pointer',
        'text-align': 'left',
      },
      on: { click: onClick },
    },
    el('span', { style: { display: 'inline-flex', color, 'flex': '0 0 auto' } }, icon(iconName, 22)),
    el(
      'span',
      { style: { flex: '1 1 auto', 'min-width': '0' } },
      el('span', { text: title, style: { display: 'block', 'font-weight': '600', 'font-size': '14px' } }),
      el('span', { text: desc, style: { display: 'block', 'font-size': '12px', color: T.dim, 'margin-top': '3px' } })
    )
  );
  card.addEventListener('mouseenter', () => {
    card.style.borderColor = color;
  });
  card.addEventListener('mouseleave', () => {
    card.style.borderColor = T.line;
  });
  return card;
}

/**
 * 全局搜索：跨全部角色搜索聊天记录，按角色分组展示。
 * 点击结果 → ctx.openChat(charId) 并 emit('chat:focus-message', messageId)
 */
export function openGlobalSearch() {
  const input = el('input', {
    type: 'search',
    placeholder: '搜索全部聊天记录…',
    'aria-label': '全局搜索',
  });
  const results = el('div.search-results');
  const hint = el('div.field-hint', { text: '输入关键词开始搜索（跨全部好友）' });

  const m = modal({
    title: '全局搜索',
    width: 560,
    body: el('div', el('div.search-bar', input), hint, results),
    actions: [],
  });

  const charMap = new Map(ctxChars(refs.ctx).map((c) => [String(c.id), c]));

  const run = debounce(async () => {
    try {
      const kw = String(input.value || '').trim();
      if (!kw) {
        mount(results);
        hint.style.display = '';
        hint.textContent = '输入关键词开始搜索（跨全部好友）';
        return;
      }
      hint.style.display = '';
      hint.textContent = '搜索中…';
      let hits = [];
      try {
        hits = await searchMessages(null, kw);
      } catch (err) {
        console.warn('[sidebar] 搜索失败', err);
        hint.textContent = '搜索失败，请重试';
        return;
      }
      if (!hits.length) {
        mount(results);
        hint.textContent = `没有找到包含「${kw}」的消息`;
        return;
      }
      hint.style.display = 'none';
      mount(results, groupHits(hits, kw, charMap, m));
    } catch (err) {
      // 兜底：渲染异常不能让弹层直接崩掉
      console.error('[sidebar] 渲染搜索结果失败', err);
      hint.style.display = '';
      hint.textContent = '结果渲染失败，换个关键词试试';
    }
  }, 260);

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run.flush();
    }
  });
  return m;
}

/** 搜索结果按角色分组：分组头是「头像 + 名字 + 条数」，条目是「谁 + 时间 + 片段」 */
function groupHits(hits, kw, charMap, modalHandle) {
  const byChar = new Map();
  for (const msg of hits) {
    const key = String(msg.charId || '');
    if (!byChar.has(key)) byChar.set(key, []);
    byChar.get(key).push(msg);
  }

  const nodes = [];
  for (const [charId, list] of byChar) {
    const c = charMap.get(charId);
    const color = (c && c.color) || 'var(--accent, #6c8cff)';

    const head = el(
      'div.row',
      { style: { padding: '10px 4px 4px' } },
      hitAvatar(c, color),
      el('b', { text: (c && c.name) || '未知角色' }),
      el('span.small.muted', { text: `${list.length} 条` })
    );

    const items = list.slice(0, 30).map((msg) =>
      el(
        'button.hit',
        {
          type: 'button',
          on: {
            click: () => {
              modalHandle.close();
              ctxOpenChat(refs.ctx, msg.charId);
              // 约定：app.js 监听 chat:focus-message 并滚动/高亮该条消息。
              // 传 { id, charId } —— app.js 会先确保会话已切换再定位，避免与 openChat 抢时序
              // （app.js 同时兼容纯字符串 id 的写法）
              bus.emit('chat:focus-message', { id: msg.id, charId: msg.charId });
            },
          },
        },
        hitAvatar(c, color),
        el(
          'div.h-main',
          el(
            'div.h-top',
            el('b', { text: msg.role === 'user' ? '我' : (c && c.name) || '角色' }),
            el('span', { text: relTime(msg.at) })
          ),
          el('div.h-text', { text: snippet(msg.content, kw) })
        )
      )
    );

    nodes.push(el('div.search-group', head, el('div', items)));
  }
  return nodes;
}

/** 搜索结果里的小头像（32px，.avatar.sm） */
function hitAvatar(c, color) {
  return el(
    'span.avatar.sm',
    { style: { background: alpha(color, 0.18), color, border: `1px solid ${alpha(color, 0.5)}` } },
    c && isImageAvatar(c.avatar)
      ? el('img', { src: c.avatar, alt: '' })
      : el('span', { text: c ? avatarText(c) : '?' })
  );
}

/** 搜索结果按角色分组 */

/** 命中的消息片段（关键词前后各取一点上下文） */
function snippet(content, kw) {
  const text = String(content || '').replace(/\s+/g, ' ');
  const idx = text.toLowerCase().indexOf(String(kw || '').toLowerCase());
  if (idx < 0) return truncate(text, 60);
  const start = Math.max(0, idx - 18);
  const body = text.slice(start, start + 70);
  return `${start > 0 ? '…' : ''}${body}${start + 70 < text.length ? '…' : ''}`;
}
