/**
 * 通用工具函数（契约 3.2）。
 * 约束：零依赖、可在浏览器与 Node 中安全 import（不触碰 window 顶层 API）。
 */

/** 生成带前缀的唯一 id */
export function createId(prefix = 'i') {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 无前缀唯一 id */
export function uid() {
  return createId('u');
}

/** 防抖 */
export function debounce(fn, ms = 300) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return wrapped;
}

/** 节流（首次立即执行，尾部补一次） */
export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    const now = Date.now();
    lastArgs = args;
    if (now - last >= ms) {
      last = now;
      fn(...args);
      return;
    }
    if (timer) return;
    timer = setTimeout(
      () => {
        timer = null;
        last = Date.now();
        fn(...lastArgs);
      },
      ms - (now - last)
    );
  };
}

/** HTML 转义（用于必须拼接字符串的场景） */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 过滤 falsy 值并拼接 class */
export function clsx(...parts) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    if (typeof p === 'string' || typeof p === 'number') {
      out.push(String(p));
    } else if (Array.isArray(p)) {
      p.forEach(walk);
    } else if (typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) if (v) out.push(k);
    }
  };
  parts.forEach(walk);
  return out.join(' ');
}

/** 32 位十六进制哈希（FNV-1a 变体），用于缓存 key */
export function hashCode(s) {
  const str = String(s == null ? '' : s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 随机取一项 */
export function pick(array) {
  if (!Array.isArray(array) || !array.length) return undefined;
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * 洗牌（Fisher–Yates），返回新数组，不改动入参。
 *
 * 注意：不要用 `arr.slice().sort(() => Math.random() - 0.5)` 来"随机打乱"——
 * 用随机比较器排序在 JS 里是**有偏**的（排序算法不保证每种排列等概率，
 * 越靠后的元素越难被排到前面）。实测 4 个元素取 2 个时，最后一位的出现率只有 37%，
 * 而公平值是 50%。这里用标准 Fisher–Yates，每种排列等概率。
 * @template T
 * @param {T[]} array
 * @returns {T[]}
 */
export function shuffle(array) {
  const out = Array.isArray(array) ? array.slice() : [];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/** 等待 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 数值裁剪 */
export function clamp(n, min, max) {
  const v = num(n, min);
  return Math.min(max, Math.max(min, v));
}

/** 安全数字 */
export function num(v, d = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 14:05 */
export function fmtTime(ts) {
  const d = new Date(num(ts, Date.now()));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 今天 / 昨天 / 3月5日 / 2024年3月5日 */
export function fmtDay(ts) {
  const d = new Date(num(ts, Date.now()));
  const now = new Date();
  if (isSameDay(d, now)) return '今天';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (isSameDay(d, yest)) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 2024-03-05 14:05 */
export function fmtDate(ts) {
  const d = new Date(num(ts, Date.now()));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

/** 刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 具体日期 */
export function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - num(ts);
  if (diff < 30 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtDay(ts);
}

/** 同一天 */
export function isSameDay(a, b) {
  const d1 = new Date(a instanceof Date ? a.getTime() : num(a));
  const d2 = new Date(b instanceof Date ? b.getTime() : num(b));
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 时间感知上下文（注入提示词，让角色"知道现在几点"）
 * @returns {{now:number,hour:number,minute:number,dateStr:string,weekStr:string,partOfDay:string,isWeekend:boolean}}
 */
export function timeContext() {
  const d = new Date();
  const hour = d.getHours();
  let partOfDay = '深夜';
  if (hour >= 5 && hour < 9) partOfDay = '清晨';
  else if (hour >= 9 && hour < 12) partOfDay = '上午';
  else if (hour >= 12 && hour < 14) partOfDay = '中午';
  else if (hour >= 14 && hour < 18) partOfDay = '下午';
  else if (hour >= 18 && hour < 23) partOfDay = '晚上';
  return {
    now: d.getTime(),
    hour,
    minute: d.getMinutes(),
    dateStr: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
    weekStr: WEEK[d.getDay()],
    partOfDay,
    isWeekend: d.getDay() === 0 || d.getDay() === 6,
  };
}

/**
 * 粗略估算 token：中日韩字符 ≈ 1 token，其他每 4 字符 ≈ 1 token
 * @param {string} text
 */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/** 字符数 */
export function countChars(text) {
  return String(text == null ? '' : text).length;
}

/* ------------------------------------------------------------------ *
 * 展示层公用映射（原先在 ui/app.js、core/prompt.js、ui/settings.js、core/llm.js、
 * ui/chat.js、core/group.js 各复制了一份，且默认值已经不一致，统一到这里）
 * ------------------------------------------------------------------ */

/** 情绪英文键 → 中文（未知一律"平静"，与界面显示保持一致） */
export function moodZh(mood) {
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

/** 时间戳 → YYYY-MM-DD（按本地时区）。接受 Date 或数字 */
export function dayKey(ts) {
  const d = ts instanceof Date ? ts : new Date(num(ts, Date.now()));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 费用估算的安全包装：出错/未知模型返回 0，绝不因为统计问题打断对话
 * @param {(provider:string, model:string, usage:object)=>number} estimate 估算函数
 * @param {string} provider
 * @param {string} model
 * @param {object} usage
 * @returns {number}
 */
export function safeCostWith(estimate, provider, model, usage) {
  try {
    const v = typeof estimate === 'function' ? estimate(provider, model, usage) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** 触发浏览器下载 */
export function download(filename, blobOrText, mime = 'application/json') {
  const blob =
    blobOrText instanceof Blob ? blobOrText : new Blob([String(blobOrText)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 读取文件为文本 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('文件读取失败'));
    fr.readAsText(file, 'utf-8');
  });
}

/** 读取文件为 dataURL（头像用） */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('文件读取失败'));
    fr.readAsDataURL(file);
  });
}

/** 复制文本到剪贴板（含降级） */
export async function copyText(text) {
  const s = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 按"用户感知的一个字符"（图形簇）切分，正确处理 emoji 的肤色/变体选择符/组合序列 */
let segmenter = null;
export function toGraphemes(s) {
  const t = String(s == null ? '' : s);
  if (!t) return [];
  try {
    if (!segmenter && typeof Intl !== 'undefined' && Intl.Segmenter) {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    }
    if (segmenter) return [...segmenter.segment(t)].map((x) => x.segment);
  } catch {
    /* 落回下面的实现 */
  }
  // 退路：至少别把变体选择符 / ZWJ / 肤色修饰符切开
  const out = [];
  for (const ch of Array.from(t)) {
    const cp = ch.codePointAt(0);
    const isJoiner = cp === 0xfe0f || cp === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff);
    if (isJoiner && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** 取首字（无头像时显示）。emoji 也能正确取到完整的一个 */
export function firstChar(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '?';
  const arr = toGraphemes(t);
  return arr[0] || '?';
}

/** 取前 n 个"图形簇"（emoji 不会被切成半个） */
export function takeGraphemes(s, n) {
  return toGraphemes(s).slice(0, Math.max(0, n)).join('');
}

/** 截断（按字符，带省略号） */
export function truncate(s, n) {
  const t = String(s == null ? '' : s);
  const arr = Array.from(t);
  return arr.length <= n ? t : arr.slice(0, n).join('') + '…';
}

/**
 * 朗读前清洗：去掉 Markdown 标记、代码块、URL、括注动作等对听感无用的内容
 * @param {string} s
 */
export function stripMarkdown(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/```[\s\S]*?```/g, ' 代码块省略 ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, ' 链接 ');
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/\*\*([^*]*)\*\*/g, '$1');
  t = t.replace(/\*([^*]*)\*/g, '$1');
  t = t.replace(/~~([^~]*)~~/g, '$1');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{2,}/g, '\n');
  return t.trim();
}
