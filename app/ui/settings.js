/**
 * ui/settings.js —— 设置面板（契约 3.14）
 * ---------------------------------------------------------------------------
 * 导出：export function openSettings(section)  // section: model|voice|context|data|about
 *
 * 设计要点：
 *   1. 用 ui/toast.js 的 modal() 打开，宽度 820，内部「左 .set-nav / 右 .set-content」布局，
 *      全部样式类复用 styles/base.css 与 styles/app.css 里已有的定义（不新造一套样式）。
 *   2. 所有设置项即时写入 core/store.js 的 setSettings()（200ms 防抖合并），
 *      关闭弹层时强制 flush 并广播 settings:changed。
 *   3. 主题与强调色改完立即生效（写 documentElement 的 data-theme 与 --accent/--accent-soft）。
 *   4. 绝不把用户输入拼进 innerHTML —— 一律走 el() 的 text / textContent。
 *   5. 直连密钥保存在浏览器，并随设置同步至本机数据目录；请求时发送给所选供应商。
 *      代理模式从服务器环境变量读取密钥。
 * ---------------------------------------------------------------------------
 */

import { el, clear, mount } from './dom.js';
import { icon } from './icons.js';
import { modal, toast, confirmDialog, promptDialog } from './toast.js';
import { bus } from '../core/bus.js';
import { debounce, num, clamp, truncate, fmtDate, relTime, copyText, createId, dayKey, readFileAsDataURL } from '../core/util.js';
import { avatarNode, isImageAvatar, presetCombo, captureVoiceError } from './shared.js';
import {
  getSettings,
  setSettings,
  listCharacters,
  getCharacter,
  listMessages,
  getMemory,
  getMemorySource,
  correctMemoryFact,
  retractMemoryFact,
  getRecentExperiences,
  saveMemory,
  dbStats,
  wipeAll,
} from '../core/store.js';
import { chat, listModels, getUsage, clearUsage, llmErrors } from '../core/llm.js';
import { buildMessages, rebuildMemory } from '../core/prompt.js';
import { getRuntime } from '../core/runtime.js';
import { PROVIDERS_META, CHAT_MODELS, DEFAULT_PRESETS, PARAM_HINTS, getProvider, THINKING_CHOICES, thinkingChoiceOf, thinkingParamOf } from '../data/models.js';
import { speaker, voiceAvailable, clearVoiceCache, CLOUD_VOICE_PRESETS, CLOUD_TTS_MODELS } from '../voice/tts.js';
import { fileStatus, syncOnBoot, snapshotNow } from '../core/filestore.js';
import { clearAllGames } from '../core/werewolf.js';

/* ===========================================================================
 * 常量
 * ======================================================================== */

/** 密钥掩码（显示用，绝不代表真实值） */
const PASSWORD = '•'.repeat(8);

/** 版本号（关于页展示） */
const APP_VERSION = 'v1.0.0';

/** 左侧导航分区 */
const SECTIONS = [
  { id: 'model', label: '模型', icon: 'sparkles' },
  { id: 'voice', label: '语音', icon: 'speaker' },
  { id: 'context', label: '记忆与上下文', icon: 'brain' },
  { id: 'group', label: '群聊', icon: 'users' },
  { id: 'profile', label: '我的资料', icon: 'user' },
  { id: 'data', label: '数据', icon: 'chart' },
  { id: 'about', label: '关于', icon: 'shield' },
];

/** 文件存储状态 → 中文文案 */
function storeStatusText(st) {
  if (!st) return '未知';
  if (st.status === 'off' || !st.available) return '未启用（请用 node server.mjs 启动，数据才会写入电脑文件）';
  if (st.status === 'syncing') return '正在读写本地文件…';
  if (st.status === 'error') return '写入失败';
  if (st.status === 'ok' && st.pending > 0) return `正在保存（${st.pending} 项待写入）`;
  return st.lastSync ? `正常（最近写入 ${relTime(st.lastSync)}）` : '正常';
}

/** 参数滑块的展示顺序（对应 PARAM_HINTS） */
const PARAM_ORDER = ['temperature', 'topP', 'maxTokens', 'presencePenalty', 'frequencyPenalty'];

/** 强调色预设 */
const ACCENT_PRESETS = ['#6c8cff', '#4ec9a8', '#e0b341', '#ff6b6b', '#c084fc', '#38bdf8', '#fb923c', '#f472b6'];


/** 「获取模型列表」的结果缓存：provider → 模型名数组（不持久化） */
const fetchedModels = {};

/* ===========================================================================
 * 主题（app.js 也复用这里的 applyTheme，保证只有一份实现）
 * ======================================================================== */

/**
 * 把 #rrggbb 转成带 16 进制透明度的颜色（用于派生 --accent-soft）。
 * @param {string} hex 形如 #6c8cff
 * @param {string} [alphaHex='29'] 透明度（29 ≈ 16%）
 * @returns {string} 形如 #6c8cff29；无法识别时回退 rgba()
 */
function softFromAccent(hex, alphaHex = '29') {
  const s = String(hex || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return `${s}${alphaHex}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1];
    const g = s[2];
    const b = s[3];
    return `#${r}${r}${g}${g}${b}${b}${alphaHex}`;
  }
  return 'rgba(108, 140, 255, 0.16)';
}

/**
 * 立即应用主题与强调色（改完立刻生效，不需要刷新）。
 * @param {'dark'|'light'|'auto'} theme 主题模式
 * @param {string} accent 强调色（#rrggbb）
 * @returns {'dark'|'light'} 实际生效的主题
 */
export function applyTheme(theme, accent) {
  const root = document.documentElement;
  let resolved = theme === 'light' ? 'light' : 'dark';
  if (theme === 'auto') {
    try {
      resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
      resolved = 'dark';
    }
  }
  root.dataset.theme = resolved;
  root.dataset.themeMode = theme || 'dark';
  const a = String(accent || '#6c8cff');
  root.style.setProperty('--accent', a);
  root.style.setProperty('--accent-soft', softFromAccent(a));
  // 同步浏览器地址栏 / 状态栏颜色，让 PWA 更整体
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f4f6fa' : '#0f1115');
  return resolved;
}

// 「跟随系统」时，系统主题一变就跟着换
try {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onSystemTheme = () => {
    const s = getSettings();
    if (s.theme === 'auto') applyTheme('auto', s.accent);
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSystemTheme);
  else if (typeof mq.addListener === 'function') mq.addListener(onSystemTheme);
} catch {
  /* 忽略：极旧环境没有 matchMedia */
}

/* ===========================================================================
 * 设置写入：200ms 防抖合并
 * ======================================================================== */

/** @type {object} 待写入的增量补丁 */
let pendingPatch = {};
/** 是否有待写入内容 */
let patchDirty = false;

/** 深合并补丁（对象递归合并，数组与标量直接替换） */
function mergePatch(base, patch) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = mergePatch(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 真正落盘（只有存在待写内容时才写） */
function flushPatch() {
  if (!patchDirty) return;
  const p = pendingPatch;
  pendingPatch = {};
  patchDirty = false;
  try {
    setSettings(p); // setSettings 内部已 emit('settings:changed')
  } catch (err) {
    toast(`设置保存失败：${(err && err.message) || err}`, 'error');
  }
}

const flushPatchSoon = debounce(flushPatch, 200);

/**
 * 写入设置（防抖 200ms）。
 * @param {object} p 增量补丁
 */
function patch(p) {
  pendingPatch = mergePatch(pendingPatch, p);
  patchDirty = true;
  // 关键：必须**同步**写一次 settingsCache。
  // 之前这里只记 pendingPatch 就返回，而各个 handler 紧接着会调 renderXxx() 重渲染，
  // 重渲染读的是 getSettings()（进程内缓存）——于是界面显示的还是旧值（下拉弹回原选项、
  // 云端音色的附加字段不出现、强调色选中环不动），而 200ms 后底层却保存了新值。
  // 现在改成"同步更新缓存 + 防抖只用于合并广播与落盘"，界面与真实配置始终一致。
  try {
    setSettings(p);
    pendingPatch = {};
    patchDirty = false;
  } catch (err) {
    // 同步写失败就退回原来的防抖路径，至少不丢改动
    flushPatchSoon();
  }
}

/* ===========================================================================
 * 小工具 / 通用控件
 * ======================================================================== */

/**
 * 标准表单行
 * @param {string} label 标签
 * @param {Node} control 控件
 * @param {string} [hint] 说明文字
 * @returns {HTMLElement}
 */
function field(label, control, hint) {
  return el(
    'div.field',
    label ? el('label.field-label', { text: label }) : null,
    control,
    hint ? el('div.field-hint', { text: hint }) : null
  );
}

/**
 * 开关行（整行可点，点哪都能切换）
 * @param {string} label 标题
 * @param {boolean} checked 当前值
 * @param {(v:boolean)=>void} onChange 变化回调
 * @param {string} [hint] 说明
 * @returns {HTMLElement}
 */
function toggleRow(label, checked, onChange, hint) {
  const cb = el('input', {
    type: 'checkbox',
    checked: !!checked,
    on: { change: (e) => onChange(e.target.checked) },
  });
  return el(
    'div.field',
    el('label.row-between', { style: { cursor: 'pointer', gap: '14px' } }, el('span', { text: label }), cb),
    hint ? el('div.field-hint', { text: hint }) : null
  );
}

/**
 * 下拉选择
 * @param {Array<{value:string,label:string,disabled?:boolean}>} options 选项
 * @param {string} value 当前值
 * @param {(v:string)=>void} onChange 回调
 * @returns {HTMLSelectElement}
 */
/**
 * 当前设备上"浏览器内置音色"的名字/URI 集合。
 * 用途：切到云端合成时判断"现有 voiceId 是不是系统音色名"——只有这种才需要换掉，
 * 用户手填的云端音色（edge-tts / MiniMax / 克隆音色）必须原样保留。
 * @returns {string[]} 系统音色的 name 与 voiceURI
 */
function safeSystemVoiceNames() {
  try {
    const list = speaker.listVoices('zh') || [];
    const out = [];
    for (const x of list) {
      if (x && x.name) out.push(String(x.name));
      if (x && x.id) out.push(String(x.id));
    }
    return out;
  } catch (e) {
    return [];
  }
}

function selectBox(options, value, onChange) {
  const sel = el('select', { on: { change: (e) => onChange(e.target.value) } });
  for (const o of options) {
    sel.appendChild(el('option', { value: o.value, text: o.label, disabled: !!o.disabled }));
  }
  // 允许「当前值不在列表里」的情况（例如手填的自定义模型名）
  if (value != null && value !== '' && !options.some((o) => o.value === value)) {
    sel.appendChild(el('option', { value: String(value), text: `（自定义）${value}` }));
  }
  sel.value = value == null ? '' : String(value);
  return sel;
}

/**
 * 统计卡片（.stat-grid / .stat）
 * @param {string|number} n 数字
 * @param {string} l 说明
 */
function statCard(n, l) {
  return el('div.stat', el('div.n', { text: String(n) }), el('div.l', { text: l }));
}

/**
 * 条形图项（.bar-item）
 * @param {string} label 左侧文字
 * @param {string} valueText 右侧文字
 * @param {number} ratio 0~1
 * @param {string} [color] 自定义填充色
 */
function barItem(label, valueText, ratio, color) {
  const fill = el('i');
  fill.style.width = `${clamp(ratio * 100, 0, 100).toFixed(1)}%`;
  if (color) fill.style.background = color;
  return el(
    'div.bar-item',
    el('div.bl', el('span', { text: label }), el('span', { text: valueText })),
    el('div.bt', fill)
  );
}

/**
 * 分区外壳：标题 + 说明 + 内容
 * @param {string} title
 * @param {string} desc
 * @param {...any} children
 */
function section(title, desc, ...children) {
  return el('div', el('h3', { text: title }), el('p.desc', { text: desc }), ...children);
}

/** 本地日期键 YYYY-MM-DD */
/** 取上次打开的角色 id（app.js 会写 localStorage 的 aichat.lastChar） */
function currentCharId() {
  try {
    return localStorage.getItem('aichat.lastChar') || '';
  } catch {
    return '';
  }
}

/** 取上次打开的角色对象 */
async function currentChar() {
  const id = currentCharId();
  if (!id) return null;
  try {
    return await getCharacter(id);
  } catch {
    return null;
  }
}

/* ===========================================================================
 * 分区一：模型
 * ======================================================================== */

/**
 * 查询后端代理状态（设置面板打开代理开关时调用）。
 * @returns {Promise<object|null>} 成功返回 /api/health 的 JSON，失败返回 null
 */
async function checkHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data && data.providers) ? data.providers : [];
    if (list.length) {
      const names = list.map((id) => (PROVIDERS_META[id] ? PROVIDERS_META[id].label : id)).join('、');
      toast(`后端代理已就绪，服务器已配置密钥：${names}`, 'ok', 5200);
    } else {
      toast('后端代理已启动，但服务器还没有配置任何密钥，请在 app/.env 里填写', 'warn', 5600);
    }
    return data;
  } catch {
    toast('未检测到后端代理，请运行 node server.mjs', 'warn', 5600);
    return null;
  }
}

/** 模型分区 */
function renderModel(content) {
  const s = getSettings();
  const pid = PROVIDERS_META[s.provider] ? s.provider : 'deepseek';
  const meta = getProvider(pid);
  const keyVal = (s.apiKeys && s.apiKeys[pid]) || '';
  const baseVal = (s.baseUrls && s.baseUrls[pid]) || '';

  clear(content);

  /* ---------- 供应商 ---------- */
  const providerOptions = Object.values(PROVIDERS_META).map((m) => ({
    value: m.id,
    label: `${m.label} · ${m.kind}`,
  }));
  const providerSel = selectBox(providerOptions, pid, (v) => {
    const models = modelOptionsFor(v);
    patch({ provider: v, model: models[0] || '' });
    renderModel(content);
  });

  /* ---------- 模型 ---------- */
  const modelOptions = modelOptionsFor(pid).map((m) => ({ value: m, label: m }));
  const modelSel = selectBox(modelOptions, s.model, (v) => {
    patch({ model: v });
    modelInput.value = v;
  });
  const modelInput = el('input', {
    value: s.model || '',
    placeholder: '也可以直接手填模型名，例如 deepseek-flash',
    on: {
      change: (e) => {
        const v = String(e.target.value || '').trim();
        if (!v) return;
        patch({ model: v });
        if (!modelOptions.some((o) => o.value === v)) {
          modelSel.appendChild(el('option', { value: v, text: `（自定义）${v}` }));
        }
        modelSel.value = v;
      },
    },
  });

  /* ---------- 接口地址 ---------- */
  const baseInput = el('input', {
    value: baseVal,
    placeholder: meta.baseUrl || 'https://你的反代地址/v1',
    on: {
      change: (e) => {
        const v = String(e.target.value || '').trim();
        patch({ baseUrls: { [pid]: v } });
      },
    },
  });

  /* ---------- 获取模型列表 ---------- */
  const fetchBtn = el(
    'button.btn',
    {
      on: {
        click: async () => {
          const cur = getSettings();
          fetchBtn.disabled = true;
          fetchBtn.textContent = '获取中…';
          try {
            // 先 flush 再取设置：否则刚粘进 Key/改完接口地址就点这个按钮，用的是渲染那一刻的旧值
            flushPatch();
            const fresh = getSettings();
            const list = await listModels(
              pid,
              fresh.useProxy ? '' : (fresh.apiKeys && fresh.apiKeys[pid]) || '',
              (fresh.baseUrls && fresh.baseUrls[pid]) || '',
              { useProxy: !!fresh.useProxy, proxyToken: fresh.proxyToken || '', keySlot: fresh.proxyKeySlot || 'default' }
            );
            if (list && list.length) {
              fetchedModels[pid] = list;
              toast(`获取到 ${list.length} 个模型`, 'ok');
              renderModel(content);
            } else {
              toast('获取模型列表失败：请检查接口地址与 API Key（部分供应商不提供该接口）', 'warn', 5200);
            }
          } catch (err) {
            toast(`获取模型列表失败：${(err && err.message) || err}`, 'error');
          } finally {
            fetchBtn.disabled = false;
            fetchBtn.textContent = '获取模型列表';
          }
        },
      },
    },
    icon('refresh', 15),
    el('span', { text: '获取模型列表' })
  );

  /* ---------- API Key ---------- */
  let revealed = false;
  let realKey = keyVal;
  const keyInput = el('input.mono', {
    type: 'password',
    value: realKey ? PASSWORD : '',
    placeholder: meta.needKey === false ? '（该模型通常无需密钥）' : '粘贴该供应商的原始 API Key',
    disabled: s.useProxy,
    on: {
      focus: () => {
        if (!revealed && keyInput.value === PASSWORD) keyInput.value = '';
      },
      blur: () => {
        if (!revealed) keyInput.value = realKey ? PASSWORD : '';
      },
      input: () => {
        revealed = true;
        realKey = String(keyInput.value || '').trim();
        patch({ apiKeys: { [pid]: realKey } });
      },
    },
  });
  const eyeBtn = el(
    'button.btn',
    {
      type: 'button',
      title: '显示 / 隐藏',
      disabled: s.useProxy,
      on: {
        click: () => {
          revealed = !revealed;
          keyInput.type = revealed ? 'text' : 'password';
          keyInput.value = realKey ? (revealed ? realKey : PASSWORD) : '';
          eyeBtn.textContent = revealed ? '隐藏' : '显示';
        },
      },
    },
    el('span', { text: '显示' })
  );

  /* ---------- 服务器代理 ---------- */
  const proxyRow = toggleRow(
    '使用服务器代理（useProxy）',
    !!s.useProxy,
    (on) => {
      patch({ useProxy: on });
      renderModel(content);
      if (on) void checkHealth();
    },
    '打开后请求发往本机 /api/llm，由 server.mjs 从环境变量或 app/.env 注入密钥；之前填写的直连密钥仍保留，但不用于代理请求。'
  );

  // 代理口令（对应 server.mjs 的 AICHAT_PROXY_TOKEN；留空表示服务器未开启校验）
  const proxyTokenRow = field(
    '代理口令（可选）',
    el('input.input', {
      type: 'password',
      value: s.proxyToken || '',
      placeholder: '服务器 .env 里的 AICHAT_PROXY_TOKEN，留空表示不需要',
      on: {
        input: (e) => patch({ proxyToken: String(e.target.value || '').trim() }),
      },
    }),
    '局域网用 ?token= 登录后会自动记住口令；也可在这里填写作为备用。仅本机访问无需填写。'
  );

  /* ---------- 参数 ---------- */
  const paramNodes = PARAM_ORDER.filter((k) => PARAM_HINTS[k]).map((k) => renderParam(k, s));

  /* ---------- 预设 ---------- */
  const presetBlock = renderPresets(content, s);

  /* ---------- 测试连接 ---------- */
  const testBtn = el(
    'button.btn.btn-primary',
    {
      on: {
        click: async () => {
          flushPatch(); // 先把当前编辑内容落盘，保证测的是最新配置
          const cur = getSettings();
          testBtn.disabled = true;
          testBtn.textContent = '测试中…';
          const t0 = Date.now();
          try {
            const res = await chat({
              provider: cur.provider,
              model: cur.model,
              apiKey: cur.useProxy ? '' : (cur.apiKeys && cur.apiKeys[cur.provider]) || '',
              baseUrl: (cur.baseUrls && cur.baseUrls[cur.provider]) || '',
              useProxy: cur.useProxy,
              messages: [{ role: 'user', content: '说"连接正常"四个字' }],
              params: { maxTokens: 20, temperature: 0 },
              stream: false,
            });
            const ms = Date.now() - t0;
            const text = truncate(String((res && res.text) || '').trim() || '（模型返回了空内容）', 40);
            toast(`连接成功（${ms}ms）：${text}`, 'ok', 4600);
          } catch (err) {
            toast(llmErrors.humanize(err), 'error', 5600);
          } finally {
            testBtn.disabled = false;
            testBtn.textContent = '测试连接';
          }
        },
      },
    },
    icon('send', 15),
    el('span', { text: '测试连接' })
  );

  content.appendChild(
    section(
      '模型接入',
      s.useProxy
        ? '当前模式：服务器代理 —— 使用服务器配置的密钥。'
        : '当前模式：浏览器直连 —— 使用本机保存的密钥，请求时发送给所选供应商。',
      field('供应商', providerSel, `${meta.note || ''}${meta.needKey === false ? '（无需密钥）' : ''}`),
      field(
        '模型',
        el('div', { style: { display: 'grid', gap: '8px' } }, modelSel, modelInput),
        '下拉里是常用模型；供应商更新较快时，直接手填模型名即可。'
      ),
      field('接口地址（baseUrl）', baseInput, `留空则使用默认：${meta.baseUrl || '（自定义供应商必须填写）'}`),
      field('', el('div.row', fetchBtn), null),
      field('API Key', el('div.key-row', keyInput, eyeBtn), `粘贴原始密钥，不要添加 Bearer、引号或换行；不限前缀和长度。直连密钥保存在浏览器并同步到本机数据目录，请求时仅发送至当前配置的接口。代理模式请在 .env 配置对应供应商的密钥。${meta.keyUrl ? `申请地址：${meta.keyUrl}` : ''}`),
      proxyRow,
      proxyTokenRow,
      el('div.divider'),
      el('h3', { text: '生成参数' }),
      el('p.desc', { text: '这些参数决定角色说话的风格；改动即时生效，并作用于所有角色（狼人杀对局除外）。' }),
      ...paramNodes,
      renderThinkingRow(meta, s),
      el('div.divider'),
      el('h3', { text: '参数预设' }),
      el('p.desc', { text: '把一整套参数存下来，之后一键切换（例如「短回复」「长文叙事」）。' }),
      presetBlock,
      el('div.divider'),
      el('div.row', testBtn)
    )
  );
}

/** 组合某个供应商的可选模型：内置 + 已拉取 */
function modelOptionsFor(pid) {
  const builtin = Array.isArray(CHAT_MODELS[pid]) ? CHAT_MODELS[pid].slice() : [];
  const extra = Array.isArray(fetchedModels[pid]) ? fetchedModels[pid] : [];
  return Array.from(new Set([...builtin, ...extra]));
}

/**
 * 生成单个参数控件（滑块 + 实时数值）
 * @param {string} key 参数名
 * @param {object} s 设置
 */
function renderParam(key, s) {
  const hint = PARAM_HINTS[key];
  const cur = num(s.params && s.params[key], 0);
  const valueText = el('span.tiny.mono', { text: String(cur) });
  const range = el('input', {
    type: 'range',
    min: String(hint.min),
    max: String(hint.max),
    step: String(hint.step),
    value: String(cur),
    on: {
      input: (e) => {
        const v = num(e.target.value, cur);
        valueText.textContent = String(v);
        patch({ params: { [key]: v } });
      },
    },
  });

  let extra = null;
  if (key === 'maxTokens') {
    // 长度类参数额外给一个数字输入，方便精确填值
    const nInput = el('input', {
      type: 'number',
      min: String(hint.min),
      max: String(hint.max),
      step: String(hint.step),
      value: String(cur),
      style: { width: '104px' },
      on: {
        change: (e) => {
          const v = clamp(num(e.target.value, cur), hint.min, hint.max);
          e.target.value = String(v);
          range.value = String(v);
          valueText.textContent = String(v);
          patch({ params: { [key]: v } });
        },
      },
    });
    range.addEventListener('input', () => {
      nInput.value = range.value;
    });
    extra = nInput;
  }

  return el(
    'div.field',
    el('label.field-label.row-between', el('span', { text: hint.label }), valueText),
    el('div.row', range, extra),
    el('div.field-hint', { text: hint.desc })
  );
}

/**
 * 「思考模式」三态选择（契约 3.10 的 THINKING_CHOICES，见 ARCHITECTURE 5.19）。
 *
 * 与上面几个滑块的区别：这不是数值参数，而是 DeepSeek 的**请求级开关**，
 * 且"不干预"本身是一个有意义的选项（模型默认是思考开，见 5.17），所以用三态下拉而不是勾选框。
 * 三态 ↔ `params.thinking` 的换算只走 data/models.js 的 thinkingChoiceOf / thinkingParamOf。
 * @param {{ id: string, label: string }} meta 当前供应商元数据（用于提示"这个开关对谁生效"）
 * @param {object} s 设置
 */
function renderThinkingRow(meta, s) {
  const cur = thinkingChoiceOf(s.params);
  const note = el('div.field-hint');
  /** 选中的那一态 + 生效范围提示（供应商不是 DeepSeek 时要点明"不下发"） */
  const paint = (choice) => {
    const item = THINKING_CHOICES.find((x) => x.value === choice) || THINKING_CHOICES[0];
    const scope =
      meta.id === 'deepseek'
        ? ''
        : `当前供应商是「${meta.label}」，非 DeepSeek 官方接口不会收到这个字段（防止兼容站因未知字段报错），所以它只对切回 DeepSeek 时生效。`;
    note.textContent = `${item.desc}${scope}狼人杀对局自带关闭思考，不受这里影响。`;
  };
  const sel = selectBox(
    THINKING_CHOICES.map((x) => ({ value: x.value, label: x.label })),
    cur,
    (v) => {
      patch({ params: { thinking: thinkingParamOf(v) } });
      paint(v);
    }
  );
  paint(cur);
  return el(
    'div.field',
    el('label.field-label', { text: '思考模式（DeepSeek）' }),
    sel,
    note
  );
}

/** 参数预设块 */
function renderPresets(content, s) {
  const builtin = DEFAULT_PRESETS.map((p) => ({ ...p, custom: false }));
  const custom = (Array.isArray(s.presets) ? s.presets : []).map((p) => ({ ...p, custom: true }));
  const all = [...builtin, ...custom];

  const options = all.map((p) => ({ value: p.id, label: `${p.name}${p.custom ? '（我的）' : ''}` }));
  const sel = selectBox(options, all[0] ? all[0].id : '', () => {});

  const applyBtn = el(
    'button.btn',
    {
      on: {
        click: () => {
          const p = all.find((x) => x.id === sel.value);
          if (!p) return;
          patch({ params: { ...p.params } });
          flushPatch();
          toast(`已应用预设「${p.name}」`, 'ok');
          renderModel(content);
        },
      },
    },
    el('span', { text: '应用预设' })
  );

  const saveBtn = el(
    'button.btn',
    {
      on: {
        click: async () => {
          const name = await promptDialog({
            title: '另存为预设',
            label: '预设名称',
            value: `我的预设 ${(s.presets || []).length + 1}`,
            placeholder: '例如：深夜慢聊',
          });
          if (!name) return;
          const next = [...(getSettings().presets || []), { id: createId('p'), name, params: { ...getSettings().params } }];
          flushPatch();
          setSettings({ presets: next });
          toast(`预设「${name}」已保存`, 'ok');
          renderModel(content);
        },
      },
    },
    el('span', { text: '另存为预设' })
  );

  const delBtn = el(
    'button.btn.btn-danger',
    {
      on: {
        click: async () => {
          const p = all.find((x) => x.id === sel.value);
          if (!p) return;
          if (!p.custom) {
            toast('内置预设不能删除', 'warn');
            return;
          }
          const ok = await confirmDialog({
            title: '删除预设',
            message: `确定删除预设「${p.name}」吗？`,
            okText: '删除',
            danger: true,
          });
          if (!ok) return;
          setSettings({ presets: (getSettings().presets || []).filter((x) => x.id !== p.id) });
          toast('预设已删除', 'ok');
          renderModel(content);
        },
      },
    },
    el('span', { text: '删除预设' })
  );

  return el('div', el('div.field', el('label.field-label', { text: '选择预设' }), sel), el('div.row.wrap', applyBtn, saveBtn, delBtn));
}

/* ===========================================================================
 * 分区二：语音
 * ======================================================================== */

/** 语音分区 */
function renderVoice(content) {
  const s = getSettings();
  const v = s.voice || {};
  const avail = voiceAvailable();
  clear(content);

  /* ---------- 手势解锁 ---------- */
  const unlockBtn = el(
    'button.btn.btn-block',
    {
      on: {
        click: async () => {
          try {
            await speaker.unlock();
            toast('语音已开启，现在可以播放声音了', 'ok');
          } catch {
            toast('当前环境无法播放声音，请检查系统音量或浏览器权限', 'warn');
          }
        },
      },
    },
    el('span', { text: '🔊 点击开启语音（需要一次用户手势才能播放声音）' })
  );

  /* ---------- 总开关 / 引擎 ---------- */
  const engineSel = selectBox(
    [
      { value: 'webspeech', label: '浏览器内置（webspeech，免费离线）' },
      { value: 'cloud', label: '云端合成（cloud，更自然但按量计费）' },
    ],
    v.provider || 'webspeech',
    (val) => {
      const cur = getSettings();
      const patchVoice = { provider: val };
      // 切到云端时，只有"当前音色其实是浏览器内置音色"才需要换掉：
      // 那种名字云端接口会直接 400 并静默降级回系统音色（界面显示着云端音色其实没用上）。
      // 反过来，**用户手填的云端音色（edge-tts / MiniMax / 本地克隆音色名）必须保留**，
      // 不能因为"不在预设列表里"就被清掉。
      if (val === 'cloud') {
        const curId = String((cur.voice || {}).voiceId || '').trim();
        const systemNames = new Set(safeSystemVoiceNames());
        if (curId && systemNames.has(curId)) patchVoice.voiceId = CLOUD_VOICE_PRESETS[0];
      }
      patch({ voice: patchVoice });
      renderVoice(content);
    }
  );

  /* ---------- 音色 ---------- */
  const voiceSel = el('select', {
    on: {
      change: (e) => {
        patch({ voice: { voiceId: String(e.target.value || '') } });
      },
    },
  });
  const voiceHint = el('div.field-hint');

  /** 填充音色下拉；返回是否已有可用音色 */
  const fillVoices = (voices) => {
    const list = Array.isArray(voices) ? voices : speaker.listVoices('zh');
    clear(voiceSel);
    voiceSel.appendChild(el('option', { value: '', text: '（跟随系统默认）' }));
    for (const vo of list) {
      voiceSel.appendChild(
        el('option', {
          value: vo.id,
          text: `${vo.name}${vo.lang ? ` · ${vo.lang}` : ''}${vo.local ? '' : '（在线）'}`,
        })
      );
    }
    const cur = String((getSettings().voice || {}).voiceId || '');
    if (cur && !list.some((x) => x.id === cur)) {
      voiceSel.appendChild(el('option', { value: cur, text: `（已保存）${cur}` }));
    }
    voiceSel.value = cur;
    if (!list.length) {
      voiceHint.textContent =
        '当前设备没有可用的中文音色，且浏览器内置语音在部分系统上音色较少；可改用云端合成，或先在系统里安装中文语音包。';
    } else {
      voiceHint.textContent = `共 ${list.length} 个可用音色（webspeech 由系统提供，音色数量取决于操作系统）。`;
    }
    return list.length > 0;
  };

  const initialVoices = v.provider === 'cloud' ? [] : speaker.listVoices('zh');
  if (v.provider !== 'cloud') fillVoices(initialVoices);

  /* ---------- 云端配置 ---------- */
  const cloudNodes = [];
  if (v.provider === 'cloud') {
    const openaiLike = Object.values(PROVIDERS_META)
      .filter((m) => m.kind === 'openai')
      .map((m) => ({ value: m.id, label: `${m.label} · ${m.kind}` }));
    const ttsProvider = v.ttsProvider || s.provider;
    const cloudProviderSel = selectBox(openaiLike, ttsProvider, (val) => {
      patch({ voice: { ttsProvider: val } });
      renderVoice(content);
    });
    // 「预设 + 可手填」：模型名与音色名完全由供应商定义，写死的下拉会把用户挡在门外
    // （edge-tts 的 zh-CN-XiaoxiaoNeural、MiniMax 的 speech-02-hd、本地克隆音色名…）
    const cloudModelBox = presetCombo(
      CLOUD_TTS_MODELS.map((m) => ({ value: m, label: m })),
      v.ttsModel || 'gpt-4o-mini-tts',
      (val) => patch({ voice: { ttsModel: val } }),
      { placeholder: '自定义模型名', title: '例如 speech-02-hd / cosyvoice-v1 / tts-1' }
    );
    const cloudVoiceBox = presetCombo(
      CLOUD_VOICE_PRESETS.map((m) => ({ value: m, label: m })),
      v.voiceId || 'alloy',
      (val) => patch({ voice: { voiceId: val } }),
      { placeholder: '自定义音色名', title: '例如 zh-CN-XiaoxiaoNeural / female-shaonv / 你的克隆音色名' }
    );
    const hasKey = !!(s.apiKeys && s.apiKeys[ttsProvider]);
    cloudNodes.push(
      field('云端供应商', cloudProviderSel, '这里复用「模型」分区里对应供应商的 API Key 与接口地址，不单独保存密钥。'),
      field('云端模型', cloudModelBox, 'OpenAI 兼容的 /audio/speech 接口；不同供应商支持的模型名不同，可直接手填。'),
      field('云端音色', cloudVoiceBox, '预设只是常用项：Edge TTS（zh-CN-XiaoxiaoNeural）、MiniMax、百炼 CosyVoice、本地自建/克隆音色都可以直接填名字。'),
      el('div.field-hint', {
        text: hasKey
          ? `已检测到「${getProvider(ttsProvider).label}」的密钥，可直接试听。`
          : `还没有为「${getProvider(ttsProvider).label}」配置密钥：请到「模型」分区把供应商切换为它并填入 API Key（或开启服务器代理并在 .env 里配置）。`,
      })
    );
  } else {
    cloudNodes.push(field('音色', voiceSel, ''));
    cloudNodes.push(voiceHint);
  }

  /* ---------- 语速 / 音调 ---------- */
  const rateText = el('span.tiny.mono', { text: String(num(v.rate, 1)) });
  const rateRange = el('input', {
    type: 'range',
    min: '0.5',
    max: '2',
    step: '0.05',
    value: String(num(v.rate, 1)),
    on: {
      input: (e) => {
        rateText.textContent = String(num(e.target.value, 1));
        patch({ voice: { rate: num(e.target.value, 1) } });
      },
    },
  });
  const pitchText = el('span.tiny.mono', { text: String(num(v.pitch, 1)) });
  const pitchRange = el('input', {
    type: 'range',
    min: '0.5',
    max: '2',
    step: '0.05',
    value: String(num(v.pitch, 1)),
    on: {
      input: (e) => {
        pitchText.textContent = String(num(e.target.value, 1));
        patch({ voice: { pitch: num(e.target.value, 1) } });
      },
    },
  });

  const testBtn = el(
    'button.btn',
    {
      on: {
        click: async () => {
          flushPatch();
          const cur = getSettings();
          const cfg = {
            provider: (cur.voice && cur.voice.provider) === 'cloud' ? 'cloud' : 'webspeech',
            voiceId: (cur.voice && cur.voice.voiceId) || '',
            rate: num(cur.voice && cur.voice.rate, 1),
            pitch: num(cur.voice && cur.voice.pitch, 1),
            autoplay: 'off',
            cache: (cur.voice && cur.voice.cache) !== false,
          };
          try {
            await speaker.unlock();
            // 云端失败原因只能从 cfg.onError 拿到（speak 永不 reject），见 shared.js 的 captureVoiceError
            const why = captureVoiceError(cfg);
            await speaker.test('你好，我是你的 AI 好友，很高兴见到你。', cfg);
            if (why()) toast(`云端语音失败：${why()}`, 'error', 5200);
          } catch {
            toast('试听失败：当前设备可能无法播放声音', 'warn');
          }
        },
      },
    },
    icon('speaker', 15),
    el('span', { text: '试听' })
  );

  /* ---------- 自动朗读策略 ---------- */
  const autoplaySel = selectBox(
    [
      { value: 'off', label: '关闭（完全手动）' },
      { value: 'short', label: '只朗读短回复' },
      { value: 'always', label: '每条回复都朗读' },
    ],
    v.autoplay || 'off',
    (val) => {
      patch({ voice: { autoplay: val } });
      renderVoice(content);
    }
  );

  const autoplayExtra = [];
  if ((v.autoplay || 'off') === 'short') {
    autoplayExtra.push(
      field(
        '字数上限',
        el('input', {
          type: 'number',
          min: '10',
          max: '500',
          value: String(num(v.shortLimit, 60)),
          on: { change: (e) => patch({ voice: { shortLimit: clamp(num(e.target.value, 60), 10, 500) } }) },
        }),
        '超过这个字数的回复不会被自动朗读（避免长文把耳朵念累）。'
      )
    );
  }

  /* ---------- 缓存 ---------- */
  const cacheRow = toggleRow('缓存云端语音', v.cache !== false, (on) => patch({ voice: { cache: on } }), '云端合成的音频会缓存在本机（IndexedDB，最多 200 条），重听同一句不再重复计费。');
  const clearCacheBtn = el(
    'button.btn',
    {
      on: {
        click: async () => {
          try {
            const n = await clearVoiceCache();
            toast(`已清空语音缓存（${n} 条）`, 'ok');
          } catch (err) {
            toast(`清空失败：${(err && err.message) || err}`, 'error');
          }
        },
      },
    },
    icon('trash', 15),
    el('span', { text: '清空语音缓存' })
  );

  /* ---------- 语音输入 ---------- */
  const stt = v.stt || {};
  const sttNodes = [
    toggleRow('启用语音输入（麦克风转文字）', stt.enabled !== false, (on) => patch({ voice: { stt: { enabled: on } } })),
    field(
      '识别语言',
      selectBox(
        [
          { value: 'zh-CN', label: '中文（普通话）' },
          { value: 'en-US', label: 'English (US)' },
          { value: 'ja-JP', label: '日本語' },
        ],
        stt.lang || 'zh-CN',
        (val) => patch({ voice: { stt: { lang: val } } })
      )
    ),
    toggleRow('识别完自动发送', !!stt.autoSend, (on) => patch({ voice: { stt: { autoSend: on } } }), '说完停顿一下就会自动把消息发出去，适合躺着聊天。'),
  ];

  const unavailable = [];
  if (!avail.tts) {
    unavailable.push('⚠️ 当前环境不支持语音合成（speechSynthesis）。建议使用 Chrome / Edge，或在系统里安装中文语音包。');
  }
  if (!avail.stt) {
    unavailable.push('⚠️ 当前浏览器不支持语音识别，请使用 Chrome 或 Edge 打开本应用（Safari / Firefox 暂不支持）。');
  }

  content.appendChild(
    section(
      '语音',
      '让角色真的"开口说话"。语音失败不会影响文字聊天。',
      unlockBtn,
      el('div.divider'),
      toggleRow('启用语音功能', v.enabled !== false, (on) => patch({ voice: { enabled: on } })),
      field('合成引擎', engineSel, '云端合成失败时会自动静默降级到浏览器内置语音。'),
      ...cloudNodes,
      el('div.divider'),
      field('语速', el('div.row', rateRange, rateText)),
      field('音调', el('div.row', pitchRange, pitchText)),
      el('div.row', testBtn),
      el('div.divider'),
      field('自动朗读', autoplaySel, '角色回复时是否自动逐句朗读。'),
      ...autoplayExtra,
      cacheRow,
      el('div.row', clearCacheBtn),
      el('div.divider'),
      el('h3', { text: '语音输入' }),
      el('p.desc', { text: '把你说的话转成文字填进输入框。' }),
      ...sttNodes,
      unavailable.length ? el('div.field-hint', { text: unavailable.join('\n'), style: { whiteSpace: 'pre-wrap', color: 'var(--warn)' } }) : null
    )
  );

  // 音色首次为空：注册 onvoiceschanged 后重填（部分浏览器只在事件里给出音色）
  if (v.provider !== 'cloud') {
    const ss = window.speechSynthesis;
    if (ss && !initialVoices.length && typeof ss.addEventListener === 'function') {
      const onChanged = () => {
        if (fillVoices(speaker.listVoices('zh'))) {
          try {
            ss.removeEventListener('voiceschanged', onChanged);
          } catch {
            /* 忽略 */
          }
        }
      };
      try {
        ss.addEventListener('voiceschanged', onChanged);
      } catch {
        /* 忽略 */
      }
      // 兜底：speaker 内部还有轮询，稍后再取一次
      if (typeof speaker.voicesReady === 'function') {
        speaker.voicesReady().then((list) => {
          if (Array.isArray(list) && list.length) fillVoices(list);
        });
      }
      setTimeout(() => {
        fillVoices(speaker.listVoices('zh'));
      }, 1200);
    }
  }
}

/* ===========================================================================
 * 分区三：记忆与上下文
 * ======================================================================== */

/**
 * 群聊分区：新建群聊时的默认项
 * —— 只影响"以后新建的群"，已有群聊的设置请到群资料面板里改。
 */
async function renderGroup(content) {
  const s = getSettings();
  const g = s.group || {};
  clear(content);

  const turnModeSel = selectBox(
    [
      { value: 'smart', label: '智能接话（推荐）：谁最该接这句谁上' },
      { value: 'round', label: '轮流发言：按成员顺序一人一句' },
      { value: 'random', label: '随机插话：更热闹、更容易出意外' },
      { value: 'mention', label: '只应 @：只有被点名的角色才开口' },
    ],
    g.turnMode || 'smart',
    (v) => patch({ group: { turnMode: v } })
  );

  // 1~8 与 core/store.js 的 clamp(..., 1, 8) 对齐（原来只到 6，值 7/8 会显示成 1）
  const turnsSel = selectBox(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: `${n} 位角色` })),
    String(num(g.maxAutoTurns, 3)),
    (v) => patch({ group: { maxAutoTurns: num(v, 3) } })
  );

  const delaySel = selectBox(
    [
      { value: '0', label: '不等待（连着说，像抢话）' },
      { value: '400', label: '0.4 秒' },
      { value: '900', label: '0.9 秒（推荐）' },
      { value: '1800', label: '1.8 秒（有思考感）' },
      { value: '3000', label: '3 秒（慢节奏）' },
    ],
    String(num(g.autoDelayMs, 900)),
    (v) => patch({ group: { autoDelayMs: num(v, 900) } })
  );

  const stat = await dbStats().catch(() => ({ groups: 0, groupMessages: 0 }));

  content.append(
    section(
      '群聊',
      '群聊是"多人客厅"：把两位以上好友拉进同一个群，他们能看见彼此的发言，也会互相接话、吐槽、拆台。下面这些是**新建群聊时的默认值**，每个群都可以在群资料里单独改。',
      el(
        'div.stat-grid',
        statCard(num(stat.groups, 0), '个群聊'),
        statCard(num(stat.groupMessages, 0), '条群消息')
      ),
      field('接话策略', turnModeSel, '决定"用户说了一句话之后，谁先接、还有谁接"。'),
      el(
        'div.grid-2',
        field('一轮最多几位角色发言', turnsSel, '越多越热闹，但 token 消耗也越多。'),
        field('角色之间间隔', delaySel, '让群里有"打字"的节奏感，而不是一瞬间全说完。')
      ),
      toggleRow(
        '新群默认开启自动接话',
        g.autoTalk !== false,
        (on) => patch({ group: { autoTalk: on } }),
        '关闭后，新建的群里只有被你 @ 到的角色才会回复，其余人安静旁听。'
      ),
      toggleRow(
        '新群默认：自己聊时每人至少发言一次',
        g.everyoneSpeaks !== false,
        (on) => patch({ group: { everyoneSpeaks: on } }),
        '点「让他们自己聊」时保证每位成员都轮到一次（人比「一轮最多」多时以人数为准）。关掉则严格按「一轮最多」截断。'
      ),
      toggleRow(
        '新群默认朗读角色发言',
        g.autoVoice === true,
        (on) => patch({ group: { autoVoice: on } }),
        '每个角色用自己的声线；需要先在「设置 → 语音」里开启语音功能。'
      ),
      el('div.field-hint', {
        text:
          '用法提示：\n' +
          '· 在群里输入「@名字 内容」可以点名让某个角色先回。\n' +
          '· 点顶部的 🎭「自动接话」可以切到「仅应 @」，你就完全掌控节奏。\n' +
          '· 空群或者想旁观时，点「让他们自己聊」，角色们会自己找话题接着聊下去。',
        style: { whiteSpace: 'pre-wrap' },
      })
    )
  );
}

/** 记忆与上下文分区 */
async function renderContext(content) {
  const s = getSettings();
  const c = s.context || {};
  clear(content);

  /* ---------- 上下文名额 ---------- */
  const maxMsgInput = el('input', {
    type: 'number',
    min: '4',
    max: '200',
    value: String(num(c.maxMessages, 40)),
    on: { change: (e) => patch({ context: { maxMessages: clamp(num(e.target.value, 40), 4, 200) } }) },
  });

  const budgetText = el('span.tiny.mono', { text: String(num(c.budgetTokens, 8000)) });
  const budgetRange = el('input', {
    type: 'range',
    min: '2000',
    max: '32000',
    step: '500',
    value: String(num(c.budgetTokens, 8000)),
    on: {
      input: (e) => {
        budgetText.textContent = String(num(e.target.value, 8000));
        patch({ context: { budgetTokens: num(e.target.value, 8000) } });
      },
    },
  });

  /* ---------- 主动性 ---------- */
  const p = s.proactive || {};
  const proactiveRow = toggleRow(
    '角色主动性（久未联系会主动找你）',
    !!p.enabled,
    (on) => {
      // core/proactive.js 的唯一开关是 settings.proactive.enabled。
      // 这里以前还会顺带写一份 context.proactive（早期版本读它），哪边都不再读那份旧字段了，已删。
      patch({ proactive: { enabled: on } });
      flushPatch();
      renderContext(content).catch((err) => console.warn('[settings] 渲染上下文分区失败', err));
    },
    '开启后角色会在你久未联系时主动发来一条消息；发送时会尊重下面的免打扰时段与每日上限。'
  );

  const proactiveExtra = [];
  if (p.enabled) {
    const quietWrap = el(
      'div.grid-2',
      field(
        '免打扰开始（整点）',
        el('input', {
          type: 'number',
          min: '0',
          max: '23',
          value: String(num(p.quietStart, 23)),
          on: { change: (e) => patch({ proactive: { quietStart: clamp(num(e.target.value, 23), 0, 23) } }) },
        })
      ),
      field(
        '免打扰结束（整点）',
        el('input', {
          type: 'number',
          min: '0',
          max: '23',
          value: String(num(p.quietEnd, 7)),
          on: { change: (e) => patch({ proactive: { quietEnd: clamp(num(e.target.value, 7), 0, 23) } }) },
        })
      )
    );
    proactiveExtra.push(
      field(
        '最小间隔（小时）',
        el('input', {
          type: 'number',
          min: '1',
          max: '168',
          value: String(num(p.minGapHours, 6)),
          on: { change: (e) => patch({ proactive: { minGapHours: clamp(num(e.target.value, 6), 1, 168) } }) },
        }),
        '距上次聊天超过这个时长，角色才可能主动发消息。'
      ),
      quietWrap,
      field(
        '每天最多几条',
        el('input', {
          type: 'number',
          min: '1',
          max: '20',
          value: String(num(p.maxPerDay, 2)),
          on: { change: (e) => patch({ proactive: { maxPerDay: clamp(num(e.target.value, 2), 1, 20) } }) },
        }),
        '免打扰时段跨午夜也支持，例如 23 → 7。'
      )
    );
  }

  /* ---------- 预算可视化 + 记忆 ---------- */
  const budgetBox = el('div');
  const memoryBox = el('div');
  const char = await currentChar();

  if (char) {
    void renderBudgetBox(budgetBox, char);
    void renderMemoryBox(memoryBox, char, () => renderBudgetBox(budgetBox, char));
  } else {
    budgetBox.appendChild(el('div.field-hint', { text: '先在左侧打开一位好友的聊天，这里就会显示这一轮上下文的 token 分布。' }));
    memoryBox.appendChild(el('div.field-hint', { text: '先打开一位好友的聊天，这里会显示他的长期记忆。' }));
  }

  content.appendChild(
    section(
      '记忆与上下文',
      '决定角色"聊久了会不会变傻"。预算越大越聪明，也越贵。',
      field('上下文条数上限', maxMsgInput, '每次请求最多携带最近多少条消息。'),
      field('token 预算', el('div.row', budgetRange, budgetText), '整轮请求（人设 + 记忆 + 历史）的 token 上限，超出会从最旧的消息开始丢弃。'),
      toggleRow('滚动摘要（自动把旧对话压缩成记忆）', c.summary !== false, (on) => patch({ context: { summary: on } }), '历史过长时自动调用模型生成摘要，保持长期连贯性。'),
      field(
        '保留最近 N 条不压缩',
        el('input', {
          type: 'number',
          min: '2',
          max: '80',
          value: String(num(c.summaryKeep, 12)),
          on: { change: (e) => patch({ context: { summaryKeep: clamp(num(e.target.value, 12), 2, 80) } }) },
        }),
        '最近的对话永远原样保留，只压缩更早的部分。'
      ),
      el('div.divider'),
      toggleRow('时间感知', c.timeAware !== false, (on) => patch({ context: { timeAware: on } }), '让角色知道现在几点、你们上次聊天是几天前。'),
      toggleRow('好感度注入', c.affinity !== false, (on) => patch({ context: { affinity: on } }), '把当前好感度换算成语气提示注入提示词，让关系有"进展感"。'),
      proactiveRow,
      ...proactiveExtra,
      el('div.divider'),
      el('h3', { text: '上下文预算可视化' }),
      el('p.desc', { text: '这一轮实际发给模型的 token 分布。' }),
      budgetBox,
      el('div.divider'),
      el('h3', { text: '记忆管理' }),
      el('p.desc', { text: char ? `当前角色：${char.name}` : '当前没有打开的角色。' }),
      memoryBox
    )
  );
}

/** 上下文预算可视化 */
async function renderBudgetBox(box, char) {
  clear(box);
  box.appendChild(el('div.row', el('span.spinner'), el('span.small.muted', { text: '正在计算上下文…' })));
  try {
    const s = getSettings();
    const history = await listMessages(char.id);
    const memory = await getMemory(char.id);
    const recentExperiences = await getRecentExperiences(char.id);
    const { messages, meta } = buildMessages(char, history, {
      settings: s,
      memory,
      recentExperiences,
      runtime: getRuntime(char.id),
      budgetTokens: num(s.context && s.context.budgetTokens, 8000),
    });

    const budget = num(meta.budget, num(s.context && s.context.budgetTokens, 8000)) || 1;
    const total = num(meta.total, 0);
    const list = el('div.bar-list');
    for (const part of meta.breakdown || []) {
      const t = num(part.tokens, 0);
      list.appendChild(barItem(part.label, `${t} tokens · ${((t / total) * 100 || 0).toFixed(0)}%`, t / budget));
    }

    const promptBtn = el(
      'button.btn',
      {
        on: {
          click: () => {
            const text = messages.map((m) => `【${m.role}】\n${m.content}`).join('\n\n');
            const pre = el('pre.mono.small', {
              text,
              style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '60vh', overflow: 'auto' },
            });
            modal({
              title: `本轮实际提示词（${messages.length} 条 / ${total} tokens）`,
              body: el('div', el('p.desc', { text: '这就是这一轮真正发给模型的内容，调人设时非常有用。' }), pre),
              width: 720,
              actions: [
                {
                  text: '复制全文',
                  keepOpen: true,
                  onClick: async () => {
                    const ok = await copyText(text);
                    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中复制', ok ? 'ok' : 'warn');
                  },
                },
                { text: '关闭', kind: 'primary' },
              ],
            });
          },
        },
      },
      icon('book', 15),
      el('span', { text: '查看本轮实际提示词' })
    );

    clear(box);
    box.append(
      el(
        'div.stat-grid',
        statCard(total, `本轮 tokens / 预算 ${budget}`),
        statCard(meta.kept == null ? '-' : meta.kept, '保留消息数'),
        statCard(meta.dropped == null ? '-' : meta.dropped, '被丢弃消息数')
      ),
      list,
      el('div.row', { style: { marginTop: '12px' } }, promptBtn)
    );
  } catch (err) {
    clear(box);
    box.appendChild(el('div.field-hint', { text: `计算失败：${(err && err.message) || err}` }));
  }
}

/** 来源时间保留时分秒；损坏的旧记录不显示猜测值。 */
function memoryTime(value) {
  const stamp = typeof value === 'number' ? value : Number(value) || Date.parse(value);
  const date = new Date(stamp);
  return Number.isFinite(stamp) && stamp > 0 && Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false })
    : '时间未记录';
}

/** 仅展示 store 重新核对可见性的来源，不回退展示缓存摘录。 */
async function showMemorySources(char, record) {
  const body = el('div.memory-source-list', el('p.field-hint', { text: '正在读取来源…' }));
  const dialog = modal({ title: `记忆来源 · ${char.name}`, body, width: 620, actions: [{ text: '关闭', kind: 'primary' }] });
  try {
    const result = await getMemorySource(char.id, record.id);
    if (!document.body.contains(dialog.root)) return;
    const sources = Array.isArray(result) ? result : [];
    clear(body);
    body.appendChild(el('p.memory-fact-text', { text: record.text }));
    if (!sources.length) {
      const message = record.origin === 'legacy'
        ? '历史记忆，来源未记录。'
        : record.origin === 'game' ? '这条记忆来自游戏结算，不是聊天内容提取；可在对应群聊查看对局。'
        : record.origin === 'manual'
          ? '这条记忆由你手动记录，没有可查看的聊天来源。'
          : '没有可查看的来源。原消息可能已删除，或不在当前角色可见的范围内。';
      body.appendChild(el('p.field-hint', { text: message }));
      return;
    }
    body.appendChild(el('p.field-hint', { text: '仅展示这位角色可见的来源；删除或不可见的消息不会显示历史摘录。' }));
    for (const source of sources) {
      const available = source.available === true;
      const scene = source.kind === 'group' ? '群聊' : source.kind === 'private' ? '私聊' : '聊天';
      const state = !available ? '来源已删除或不可查看' : source.changed ? '来源内容已变化' : '来源可查看';
      body.appendChild(el('article.memory-source',
        el('div.memory-fact-head',
          el('strong', { text: `${scene}${source.sourceName ? ` · ${source.sourceName}` : ''}` }),
          el('span.memory-status', { text: state, dataset: { status: available && !source.changed ? 'active' : 'stale' } })
        ),
        el('div.memory-fact-meta', { text: memoryTime(source.at) }),
        available
          ? el('p.memory-source-content', { text: typeof source.content === 'string' ? source.content : '（来源内容为空）' })
          : el('p.field-hint', { text: '不再展示这条来源的内容。' }),
        available && source.changed
          ? el('p.field-hint', { text: '上方是当前消息内容，与提取这条记忆时不同。请核对并纠正记忆。' })
          : null
      ));
    }
  } catch (err) {
    if (!document.body.contains(dialog.root)) return;
    clear(body);
    body.appendChild(el('p.field-hint', { text: `读取来源失败：${(err && err.message) || err}` }));
  }
}

/** 记忆管理：有效事实默认展示，失效记录收进可展开历史。 */
async function renderMemoryBox(box, char, onChanged) {
  const historyExpanded = box.querySelector('.memory-history')?.open === true;
  clear(box);
  box.appendChild(el('p.field-hint', { text: '正在读取记忆…' }));
  const reload = () => renderMemoryBox(box, char, onChanged);
  try {
    const mem = await getMemory(char.id);
    const records = Array.isArray(mem.factRecords) ? mem.factRecords.filter((r) => r && typeof r.text === 'string') : [];
    const activeRecords = records.filter((r) => r.status === 'active');
    const historyRecords = records.filter((r) => r.status !== 'active');
    // 旧导入缺少结构化记录时只读展示，不在界面捏造可用于写操作的 id。
    const legacyFacts = records.length ? [] : (Array.isArray(mem.facts) ? mem.facts : []).filter((f) => typeof f === 'string');
    let busy = false;
    const mutate = async (action, successMessage) => {
      if (busy) return;
      busy = true;
      box.querySelectorAll('button[data-memory-write]').forEach((button) => { button.disabled = true; });
      try {
        const changed = await action();
        if (changed === false) return;
        if (successMessage) toast(successMessage, 'ok');
        await reload();
        if (typeof onChanged === 'function') await onChanged();
      } catch (err) {
        toast(`记忆操作失败：${(err && err.message) || err}`, 'error');
      } finally {
        busy = false;
        box.querySelectorAll('button[data-memory-write]').forEach((button) => { button.disabled = false; });
      }
    };
    const recordNode = (record) => {
      const labels = { active: '有效', superseded: '已修正', retracted: '已撤回', stale: '来源变化' };
      const sourceLabel = record.origin === 'legacy'
        ? '历史记忆，来源未记录'
        : record.origin === 'game' ? '游戏结算记录'
        : record.origin === 'manual'
          ? (record.replaces ? '手动纠正' : '手动记录')
          : record.sourceStatus === 'verified' ? '已记录聊天来源' : '来源未核验';
      const actions = el('div.row.wrap.memory-fact-actions');
      if (record.id) {
        actions.appendChild(el('button.btn.btn-sm', {
          text: '查看来源',
          attr: { 'aria-label': `查看记忆来源：${record.text}` },
          on: { click: () => void showMemorySources(char, record) },
        }));
        if (record.status === 'active' || record.status === 'stale') {
          actions.appendChild(el('button.btn.btn-sm', {
            text: '纠正', dataset: { memoryWrite: 'correct' },
            attr: { 'aria-label': `纠正记忆：${record.text}` },
            on: { click: () => void mutate(async () => {
              const text = await promptDialog({
                title: '纠正这条记忆',
                label: '填写正确内容。保存后原条目进入历史，聊天原文不会改动。',
                value: record.text, multiline: true,
              });
              if (text == null) return false;
              await correctMemoryFact(char.id, record.id, text);
            }, '记忆已纠正') },
          }));
        }
        if (record.status === 'active') {
          actions.appendChild(el('button.btn.btn-sm.btn-danger', {
            text: '撤回', dataset: { memoryWrite: 'retract' },
            attr: { 'aria-label': `撤回记忆：${record.text}` },
            on: { click: () => void mutate(async () => {
              const ok = await confirmDialog({
                title: '撤回这条记忆',
                message: `“${record.text}”\n\n撤回后不再作为有效记忆使用，条目保留在历史中。聊天原文不会被删除；若原文也有错误，请一并修改。`,
                okText: '撤回记忆', danger: true,
              });
              if (!ok) return false;
              await retractMemoryFact(char.id, record.id);
            }, '记忆已撤回') },
          }));
        }
      }
      return el('article.memory-fact', { dataset: { memoryId: record.id || '', memoryStatus: record.status || 'unknown' } },
        el('div.memory-fact-head',
          el('span.memory-status', { text: labels[record.status] || '状态待核对', dataset: { status: record.status || 'unknown' } }),
          el('span.memory-fact-meta', { text: sourceLabel })
        ),
        el('p.memory-fact-text', { text: record.text }),
        el('div.memory-fact-meta', { text: `更新于 ${memoryTime(record.updatedAt || record.createdAt)}` }),
        record.status === 'stale' ? el('p.field-hint', { text: '来源已变化或不可查看，这条记忆已暂停使用。可核对来源后纠正。' }) : null,
        actions
      );
    };
    const rebuildBtn = el('button.btn', {
      dataset: { memoryWrite: 'rebuild' },
      on: { click: () => void mutate(async () => {
        rebuildBtn.textContent = '整理中…';
        try {
          flushPatch();
          const history = await listMessages(char.id);
          const next = await rebuildMemory(char, history, getSettings());
          // 用 summarized 标记判断，失败时底层可能回填非空的旧摘要。
          if (next && next.summarized) toast('记忆已重新整理', 'ok');
          else toast(next?.conflict ? '记忆已被更新，本次整理没有覆盖新的修改。' : next?.error || '暂无可整理的内容，原记忆已保留。', 'warn', 4800);
        } finally {
          rebuildBtn.textContent = '重新整理记忆';
        }
      }) },
    }, icon('brain', 15), el('span', { text: '重新整理记忆' }));
    const clearBtn = el('button.btn.btn-danger', {
      dataset: { memoryWrite: 'clear' },
      on: { click: () => void mutate(async () => {
        const ok = await confirmDialog({
          title: '清空记忆',
          message: `确定清空「${char.name}」的长期记忆吗？摘要、事实、纠正和撤回记录都会清空，聊天原文不会删除。以后重新整理时，原聊天中的内容可能再次被提取。`,
          okText: '清空', danger: true,
        });
        if (!ok) return false;
        await saveMemory(char.id, { summary: '', summaryStatus: 'active', facts: [], factRecords: [], summarizedUpTo: 0, updatedAt: Date.now() });
      }, '记忆已清空') },
    }, icon('trash', 15), el('span', { text: '清空记忆' }));

    const factsBox = el('div.memory-facts');
    activeRecords.forEach((record) => factsBox.appendChild(recordNode(record)));
    legacyFacts.forEach((text) => factsBox.appendChild(el('article.memory-fact',
      el('p.memory-fact-text', { text }), el('p.field-hint', { text: '历史记忆，来源未记录' })
    )));
    if (!activeRecords.length && !legacyFacts.length) factsBox.appendChild(el('p.field-hint', { text: '暂无有效事实记忆。' }));
    const historyBox = historyRecords.length ? el('details.memory-history', { open: historyExpanded },
      el('summary', { text: `历史记录（${historyRecords.length}）· 已修正 / 已撤回 / 来源变化` }),
      el('p.field-hint', { text: '这些条目不作为有效事实继续使用；保留在这里便于核对。' }),
      el('div.memory-facts', ...historyRecords.map(recordNode))
    ) : null;
    const summaryNote = mem.summaryStatus === 'stale'
      ? '摘要来源变化或发生过纠正、撤回，已暂停用于后续回复；有效事实仍可使用。'
      : mem.summaryStatus === 'unverified' ? '历史摘要，来源未记录。请核对内容。' : '';
    clear(box);
    box.append(
      el('div.memory-summary',
        el('div.kv', el('span.k', { text: '摘要' }), el('span.v', { text: mem.summary || '（还没有摘要，聊天变长后会自动生成）' })),
        summaryNote ? el('p.field-hint', { text: summaryNote }) : null,
        el('div.kv', el('span.k', { text: '更新时间' }), el('span.v', { text: mem.updatedAt ? `${fmtDate(mem.updatedAt)}（${relTime(mem.updatedAt)}）` : '—' }))
      ),
      el('h4.memory-list-title', { text: `有效事实（${activeRecords.length + legacyFacts.length}）` }),
      factsBox, historyBox,
      el('p.field-hint', { text: '重新整理会根据现有聊天提取记忆；已撤回或被纠正的来源会排除，人工纠正会保留。原聊天记录不会改动。' }),
      el('div.row.wrap', { style: { marginTop: '12px' } }, rebuildBtn, clearBtn,
        el('button.btn', { text: '刷新记忆', dataset: { memoryWrite: 'refresh' }, on: { click: () => { if (!busy) void reload(); } } })
      )
    );
  } catch (err) {
    clear(box);
    box.appendChild(el('div.field-hint', { text: `读取记忆失败：${(err && err.message) || err}` }));
  }
}

/* ===========================================================================
 * 分区四：数据
 * ======================================================================== */

/** 数据分区 */
async function renderData(content) {
  const s = getSettings();
  clear(content);
  content.appendChild(el('div.empty', el('span.spinner')));

  let stats = { chars: 0, messages: 0, bytes: 0 };
  let usage = { total: { prompt: 0, completion: 0, total: 0, cost: 0 }, daily: {}, byChar: {} };
  let chars = [];
  try {
    [stats, usage, chars] = await Promise.all([dbStats(), getUsage(), listCharacters()]);
  } catch (err) {
    toast(`读取统计数据失败：${(err && err.message) || err}`, 'error');
  }
  const nameOf = (id) => {
    const c = chars.find((x) => x.id === id);
    return c ? c.name : id === 'unknown' ? '未关联角色' : id;
  };

  /* ---------- 用量：近 14 天汇总（不再逐日罗列） ---------- */
  const daily = usage.daily || {};
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  const recent = days.reduce(
    (acc, k) => {
      const rec = daily[k];
      if (!rec) return acc;
      acc.tokens += num(rec.tokens, 0);
      acc.calls += num(rec.calls, 0);
      acc.activeDays += num(rec.tokens, 0) > 0 || num(rec.calls, 0) > 0 ? 1 : 0;
      return acc;
    },
    { tokens: 0, calls: 0, activeDays: 0 }
  );

  /* ---------- 用量：按角色 ---------- */
  const byChar = usage.byChar || {};
  const charEntries = Object.entries(byChar).sort((a, b) => num(b[1].tokens) - num(a[1].tokens)).slice(0, 20);
  const maxChar = charEntries.reduce((m, [, v]) => Math.max(m, num(v.tokens, 0)), 0) || 1;
  const charList = el('div.bar-list');
  if (!charEntries.length) {
    charList.appendChild(el('div.field-hint', { text: '还没有用量记录。' }));
  } else {
    for (const [id, v] of charEntries) {
      charList.appendChild(
        barItem(nameOf(id), `${num(v.tokens, 0)} tokens · ${num(v.calls, 0)} 次`, num(v.tokens, 0) / maxChar)
      );
    }
  }

  /* ---------- 本地文件存储（角色直接保存在电脑文件里） ---------- */
  const fsInfo = fileStatus();
  const storeSection = el(
    'div',
    el('h3', { text: '本地文件存储' }),
    el('p.desc', {
      text: '角色卡、聊天记录与记忆会直接写入你电脑上的文件，关掉浏览器或重启电脑都不会丢；下次打开会自动从这里恢复。',
    }),
    el('div.kv', el('span.k', { text: '保存目录' }), el('span.v.mono', { text: fsInfo.dir || '（未连接本地文件服务）' })),
    el('div.kv', el('span.k', { text: '当前状态' }), el('span.v', { text: storeStatusText(fsInfo) + (fsInfo.error ? `：${fsInfo.error}` : '') })),
    el(
      'div.row',
      { style: { gap: '8px', 'flex-wrap': 'wrap', 'margin-top': '10px' } },
      el(
        'button.btn',
        {
          on: {
            click: async () => {
              const r = await syncOnBoot();
              if (r.ok) window.location.reload();
              else toast(`同步失败：${r.error || '未检测到本地文件服务（请用 node server.mjs 启动）'}`, 'error', 5200);
              await renderData(content);
            },
          },
        },
        icon('refreshCw', 15),
        el('span', { text: '立即同步到文件' })
      ),
      el(
        'button.btn',
        {
          on: {
            click: async () => {
              const r = await snapshotNow();
              if (r.ok) toast(`已生成快照：${r.file}`, 'ok', 5600);
              else toast(`生成快照失败：${r.error || '未检测到本地文件服务'}`, 'error', 5200);
            },
          },
        },
        icon('layers', 15),
        el('span', { text: '生成整库快照' })
      )
    ),
    el('div.field-hint', {
      text: '快照是磁盘上的一份完整副本（data/db/backup-*.json）；服务器每次启动也会自动留一份，最多保留 10 份。',
    })
  );

  const wipeBtn = el(
    'button.btn.btn-danger',
    {
      on: {
        click: async () => {
          const first = await confirmDialog({
            title: '清空全部数据',
            message: '这会同时删除浏览器里的数据和电脑上 data/db 里的文件（角色、聊天记录、记忆、用量统计）。\n确定要继续吗？',
            okText: '继续',
            danger: true,
          });
          if (!first) return;
          const second = await confirmDialog({
            title: '真的要清空吗？',
            message: '最后确认：清空后无法恢复（磁盘上 data/db 里的备份快照仍会保留，可手动取回）。',
            okText: '我确定，清空',
            cancelText: '算了',
            danger: true,
          });
          if (!second) return;
          try {
            const res = await wipeAll();
            // 狼人杀存档在 localStorage，wipeAll 只清 IndexedDB —— 不清的话
            // "清空全部数据"之后对局存档还在，恢复同一份备份时群会莫名进入游戏模式。
            if (res?.ok !== false) clearAllGames();
            // 只有浏览器与磁盘都处理完了才报成功：磁盘清空失败时旧数据会在下次启动被回填，
            // 此时弹"已清空"就是在骗用户（见 core/store.js 的 wipeAll 返回值）。
            if (res && res.ok === false) {
              toast(`电脑上的文件没清掉，已停止清空并保留浏览器数据：${res.fileError}。`, 'error', 8000);
            } else {
              toast('已清空全部本机数据', 'ok');
            }
            await renderData(content);
          } catch (err) {
            toast(`清空失败：${(err && err.message) || err}`, 'error');
          }
        },
      },
    },
    icon('trash', 15),
    el('span', { text: '清空全部数据' })
  );

  /* ---------- 主题 ---------- */
  const themeBtns = ['dark', 'light', 'auto'].map((mode) => {
    const label = mode === 'dark' ? '深色' : mode === 'light' ? '浅色' : '跟随系统';
    const btn = el(
      'button.btn',
      {
        on: {
          click: () => {
            applyTheme(mode, getSettings().accent);
            patch({ theme: mode });
            for (const b of themeBtns) b.classList.remove('btn-primary');
            btn.classList.add('btn-primary');
          },
        },
      },
      el('span', { text: label })
    );
    if ((s.theme || 'dark') === mode) btn.classList.add('btn-primary');
    return btn;
  });

  const accentSwatches = ACCENT_PRESETS.map((hex) => {
    const sw = el('button', {
      type: 'button',
      title: hex,
      style: {
        width: '30px',
        height: '30px',
        padding: '0',
        borderRadius: '50%',
        background: hex,
        border: String(s.accent).toLowerCase() === hex ? '2px solid var(--text)' : '1px solid var(--line)',
      },
      on: {
        click: () => {
          applyTheme(getSettings().theme, hex);
          patch({ accent: hex });
          renderData(content);
        },
      },
    });
    return sw;
  });
  const accentInput = el('input', {
    type: 'color',
    value: /^#[0-9a-fA-F]{6}$/.test(String(s.accent)) ? String(s.accent) : '#6c8cff',
    style: { width: '52px' },
    on: {
      input: (e) => {
        const v = String(e.target.value || '#6c8cff');
        applyTheme(getSettings().theme, v);
        patch({ accent: v });
      },
    },
  });

  const usageTotal = usage.total || { prompt: 0, completion: 0, total: 0, cost: 0 };

  // 注：按需求这里不再显示任何金额 —— 原有的「累计费用」「近 14 天费用」卡片、
  // 按角色行里的 ¥ 金额、以及「每月预算（元）」输入框都已移除。
  // 底层 usage 记录里仍保留 cost 字段（调试面板会用到），只是设置界面不再展示。
  clear(content);
  content.appendChild(
    section(
      '数据与统计',
      '本地优先：角色与聊天记录即时存在浏览器数据库里，并会自动写入你电脑上的文件（见下方"本地文件存储"）。',
      el(
        'div.stat-grid',
        statCard(stats.chars, '角色数'),
        statCard(stats.messages, '消息数'),
        statCard(`${(num(stats.bytes, 0) / 1024 / 1024).toFixed(2)} MB`, '占用空间'),
        statCard(usageTotal.total, '累计 tokens')
      ),
      el('h3', { text: '用量：近 14 天' }),
      el('p.desc', { text: '近 14 天的整体消耗汇总与按角色的分布（仅为估算值）。' }),
      el(
        'div.stat-grid',
        statCard(recent.tokens, '近 14 天 tokens'),
        statCard(recent.calls, '近 14 天对话次数'),
        statCard(`${recent.activeDays} / 14`, '有使用的天数')
      ),
      el('div.divider'),
      el('h3', { text: '用量：按角色' }),
      charList,
      el('div.row', { style: { marginTop: '12px' } },
        el('button.btn', {
          on: {
            click: async () => {
              const ok = await confirmDialog({ title: '清空用量统计', message: '只会清空 token 用量统计，不影响角色和聊天记录。', okText: '清空', danger: true });
              if (!ok) return;
              try {
                await clearUsage();
                toast('用量统计已清空', 'ok');
                await renderData(content);
              } catch (err) {
                toast(`清空失败：${(err && err.message) || err}`, 'error');
              }
            },
          },
        }, icon('refresh', 15), el('span', { text: '清空用量统计' }))
      ),
      el('div.divider'),
      storeSection,
      el('div.divider'),
      el('h3', { text: '主题外观' }),
      el('div.row.wrap', ...themeBtns),
      field('强调色', el('div.row.wrap', ...accentSwatches, accentInput), '改完立即生效，并会同步派生色 --accent-soft。'),
      el('div.divider'),
      el('h3', { text: '其他' }),
      toggleRow('打字机效果', s.typedEffect !== false, (on) => patch({ typedEffect: on }), '角色回复逐字出现，更有"正在输入"的感觉。'),
      field(
        '发送快捷键',
        selectBox(
          [
            { value: 'enter', label: 'Enter 发送，Shift+Enter 换行' },
            { value: 'mod-enter', label: 'Ctrl/Cmd+Enter 发送，Enter 换行' },
          ],
          s.sendKey || 'enter',
          (v) => patch({ sendKey: v })
        )
      ),
      toggleRow('显示调试面板', !!s.showDebug, (on) => {
        patch({ showDebug: on });
        const dbg = document.querySelector('.debug');
        if (dbg) dbg.classList.toggle('on', on); // 元素不存在就只保存设置
      }, '右下角显示最近一轮的 token 与模型信息，调参时很有用。'),
      el('div.divider'),
      el('h3', { text: '危险操作' }),
      el('p.desc', { text: '下面这个按钮会清空本机保存的全部内容，请谨慎操作。' }),
      el('div.row', wipeBtn)
    )
  );
}

/* ===========================================================================
 * 分区五：我的资料（你自己的昵称与头像 —— 聊天里"你"那条消息旁边显示的就是它）
 * ======================================================================== */

/**
 * 用户性别的可选项。
 * 与角色卡编辑器（ui/editor.js 的 GENDER_LIST）保持一致，空串表示"不设定"。
 */
const USER_GENDER_LIST = ['', '女', '男', '其他'];

/** 头像图片超过这个边长就等比缩小（存储要进 localStorage，必须压得很小） */
const USER_AVATAR_MAX_PX = 256;
/** 小于这个体积的图片直接原样存，不做二次编码 */
const USER_AVATAR_RAW_LIMIT = 200 * 1024;

/**
 * 把用户选的图片转成头像 dataURL：小图原样，大图缩到 256px 内再转 JPEG
 * @param {File} file
 * @returns {Promise<string>}
 */
async function avatarDataUrl(file) {
  if (!file) throw new Error('没有选择图片');
  const raw = await readFileAsDataURL(file);
  if (file.size <= USER_AVATAR_RAW_LIMIT) return raw;

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = raw;
  });
  const scale = Math.min(1, USER_AVATAR_MAX_PX / Math.max(img.width || 1, img.height || 1));
  const w = Math.max(1, Math.round((img.width || 1) * scale));
  const h = Math.max(1, Math.round((img.height || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.86);
}

/** 我的资料分区：昵称 + 性别 + 聊天头像 */
function renderProfile(content) {
  const s = getSettings();
  const cur = () => getSettings().user || {};
  clear(content);

  /* ---------- 头像预览 ---------- */
  const preview = el('div');
  const paint = () => {
    const u = cur();
    mount(preview, avatarNode({ name: u.name || '我', avatar: u.avatar || '🙂' }, 'xl'));
  };

  const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      toast('请选择图片文件（JPG / PNG / WebP）', 'warn');
      return;
    }
    try {
      const url = await avatarDataUrl(file);
      patch({ user: { avatar: url } });
      flushPatch();
      emojiInput.value = '';
      paint();
      toast('头像已更新', 'ok');
    } catch (err) {
      console.warn('[settings] 读取头像失败', err);
      toast(`读取图片失败：${(err && err.message) || err}`, 'error');
    }
  });

  const uploadBtn = el(
    'button.btn',
    { type: 'button', on: { click: () => fileInput.click() } },
    icon('upload', 14),
    el('span', { text: '上传图片' })
  );
  const clearBtn = el(
    'button.btn',
    {
      type: 'button',
      on: {
        click: () => {
          patch({ user: { avatar: '' } });
          flushPatch();
          emojiInput.value = '';
          paint();
          toast('已清除头像，改用 emoji / 昵称首字', 'info');
        },
      },
    },
    icon('trash', 14),
    el('span', { text: '清除头像' })
  );

  /* ---------- emoji 兜底 ---------- */
  const emojiInput = el('input', {
    type: 'text',
    value: isImageAvatar(cur().avatar) ? '' : String(cur().avatar || ''),
    placeholder: '🙂',
    style: { 'max-width': '120px' },
    on: {
      input: (e) => {
        const v = Array.from(String(e.target.value || '')).slice(0, 3).join('');
        patch({ user: { avatar: v } });
        paint();
      },
    },
  });

  /* ---------- 昵称 ---------- */
  const nameInput = el('input', {
    type: 'text',
    value: String(cur().name || ''),
    placeholder: '我',
    on: {
      input: (e) => {
        patch({ user: { name: String(e.target.value || '').slice(0, 24) } });
      },
    },
  });

  /* ---------- 性别 ---------- */
  const genderSel = selectBox(
    USER_GENDER_LIST.map((g) => ({ value: g, label: g || '不设定' })),
    String(cur().gender || ''),
    (v) => patch({ user: { gender: v } })
  );

  paint();

  content.appendChild(
    section(
      '我的资料',
      '这里是你自己的身份：聊天与群聊里"你"发的那条消息旁边显示的就是这个头像，角色也会用这个昵称称呼你。',
      el(
        'div',
        { style: { display: 'flex', gap: '14px', 'align-items': 'flex-start', 'margin-bottom': '4px' } },
        preview,
        el(
          'div',
          { style: { flex: '1 1 auto', 'min-width': '0' } },
          el('div.row.wrap', { style: { gap: '8px', 'margin-bottom': '10px' } }, uploadBtn, clearBtn, fileInput),
          field('或直接用 emoji 当头像', emojiInput, '不传图片时，聊天里就显示这个 emoji（留空则用昵称首字）。')
        )
      ),
      field('你的昵称', nameInput, '角色会用它来称呼你，也会写进提示词（「对方的名字/昵称是…」）。'),
      field(
        '你的性别',
        genderSel,
        '会一起写进提示词，让角色在称呼与用词上贴合你；选「不设定」就完全不让角色知道。'
      ),
      el('div.field-hint', { text: '头像、昵称与性别只存在你自己的电脑上（浏览器 localStorage 与 data/db/settings.json），不会上传。' })
    )
  );
}

/* ===========================================================================
 * 分区六：关于
 * ======================================================================== */

/** 关于分区 */
function renderAbout(content) {
  const s = getSettings();
  clear(content);

  const shortcuts = [
    ['Ctrl / Cmd + K', '全局搜索（跨角色搜消息与角色名）'],
    ['Ctrl / Cmd + N', '新建角色'],
    ['Esc', '关闭最上层弹层；没有弹层时停止生成'],
    ['Ctrl / Cmd + /', '打开这份快捷键帮助'],
  ];
  const kvList = el('div');
  for (const [k, v] of shortcuts) {
    kvList.appendChild(el('div.kv', el('span.k', { text: k }), el('span.v', { text: v })));
  }

  content.appendChild(
    section(
      '关于 AI 好友',
      '一个本地优先（local-first）的 AI 好友通讯录：你不是在用一个聊天框，而是在养一群住在同一部设备里的角色。',
      el('div.kv', el('span.k', { text: '版本' }), el('span.v', { text: `${APP_VERSION} · 原生 ES Module，零依赖零构建` })),
      el('div.kv', el('span.k', { text: '数据' }), el('span.v', { text: '角色、聊天记录、记忆都存在本机浏览器（IndexedDB）；设置与密钥存在 localStorage。' })),
      el('div.kv', el('span.k', { text: '运行时' }), el('span.v', { text: '需要 node server.mjs 启动（默认 http://127.0.0.1:5180）。' })),
      el('div.divider'),
      el('h3', { text: '快捷键' }),
      kvList,
      el('div.divider'),
      el('h3', { text: '隐私说明' }),
      el(
        'p.desc',
        {
          text:
            '· 你的 API Key 与聊天记录都只保存在本机浏览器，本应用没有服务器数据库，也不会上传任何数据。\n' +
            '· 只有在你发送消息、测试连接、整理记忆或使用云端语音时，相关内容才会通过你配置的接口发往你选择的模型供应商。\n' +
            '· 如果开启「服务器代理」，密钥会改由本机 server.mjs 从 .env 读取，浏览器不再持有密钥；请勿把带密钥的代理暴露到公网。\n' +
            '· 角色与聊天记录会自动写入电脑本地文件（data/db），浏览器数据被清理也能恢复。',
          style: { whiteSpace: 'pre-wrap' },
        }
      ),
      el('div.divider'),
      el('h3', { text: '情感依赖提醒' }),
      el('p.desc', {
        text:
          '角色很会陪你，但它是模型生成的，不是真人。长时间连续聊天容易产生依赖感，本应用会在你连续使用较久时温和地提醒一次休息。',
      }),
      toggleRow(
        '开启使用时长提醒',
        s.dependencyReminder !== false,
        (on) => patch({ dependencyReminder: on }),
        '默认开启：连续使用约 90 分钟后提示你起来走走、喝水、看看窗外；每天最多提醒一次。'
      ),
      el('div.divider'),
      el('h3', { text: '如果遇到问题' }),
      el('p.desc', {
        text:
          '· 页面白屏或报错：请确认是用 node server.mjs 启动后访问 http://127.0.0.1:5180，而不是直接双击 index.html。\n' +
          '· 收不到回复：到「模型」分区点「测试连接」，看具体报错；401 一般是密钥问题，网络错误一般是地址或代理问题。\n' +
          '· 没有声音：先点语音分区顶部的「🔊 点击开启语音」，浏览器要求至少一次用户手势才允许播放声音。',
        style: { whiteSpace: 'pre-wrap' },
      })
    )
  );
}

/* ===========================================================================
 * 入口
 * ======================================================================== */

/** 分区渲染表 */
const RENDERERS = {
  model: (content) => renderModel(content),
  voice: (content) => renderVoice(content),
  context: (content) => renderContext(content),
  group: (content) => renderGroup(content),
  profile: (content) => renderProfile(content),
  data: (content) => renderData(content),
  about: (content) => renderAbout(content),
};

/**
 * 打开设置面板（契约 3.14）
 * @param {string} [section] 初始分区：model | voice | context | data | about
 * @returns {void}
 */
export function openSettings(section) {
  const layout = el('div.set-layout');
  const nav = el('div.set-nav');
  const content = el('div.set-content');
  layout.append(nav, content);

  const found = SECTIONS.find((x) => x.id === section);
  let active = found ? found.id : 'model';

  /** @type {Map<string, HTMLElement>} */
  const navButtons = new Map();

  /**
   * 渲染指定分区
   * @param {string} id
   */
  // 渲染代际号：异步分区（数据/上下文/群聊）在 await 之后才往 content 里写，
  // 若期间用户切到了别的分区，晚返回的旧渲染会把当前分区整个覆盖（导航却停在新分区）。
  let renderToken = 0;
  const render = async (id) => {
    active = id;
    const myToken = ++renderToken;
    for (const [key, btn] of navButtons) btn.classList.toggle('on', key === id);
    clear(content);
    content.appendChild(el('div.empty', el('span.spinner')));
    try {
      await RENDERERS[id](content);
      // 期间切换过分区 → 丢弃这次渲染的结果，让新分区自己渲染
      if (myToken !== renderToken) return;
    } catch (err) {
      if (myToken !== renderToken) return;
      clear(content);
      content.appendChild(
        el(
          'div.empty',
          el('div.big', { text: '⚠️' }),
          el('h3', { text: '这个分区加载失败' }),
          el('p.small', { text: String((err && err.message) || err) })
        )
      );
    }
  };

  for (const sec of SECTIONS) {
    const btn = el('button', { on: { click: () => void render(sec.id) } }, icon(sec.icon, 14), el('span', { text: sec.label }));
    navButtons.set(sec.id, btn);
    nav.appendChild(btn);
  }

  const ref = modal({
    title: '设置',
    body: layout,
    width: 820,
    actions: [{ text: '完成', kind: 'primary' }],
  });

  /** 关闭时收尾：把防抖中的设置强制落盘并广播一次 */
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    flushPatchSoon.cancel();
    flushPatch();
    // setSettings 内部已经 emit 过；这里再补一次，确保关闭弹层后依赖方一定收到
    try {
      bus.emit('settings:changed', getSettings());
    } catch {
      /* 忽略 */
    }
  };

  const observer = new MutationObserver(() => {
    if (!document.body.contains(ref.root)) {
      observer.disconnect();
      cleanup();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  void render(active);
}

export default openSettings;
