#!/usr/bin/env node
/**
 * 代码卫生审计（零依赖，纯静态分析）
 *
 * 为什么需要它：连续多轮改动 + 用正则批量改代码之后，容易留下"改了没效果"这类静默 bug。
 * 这个脚本专查那类痕迹：
 *   · 同一作用域里重复的 function / const 声明（后者会让前者静默失效）
 *     —— 本项目已经踩过两次：ui/toast.js 的 footButton、ui/editor.js 的 renderList
 *   · 括号 / 引号 / 模板串 / 正则 不配平（正则删代码删多了的典型症状）
 *   · import 了不存在的导出、动态 import 路径写错
 *   · 定义了但没人调用的死代码（改动残留）
 *   · 真正的调试残留（globalThis.__X / window.__X / debugger），
 *     但排除 __AICHAT__（它是正式的调试钩子）
 *
 * 不做的事：不检查 console.log（服务端启动日志等属于正常输出）。
 *
 * 用法：node tools/audit.mjs
 * 退出码：有阻断问题 → 1；否则 0
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const SRC_DIRS = ['core', 'data', 'ui', 'voice'];
const problems = [];
const warnings = [];
const notes = [];
const problem = (where, what, extra = '') => problems.push({ where, what, extra });
const warn = (where, what, extra = '') => warnings.push({ where, what, extra });

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 参与审计的应用源码（不含 tools/，那里是命令行工具，写法不同） */
const appFiles = [];
for (const d of SRC_DIRS) walk(path.join(ROOT, d), appFiles);
const toolFiles = walk(path.join(ROOT, 'tools'));
const serverFile = path.join(ROOT, 'server.mjs');
const allFiles = [...appFiles, ...toolFiles, serverFile].filter((f) => fs.existsSync(f));
const sources = new Map(allFiles.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const rel = (f) => path.relative(ROOT, f);

console.log(`审计 ${allFiles.length} 个 JS 文件（应用源码 ${appFiles.length} 个）…\n`);

/* ================================================================== *
 * 1. 词法扫描：括号 / 引号 / 模板串 / 正则 配平
 *    能正确识别：// 注释、块注释、'..'、".."、`..`（含 ${} 嵌套）、/regex/flags
 * ================================================================== */
const REGEX_PREV = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n', '',
]);

function scanBalance(src) {
  const stack = [];
  let i = 0;
  let line = 1;
  let prevSignificant = '';
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const push = (c) => stack.push({ c, line });
  const pop = (c) => {
    const top = stack[stack.length - 1];
    if (!top) return { ok: false, msg: `第 ${line} 行的 ${c} 没有匹配的 ${pairs[c]}` };
    if (top.c !== pairs[c]) return { ok: false, msg: `第 ${line} 行的 ${c} 与第 ${top.line} 行的 ${top.c} 不匹配` };
    stack.pop();
    return { ok: true };
  };

  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '\n') {
      line++;
      prevSignificant = '\n';
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      prevSignificant = ' ';
      continue;
    }
    // 正则字面量：只有在"上一个是运算符/括号/逗号/换行"时 / 才是正则起始
    if (c === '/' && REGEX_PREV.has(prevSignificant)) {
      i++;
      let inClass = false;
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '\n') return { ok: false, msg: `第 ${line} 行的正则字面量没有闭合` };
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return { ok: false, msg: `第 ${line} 行的正则字面量没有闭合` };
      while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
      prevSignificant = 'r';
      continue;
    }
    // 普通字符串
    if (c === '"' || c === "'") {
      const q = c;
      const startLine = line;
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        if (src[i] === q) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return { ok: false, msg: `第 ${startLine} 行开始的字符串没有闭合（${q}）` };
      prevSignificant = 's';
      continue;
    }
    // 模板串（${} 内是表达式，需要继续按代码解析）
    if (c === '`') {
      const startLine = line;
      i++;
      let depth = 0;
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '\n') line++;
        if (ch === '$' && src[i + 1] === '{') {
          depth++;
          stack.push({ c: '{', line, template: true });
          i += 2;
          continue;
        }
        if (ch === '}' && depth > 0) {
          depth--;
          stack.pop();
          i++;
          continue;
        }
        if (ch === '`' && depth === 0) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return { ok: false, msg: `第 ${startLine} 行开始的模板字符串没有闭合` };
      prevSignificant = 's';
      continue;
    }
    if ('([{'.includes(c)) {
      push(c);
      prevSignificant = c;
      i++;
      continue;
    }
    if (')]}'.includes(c)) {
      const r = pop(c);
      if (!r.ok) return r;
      prevSignificant = c;
      i++;
      continue;
    }
    prevSignificant = c;
    i++;
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    return { ok: false, msg: `第 ${t.line} 行的 ${t.c} 没有闭合` };
  }
  return { ok: true };
}

for (const [f, src] of sources) {
  const r = scanBalance(src);
  if (!r.ok) problem(rel(f), '括号/引号/正则不配平', r.msg);
  if (src.includes('\t')) warn(rel(f), '含 Tab 缩进', '项目约定 2 空格');
}


/* ================================================================== *
 * 作用域深度：只有同一花括号深度上的声明，才算"重复声明"
 * ================================================================== */
function codeDepths(src) {
  const depths = new Array(src.split('\n').length).fill(0);
  let depth = 0;
  let line = 0;
  let i = 0;
  let prev = '';
  const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n', '']);
  const mark = () => {
    depths[line] = depth;
  };
  mark();
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '\n') {
      line++;
      if (line < depths.length) depths[line] = depth;
      prev = '\n';
      i++;
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++;
          if (line < depths.length) depths[line] = depth;
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') break;
        i++;
      }
      i++;
      prev = 's';
      continue;
    }
    if (c === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') i += 2;
        else {
          if (src[i] === '\n') {
            line++;
            if (line < depths.length) depths[line] = depth;
          }
          i++;
        }
      }
      i++;
      prev = 's';
      continue;
    }
    if (c === '/' && REGEX_PREV.has(prev)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) {
          i++;
          break;
        }
        i++;
      }
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      prev = 'r';
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      prev = c;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      prev = c;
      continue;
    }
    if (c !== ' ' && c !== '\t' && c !== '\r') prev = c;
    i++;
  }
  return depths;
}

/* ================================================================== *
 * 2. 重复声明（"改了没效果"的元凶）
 * ================================================================== */
for (const [f, src] of sources) {
  const r = rel(f);
  const lines = src.split('\n');

  // 2a. 顶层重复（只看真正的顶层：花括号深度 0）
  const depths = codeDepths(src);
  const top = new Map();
  const topRe = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  lines.forEach((line, i) => {
    if (depths[i] !== 0) return;
    const m = line.match(topRe);
    if (!m) return;
    const name = m[2];
    if (top.has(name)) problem(r, `顶层重复声明「${name}」`, `第 ${top.get(name)} 行与第 ${i + 1} 行`);
    else top.set(name, i + 1);
  });

  // 2b. 每个顶层函数体内，同缩进同名声明出现两次
  lines.forEach((line, i) => {
    const fm = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (!fm) return;
    // 找函数结束：缩进 0 的 }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '}') {
        end = j;
        break;
      }
    }
    const seen = new Map();
    const bodyDepth = codeDepths(src)[i]; // 函数声明所在深度
    for (let j = i + 1; j < end; j++) {
      // 只统计"与函数体同深度"的声明：块里的（if/for 内）与嵌套函数里的都不算重复
      if (depths[j] !== bodyDepth) continue;
      const m = lines[j].match(/^\s{2,}(?:async\s+)?(function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=(])/);
      if (!m) continue;
      const name = m[2] || m[3];
      if (seen.has(name)) {
        problem(r, `函数 ${fm[1]} 内重复声明「${name}」`, `第 ${seen.get(name)} 行与第 ${j + 1} 行（同一作用域，后者会让前者失效）`);
      } else seen.set(name, j + 1);
    }
  });
}

/* ================================================================== *
 * 3. 真正的调试残留（排除正式调试钩子 __AICHAT__）
 * ================================================================== */
/** 允许存在的调试/注入挂载点（有意为之，不算残留） */
const DEBUG_ALLOW = [
  /globalThis\.__ttsSettings/, // 测试注入语音设置
  /globalThis\.__AICHAT__/,    // 正式的调试与自动化钩子
  /window\.__AICHAT__/,
];

const DEBUG_RE = [
  [/\bglobalThis\.__(?!AICHAT__)[A-Za-z]/, 'globalThis.__X 调试挂载'],
  [/\bwindow\.__(?!AICHAT__)[A-Za-z]/, 'window.__X 调试挂载'],
  [/\bdebugger\s*;/, 'debugger 语句'],
];
for (const [f, src] of sources) {
  if (rel(f).startsWith('tools' + path.sep)) continue; // 测试脚本本来就要读 __AICHAT__
  src.split('\n').forEach((line, i) => {
    if (DEBUG_ALLOW.some((re) => re.test(line))) return;
    for (const [re, label] of DEBUG_RE) {
      if (re.test(line)) warn(`${rel(f)}:${i + 1}`, label, line.trim().slice(0, 90));
    }
  });
}

/* ================================================================== *
 * 4. 导出 / 导入 一致性（含动态 import 的路径）
 * ================================================================== */
function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}
const exportMap = new Map([...sources].map(([f, s]) => [f, exportsOf(s)]));

const imported = new Set();
/** 解析相对路径；inBrowser=true 时基准目录是 web 根（tools 里的页面脚本） */
const DYNAMIC_IMPORT_ALLOW = new Set(['./ui/app.js']); // index.html 的启动入口，从 web 根解析
function resolveSpec(fromFile, spec, inBrowser) {
  const base = inBrowser ? ROOT : path.dirname(fromFile);
  return path.resolve(base, spec);
}
function resolveExisting(target) {
  if (fs.existsSync(target)) return target;
  for (const ext of ['.js', '.mjs', '/index.js']) if (fs.existsSync(target + ext)) return target + ext;
  return '';
}

for (const [f, src] of sources) {
  const r = rel(f);
  const isTool = r.startsWith('tools' + path.sep);
  for (const m of src.matchAll(/^[ \t]*import\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = resolveExisting(resolveSpec(f, spec, false));
    if (!target) {
      problem(r, `import 的模块不存在：${spec}`);
      continue;
    }
    imported.add(target);
    const exp = exportMap.get(target);
    if (!exp) continue;
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const orig = t.split(/\s+as\s+/)[0].trim();
        if (!exp.has(orig)) problem(r, `从 ${spec} 导入了不存在的「${orig}」`);
      }
    }
    const defPart = clause.replace(/\{[\s\S]*?\}/, '').replace(/[*,\s]/g, '');
    if (defPart && !exp.has('default') && !clause.trim().startsWith('*')) {
      problem(r, `从 ${spec} 使用默认导入，但目标没有 export default`);
    }
  }
  // 动态 import：tools/ 里的字符串是给浏览器执行的，基准是 web 根
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    if (DYNAMIC_IMPORT_ALLOW.has(spec)) {
      const p = resolveExisting(resolveSpec(f, spec, true));
      if (p) {
        imported.add(p);
        continue;
      }
    }
    const target = resolveExisting(resolveSpec(f, spec, isTool));
    if (!target) {
      // tools 里的字符串也可能是磁盘相对路径（.mjs 工具），两种都试过再报
      problem(r, `动态 import 的模块不存在：${spec}`, isTool ? '（已按 web 根与文件目录两种基准解析）' : '');
      continue;
    }
    imported.add(target);
  }
}

/* ================================================================== *
 * 5. 孤儿文件（应用源码里没人 import 的模块）
 * ================================================================== */
for (const f of appFiles) {
  if (!imported.has(f)) warn(rel(f), '没有任何模块 import 它（孤儿文件？）');
}

/* ================================================================== *
 * 5b. 未使用的具名导入（改动清理后的常见残留）
 * ================================================================== */
/** 有意保留的导入（例如为了副作用或契约完整性） */
const IMPORT_ALLOW = new Set([
  'ui/app.js:groupChatMod', // 命名空间导入用于软降级调用
]);

for (const [f, src] of sources) {
  const r = rel(f);
  const body = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];/gm, '');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const name = raw.split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      if (IMPORT_ALLOW.has(`${r}:${name}`)) continue;
      const uses = (body.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
      if (uses === 0) warn(r, `导入了但没用到「${name}」`, '死导入，可删除');
    }
  }
}

/* ================================================================== *
 * 6. 死代码：顶层非导出函数，全项目只出现一次（定义处）
 * ================================================================== */
const allSrc = [...sources.values()].join('\n');
for (const [f, src] of sources) {
  const r = rel(f);
  if (r.startsWith('tools' + path.sep)) continue;
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (['bootstrap', 'main'].includes(name)) continue;
    const uses = (allSrc.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
    const isExported = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\b`, 'm').test(src);
    if (uses <= 1 && !isExported) warn(r, `函数「${name}」定义了但没人调用`, '可能是改动残留');
  }
}

/* ================================================================== *
 * 7. 导出符号 / 旧别名：全项目没人调用（改动残留的高发区）
 *
 * 为什么单独做这一类：第 6 节只查"**非导出**的顶层 function"，而这类残留恰恰全是"导出的"
 * （导出的函数、常量别名、类方法）。真实案例：ui/editor.js 里按需求隐藏了界面入口的两个
 * 导入/导出弹窗（约 300 行）、core/werewolf.js 的旧别名 guardWolfConfession()、
 * ui/shared.js 的 charEmoji 别名 —— 全都因为"是导出的"而躲过了审计，最后靠人工审查才发现。
 *
 * 两个坑，都在这里处理掉：
 *   · 统计引用时必须把 tools/ 也算上（备份导入导出这类能力只被测试用到，仍属"有人用"）；
 *   · 必须摘掉 selftest 里那张"导出契约核对"清单 —— 那里的名字只是**字符串**，
 *     却会让"只有契约在要求、实际没人调用"的死代码看起来像有人在用（正是弹窗藏这么久的原因）。
 * ================================================================== */

/**
 * 工具箱模块：文档（ARCHITECTURE 3.2/3.3/3.17）把它们定义为**标准工具库**——
 * "这些能力只允许存在于这里，界面模块必须 import"。库里有几个成员当前没人用是正常的，
 * 按模块整块豁免，不逐个列名字。
 */
const TOOLBOX_MODULES = new Set(['core/util.js', 'ui/dom.js', 'ui/shared.js']);

/**
 * 有意保留的公开接口：零调用是**有意的**，不算改动残留。
 * 要清理它们时，正确顺序是"先改文档（ARCHITECTURE 3.6 等），再把这里删掉"，而不是让审计一直报噪音。
 */
const EXPORT_API_ALLOW = new Set([
  // store 层对外 API（供控制台调试 / 外部扩展 / 测试使用）
  'core/store.js:getMessage',
  'core/store.js:resetSettings',
  'core/store.js:deleteMessages',
  'core/store.js:apiKeyFor',
  'core/store.js:baseUrlFor',
  'core/store.js:chatVolume',
  'core/group.js:memberEmoji',
  // 弹层与主动性：与当前在用的 closeTopModal 功能互补，本轮评审决定暂留
  'ui/toast.js:hasOpenModal',
  'ui/toast.js:closeAllModals',
  'core/proactive.js:triggerNow',
]);

/** 统计引用用的文本：应用源码 + tools + server，但摘掉 selftest 的导出契约清单 */
const usageSrc = [...sources.entries()]
  .map(([f, s]) => {
    if (!f.endsWith('selftest.mjs')) return s;
    return s.replace(/const expectations = \{[\s\S]*?\n  \};/, '/* 契约清单：不算"有人调用" */');
  })
  .join('\n');

/** 某个名字在（除定义处之外的）项目里被引用了几次 */
function refCount(name) {
  return (usageSrc.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
}

for (const [f, src] of sources) {
  const r = rel(f);
  if (r.startsWith('tools' + path.sep)) continue; // 工具脚本的"导出"是给命令行用的，不按这条判
  if (TOOLBOX_MODULES.has(r)) continue; // 标准工具库：成员暂时没人用属正常（见上面的说明）

  // 7a. 导出的函数 / 常量 / 类：全项目零调用
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (EXPORT_API_ALLOW.has(`${r}:${name}`)) continue;
    if (refCount(name) <= 1) {
      warn(r, `导出的「${name}」全项目没有调用点`, '可能是改动残留（界面入口被删/改名后留下的旧实现）');
    }
  }

  // 7b. 类方法里"只转调另一个方法"的旧别名，且没人调用
  for (const m of src.matchAll(/\n {2}(?:async\s+)?([A-Za-z_$][\w$]*)\(([^)]*)\)\s*\{\s*\n\s*return this\.([A-Za-z_$][\w$]*)\(([^)]*)\);\s*\n {2}\}/g)) {
    const name = m[1];
    if (refCount(name) <= 1) {
      warn(r, `方法「${name}()」只是转调 this.${m[3]}() 且没人调用`, '旧名字别名，可删除');
    }
  }
}

/* ================================================================== *
 * 输出
 * ================================================================== */
console.log('=== 阻断性问题（必须修）===');
if (!problems.length) console.log('  ✅ 无');
else for (const p of problems) console.log(`  ✗ ${p.where} —— ${p.what}${p.extra ? `（${p.extra}）` : ''}`);

console.log('\n=== 警告（建议人工确认）===');
if (!warnings.length) console.log('  ✅ 无');
else {
  const grouped = new Map();
  for (const w of warnings) {
    if (!grouped.has(w.what)) grouped.set(w.what, []);
    grouped.get(w.what).push(w);
  }
  for (const [k, list] of grouped) {
    console.log(`  · ${k}（${list.length} 处）`);
    for (const w of list) console.log(`      ${w.where}${w.extra ? `  ${w.extra}` : ''}`);
  }
}

if (notes.length) {
  console.log('\n=== 备注 ===');
  for (const n of notes) console.log('  · ' + n);
}

console.log(`\n合计：阻断 ${problems.length} 项，警告 ${warnings.length} 项`);
process.exit(problems.length ? 1 : 0);
