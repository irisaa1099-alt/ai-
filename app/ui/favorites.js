/**
 * ui/favorites.js —— 收藏夹（左上角工具条上的 🔖 进入）
 *
 * 背景：消息上的"收藏"（☆）一直只有**单个消息上的标记**，收藏完就没有地方统一翻看
 * （`.msg-mark` 写着"★ 已收藏"，但得自己滚回去找）。这里补上"收藏夹"这一层：
 * 一条时间倒序的合并流，好友私聊与群聊的收藏都在里面，点一下就能跳回原消息。
 *
 * 约定与边界：
 * - 数据一律来自 `core/store.js` 的 `listBookmarks()`（私聊 + 群聊合并、时间倒序）；
 *   本模块**不持有**接口数据，只在面板存活期间拿一份快照 + 角色/群的名字索引。
 * - 取名字靠 `listCharacters()` / `listGroups()`（收藏条目里只有 id），
 *   会话被删掉时给出明确提示，而不是静默什么都不发生。
 * - 全部 DOM 用 `ui/dom.js` 的 `el()` 构建，消息正文一律走文本节点（防 XSS）。
 * - 跳转复用既有两条链路（与全局搜索一致，见 5.9 的约定）：
 *   私聊 → `bus.emit('chat:focus-message', { id, charId })`；
 *   群聊 → `bus.emit('gchat:focus-message', { id, groupId })`（`ui/app.js` 负责开群 + 定位）。
 * - 面板关掉后要退订 bus，避免弹层销毁后监听器越攒越多（用返回的 off() + 存活检查）。
 */

import { bus } from '../core/bus.js';
import { listBookmarks, listCharacters, listGroups, updateMessage, updateGroupMessage } from '../core/store.js';
import { relTime, truncate, firstChar } from '../core/util.js';
import { el, mount } from './dom.js';
import { icon } from './icons.js';
import { toast, modal } from './toast.js';
import { isImageAvatar } from './shared.js';

/** 颜色令牌（与 base.css 的变量一致，缺样式表时也有兜底色） */
const T = {
  accent: 'var(--accent, #6c8cff)',
  dim: 'var(--dim, #8b93a7)',
};

/** 把 #rgb / #rrggbb 转成低透明度 rgba（头像底色用来源主题色） */
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

/** 收藏来源（好友 / 群聊）的展示信息 */
function sourceOf(item, charMap, groupMap) {
  if (item.kind === 'group') {
    const g = groupMap.get(String(item.groupId)) || null;
    return {
      missing: !g,
      kindLabel: '群聊',
      name: (g && g.name) || '已删除的群聊',
      sub: item.role === 'user' ? '我' : item.speakerName || '成员',
      color: (g && g.color) || T.accent,
      emoji: (g && g.emoji) || '💬',
      avatar: '',
    };
  }
  const c = charMap.get(String(item.charId)) || null;
  return {
    missing: !c,
    kindLabel: '好友',
    name: (c && c.name) || '已删除的好友',
    sub: item.role === 'user' ? '我' : (c && c.name) || '角色',
    color: (c && c.color) || T.accent,
    emoji: '',
    avatar: (c && c.avatar) || '',
  };
}

/** 行内小头像（32px，与搜索结果同一套 .avatar.sm 视觉） */
function avatarNode(src) {
  const style = {
    background: alpha(src.color, 0.18),
    color: src.color,
    border: `1px solid ${alpha(src.color, 0.5)}`,
  };
  if (src.avatar && isImageAvatar(src.avatar)) {
    return el('span.avatar.sm', { style }, el('img', { src: src.avatar, alt: '' }));
  }
  return el('span.avatar.sm', { style }, el('span', { text: src.emoji || firstChar(src.name || '?') }));
}

/**
 * 打开收藏夹。
 * @returns {{ close: () => void, root: HTMLElement, body: HTMLElement }}
 */
export function openFavorites() {
  const input = el('input', {
    type: 'search',
    placeholder: '在收藏里搜索…',
    'aria-label': '搜索收藏',
  });
  const summary = el('div.field-hint', { text: '读取中…' });
  const list = el('div.fav-list');
  const panel = el(
    'div',
    el('div.search-bar', input),
    summary,
    list
  );

  const handle = modal({ title: '收藏夹', width: 620, body: panel, actions: [] });
  const alive = () => document.body.contains(handle.root);

  /** 面板存活期间的一份快照 */
  let items = [];
  let keyword = '';
  /** 读取失败的提示（放在 render 里显示，避免被"空态"分支立刻覆盖掉） */
  let loadError = '';
  const charMap = new Map();
  const groupMap = new Map();

  /** 取消订阅 bus（面板关闭后调用） */
  const offs = [];
  const offAll = () => {
    while (offs.length) {
      const off = offs.pop();
      try {
        off();
      } catch {
        /* 忽略 */
      }
    }
  };

  /** 拉数据 + 名字索引，然后重画 */
  const load = async () => {
    try {
      const [list_, chars, groups] = await Promise.all([listBookmarks(), listCharacters(), listGroups()]);
      items = list_;
      loadError = '';
      charMap.clear();
      for (const c of chars || []) charMap.set(String(c.id), c);
      groupMap.clear();
      for (const g of groups || []) groupMap.set(String(g.id), g);
    } catch (err) {
      console.warn('[favorites] 读取收藏失败', err);
      items = [];
      loadError = '读取收藏失败，请重试';
    }
    render();
  };

  /** 按关键词过滤（正文 / 来源名 / 发言人） */
  const visible = () => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((it) => {
      const src = sourceOf(it, charMap, groupMap);
      return `${it.content} ${src.name} ${src.sub} ${src.kindLabel}`.toLowerCase().includes(kw);
    });
  };

  /** 取消收藏（同时把这份快照里的条目去掉） */
  const unbookmark = async (item) => {
    try {
      if (item.kind === 'group') await updateGroupMessage(item.id, { bookmarked: false });
      else await updateMessage(item.id, { bookmarked: false });
      items = items.filter((x) => !(x.id === item.id && x.kind === item.kind));
      toast('已取消收藏', 'ok');
      render();
    } catch (err) {
      toast(`取消收藏失败：${(err && err.message) || err}`, 'error');
    }
  };

  /** 跳回原消息：关掉面板 → 交给 app.js 打开会话并高亮那一条 */
  const jump = (item) => {
    const src = sourceOf(item, charMap, groupMap);
    if (src.missing) {
      toast(item.kind === 'group' ? '这条收藏所属的群聊已被删除' : '这条收藏所属的好友已被删除', 'warn');
      return;
    }
    handle.close();
    if (item.kind === 'group') {
      bus.emit('gchat:focus-message', { id: item.id, groupId: item.groupId });
    } else {
      bus.emit('chat:focus-message', { id: item.id, charId: item.charId });
    }
  };

  /** 一行收藏 */
  const row = (item) => {
    const src = sourceOf(item, charMap, groupMap);
    const title = el(
      'div.h-top',
      el('b', { text: src.name }),
      el('span', { text: src.kindLabel === '群聊' ? `群聊 · ${src.sub}` : src.sub }),
      item.game === 'werewolf' ? el('span.fav-tag', { text: '狼人杀' }) : null,
      el('span', { style: { 'margin-left': 'auto' }, text: relTime(item.at) })
    );
    return el(
      'div.fav-item',
      el(
        'button.hit.fav-main',
        {
          type: 'button',
          title: '跳回这条消息',
          on: { click: () => jump(item) },
        },
        avatarNode(src),
        el('div.h-main', title, el('div.h-text', { text: truncate(String(item.content || '').replace(/\s+/g, ' '), 220) }))
      ),
      el(
        'div.fav-acts',
        el(
          'button.icon-btn.msg-act',
          { type: 'button', title: '取消收藏', attr: { 'aria-label': '取消收藏' }, on: { click: () => void unbookmark(item) } },
          icon('bookmark-on', 15)
        )
      )
    );
  };

  /** 重画列表 / 汇总行 */
  function render() {
    const shown = visible();
    if (!items.length) {
      // 读取失败时只显示失败提示（否则会被下面那句空态文案盖掉）
      summary.textContent = loadError;
      mount(
        list,
        el(
          'div.empty',
          el('div.big', { text: loadError ? '⚠️' : '🔖' }),
          el('h3', { text: loadError ? '没能读到收藏' : '收藏夹还是空的' }),
          el('p.small', {
            text: loadError
              ? '本地数据读取失败，关掉面板重试一次即可。'
              : '在任意消息上点 ☆ 收藏，之后就能在这里统一翻看（好友私聊和群聊都会进来）。',
          })
        )
      );
      return;
    }
    if (!shown.length) {
      summary.textContent = `没有匹配「${keyword.trim()}」的收藏`;
      mount(list);
      return;
    }
    summary.textContent =
      shown.length === items.length
        ? `共 ${items.length} 条收藏（最新的在最上面）`
        : `${shown.length} / ${items.length} 条收藏`;
    mount(list, shown.map(row));
  }

  input.addEventListener('input', () => {
    keyword = String(input.value || '');
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      keyword = '';
      render();
    }
  });

  // 面板开着的时候，别的地方取消/新增收藏也要跟着变（消息上的 ☆ 就是这个入口）
  const onChanged = () => {
    if (!alive()) {
      offAll();
      return;
    }
    void load();
  };
  offs.push(bus.on('msg:updated', onChanged));
  offs.push(bus.on('gmsg:updated', onChanged));
  // 弹层被 Esc / 点遮罩关掉时也退订：modal() 没有 onClose 回调，用轮询兜底
  const watcher = setInterval(() => {
    if (!alive()) {
      clearInterval(watcher);
      offAll();
    }
  }, 1000);

  void load();
  return handle;
}

export default { openFavorites };
