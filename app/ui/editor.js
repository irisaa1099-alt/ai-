/**
 * ui/editor.js —— 角色卡（人设）编辑器 / 模板库（契约 3.14）
 *
 * 导出：
 *   openCharacterEditor(charOrNull)   编辑或新建角色（null = 空白新建）
 *   openTemplateGallery()             内置人设模板库
 *
 * 备注：角色现在默认直接保存到电脑本地文件（见 core/filestore.js 与 server.mjs 的 /api/db），
 *       用户不再需要手动导入 / 导出，所以界面上的入口已按需求移除。
 *       导入导出**能力**仍保留在 core/store.js 层（exportAll / importAll / toSillyTavern /
 *       importCharacter），并有回归用例覆盖；这里曾经保留的两个旧弹窗（openImportDialog /
 *       openExportDialog）已随这次清理删除，历史实现见仓库里 2.0.7 及更早的版本快照。
 *
 * 设计要点：
 * - 编辑器用 ui/toast.js 的 modal() 承载，宽度 640，标签页组织：
 *   基本信息 / 性格人设 / 关系与世界 / 语音 / 高级提示词 / 版本历史。
 * - 所有输入「即时写回草稿对象」（draft），不在保存时读 DOM；因此切换标签页、
 *   增删列表项都不会丢数据，也不怕字段是 undefined（draftFrom() 统一兜底）。
 * - 保存走 core/store.js 的 saveCharacter()：自动补默认字段、压版本历史、emit
 *   `char:changed`（sidebar 与 app.js 据此刷新）。
 * - 新建角色保存成功后 emit `app:open-chat`(charId)，
 *   由 ui/app.js 负责真正打开会话 —— 这是本模块与 app.js 的约定。
 * - 全部 DOM 用 el() 构建，用户内容一律走文本节点（防 XSS）；禁止 alert/confirm。
 * - 模块顶层不访问 document / localStorage。
 */

import {
  bus } from '../core/bus.js';
import {
  saveCharacter,
  listCharacters,
  getSettings,
  DEFAULT_VOICE,
  DEFAULT_PERSONA,
} from '../core/store.js';
import { affinityLabel } from '../core/runtime.js';
import {
  clamp,
  num,
  debounce,
  fmtDate,
  stripMarkdown,
  truncate,
  firstChar,
  readFileAsDataURL,
} from '../core/util.js';
import { el, mount } from './dom.js';
import { isImageAvatar, presetCombo, captureVoiceError } from './shared.js';
import { icon } from './icons.js';
import { toast, confirmDialog, modal } from './toast.js';
import { speaker, voiceFor, CLOUD_VOICE_PRESETS } from '../voice/tts.js';
import {
  CHARACTER_TEMPLATES,
  TEMPLATE_GROUPS,
  templatesByGroup,
  getTemplate,
  templateToCharacter,
  WORLD_PRESETS,
  applyWorldPreset,
} from '../data/templates.js';

/* ------------------------------------------------------------------ *
 * 一、模板库的小适配层
 *
 * data/templates.js 是独立维护的内容库（模板会不断增加），这里做了两层保护：
 *   1) 导出为空数组时给「友好空态」，而不是让模板库页面崩掉；
 *   2) 转换函数用 try/catch 包一层，异常时退化处理，并把原因打到控制台。
 * ------------------------------------------------------------------ */

/** 模板分组（过滤掉结构不完整的项） */
const GROUPS = Array.isArray(TEMPLATE_GROUPS) ? TEMPLATE_GROUPS.filter((g) => g && g.id) : [];

/** 内置模板（可能为空：模板库尚未生成时） */
const TEMPLATES = Array.isArray(CHARACTER_TEMPLATES) ? CHARACTER_TEMPLATES : [];

/** 取某分组下的模板 */
function templatesOf(groupId) {
  try {
    const list = templatesByGroup(groupId);
    if (Array.isArray(list)) return list;
  } catch (err) {
    console.warn('[editor] templatesByGroup() 调用失败', err);
  }
  return TEMPLATES.filter((t) => t && t.group === groupId);
}

/** 用 id 取回「权威」模板对象（网格里渲染的可能只是派生副本） */
function resolveTpl(tpl) {
  if (!tpl || typeof tpl !== 'object') return null;
  if (tpl.id) {
    try {
      const found = getTemplate(tpl.id);
      if (found) return found;
    } catch (err) {
      console.warn('[editor] getTemplate() 调用失败', err);
    }
  }
  return tpl;
}

/** 模板对象 → 角色卡（异常时退化为「原样当角色卡用」，saveCharacter 会补齐字段） */
function templateToChar(tpl) {
  const src = resolveTpl(tpl);
  if (!src) return {};
  try {
    const char = templateToCharacter(src);
    if (char && typeof char === 'object') return char;
  } catch (err) {
    console.warn('[editor] templateToCharacter() 调用失败，退化为直接使用模板对象', err);
  }
  return { ...src };
}

/* ------------------------------------------------------------------ *
 * 二、设计令牌与内联样式（与 sidebar.js 保持同一套写法）
 * ------------------------------------------------------------------ */

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
 * 内联样式只保留两类东西：
 * 1) 壳里 CSS 覆盖不到的自定义件（导出选项卡、拖拽区、色块…）；
 * 2) 动态值（角色主题色、头像预览底色）。
 * 表单控件 / 按钮 / 标签页 / 卡片 / 空状态一律用 base.css 与 app.css 的既有类：
 * .field .field-label .field-hint .row .grid-2 .grid-3 .btn .btn-primary .btn-ghost
 * .btn-sm .btn-block .icon-btn.sm .chip .chip .x .badge .tag .empty .avatar.xl
 * .modal .tabs button.on .tpl-layout .tpl-groups .tpl-main .tpl-grid .tpl-card
 * .search-bar .search-results .hit .kv
 */
const S = {
  /** 自定义件：可增删列表里的一张卡（示例对话 / 版本历史） */
  listItem: {
    padding: '10px',
    background: 'var(--panel-2, #1e222b)',
    border: '1px solid var(--line, #2a2f3a)',
    'border-radius': '10px',
    'margin-bottom': '9px',
  },
  /** 自定义件：拖拽导入区 */
  drop: {
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'center',
    gap: '8px',
    padding: '22px 14px',
    border: '1.5px dashed var(--line, #2a2f3a)',
    'border-radius': '12px',
    color: 'var(--dim, #8b93a7)',
    'text-align': 'center',
    'font-size': '12px',
  },
  /** 自定义件：导出选项卡（整块可点） */
  exportRow: { width: '100%', 'margin-bottom': '10px' },
};

/** 预设主题色 */
const PRESET_COLORS = ['#6c8cff', '#a78bfa', '#f472b6', '#ff6b6b', '#e0b341', '#4ec9a8', '#38bdf8', '#ff8a5c'];

/** persona 字段 → 中文标签（表单与版本对比共用） */
/** 世界书条目上限（与 core/store.js 的 normalizeCharacter 里 slice(0, 60) 保持一致） */
const LOREBOOK_LIMIT = 60;

const PERSONA_FIELDS = [
  ['personality', '性格关键词'],
  ['mbti', 'MBTI'],
  ['values', '价值观'],
  ['style', '说话风格'],
  ['catchphrase', '口头禅'],
  ['emojiHabit', '常用表情符号'],
  ['particles', '语气助词'],
  ['relationship', '与用户的关系'],
  ['addressUser', '称呼用户的方式'],
  ['world', '世界观 / 时代背景'],
  ['place', '所处地点'],
  ['speech', '说话禁忌'],
  ['taboo', '禁区话题'],
];

const MBTI_LIST = [
  '', 'INTJ', 'INTP', 'ENTJ', 'ENTP', 'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ', 'ISTP', 'ISFP', 'ESTP', 'ESFP',
];

const STYLE_LIST = ['口语', '书面', '方言', '高冷', '中二', '古风', '毒舌', '软萌', '学术'];

const RELATION_LIST = ['朋友', '恋人', '家人', '损友', '上司', '下属', '陌生人', '主仆', '竞争对手'];

const GENDER_LIST = ['', '女', '男', '其他'];

/* ------------------------------------------------------------------ *
 * 三、草稿归一化（所有字段都保证有值，绝不让 undefined 漏进表单）
 * ------------------------------------------------------------------ */

/** 空白角色草稿 */
function emptyDraft() {
  return {
    id: '',
    name: '',
    avatar: '',
    emoji: '',
    color: '#6c8cff',
    gender: '',
    age: '',
    job: '',
    tagline: '',
    tags: [],
    group: '默认',
    pinned: false,
    muted: false,
    // 复用 core/store.js 的唯一一份定义（避免以后加字段时这里忘了同步）
    persona: { ...DEFAULT_PERSONA },
    systemPrompt: '',
    examples: [],
    lorebook: [],
    authorNote: '',
    affinity: 20,
    greeting: [],
    voice: { ...DEFAULT_VOICE },
    model: null,
    createdAt: 0,
    updatedAt: 0,
    version: 0,
    history: [],
  };
}

/**
 * 任意角色卡 → 编辑器草稿（缺字段全部补默认值）
 * @param {object|null|undefined} char
 * @returns {object}
 */
function draftFrom(char) {
  const base = emptyDraft();
  if (!char || typeof char !== 'object') return base;

  const persona = char.persona && typeof char.persona === 'object' ? char.persona : {};
  const voice = char.voice && typeof char.voice === 'object' ? char.voice : {};
  const out = {
    ...base,
    ...char,
    persona: { ...base.persona, ...persona },
    voice: { ...base.voice, ...voice },
    tags: Array.isArray(char.tags) ? char.tags.map(String).filter(Boolean) : [],
    examples: Array.isArray(char.examples)
      ? char.examples
          .filter((e) => e && typeof e === 'object')
          .map((e) => ({ user: String(e.user == null ? '' : e.user), ai: String(e.ai == null ? '' : e.ai) }))
      : [],
    greeting: Array.isArray(char.greeting)
      ? char.greeting.map(String).filter(Boolean)
      : char.greeting
        ? [String(char.greeting)]
        : [],
    history: Array.isArray(char.history) ? char.history : [],
    // 世界书：深拷贝一份，编辑器里增删改不会动到已保存的角色对象
    lorebook: Array.isArray(char.lorebook)
      ? char.lorebook
          .filter((l) => l && typeof l === 'object')
          .map((l) => ({
            keys: Array.isArray(l.keys) ? l.keys.map(String).filter(Boolean) : [],
            content: l.content == null ? '' : String(l.content),
            enabled: l.enabled !== false,
          }))
      : [],
  };

  // 顶层字符串字段兜底（展开 ...char 可能带进 undefined / null）
  for (const key of ['name', 'avatar', 'emoji', 'color', 'gender', 'job', 'tagline', 'group', 'systemPrompt', 'authorNote']) {
    out[key] = out[key] == null ? base[key] : String(out[key]);
  }
  for (const key of Object.keys(base.persona)) {
    out.persona[key] = out.persona[key] == null ? base.persona[key] : String(out.persona[key]);
  }
  out.age = out.age == null ? '' : String(out.age);
  out.id = out.id ? String(out.id) : '';
  out.color = /^#[0-9a-f]{3,8}$/i.test(out.color) ? out.color : base.color;
  out.group = out.group.trim() || '默认';
  out.affinity = clamp(num(out.affinity, 20), 0, 100);
  out.pinned = Boolean(out.pinned);
  out.muted = Boolean(out.muted);
  out.voice.rate = clamp(num(out.voice.rate, 1), 0.5, 2);
  out.voice.pitch = clamp(num(out.voice.pitch, 1), 0.5, 2);
  out.voice.provider = out.voice.provider === 'cloud' ? 'cloud' : 'webspeech';
  out.voice.autoplay = ['off', 'short', 'always'].includes(out.voice.autoplay) ? out.voice.autoplay : 'short';
  out.voice.voiceId = out.voice.voiceId == null ? '' : String(out.voice.voiceId);
  return out;
}

/* ------------------------------------------------------------------ *
 * 四、表单基础件
 * ------------------------------------------------------------------ */

/** 带标签的一行字段（外观走 base.css 的 .field / .field-label / .field-hint） */
function field(label, control, hint) {
  return el(
    'div.field',
    el('div.field-label', { text: label }),
    control,
    hint ? el('div.field-hint', { text: hint }) : null
  );
}

/** 单行输入（表单控件外观由 base.css 的 input 元素级样式负责） */
function textInput(value, placeholder, onInput, extra) {
  const input = el('input', {
    type: (extra && extra.type) || 'text',
    value: value == null ? '' : String(value),
    placeholder: placeholder || '',
    ...(extra && extra.style ? { style: extra.style } : null),
    ...(extra && extra.attr ? { attr: extra.attr } : null),
  });
  input.addEventListener('input', () => onInput(input.value, input));
  return input;
}

/** 多行输入 */
function textArea(value, placeholder, onInput, rows) {
  const ta = el('textarea', {
    rows: rows || 3,
    placeholder: placeholder || '',
    value: value == null ? '' : String(value),
  });
  ta.addEventListener('input', () => onInput(ta.value, ta));
  return ta;
}

/**
 * 下拉框。注意：必须在 option 追加完成后再设置 value，否则选中项会被重置。
 * @param {string} value 当前值
 * @param {Array<{value: string, label: string}>} options
 * @param {(v: string) => void} onChange
 */
function selectInput(value, options, onChange) {
  const list = Array.isArray(options) ? options.slice() : [];
  const cur = value == null ? '' : String(value);
  const sel = el('select');
  if (!list.some((o) => String(o.value) === cur)) {
    list.push({ value: cur, label: cur ? `${cur}（原设定）` : '（未设置）' });
  }
  for (const o of list) {
    sel.appendChild(el('option', { value: String(o.value), text: String(o.label) }));
  }
  sel.value = cur;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

/** 0.5 ~ 2.0 的滑块 + 实时数值（滑块外观见 base.css 的 input[type=range]） */
function sliderRow(value, onChange) {
  const v = clamp(num(value, 1), 0.5, 2);
  const out = el('span.small.muted', { text: v.toFixed(2) });
  const input = el('input', {
    type: 'range',
    min: '0.5',
    max: '2',
    step: '0.05',
    value: String(v),
    style: { flex: '1 1 auto', 'min-width': '0' },
  });
  input.addEventListener('input', () => {
    const nv = clamp(num(input.value, 1), 0.5, 2);
    out.textContent = nv.toFixed(2);
    onChange(nv);
  });
  return el('div.row', input, out);
}

/** 下拉 + 自定义输入的组合（说话风格 / 关系）：下拉选预设，右边输入框写自己的 */
function comboRow(value, options, onPick, customPlaceholder) {
  const cur = value == null ? '' : String(value);
  const inList = options.includes(cur);
  const CUSTOM = '__custom__';
  const wrap = el('div.field-row');
  const selBox = el('div', { style: { flex: '0 0 40%' } });
  const customBox = el('div', { style: { flex: '1 1 auto', 'min-width': '120px' } });

  /** 下拉里当前选中的预设值（清空自定义输入时用于回退） */
  let picked = inList ? cur : String(options[0] || '');

  const sel = selectInput(inList ? cur : CUSTOM, [
    ...options.map((o) => ({ value: o, label: o })),
    { value: CUSTOM, label: '自定义…' },
  ], (v) => {
    if (v === CUSTOM) {
      custom.focus();
      return;
    }
    picked = v;
    custom.value = '';
    onPick(v);
  });

  const custom = textInput(inList ? '' : cur, customPlaceholder || '自定义…', (v) => {
    const text = String(v || '').trim();
    if (text) {
      picked = text;
      sel.value = CUSTOM;
      onPick(text);
    } else {
      sel.value = picked;
      onPick(picked);
    }
  });

  selBox.appendChild(sel);
  customBox.appendChild(custom);
  wrap.appendChild(selBox);
  wrap.appendChild(customBox);
  return wrap;
}

/** 迷你图标按钮（外观走 base.css 的 .icon-btn.sm） */
function smallButton(iconName, title, onClick) {
  return el(
    'button.icon-btn.sm',
    { type: 'button', title, on: { click: onClick } },
    icon(iconName, 14)
  );
}

/* ------------------------------------------------------------------ *
 * 五、编辑器主入口
 * ------------------------------------------------------------------ */

/**
 * 打开角色编辑器
 * @param {object|null} charOrNull 角色卡；null / 无 id 视为新建
 * @param {{isNew?: boolean}} [opts] isNew 强制标记为「尚未落库」（模板预览用）
 * @returns {{close: () => void, root: HTMLElement, body: HTMLElement}}
 */
export function openCharacterEditor(charOrNull, opts = {}) {
  const draft = draftFrom(charOrNull);
  const isNew = opts && opts.isNew === true ? true : !(charOrNull && charOrNull.id);

  /** 编辑器状态（传给各个标签页构建函数） */
  const st = {
    draft,
    isNew,
    activeTab: 'basic',
    selectTab: null,
    close: null,
    /** 是否改过内容：任何输入置位，用于关闭前提醒（否则 Esc/点遮罩会静默丢弃全部改动） */
    dirty: false,
  };

  const tabs = buildTabs(st);
  st.selectTab = tabs.select;

  const editorRoot = el('div.editor-root', tabs.bar, tabs.panelHost);
  // 一次委托覆盖所有输入控件（各标签页自己创建的 input/textarea/select 都冒泡到这里）
  editorRoot.addEventListener('input', () => {
    st.dirty = true;
  });
  editorRoot.addEventListener('change', () => {
    st.dirty = true;
  });

  const m = modal({
    title: isNew ? '新建好友' : `编辑「${draft.name || '角色'}」`,
    width: 640,
    body: editorRoot,
    actions: [
      { text: '取消', onClick: () => {} },
      {
        text: '保存',
        kind: 'primary',
        // 返回 false 阻止 modal 自动关闭：校验失败要留在原地，保存成功后再手动 close()
        onClick: (close) => {
          saveDraft(st, close).catch((err) => toast(`保存失败：${(err && err.message) || err}`, 'error'));
          return false;
        },
      },
    ],
  });

  // 包一层 close：标题栏 × / Esc / 点遮罩都会走 m.close，
  // 有未保存改动时先确认，避免"写了一堆人设按了 Esc 就全没了"
  const rawClose = m.close;
  let confirmedClose = false;
  const guardClose = () => {
    if (confirmedClose || !st.dirty) {
      rawClose();
      return;
    }
    void confirmDialog({
      title: '放弃未保存的修改？',
      message: '这份角色卡有改动还没保存，关闭后这些改动会丢失。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      danger: true,
    }).then((yes) => {
      if (yes) {
        confirmedClose = true;
        rawClose();
      }
    });
  };
  st.close = guardClose;
  m.close = guardClose;
  tabs.select(st.activeTab);
  return m;
}

/** 保存草稿 → store；成功后通知 app.js 打开会话（新建时） */
async function saveDraft(st, close) {
  const d = st.draft;
  const name = String(d.name == null ? '' : d.name).trim();

  // 保存前把"会被底层静默丢弃的内容"显式拦下来：
  // ① 世界书条目缺关键词或内容 → core/store.js 的 normalizeCharacter 会过滤掉；
  // ② 世界书超过 60 条 → 会被 slice(0,60) 砍掉；
  // ③ 开场白被清空 → 新会话会没有任何开场白。
  const badLore = (d.lorebook || []).filter((e) => !(e.keys || []).length || !String(e.content || '').trim()).length;
  const overLore = (d.lorebook || []).length > LOREBOOK_LIMIT ? (d.lorebook || []).length - LOREBOOK_LIMIT : 0;
  if (badLore || overLore) {
    const parts = [];
    if (badLore) parts.push(`${badLore} 条世界书缺关键词或内容（会被丢弃）`);
    if (overLore) parts.push(`世界书超出上限 ${overLore} 条（会被丢弃）`);
    const go = await confirmDialog({
      title: '确认保存？',
      message: `${parts.join('；')}。\n\n建议先补全或删掉它们，再保存。要继续保存吗？`,
      okText: '仍然保存',
      cancelText: '回去修改',
      danger: true,
    });
    if (!go) return;
  }
  if (!Array.isArray(d.greeting) || !d.greeting.filter((g) => String(g || '').trim()).length) {
    // 至少留一条，保持与模板库/契约一致（否则新会话没有开场白）
    d.greeting = ['……你好。'];
  }
  if (!name) {
    toast('请先给这位好友起个名字', 'warn');
    st.selectTab('basic');
    return;
  }
  d.name = name;
  d.affinity = clamp(num(d.affinity, 20), 0, 100);

  try {
    const saved = await saveCharacter(d);
    // 保存成功后清掉脏标记：否则用户保存完再关闭还会被问一次"放弃未保存的修改？"
    st.dirty = false;
    // 回填 store 生成的 id / 版本 / 历史，让「版本历史」标签页立刻有内容
    st.draft.id = saved.id;
    st.draft.createdAt = saved.createdAt;
    st.draft.updatedAt = saved.updatedAt;
    st.draft.version = saved.version;
    st.draft.history = saved.history;
    toast('已保存', 'ok');

    if (st.isNew) {
      st.isNew = false;
      // 约定：app.js 监听 app:open-chat(charId) → 打开会话（并处理单栏/三栏）。
      // （原先这里还同时 emit 了一个 chat:open，但全项目没有任何监听者，属遗留对冲，已移除）
      bus.emit('app:open-chat', saved.id);
    }
    if (typeof close === 'function') close();
  } catch (err) {
    console.warn('[editor] 保存角色失败', err);
    toast(`保存失败：${(err && err.message) || '未知错误'}`, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * 六、标签页框架
 * ------------------------------------------------------------------ */

/** 七个标签页（顺序即界面顺序） */
const TABS = [
  { id: 'basic', label: '基本信息', icon: 'user', build: buildBasicTab },
  { id: 'persona', label: '性格人设', icon: 'brain', build: buildPersonaTab },
  { id: 'world', label: '关系与世界', icon: 'globe', build: buildWorldTab },
  { id: 'lorebook', label: '世界书', icon: 'book', build: buildLorebookTab },
  { id: 'voice', label: '语音', icon: 'speaker', build: buildVoiceTab },
  { id: 'advanced', label: '高级提示词', icon: 'wand', build: buildAdvancedTab },
  { id: 'history', label: '版本历史', icon: 'clock', build: buildHistoryTab },
];

function buildTabs(st) {
  // 外观走 app.css 的 .modal .tabs button / button.on（当前项加 .on）
  const bar = el('div.tabs');
  const panelHost = el('div.editor-panel', { style: { 'max-height': '58vh', 'overflow-y': 'auto', 'padding-top': '14px' } });
  const buttons = new Map();

  for (const tab of TABS) {
    const btn = el(
      'button.editor-tab',
      {
        type: 'button',
        dataset: { tab: tab.id },
        on: { click: () => select(tab.id) },
      },
      icon(tab.icon, 14),
      el('span', { text: tab.label })
    );
    buttons.set(tab.id, btn);
    bar.appendChild(btn);
  }

  function select(id) {
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    st.activeTab = tab.id;
    for (const [tid, btn] of buttons) {
      // app.css: .modal .tabs button.on { color/border-bottom 高亮 }
      btn.classList.toggle('on', tid === tab.id);
    }
    try {
      mount(panelHost, tab.build(st));
    } catch (err) {
      console.error('[editor] 标签页渲染失败', err);
      mount(panelHost, el('div', { text: '这个标签页渲染失败了，请重开编辑器。', style: { color: T.danger } }));
    }
    panelHost.scrollTop = 0;
  }

  return { bar, panelHost, select };
}

/* ------------------------------------------------------------------ *
 * 七、标签页：基本信息
 * ------------------------------------------------------------------ */

function buildBasicTab(st) {
  const d = st.draft;
  const wrap = el('div');

  /* ---- 头像 + emoji ---- */
  const avatarBox = el('div.avatar.xl');
  const paintAvatar = () => {
    mount(
      avatarBox,
      isImageAvatar(d.avatar)
        ? el('img', { src: d.avatar, alt: '头像' })
        : el('span', { text: d.emoji || firstChar(d.name) })
    );
    // 主题色是动态值，必须内联
    avatarBox.style.background = alpha(d.color, 0.18);
    avatarBox.style.border = `1px solid ${alpha(d.color, 0.5)}`;
    avatarBox.style.color = d.color;
  };

  const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 200 * 1024) {
      toast('图片超过 200KB，请先压缩（建议 128×128 的 JPG/PNG）', 'warn', 5000);
      return;
    }
    try {
      d.avatar = await readFileAsDataURL(file);
      paintAvatar();
      toast('头像已更新，记得保存', 'ok');
    } catch (err) {
      console.warn('[editor] 读取头像失败', err);
      toast('读取图片失败', 'error');
    }
  });

  const emojiInput = textInput(d.emoji, '🌙', (v) => {
    d.emoji = Array.from(String(v || '')).slice(0, 4).join('');
    paintAvatar();
  }, { style: { 'max-width': '120px' } });

  paintAvatar();

  wrap.appendChild(
    el(
      'div',
      { style: { display: 'flex', gap: '14px', 'align-items': 'flex-start', 'margin-bottom': '14px' } },
      avatarBox,
      el(
        'div',
        { style: { flex: '1 1 auto', 'min-width': '0' } },
        el(
          'div',
          { style: { display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'margin-bottom': '10px' } },
          el(
            'button.btn',
            { type: 'button', on: { click: () => fileInput.click() } },
            icon('upload', 14),
            el('span', { text: '上传头像' })
          ),
          d.avatar
            ? el(
                'button.btn',
                {
                  type: 'button',
                  class: 'btn btn-sm',
                  on: {
                    click: () => {
                      d.avatar = '';
                      paintAvatar();
                    },
                  },
                },
                el('span', { text: '清除图片' })
              )
            : null,
          fileInput
        ),
        field('或直接用 emoji 当头像', emojiInput, '不传图片时，列表里就显示这个 emoji（留空则用名字首字）')
      )
    )
  );

  /* ---- 名字 / 简介 ---- */
  const nameInput = textInput(d.name, '林晚', (v) => {
    d.name = v;
  });
  nameInput.dataset.role = 'name';
  wrap.appendChild(field('名字', nameInput, '必填。会显示在好友列表与每一条回复上'));
  wrap.appendChild(
    field('一句话简介', textInput(d.tagline, '深夜电台里那个总说“我懂”的人', (v) => {
      d.tagline = v;
    }), '显示在好友列表的第二行（还没聊过时）')
  );

  /* ---- 性别 / 年龄 / 职业 ---- */
  wrap.appendChild(
    el(
      'div',
      { class: 'row', style: { 'align-items': 'flex-start', 'margin-bottom': '12px' } },
      el('div', { style: { flex: '0 0 96px' } }, field('性别', selectInput(d.gender, GENDER_LIST.map((g) => ({ value: g, label: g || '未设定' })), (v) => {
        d.gender = v;
      }))),
      el('div', { style: { flex: '0 0 90px' } }, field('年龄', textInput(d.age, '24', (v) => {
        d.age = v;
      }))),
      el('div', { style: { flex: '1 1 auto' } }, field('职业 / 身份', textInput(d.job, '插画师', (v) => {
        d.job = v;
      })))
    )
  );

  wrap.appendChild(field('标签', buildTagsEditor(st), '回车添加，点 × 删除。标签也会参与左侧的搜索过滤'));

  /* ---- 分组 ---- */
  const groupsList = el('datalist', { id: 'aichat-group-list' });
  listCharacters()
    .then((list) => {
      const names = new Set();
      for (const c of list || []) names.add(String(c.group || '默认'));
      for (const n of names) groupsList.appendChild(el('option', { value: n }));
    })
    .catch(() => {});
  wrap.appendChild(
    field(
      '分组',
      el(
        'div',
        textInput(d.group, '默认', (v) => {
          d.group = v;
        }, { attr: { list: 'aichat-group-list' } }),
        groupsList
      ),
      '左侧列表按分组折叠展示：家人 / 工作 / 剧情 / 测试…'
    )
  );

  /* ---- 主题色 ---- */
  const swatchRow = el('div', { style: { display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' } });
  const swatches = [];
  const paintSwatches = () => {
    swatches.forEach((btn, i) => {
      const on = PRESET_COLORS[i].toLowerCase() === String(d.color).toLowerCase();
      btn.style.borderColor = on ? T.text : 'transparent';
      btn.style.boxShadow = on ? `0 0 0 2px ${alpha(PRESET_COLORS[i], 0.35)}` : 'none';
    });
    avatarBox.style.background = alpha(d.color, 0.18);
    avatarBox.style.borderColor = alpha(d.color, 0.5);
  };
  PRESET_COLORS.forEach((color) => {
    const btn = el('button', {
      type: 'button',
      title: color,
      style: { width: '26px', height: '26px', 'border-radius': '8px', border: '2px solid transparent', cursor: 'pointer', padding: '0', background: color },
      on: {
        click: () => {
          d.color = color;
          colorInput.value = color;
          paintSwatches();
        },
      },
    });
    swatches.push(btn);
    swatchRow.appendChild(btn);
  });
  const colorInput = el('input', {
    type: 'color',
    value: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#6c8cff',
    style: { width: '34px', height: '28px', border: `1px solid ${T.line}`, 'border-radius': '8px', background: 'transparent', cursor: 'pointer', padding: '0' },
  });
  colorInput.addEventListener('input', () => {
    d.color = colorInput.value;
    paintSwatches();
  });
  swatchRow.appendChild(colorInput);
  paintSwatches();
  wrap.appendChild(field('主题色', swatchRow, '用于头像底色、聊天气泡与强调色'));

  /* ---- 初始好感度 ---- */
  const affOut = el('span', {
    text: `${d.affinity} · ${affinityLabel(d.affinity)}`,
    class: 'small muted',
    style: { 'min-width': '86px', 'text-align': 'right' },
  });
  const affInput = el('input', { type: 'range', min: '0', max: '100', step: '1', value: String(d.affinity), style: { flex: '1 1 auto', 'min-width': '0' } });
  affInput.addEventListener('input', () => {
    const v = clamp(Math.round(num(affInput.value, 20)), 0, 100);
    d.affinity = v;
    affOut.textContent = `${v} · ${affinityLabel(v)}`;
  });
  wrap.appendChild(
    field(
      '初始好感度',
      el('div', { style: { display: 'flex', 'align-items': 'center', gap: '10px' } }, affInput, affOut),
      '只影响「第一次见面」时的态度；之后随聊天自然升降'
    )
  );

  return wrap;
}

/** 标签 chips 编辑器 */
function buildTagsEditor(st) {
  const d = st.draft;
  // 外观走 app.css 的 .tag-box（边框 / 底色 / 圆角，聚焦时整框变蓝而不是内层 input 自己画圈）
  const chipHost = el('div.row.wrap.tag-box');
  const input = el('input', {
    type: 'text',
    placeholder: '输入标签后回车（如：温柔）',
    // 与相邻 chip 同高、底边齐平（高度走 base.css 的 --ctrl-h-inline，别写死 padding）
    style: { flex: '1 1 140px', 'min-width': '110px', border: 'none', background: 'transparent' },
    on: {
      keydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        add(input.value);
      },
      blur: () => add(input.value),
    },
  });

  function add(raw) {
    const text = String(raw || '').trim().replace(/[,，]/g, '');
    input.value = '';
    if (!text) return;
    if (d.tags.length >= 12) {
      toast('标签最多 12 个', 'warn');
      return;
    }
    if (d.tags.includes(text)) return;
    d.tags.push(text);
    paint();
  }

  function paint() {
    mount(
      chipHost,
      d.tags.map((tag) =>
        el(
          'span.editor-chip',
          { class: 'chip' },
          el('span', { text: tag }),
          el(
            'button',
            {
              type: 'button',
              title: '删除标签',
              class: 'x',
              style: { border: 'none', background: 'transparent', cursor: 'pointer', padding: '0' },
              on: {
                click: () => {
                  d.tags = d.tags.filter((t) => t !== tag);
                  paint();
                },
              },
            },
            icon('close', 11)
          )
        )
      ),
      input
    );
  }

  paint();
  return chipHost;
}

/* ------------------------------------------------------------------ *
 * 八、标签页：性格人设
 * ------------------------------------------------------------------ */

function buildPersonaTab(st) {
  const p = st.draft.persona;
  const wrap = el('div');

  wrap.appendChild(
    field(
      '性格关键词',
      textArea(p.personality, '温柔但有边界感，说话慢，会记住你提过的细节；被夸会别扭地转移话题', (v) => {
        p.personality = v;
      }, 4),
      '写“怎么做”比写“是什么”更有用：把抽象性格翻成具体行为'
    )
  );

  wrap.appendChild(
    el(
      'div',
      { class: 'row', style: { 'align-items': 'flex-start', 'margin-bottom': '12px' } },
      el('div', { style: { flex: '0 0 140px' } }, field('MBTI', selectInput(p.mbti, MBTI_LIST.map((m) => ({ value: m, label: m || '未知' })), (v) => {
        p.mbti = v;
      }))),
      el('div', { style: { flex: '1 1 auto' } }, field('价值观 / 行为动机', textInput(p.values, '重视承诺与陪伴，讨厌被敷衍', (v) => {
        p.values = v;
      })))
    )
  );

  wrap.appendChild(
    field(
      '说话风格',
      comboRow(p.style, STYLE_LIST, (v) => {
        p.style = v;
      }, '自定义风格（如：民国腔）'),
      '口语 / 书面 / 方言 / 高冷 / 中二 / 古风…也可以在右边自己写'
    )
  );

  wrap.appendChild(
    field('口头禅', textInput(p.catchphrase, '……嗯。', (v) => {
      p.catchphrase = v;
    }), '每次开口都可能带上的固定说法，最出戏感的来源')
  );

  wrap.appendChild(
    el(
      'div',
      { class: 'row', style: { 'align-items': 'flex-start' } },
      el('div', { style: { flex: '1 1 50%' } }, field('常用表情符号', textInput(p.emojiHabit, '爱用（￣▽￣）和 ♪ 结尾', (v) => {
        p.emojiHabit = v;
      }))),
      el('div', { style: { flex: '1 1 50%' } }, field('语气助词', textInput(p.particles, '呀 / 啦 / 嘛 / 呢', (v) => {
        p.particles = v;
      })))
    )
  );

  return wrap;
}

/* ------------------------------------------------------------------ *
 * 九、标签页：关系与世界
 * ------------------------------------------------------------------ */

function buildWorldTab(st) {
  const p = st.draft.persona;
  const wrap = el('div');

  wrap.appendChild(
    field('与用户的关系', comboRow(p.relationship, RELATION_LIST, (v) => {
      p.relationship = v;
    }, '自定义关系（如：同居室友）'), '关系决定称呼、距离感与能开的话题')
  );

  wrap.appendChild(
    field('称呼用户的方式', textInput(p.addressUser, '你 / 老板 / 学姐', (v) => {
      p.addressUser = v;
    }), 'TA 在对话里怎么叫你')
  );

  wrap.appendChild(
    field('世界观 / 时代背景', textArea(p.world, '现代都市 · 2024 年的上海，梅雨季；两人是同一栋楼的邻居', (v) => {
      p.world = v;
    }, 4))
  );

  wrap.appendChild(
    field('所处地点', textInput(p.place, '老城区一间开在二楼的旧书店', (v) => {
      p.place = v;
    }), 'TA 常驻的地方，聊天里会被自然提到')
  );

  return wrap;
}

/* ------------------------------------------------------------------ *
 * 九·五、标签页：世界书（关键词触发式设定注入）
 *   只有对话里出现关键词时，这条设定才会进提示词——长设定不炸 token。
 * ------------------------------------------------------------------ */

function buildLorebookTab(st) {
  const wrap = el('div');
  if (!Array.isArray(st.draft.lorebook)) st.draft.lorebook = [];

  /* ---- 条目列表 ---- */
  const list = el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } });

  const countEl = el('span.muted.small.lore-count', { text: `0 / ${LOREBOOK_LIMIT} 条` });

  /** 只刷新"计数 + 将被丢弃"的提示（输入时用，不重建列表，避免打断输入焦点） */
  const updateCount = () => {
    if (!countEl) return;
    const total = st.draft.lorebook.length;
    const invalid = st.draft.lorebook.filter((e) => !(e.keys || []).length || !String(e.content || '').trim()).length;
    countEl.textContent = invalid
      ? `${total} / ${LOREBOOK_LIMIT} 条（${invalid} 条缺关键词或内容，保存会丢弃）`
      : `${total} / ${LOREBOOK_LIMIT} 条`;
    countEl.style.color = invalid ? 'var(--warn, #e0b341)' : '';
  };

  const renderList = () => {
    updateCount();
    mount(list);
    if (!st.draft.lorebook.length) {
      list.appendChild(
        el('div.empty', el('div.big', { text: '📖' }), el('h3', { text: '还没有世界书条目' }), el('div.muted.small', { text: '点下面的「添加条目」，或直接套用一套世界观预设。' }))
      );
      return;
    }
    st.draft.lorebook.forEach((entry, i) => {
      const node = renderEntry(entry, i);
      list.appendChild(node);
    });
  };

  const renderEntry = (entry, i) => {
    const head = el(
      'div.row',
      el('span.tag', { text: `#${i + 1}` }),
      el(
        'label.row.small',
        { style: { gap: '5px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox',
          checked: entry.enabled !== false,
          on: {
            change: (e) => {
              entry.enabled = e.target.checked;
            },
          },
        }),
        el('span.muted', { text: '启用' })
      ),
      el('span.spacer'),
      smallButton('copy', '复制这一条', () => {
        st.draft.lorebook.splice(i + 1, 0, {
          keys: entry.keys.slice(),
          content: entry.content,
          enabled: entry.enabled !== false,
        });
        renderList();
      }),
      smallButton('trash', '删除这一条', () => {
        st.draft.lorebook.splice(i, 1);
        renderList();
      })
    );

    return el(
      'div',
      {
        style: {
          border: '1px solid var(--line)',
          'border-radius': '10px',
          padding: '10px',
          background: 'var(--panel-2)',
          display: 'flex',
          'flex-direction': 'column',
          gap: '7px',
          opacity: entry.enabled === false ? '0.6' : '1',
        },
      },
      head,
      el(
        'div.field',
        el('div.field-label', { text: '关键词（逗号分隔，命中任意一个就注入）' }),
        textInput(entry.keys.join('、'), '老巷子、巷口、小时候', (v) => {
          entry.keys = String(v)
            .split(/[,，、\s]+/)
            .map((k) => k.trim())
            .filter(Boolean);
          updateCount();
        })
      ),
      el(
        'div.field',
        el('div.field-label', { text: '设定内容' }),
        textArea(entry.content, '老巷子是两人一起长大的地方：巷口有棵歪脖子槐树……', (v) => {
          entry.content = String(v);
          updateCount();
        }, 3)
      )
    );
  };

  function rerenderTab() {
    mount(wrap);
    build();
  }

  function build() {
    wrap.appendChild(
      el('p.field-hint', {
        text:
          '世界书里的设定不会每轮都发给模型：只有最近对话（或你这句话）里出现了关键词，这条设定才会被注入，所以世界观可以写得很细，也不会白白占用上下文。',
      })
    );
    // 当前已套用的预设：用角色卡里的 world 文案反查，这样重新渲染后下拉仍显示选中的那一套
    const worldText = String((st.draft.persona && st.draft.persona.world) || '');
    const matched = WORLD_PRESETS.find((w) => w.world && worldText && worldText.trim() === w.world.trim());
    // world 有值但匹配不到预设 = 用户自己写的 → 直接展开自定义输入框
    const customWorld = matched ? '' : worldText;
    /* ---- 世界类型：下拉里每一项都自解释，含明确的「清空世界设定」 ---- */
    const EMPTY_WORLD = '__empty_world__';
    const worldSel = el(
      'select',
      {
        on: {
          change: () => {
            const v = worldSel.value;
            applyWorldChoice(v === EMPTY_WORLD ? '' : v);
          },
        },
      },
      el('option', { value: '', text: '选择世界类型…（共 ' + WORLD_PRESETS.length + ' 套预设）' }),
      ...WORLD_PRESETS.map((w) => el('option', { value: w.name, text: w.name })),
      el('option', { value: EMPTY_WORLD, text: '✕ 清空世界设定（移除当前世界的设定条目）' })
    );
    worldSel.value = matched ? matched.name : '';

    // 自定义世界文案：默认收起；仅在"world 有值但不是预设文案"时自动展开
    let customMode = Boolean(customWorld);
    const customInput = textInput(customWorld, '例如：现代都市 · 2024 年的上海，梅雨季', (v) => {
      // 只改文案，**不要**重建 persona/lorebook 对象：
      // 重建会让下面已经渲染出来的条目节点继续闭包持有旧数组里的 entry，
      // 之后对条目的编辑全部写到孤儿对象上，保存时静默丢失。
      st.draft.persona.world = String(v);
      st.draft.name = st.draft.name; // 保持引用不变（防止将来有人误加重建逻辑）
    });
    const customBox = el('div', { style: { display: customMode ? 'block' : 'none', 'margin-top': '8px' } }, customInput);
    const customBtn = el(
      'button.btn.btn-sm',
      {
        type: 'button',
        title: '不想用预设？自己写这个世界',
        on: {
          click: () => {
            customMode = !customMode;
            customBox.style.display = customMode ? 'block' : 'none';
            customBtn.classList.toggle('on', customMode);
            if (customMode) customInput.focus();
          },
        },
      },
      icon('edit', 14),
      el('span', { text: '自定义' })
    );

    /**
     * 应用一个世界选择
     * @param {string} worldIdOrName 预设 id 或名称；传空串 = 清空世界设定
     */
    function applyWorldChoice(worldIdOrName) {
      const before = Array.isArray(st.draft.lorebook) ? st.draft.lorebook.length : 0;
      const w = WORLD_PRESETS.find((x) => x.id === worldIdOrName || x.name === worldIdOrName);
      const next = applyWorldPreset(st.draft, w ? w.id : '');
      st.draft.persona = next.persona;
      st.draft.lorebook = next.lorebook;
      rerenderTab();
      const after = next.lorebook.length;
      const removed = Math.max(0, before - after);
      if (!w) {
        toast(
          '已清空世界设定' + (removed ? '：移除了 ' + removed + ' 条设定条目' : '') + (after ? '，你手写的 ' + after + ' 条保留' : ''),
          'info',
          4600
        );
        return;
      }
      toast(
        removed > 0
          ? '已切换到「' + w.name + '」：替换掉 ' + removed + ' 条旧世界设定，现有 ' + after + ' 条'
          : '已套用「' + w.name + '」：现有 ' + after + ' 条设定',
        'ok',
        4600
      );
    }

    wrap.appendChild(
      field(
        '世界类型',
        el('div', el('div.field-row', el('div', { style: { 'flex': '1 1 auto' } }, worldSel), customBtn), customBox),
        '选择一套预设会写入「世界 / 地点」并替换上一套预设的设定条目（你手写的条目保留）；选最后一项可清空。'
      )
    );

    wrap.appendChild(
      field(
        '设定条目',
        el(
          'div',
          { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } },
          list,
          el(
            'div.row',
            smallButton('plus', '添加条目', () => {
              if (st.draft.lorebook.length >= LOREBOOK_LIMIT) {
                toast(`世界书最多 ${LOREBOOK_LIMIT} 条（超出的部分保存时会被丢弃）`, 'warn');
                return;
              }
              st.draft.lorebook.push({ keys: [], content: '', enabled: true });
              renderList();
            }),
            // 计数必须是"活的"：之前这是一次性文本，增删条目后永远显示旧数字，
            // 用户会以为条目都在，保存时却被 slice(0,60) 静默砍掉
            countEl
          )
        ),
        '关键词命中才会注入。建议一条只写一个话题，关键词写角色名/地名/物品名等。'
      )
    );
    // 打开标签页时必须渲染一次条目列表；只靠"添加条目"按钮触发的话，列表永远是空的
    renderList();
  }
  build();
  return wrap;
}

/* ------------------------------------------------------------------ *
 * 十、标签页：语音
 * ------------------------------------------------------------------ */

/**
 * 本机"浏览器内置音色"的名字集合（name 与 voiceURI 都算）。
 * 切到云端时用它判断"当前音色是不是系统音色名"——只有这种需要清掉，
 * 手填的云端音色必须保留。
 * @returns {Set<string>}
 */
function safeVoiceNames() {
  const out = new Set();
  try {
    for (const x of speaker.listVoices('zh') || []) {
      if (x && x.name) out.add(String(x.name));
      if (x && x.id) out.add(String(x.id));
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

function buildVoiceTab(st) {
  const d = st.draft;
  const v = d.voice;
  const wrap = el('div');

  wrap.appendChild(
    field(
      '语音来源',
      selectInput(v.provider, [
        { value: 'webspeech', label: '浏览器内置（免费、离线）' },
        { value: 'cloud', label: '云端语音（在「设置 → 语音」里配置）' },
      ], (val) => {
        const next = val === 'cloud' ? 'cloud' : 'webspeech';
        // 从"内置"切到"云端"时，若音色还留着系统音色的名字，云端接口会 400 并静默降级回系统音色；
        // 清成空 = 跟随「设置 → 语音」里的全局云端音色（想单独指定就填下面那个云端音色）。
        // 反之，用户手填的云端音色（edge-tts / MiniMax / 本地克隆音色名）不会被清掉。
        if (next === 'cloud' && String(v.voiceId || '').trim() && safeVoiceNames().has(String(v.voiceId).trim())) {
          v.voiceId = '';
        }
        v.provider = next;
        syncVoiceFields();
      }),
      '浏览器内置音色随系统不同；云端音色更好听，但需要密钥与网络'
    )
  );

  /* ---- 音色下拉：getVoices() 首次常常是空数组，要等 voiceschanged ---- */
  const voiceSel = el('select');
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    const ss = safeSpeechSynthesis();
    if (ss && voiceListener) {
      try {
        ss.removeEventListener('voiceschanged', voiceListener);
      } catch {
        /* 忽略 */
      }
    }
  };

  const paintVoices = () => {
    // 标签页已切走 / 弹层已关闭：自行解除监听，避免泄漏
    if (!document.body.contains(voiceSel)) {
      detach();
      return;
    }
    const list = safeListVoices();
    const cur = String(v.voiceId || '');
    const options = [
      el('option', {
        value: '',
        text: list.length ? '默认音色（不指定）' : '（系统音色加载中…稍后会自动出现）',
      }),
    ];
    for (const item of list) {
      options.push(
        el('option', {
          value: item.id,
          text: `${item.name}${item.local ? '' : ' · 云端'}${item.lang ? `（${item.lang}）` : ''}`,
        })
      );
    }
    const found = list.some((item) => String(item.id) === cur);
    if (cur && !found) {
      options.push(el('option', { value: cur, text: `${cur}（当前系统找不到，可能已卸载）` }));
    }
    mount(voiceSel, options);
    voiceSel.value = cur;
  };

  let voiceListener = null;
  const ss = safeSpeechSynthesis();
  if (ss && typeof ss.addEventListener === 'function') {
    voiceListener = () => paintVoices();
    try {
      ss.addEventListener('voiceschanged', voiceListener);
    } catch {
      voiceListener = null;
    }
  }
  // tts.js 内部提供了 voicesReady()（等待 getVoices 异步就绪），有就用
  if (speaker && typeof speaker.voicesReady === 'function') {
    try {
      speaker.voicesReady().then(() => paintVoices()).catch(() => {});
    } catch {
      /* 忽略 */
    }
  }

  voiceSel.addEventListener('change', () => {
    v.voiceId = voiceSel.value;
  });
  paintVoices();

  const sysField = field('音色', voiceSel, '不同角色绑不同嗓音，切换会话时能立刻听出“是谁在说话”');
  wrap.appendChild(sysField);

  // 云端音色：预设只是常用项，音色名由供应商定义，可直接手填
  // （Edge TTS 的 zh-CN-XiaoxiaoNeural、MiniMax、百炼 CosyVoice、本地自建/克隆音色名…）
  const cloudVoiceBox = presetCombo(
    CLOUD_VOICE_PRESETS.map((m) => ({ value: m, label: m })),
    v.voiceId || '',
    (val) => {
      v.voiceId = val;
    },
    { placeholder: '跟随全局 / 填音色名', title: '例如 zh-CN-XiaoxiaoNeural / female-shaonv / 你的克隆音色名；留空则用「设置 → 语音」里的全局音色' }
  );
  const cloudField = field('云端音色', cloudVoiceBox, '填了就用它；留空则跟随「设置 → 语音」里的全局云端音色');
  wrap.appendChild(cloudField);

  /** 按"语音来源"显隐两个音色字段（不整页重绘，草稿对象一直有效） */
  function syncVoiceFields() {
    const isCloud = v.provider === 'cloud';
    sysField.style.display = isCloud ? 'none' : '';
    cloudField.style.display = isCloud ? '' : 'none';
  }
  syncVoiceFields();

  wrap.appendChild(
    el(
      'div',
      { class: 'row', style: { 'align-items': 'flex-start' } },
      el('div', { style: { flex: '1 1 50%' } }, field('语速', sliderRow(v.rate, (n) => {
        v.rate = n;
      }))),
      el('div', { style: { flex: '1 1 50%' } }, field('音调', sliderRow(v.pitch, (n) => {
        v.pitch = n;
      })))
    )
  );

  wrap.appendChild(
    field(
      '自动朗读',
      selectInput(v.autoplay, [
        { value: 'off', label: '关闭' },
        { value: 'short', label: '只读短句（推荐）' },
        { value: 'always', label: '每条都读' },
      ], (val) => {
        v.autoplay = ['off', 'short', 'always'].includes(val) ? val : 'short';
      }),
      '「只读短句」会跳过很长的段落，避免念稿子一样的疲劳感'
    )
  );

  const sampleText = () => {
    const first = Array.isArray(d.greeting) && d.greeting[0] ? d.greeting[0] : '';
    const raw = first || d.persona.catchphrase || `你好，我是${d.name || '你的新朋友'}。`;
    return truncate(stripMarkdown(raw).replace(/\s+/g, ' ').trim(), 60);
  };

  const testBtn = el(
    'button.btn',
    {
      type: 'button',
      class: 'btn btn-primary',
      on: {
        click: async () => {
          testBtn.disabled = true;
          try {
            const cfg = voiceFor({ voice: { ...v } }, getSettings());
            await speaker.unlock(); // 必须在用户手势里解锁自动播放
            // 云端失败原因只能从 cfg.onError 拿到（speak 永不 reject），见 shared.js 的 captureVoiceError
            const why = captureVoiceError(cfg);
            await speaker.test(sampleText(), cfg);
            if (why()) toast(`云端语音失败：${why()}`, 'error', 5200);
          } catch (err) {
            console.warn('[editor] 试听失败', err);
            toast('试听失败：当前浏览器可能不支持语音合成', 'error');
          } finally {
            testBtn.disabled = false;
          }
        },
      },
    },
    icon('speaker', 14),
    el('span', { text: '试听' })
  );

  wrap.appendChild(
    el(
      'div',
      { style: { display: 'flex', 'align-items': 'center', gap: '10px' } },
      testBtn,
      el('span', {
        text: '试听句子取自第一条开场白（没有则用口头禅）',
        style: { 'font-size': '11px', color: T.dim },
      })
    )
  );

  return wrap;
}

/** 语音合成可用性（安全访问，模块顶层不做这件事） */
function safeSpeechSynthesis() {
  try {
    return typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : null;
  } catch {
    return null;
  }
}

function safeListVoices() {
  try {
    if (speaker && typeof speaker.listVoices === 'function') return speaker.listVoices('zh') || [];
  } catch (err) {
    console.warn('[editor] 读取音色列表失败', err);
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * 十一、标签页：高级提示词
 * ------------------------------------------------------------------ */

function buildAdvancedTab(st) {
  const d = st.draft;
  const wrap = el('div');

  wrap.appendChild(
    field(
      '完整系统提示词',
      textArea(d.systemPrompt, '留空则由上面的设定自动装配', (v) => {
        d.systemPrompt = v;
      }, 6),
      '留空则由上面的设定自动装配。填了就以你写的为准（会跳过自动装配）'
    )
  );

  wrap.appendChild(
    field(
      '开场白',
      textArea(d.greeting.join('\n'), '……你来了。\n（第二条开场白，每条一行）', (v) => {
        d.greeting = String(v || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      }, 4),
      '每条一行。新建会话时会从这些开场白里挑一条'
    )
  );

  /* ---- 示例对话（few-shot） ---- */
  const exHost = el('div');
  const paintExamples = () => {
    if (!d.examples.length) {
      mount(exHost, el('div.field-hint', { text: '还没有示例对话。加 1~3 组，角色的语气会稳定很多。' }));
      return;
    }
    mount(
      exHost,
      d.examples.map((ex, i) =>
        el(
          'div.editor-list-item',
          { style: S.listItem },
          el(
            'div',
            { class: 'row', style: { 'margin-bottom': '7px' } },
            el('span.small.muted', { text: `示例 ${i + 1}`, style: { flex: '1 1 auto' } }),
            smallButton('trash', '删除这条示例', () => {
              d.examples.splice(i, 1);
              paintExamples();
            }, true)
          ),
          el(
            'div',
            { style: { display: 'flex', 'flex-direction': 'column', gap: '7px' } },
            textArea(ex.user, '我：你回来了？', (v) => {
              ex.user = v;
            }, 2),
            textArea(ex.ai, '……嗯。等你很久了。（她把书合上，指尖还夹着书签）', (v) => {
              ex.ai = v;
            }, 3)
          )
        )
      )
    );
  };
  paintExamples();
  wrap.appendChild(
    field(
      '示例对话（few-shot）',
      el(
        'div',
        exHost,
        el(
          'button.btn',
          {
            type: 'button',
            on: {
              click: () => {
                if (d.examples.length >= 12) {
                  toast('示例最多 12 组', 'warn');
                  return;
                }
                d.examples.push({ user: '', ai: '' });
                paintExamples();
              },
            },
          },
          icon('plus', 14),
          el('span', { text: '添加示例对话' })
        )
      ),
      '给模型看的“标准答案”，比形容词更能教会它怎么说话'
    )
  );

  wrap.appendChild(
    el(
      'div',
      { class: 'row', style: { 'align-items': 'flex-start' } },
      el('div', { style: { flex: '1 1 50%' } }, field('说话禁忌', textArea(d.persona.speech, '不说网络流行语；不用感叹号结尾；不主动提 AI 与模型', (v) => {
        d.persona.speech = v;
      }, 3))),
      el('div', { style: { flex: '1 1 50%' } }, field('禁区话题', textArea(d.persona.taboo, '不讨论政治；不评价用户的朋友', (v) => {
        d.persona.taboo = v;
      }, 3)))
    )
  );

  wrap.appendChild(
    field('作者备注', textArea(d.authorNote, '仅自己可见、会注入提示词的备注，比如：这条人设的张力来自“不安”而非“威胁”', (v) => {
      d.authorNote = v;
    }, 3))
  );

  return wrap;
}

/* ------------------------------------------------------------------ *
 * 十二、标签页：版本历史
 * ------------------------------------------------------------------ */

function buildHistoryTab(st) {
  const d = st.draft;
  const wrap = el('div');

  if (st.isNew || !Array.isArray(d.history) || !d.history.length) {
    wrap.appendChild(
      el('div.field-hint', { text: '还没有历史版本。每次保存都会自动留档（最多 20 条），改崩了可以回滚。' })
    );
    return wrap;
  }

  wrap.appendChild(
    el('div', {
      text: `当前版本 v${num(d.version, 1)} · 共 ${d.history.length} 条历史留档（点「对比」看改了什么，「回滚」退回当时的状态）`,
      class: 'field-hint',
      style: { 'margin-bottom': '10px' },
    })
  );

  const items = d.history
    .map((entry, index) => ({ entry, index }))
    .reverse()
    .map(({ entry, index }) => {
      const snap = entry && entry.snapshot && typeof entry.snapshot === 'object' ? entry.snapshot : {};
      const isCurrent = index === d.history.length - 1;
      return el(
        'div.editor-list-item',
        { style: S.listItem },
        el(
          'div',
          { class: 'row', style: { 'margin-bottom': '7px' } },
          el('span', {
            text: `${fmtDate(entry && entry.at)} · v${num(snap.version, index + 1)}${isCurrent ? ' · 最近一次修改前' : ''}`,
            class: 'small muted',
            style: { flex: '1 1 auto' },
          }),
          el(
            'button.btn',
            {
              type: 'button',
              class: 'btn btn-sm',
              on: { click: () => showDiff(snap, d, entry) },
            },
            el('span', { text: '对比' })
          ),
          el(
            'button.btn',
            {
              type: 'button',
              class: 'btn btn-sm',
              on: { click: () => rollbackTo(st, entry) },
            },
            el('span', { text: '回滚' })
          )
        ),
        el('div', { text: `${String(snap.name || '未命名')} · ${truncate(String(snap.tagline || snap.persona?.personality || '（无简介）'), 40)}`, style: { 'font-size': '12px', color: T.dim } })
      );
    });

  mount(wrap, items);
  return wrap;
}

/** 版本对比：扁平化字段后逐项比较 */
function flattenChar(c) {
  const src = c && typeof c === 'object' ? c : {};
  const p = src.persona && typeof src.persona === 'object' ? src.persona : {};
  const rows = [];
  const push = (label, value) => rows.push([label, value == null ? '' : String(value)]);
  push('名字', src.name);
  push('一句话简介', src.tagline);
  push('性别', src.gender);
  push('年龄', src.age);
  push('职业', src.job);
  push('分组', src.group);
  push('标签', Array.isArray(src.tags) ? src.tags.join('、') : '');
  push('主题色', src.color);
  push('初始好感度', src.affinity);
  for (const [key, label] of PERSONA_FIELDS) push(`人设 · ${label}`, p[key]);
  push('开场白', Array.isArray(src.greeting) ? src.greeting.join(' / ') : '');
  push('系统提示词', src.systemPrompt);
  push('作者备注', src.authorNote);
  push('示例对话', JSON.stringify(Array.isArray(src.examples) ? src.examples : []));
  push('语音', JSON.stringify(src.voice || null));
  return rows;
}

function diffChars(before, after) {
  const map = new Map(flattenChar(before));
  const out = [];
  for (const [label, to] of flattenChar(after)) {
    const from = map.has(label) ? map.get(label) : '';
    if (from !== to) out.push({ label, from, to });
  }
  return out;
}

function showDiff(snapshot, current, entry) {
  const diffs = diffChars(snapshot, current);
  const body = diffs.length
    ? el(
        'div',
        diffs.map((d) =>
          el(
            'div',
            { style: { 'margin-bottom': '10px' } },
            el('div', { text: d.label, style: { 'font-size': '12px', color: T.dim, 'margin-bottom': '4px' } }),
            el('div', { text: `旧：${truncate(d.from || '（空）', 90)}`, style: { 'font-size': '12px', color: T.danger, 'line-height': '1.6' } }),
            el('div', { text: `新：${truncate(d.to || '（空）', 90)}`, style: { 'font-size': '12px', color: T.ok, 'line-height': '1.6' } })
          )
        )
      )
    : el('div', { text: '和当前设定相比，没有任何字段发生变化。', style: { color: T.dim } });

  return modal({
    title: `版本对比 · ${fmtDate(entry && entry.at)}`,
    width: 560,
    body,
    actions: [],
  });
}

/** 回滚到某个历史快照（保留 history 由 store.saveCharacter 自动处理） */
async function rollbackTo(st, entry) {
  const snap = entry && entry.snapshot && typeof entry.snapshot === 'object' ? entry.snapshot : null;
  if (!snap) {
    toast('这条历史留档已损坏，无法回滚', 'error');
    return;
  }
  const ok = await confirmDialog({
    title: '回滚版本',
    message: `确定回滚到 ${fmtDate(entry.at)} 的设定吗？当前设定会作为一条新的历史留档保留下来。`,
    okText: '回滚',
  });
  if (!ok) return;
  try {
    // 保留 id，让 store 认出这是同一个角色（history 会被自动保留并追加）
    const saved = await saveCharacter({ ...snap, id: st.draft.id });
    Object.assign(st.draft, draftFrom(saved));
    toast(`已回滚到 v${num(snap.version, 1)}`, 'ok');
    if (typeof st.selectTab === 'function') st.selectTab('history');
  } catch (err) {
    console.warn('[editor] 回滚失败', err);
    toast('回滚失败，请重试', 'error');
  }
}

/* ------------------------------------------------------------------ *
 * 十三、模板库
 * ------------------------------------------------------------------ */

/**
 * 模板库：左侧分组，右侧模板卡片网格，顶部搜索。
 * 「直接创建」入库并打开会话；「预览并编辑」只把模板转成草稿，保存才落库。
 */
export function openTemplateGallery() {
  // 默认展示「全部模板」（templatesByGroup('all') 会返回全部），避免用户只看得到第一个分组
  const state = { group: 'all', kw: '' };
  /** 左侧列表 = 全部 + 各分组 */
  const groupItems = [{ id: 'all', name: '全部模板', desc: '全部内置人设，也可以直接搜' }, ...GROUPS];

  const search = el('input.input', {
    type: 'search',
    placeholder: '搜索模板（名字 / 标签 / 简介）',
    style: { 'margin-bottom': '12px' },
  });
  // 结构与类名对齐 app.css：.tpl-layout > .tpl-groups + .tpl-main > .search-bar + .tpl-grid
  const groupHost = el('div.tpl-groups');
  const gridHost = el('div.tpl-grid');

  const m = modal({
    title: '模板库',
    width: 900,
    body: el(
      'div.tpl-layout',
      groupHost,
      el('div.tpl-main', el('div.search-bar', search), gridHost)
    ),
    actions: [],
  });

  function paintGroups() {
    if (!groupItems.length) {
      mount(groupHost, el('div.field-hint', { text: '没有分组信息' }));
      return;
    }
    mount(
      groupHost,
      groupItems.map((g) => {
        const active = String(g.id) === String(state.group);
        const count = templatesOf(g.id).length;
        return el(
          'button',
          {
            type: 'button',
            class: active ? 'on' : '',
            title: g.desc || g.name,
            on: {
              click: () => {
                state.group = String(g.id);
                repaint();
              },
            },
          },
          el('span', { text: String(g.name || g.id) }),
          el('span.count', { text: String(count) })
        );
      })
    );
  }

  function visibleTemplates() {
    const kw = state.kw.toLowerCase();
    const pool = state.kw ? TEMPLATES : templatesOf(state.group);
    if (!kw) return pool;
    return pool.filter((t) => {
      if (!t) return false;
      const hay = [t.name, t.templateName, t.blurb, t.tagline, Array.isArray(t.tags) ? t.tags.join(' ') : '']
        .map((s) => String(s == null ? '' : s))
        .join(' ')
        .toLowerCase();
      return kw.split(/\s+/).filter(Boolean).every((part) => hay.includes(part));
    });
  }

  function paintGrid() {
    if (!TEMPLATES.length) {
      mount(
        gridHost,
        el(
          'div.empty',
          { style: { 'grid-column': '1 / -1' } },
          el('div.big', { text: '🎭' }),
          el('h3', { text: '内置模板库还没准备好' }),
          el('p', { text: '可以先「自己捏一个」，或者在「设置 → 数据」里导入一份角色卡。' }),
          el(
            'button.btn.btn-primary',
            {
              type: 'button',
              on: {
                click: () => {
                  m.close();
                  openCharacterEditor(null);
                },
              },
            },
            el('span', { text: '从零开始捏一个' })
          )
        )
      );
      return;
    }

    const list = visibleTemplates();
    if (!list.length) {
      mount(gridHost, el('div.field-hint', { style: { 'grid-column': '1 / -1', padding: '20px' }, text: '这个分组下没有匹配的模板，换个关键词试试。' }));
      return;
    }

    mount(
      gridHost,
      list.map((tpl) => {
        const tags = Array.isArray(tpl.tags) ? tpl.tags.slice(0, 4) : [];
        const card = el(
          'div.tpl-card',
          { dataset: { id: String(tpl.id || '') } },
          el(
            'div.t-head',
            el(
              'span.avatar.sm',
              { style: { background: alpha(tpl.color || '#6c8cff', 0.18), color: tpl.color || '#6c8cff' } },
              el('span', { text: String(tpl.emoji || '🙂') })
            ),
            el(
              'div',
              { style: { 'min-width': '0' } },
              el('div.t-name', { text: String(tpl.name || tpl.templateName || '未命名模板') }),
              el('div.t-sub', { text: [tpl.gender, tpl.age, tpl.job].filter(Boolean).join(' · ') })
            )
          ),
          el('div.t-blurb', { text: String(tpl.blurb || tpl.tagline || '') }),
          el(
            'div.t-tags',
            tags.map((tag) => el('span.tag', { text: String(tag) }))
          ),
          el(
            'div.t-acts',
            el(
              'button.btn.btn-primary.btn-sm',
              {
                type: 'button',
                on: { click: () => createFromTemplate(tpl, m) },
              },
              el('span', { text: '直接创建' })
            ),
            el(
              'button.btn.btn-sm',
              {
                type: 'button',
                on: {
                  click: () => {
                    m.close();
                    // 预览并编辑：不落库，直到用户在编辑器里点“保存”
                    openCharacterEditor(templateToChar(tpl), { isNew: true });
                  },
                },
              },
              el('span', { text: '预览并编辑' })
            )
          )
        );
        return card;
      })
    );
  }

  /** 重绘左右两栏（任何一个模板数据异常都不该把弹层整个弄崩） */
  function repaint() {
    try {
      paintGroups();
      paintGrid();
    } catch (err) {
      console.error('[editor] 模板库渲染失败', err);
      mount(gridHost, el('div.field-hint', { text: '模板数据有异常，未能渲染；可以试试「自己捏一个」。' }));
    }
  }

  const run = debounce(() => {
    state.kw = String(search.value || '').trim();
    repaint();
  }, 200);
  search.addEventListener('input', run);

  repaint();
  return m;
}

/** 模板 → 直接创建（落库 + 打开会话） */
async function createFromTemplate(tpl, modalHandle) {
  try {
    const saved = await saveCharacter(templateToChar(tpl));
    toast(`已创建「${saved.name}」`, 'ok');
    if (modalHandle && typeof modalHandle.close === 'function') modalHandle.close();
    bus.emit('app:open-chat', saved.id);
  } catch (err) {
    console.warn('[editor] 从模板创建失败', err);
    toast(`创建失败：${(err && err.message) || '未知错误'}`, 'error');
  }
}

/** #rgb / #rrggbb → 低透明度 rgba（头像底色、色块选中环） */
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
