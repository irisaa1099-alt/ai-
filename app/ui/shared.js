/**
 * ui/shared.js —— 界面层公用小工具（单一实现）
 *
 * 为什么要有这个文件：
 * 之前 ui/chat.js、ui/groupchat.js、ui/app.js、ui/sidebar.js、ui/editor.js、ui/groupeditor.js
 * 各自复制了一份 avatarNode / isImageAvatar / readLS / userName …… 而且**已经改岔了**：
 *   · isImageAvatar 有 3 种不同实现，对相对路径 "/x.png" 的判断互不一致；
 *   · avatarNode 有 3 种不同实现，同一个角色在不同界面显示的头像不一样；
 *   · writeLS / voiceKey / backToList / syncBackButton 在 chat 与 groupchat 里内容已不一致。
 * 这类"同一功能多份拷贝"是后续 bug 的主要来源：改了一处、忘了另一处。
 * 所以统一收敛到这里，各界面只做 import。
 *
 * 约定：本文件只放**无副作用、无全局状态**的小工具；不 import 任何业务模块，
 * 避免形成循环依赖。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { firstChar, takeGraphemes } from '../core/util.js';

/* ------------------------------------------------------------------ *
 * 头像与表情
 * ------------------------------------------------------------------ */

/**
 * 判断 avatar 字段是不是"图片地址"（而不是 emoji / 首字）
 * 统一规则：data:image、http(s)、blob:、以及以 / 开头的站内绝对路径都算图片。
 * @param {*} avatar
 * @returns {boolean}
 */
export function isImageAvatar(avatar) {
  const s = typeof avatar === 'string' ? avatar.trim() : '';
  if (!s) return false;
  return /^(data:image\/|https?:\/\/|blob:|\/)/i.test(s);
}

/**
 * 取实体在"没有图片头像"时该显示的字符：emoji 优先，其次非图片的 avatar 文本，最后取名字首字
 * @param {{name?:string, emoji?:string, avatar?:string}} who
 * @returns {string}
 */
export function entityEmoji(who) {
  const w = who || {};
  if (w.emoji) return takeGraphemes(w.emoji, 2) || firstChar(w.name || '?');
  const a = typeof w.avatar === 'string' ? w.avatar.trim() : '';
  if (a && !isImageAvatar(a)) return firstChar(a) || firstChar(w.name || '?');
  return firstChar(w.name || '?');
}

/**
 * 统一的头像节点：图片 > emoji > 名字首字，底色用实体主题色。
 *
 * 历史三种签名合并而来（都兼容）：
 *   avatarNode(char)                       // chat.js / app.js
 *   avatarNode(char, 'sm')                 // 指定尺寸类名
 *   avatarNode(char, '', true)             // 第三个参数是"显示在线状态点"
 *   avatarNode(member, 'sm', color)        // 第三个参数是底色（groupchat.js）
 *
 * @param {{name?:string, emoji?:string, avatar?:string, color?:string, muted?:boolean}} who
 * @param {string} [size] 尺寸类名（sm / lg / xl），空串表示默认
 * @param {boolean|string} [third] 布尔=是否显示在线状态点；字符串=底色覆盖
 * @returns {HTMLElement}
 */
export function avatarNode(who, size = '', third = false) {
  const w = who || {};
  const showPresence = third === true;
  const color = typeof third === 'string' && third ? third : w.color || '';
  const box = el(`span.avatar${size ? `.${size}` : ''}`, { title: w.name || '' });
  if (color) box.style.background = color;

  if (isImageAvatar(w.avatar)) {
    box.appendChild(el('img', { attr: { src: String(w.avatar), alt: w.name || '', draggable: 'false' } }));
  } else {
    box.appendChild(el('span', { text: entityEmoji(w) }));
  }
  if (showPresence) box.appendChild(el('span.presence', { class: w.muted ? 'off' : '' }));
  return box;
}

/**
 * 重新填充一个已有头像节点（用于同尺寸复用，避免重建 DOM）
 * @param {HTMLElement} box
 * @param {object} who
 */
export function fillAvatar(box, who) {
  if (!box) return box;
  const w = who || {};
  while (box.firstChild) box.removeChild(box.firstChild);
  box.title = w.name || '';
  if (w.color) box.style.background = w.color;
  if (isImageAvatar(w.avatar)) {
    box.appendChild(el('img', { attr: { src: String(w.avatar), alt: w.name || '', draggable: 'false' } }));
  } else {
    box.appendChild(el('span', { text: entityEmoji(w) }));
  }
  return box;
}

/* ------------------------------------------------------------------ *
 * 上下文取值（ui/app.js 传下来的 ctx 里是 getter，也可能是函数）
 * ------------------------------------------------------------------ */

/** 从 ctx 取当前角色（兼容 getter 与函数两种写法） */
export function ctxChar(ctx) {
  if (!ctx) return null;
  const v = typeof ctx.currentChar === 'function' ? ctx.currentChar() : ctx.currentChar;
  return v || null;
}

/** 从 ctx 取当前角色 id */
export function ctxCharId(ctx) {
  if (!ctx) return '';
  const v = typeof ctx.currentCharId === 'function' ? ctx.currentCharId() : ctx.currentCharId;
  return v || '';
}

/** 从 ctx 取设置 */
export function ctxSettings(ctx) {
  if (!ctx) return {};
  const v = typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings;
  return v || {};
}

/** 从 ctx 取角色列表 */
export function ctxChars(ctx) {
  if (!ctx) return [];
  const v = typeof ctx.characters === 'function' ? ctx.characters() : ctx.characters;
  return Array.isArray(v) ? v : [];
}

/** 安全调用 ctx 上的方法（缺方法时静默返回 undefined） */
export function ctxCall(ctx, name, ...args) {
  if (!ctx) return undefined;
  const fn = ctx[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return fn.apply(ctx, args);
  } catch (err) {
    console.warn(`[shared] ctx.${name}() 失败`, err);
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * localStorage 安全读写（隐私模式 / 配额满时不抛错）
 * ------------------------------------------------------------------ */

/**
 * 读 localStorage
 * @param {string} key
 * @param {*} [fallback]
 * @returns {string}
 */
export function readLS(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * 写 localStorage
 * @param {string} key
 * @param {string} value
 * @returns {boolean} 是否成功
 */
export function writeLS(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删 localStorage
 * @param {string} key
 */
export function removeLS(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/** 读写 JSON 形式的 localStorage 值 */
export function readLSJson(key, fallback = null) {
  const raw = readLS(key, '');
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 写入 JSON 形式的 localStorage 值 */
export function writeLSJson(key, value) {
  return writeLS(key, JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * 可收起的界面元件
 * ------------------------------------------------------------------ */

/**
 * 双态图标按钮（「收起 / 展开顶栏、右栏」这类开关用）。
 *
 * 两个图标都放进按钮，由**外壳 class** 决定显示哪一个（见 app.css 里
 * `.shell.head-collapsed [data-toggle="head"] .ic-open` 那几条）：
 * 状态只存在 `.shell` 一处，换状态时不用重建按钮，也就不会出现
 * 「顶栏被下方细条展开、而顶栏上那个按钮的图标还停在收起态」这种不同步。
 *
 * @param {string} openIcon 面板开着时显示的图标名（点它 = 收起）
 * @param {string} shutIcon 收起后显示的图标名（点它 = 展开）
 * @param {string} title 初始悬停/无障碍文案（真正的两份文案由 ui/app.js 统一同步）
 * @param {() => any} onClick 点击回调
 * @param {string} marker `data-toggle` 标记：'head' / 'right'，CSS 与文案同步都靠它
 * @param {number} [size] 图标尺寸
 * @returns {HTMLElement}
 */
export function twoStateIconBtn(openIcon, shutIcon, title, onClick, marker, size = 18) {
  const btn = el(
    'button.icon-btn.two-state',
    {
      type: 'button',
      title,
      dataset: { toggle: marker },
      attr: { 'aria-label': title },
      on: { click: onClick },
    },
    el('span.ic-open', icon(openIcon, size)),
    el('span.ic-shut', icon(shutIcon, size))
  );
  return btn;
}

/**
 * 顶栏收起后露出的那条细"拉手"：点右半边把顶栏放回来。
 * 只在 `.shell.head-collapsed` 时显示；顶栏被隐藏后它是唯一的恢复入口，
 * 所以必须留在中栏里（而不是跟着顶栏一起被 display:none 掉）。
 *
 * 窄屏（≤759.98px，与顶栏里 .chat-back 的断点一致）时左半边多一个「返回列表」——
 * 手机上顶栏里的返回键也一起被收起了，不留这个键就会走进"回不去列表"的死角。
 * 宽屏下顶栏本来就没有返回键，这里也不显示（纯 CSS 控制，见 app.css）。
 *
 * @param {() => any} onClick 点右半边：展开顶栏
 * @param {() => any} [onBack] 点左半边：返回列表（窄屏才可见）
 * @returns {HTMLElement}
 */
export function headRestoreBar(onClick, onBack) {
  return el(
    'div.head-restore',
    el(
      'button.head-restore-back',
      {
        type: 'button',
        title: '返回列表',
        attr: { 'aria-label': '返回列表' },
        on: { click: () => { if (typeof onBack === 'function') onBack(); } },
      },
      icon('arrow-left', 16)
    ),
    el(
      'button.head-restore-btn',
      {
        type: 'button',
        dataset: { toggle: 'head' },
        title: '展开顶栏',
        attr: { 'aria-label': '展开顶栏' },
        on: { click: onClick },
      },
      icon('chevron-down', 13)
    )
  );
}

/**
 * 右栏（角色卡 / 群资料）右上角的「收起右栏」按钮。
 * 它占据的是原来「编辑」铅笔的位置：编辑入口在顶栏和右栏正文里各还有一条，
 * 而右栏要收起时，开关放在它自己头上最顺手（原话：把编辑按钮换成叉）。
 * @param {() => any} onClick 点击回调（收起右栏）
 * @returns {HTMLElement} 整个 .side-tools 容器，直接塞进 .right-head 即可
 */
export function rightCollapseBtn(onClick) {
  return el(
    'div.side-tools',
    el(
      'button.icon-btn.sm',
      {
        type: 'button',
        title: '收起右栏',
        dataset: { toggle: 'right' },
        attr: { 'aria-label': '收起右栏' },
        on: { click: onClick },
      },
      icon('close', 15)
    )
  );
}

/**
 * 右栏收起后贴在中栏右边缘的竖拉手（点一下把右栏拉回来）。
 * 它占的是外壳网格里的第三列（见 app.css 的 @media (min-width: 1001px) 规则），
 * 所以不会压住消息区的滚动条 —— 这是它跟"绝对定位浮在右边"的关键区别。
 * @param {() => any} onClick 点击回调（展开右栏）
 * @returns {HTMLElement}
 */
export function rightRestoreBar(onClick) {
  return el(
    'div.right-restore',
    el(
      'button.right-restore-btn',
      {
        type: 'button',
        dataset: { toggle: 'right' },
        title: '展开右栏',
        attr: { 'aria-label': '展开右栏' },
        on: { click: onClick },
      },
      icon('chevron-left', 13)
    )
  );
}

/**
 * 「预设下拉 + 自定义输入」组合控件（云端音色 / 云端模型这类"名字由供应商定义"的字段用）。
 *
 * 为什么需要：写死的下拉会把用户挡在门外 —— edge-tts 的 `zh-CN-XiaoxiaoNeural`、
 * MiniMax 的 `speech-02-hd`、本地自建 TTS 的克隆音色名都填不进去。
 * 所以下拉只负责"常用预设"，右边的输入框负责"任意值"；当前值不在预设里时，
 * 下拉会补一条「（自定义）xxx」，保证界面显示的就是真正在用的值。
 *
 * @param {{value:string,label?:string,disabled?:boolean}[]} presets 预设项
 * @param {string} current 当前值
 * @param {(value: string) => void} onChange 选定/填好后回调
 * @param {{placeholder?: string, title?: string}} [opts]
 * @returns {HTMLElement} 一行控件（下拉 + 输入框）
 */
export function presetCombo(presets, current, onChange, opts = {}) {
  const list = Array.isArray(presets) ? presets : [];
  const cur = current == null ? '' : String(current);
  const isCustom = !!cur && !list.some((p) => String(p.value) === cur);

  const sel = el('select', {
    on: {
      change: (e) => {
        const v = String(e.target.value || '');
        if (v) onChange(v);
      },
    },
  });
  for (const p of list) {
    sel.appendChild(el('option', { value: String(p.value), text: String(p.label || p.value), disabled: !!p.disabled }));
  }
  if (isCustom) sel.appendChild(el('option', { value: cur, text: `（自定义）${cur}` }));
  sel.value = cur || (list[0] ? String(list[0].value) : '');

  const input = el('input.input', {
    type: 'text',
    value: isCustom ? cur : '',
    placeholder: opts.placeholder || '自定义…',
    title: opts.title || '供应商定义的任意值，例如 zh-CN-XiaoxiaoNeural / speech-02-hd',
    attr: { 'aria-label': opts.placeholder || '自定义值' },
    style: { 'max-width': '16em' },
    on: {
      keydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      },
      change: () => commit(),
      blur: () => commit(),
    },
  });
  function commit() {
    const v = String(input.value || '').trim();
    if (!v) return;
    // 让下拉也显示刚填的值：补一条「（自定义）xxx」并选中，
    // 否则下拉还停在预设上，界面显示的就不是真正在用的值。
    if (!list.some((p) => String(p.value) === v)) {
      let opt = Array.prototype.find.call(sel.options, (o) => o.value === v);
      if (!opt) {
        opt = el('option', { value: v });
        sel.appendChild(opt);
      }
      opt.textContent = `（自定义）${v}`;
      sel.value = v;
    } else {
      sel.value = v;
    }
    onChange(v);
  }

  return el('div.row', { style: { gap: '6px', 'flex-wrap': 'wrap' } }, sel, input);
}

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

/** 我方显示名（取设置里的 user.name） */
export function userNameOf(settings) {
  const s = settings || {};
  return (s.user && s.user.name) || '我';
}

/** 角色/群的主题色，缺省用强调色变量 */
export function colorOf(entity, fallback = 'var(--accent, #6c8cff)') {
  return (entity && entity.color) || fallback;
}

/** 简单差分：返回变化过的字段名（用于版本历史对比） */
export function changedKeys(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) {
    const va = JSON.stringify((a || {})[k]);
    const vb = JSON.stringify((b || {})[k]);
    if (va !== vb) out.push(k);
  }
  return out;
}

/**
 * 让"试听"能说出云端语音**真正的**失败原因。
 *
 * `speaker.speak()` 按设计永不 reject（云端失败会静默降级到浏览器内置，甚至直接静音），
 * 所以调用方 try/catch 永远 catch 不到东西 —— 用户点了"试听"只看到没反应，
 * 分不清是"没配密钥 / 地址填错 / 设备没声音"。唯一能拿到原因的地方是 `cfg.onError`。
 *
 * 用法：`const why = captureVoiceError(cfg); await speaker.test(text, cfg); if (why()) toast(why(), 'error')`
 * @param {object} cfg VoiceConfig（会被就地挂上 onError；非云端不需要）
 * @returns {() => string} 取回最近一次失败原因（没失败返回空串）
 */
export function captureVoiceError(cfg) {
  let msg = '';
  if (cfg && cfg.provider === 'cloud') {
    cfg.onError = (err) => {
      msg = String((err && err.message) || err || '未知错误');
    };
  }
  return () => msg;
}
