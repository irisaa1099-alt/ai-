#!/usr/bin/env node
/**
 * 布局对齐审计（零依赖 + 无头 Chrome）
 *
 * 不靠肉眼：把页面上关键元素的 getBoundingClientRect / computedStyle 全量取回，
 * 再用一组"对齐不变量"去找真正没对齐的地方。
 *
 * 检查项：
 *   A. 左对齐：同一列里的文本/头像左边缘是否对齐
 *   B. 基线：头像与相邻文本块是否垂直居中
 *   C. 内边距一致：同一容器的左右内边距是否相等（不偏一侧）
 *   D. 图标按钮等宽等高
 *   E. 面板首尾元素与容器边缘的间距是否统一
 *   F. 消息行：头像、气泡、元信息、操作栏的左边缘层级
 *   G. 多视口（1440 / 1024 / 768 / 390）下是否出现溢出、遮挡、错位
 *   H. 文本是否溢出容器（scrollWidth > clientWidth）
 *   I. 中文名字有没有被后面的文本挤成"一字一行"的竖排
 *   J. 按钮型内容行里的正文有没有被浏览器默认的 text-align:center 居中（搜索结果等）
 *   K. 勾选框有没有被表单控件的通用样式撑成方块（height/padding/底色）
 *
 * 用法：node tools/aligncheck.mjs [--port 5198] [--shots]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, sleep, freePort } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const argPort = (() => {
  const i = process.argv.indexOf('--port');
  const base = 5197 + Math.floor(Math.random() * 30);
  return i >= 0 ? process.argv[i + 1] : String(base);
})();
const SHOTS = process.argv.includes('--shots');
/** 测试专用数据目录：与真实 data/db 隔离，避免互相污染 */
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-testdb-'));
const OUT = path.join(ROOT, 'tools', 'align-report.json');

/** 页面内采集脚本：返回所有需要审计的元素矩形与样式 */
const PROBE = `(() => {
  const px = (v) => Math.round(parseFloat(v || '0') * 100) / 100;
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height), r: px(r.right), b: px(r.bottom) }; };
  const info = (sel, root) => {
    const n = (root || document).querySelector(sel);
    if (!n) return null;
    const cs = getComputedStyle(n);
    return {
      sel,
      rect: rect(n),
      pad: { l: px(cs.paddingLeft), r: px(cs.paddingRight), t: px(cs.paddingTop), b: px(cs.paddingBottom) },
      mar: { l: px(cs.marginLeft), r: px(cs.marginRight), t: px(cs.marginTop), b: px(cs.marginBottom) },
      gap: cs.gap,
      display: cs.display,
      align: cs.alignItems,
      justify: cs.justifyContent,
      overflowX: cs.overflowX,
      scroll: { sw: n.scrollWidth, cw: n.clientWidth, sh: n.scrollHeight, ch: n.clientHeight },
      text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 22),
    };
  };
  const list = (sel) => [...document.querySelectorAll(sel)]
    // display:none 的元素没有几何可言，不该参与"尺寸一致 / 触摸目标够大"这类审计：
    // 例如窄屏（≤1000px）下被隐藏的「收起右栏」按钮就是 0×0。真正该在的按钮若被
    // 意外隐藏，下面各处 info() 取到的整条工具条 rect 仍会露馅。
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .slice(0, 8)
    .map((n) => {
      const cs = getComputedStyle(n);
      return { rect: rect(n), pad: { l: px(cs.paddingLeft), r: px(cs.paddingRight), t: px(cs.paddingTop), b: px(cs.paddingBottom) }, text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 18) };
    });

  const out = {
    viewport: { w: innerWidth, h: innerHeight },
    shell: info('.shell'),
    side: info('.pane-side'),
    main: info('.pane-main'),
    right: info('.pane-right'),
    // 左侧
    sideHead: info('.side-head'),
    sideTitle: info('.side-title'),
    sideSub: info('.side-sub'),
    sideSearch: info('.side-search'),
    sideSearchInput: info('.side-search input'),
    sideBody: info('.side-body'),
    sideList: info('.side-list'),
    groupHead: info('.group-head'),
    groupBody: info('.group-body'),
    friend: info('.friend'),
    friendAvatar: info('.friend .avatar'),
    friendMain: info('.friend .friend-main'),
    friendName: info('.friend .friend-name'),
    friendTop: info('.friend .friend-top'),
    friendPreview: info('.friend .friend-preview'),
    sideFoot: info('.side-foot'),
    footButtons: list('.side-foot button'),
    // 中间
    chatHead: info('.chat-head'),
    chatAvatar: info('.chat-head .avatar'),
    chatHeadMain: info('.chat-head-main'),
    chatHeadName: info('.chat-head-name'),
    chatHeadStatus: info('.chat-head-status'),
    chatTools: info('.chat-head-tools'),
    chatToolsBtns: list('.chat-head-tools .icon-btn'),
    chatBody: info('.chat-body'),
    dayLine: info('.day-line'),
    userAvatar: info('.msg.me .avatar'),
    userWrap: info('.msg.me .msg-wrap'),
    userBubble: info('.msg.me .bub'),
    userMeta: info('.msg.me .msg-meta'),
    msg: info('.msg.ai'),
    msgAvatar: info('.msg.ai .avatar'),
    msgWrap: info('.msg.ai .msg-wrap'),
    bub: info('.msg.ai .bub'),
    msgMeta: info('.msg.ai .msg-meta'),
    msgTools: info('.msg.ai .msg-tools'),
    msgToolsBtns: list('.msg-tools .icon-btn'),
    chatFoot: info('.chat-foot'),
    inputRow: info('.input-row'),
    composerInput: info('#composerInput'),
    inputSide: info('.input-side'),
    sendBtn: info('#sendBtn'),
    footBar: info('.chat-foot-bar'),
    inputSideBtns: list('.input-side .icon-btn, .input-side .btn'),
    // 右侧
    rightHead: info('.right-head'),
    rightBody: info('.right-body'),
    cardHero: info('.card-hero'),
    chatEmpty: info('.pane-main .empty'),
    kv: info('.kv'),
    // 弹层
    modal: info('.modal'),
    modalHead: info('.modal-head'),
    modalTitle: info('.modal-title'),
    modalBody: info('.modal-body'),
    modalFoot: info('.modal-foot'),
  };

  // 左对齐操作行（如数据备份弹层的三行）：图标必须贴在容器内边距上，三行必须同列
  const actionRows = [...document.querySelectorAll('.action-row, .modal-body button.btn, .sheet-item')]
    .filter((n) => n.getClientRects().length)
    .map((n) => {
      const cs = getComputedStyle(n);
      const ic = n.querySelector('.ic');
      return {
        text: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18),
        box: rect(n),
        justify: cs.justifyContent,
        textAlign: cs.textAlign,
        padL: px(cs.paddingLeft),
        icX: ic ? px(ic.getBoundingClientRect().x) : null,
        html: n.className && typeof n.className === 'string' ? n.className.slice(0, 30) : n.tagName,
      };
    });
  out.actionRows = actionRows;

  // 全页扫描：文案靠左却把内容居中排布的按钮（"文字回中"的典型症状）
  const misplaced = [];
  for (const n of document.querySelectorAll('button')) {
    if (!n.getClientRects().length) continue;
    const cs = getComputedStyle(n);
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
    if (cs.textAlign !== 'left' && cs.textAlign !== 'start') continue;
    if (cs.justifyContent !== 'center') continue;
    if (n.children.length < 2) continue;
    misplaced.push({
      cls: (typeof n.className === 'string' ? n.className : n.tagName).slice(0, 34),
      text: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      box: rect(n),
    });
  }
  out.misplaced = misplaced.slice(0, 12);

  // 表单控件：高度必须落在统一档位（避免"某个输入框特别大"）
  const controls = [...document.querySelectorAll('input, select, textarea')]
    .filter((n) => n.getClientRects().length && !['hidden', 'range', 'checkbox', 'color', 'file'].includes(n.type))
    .map((n) => {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return {
        tag: n.tagName.toLowerCase() + (n.type ? '[' + n.type + ']' : ''),
        h: Math.round(r.height),
        w: Math.round(r.width),
        lineHeight: cs.lineHeight,
        pad: cs.padding,
        label: (n.closest('.field')?.querySelector('.field-label')?.textContent || '').slice(0, 14)
          || (n.placeholder || '').slice(0, 20) || (typeof n.className === 'string' ? n.className.slice(0, 20) : ''),
        textarea: n.tagName === 'TEXTAREA',
      };
    });
  out.controls = controls;

  // 文本溢出检测（只看可见元素）
  const overflow = [];
  for (const n of document.querySelectorAll('button, .friend-name, .friend-preview, .chat-head-name, .chat-head-status, .msg-meta, .kv .v, .field-label, .modal-title, .pill')) {
    if (!n.getClientRects().length) continue;
    const cs = getComputedStyle(n);
    if (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') continue; // 有意截断，不算问题
    if (n.scrollWidth - n.clientWidth > 2 || n.scrollHeight - n.clientHeight > 2) {
      const r = n.getBoundingClientRect();
      overflow.push({
        cls: n.className && typeof n.className === 'string' ? n.className.slice(0, 40) : n.tagName,
        text: (n.textContent || '').trim().slice(0, 24),
        sw: n.scrollWidth, cw: n.clientWidth, sh: n.scrollHeight, ch: n.clientHeight,
        x: Math.round(r.x), y: Math.round(r.y),
      });
    }
  }
  out.overflow = overflow.slice(0, 20);
  return out;
})()`;

/** 把采集结果压成可比的数字表 */
function collect(page) {
  return page.eval(PROBE);
}

const problems = [];
const notes = [];
function problem(title, detail) {
  problems.push({ title, detail });
}
function note(text) {
  notes.push(text);
}

/** 断言工具 */
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
function sameEdge(label, a, b, tol = 1.5) {
  if (a == null || b == null) return;
  if (!near(a, b, tol)) problem(`${label} 未对齐`, `相差 ${(Math.abs(a - b)).toFixed(2)}px（${a} vs ${b}）`);
}

/* ------------------------------------------------------------------ */
const child = spawn(process.execPath, ['server.mjs', '--port', argPort, '--no-open', '--data-dir', TMP_DATA], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise(async (resolve, reject) => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${argPort}/api/health`);
      if (r.ok) return resolve();
    } catch {}
    await sleep(150);
  }
  child.kill();
  reject(new Error('服务器启动失败'));
});

const page = await launch({ port: await freePort(), width: 1440, height: 900 });
const reports = {};

try {
  // 造点数据：两个角色、几条消息（含引用），保证各元素都存在
  await page.goto(`http://127.0.0.1:${argPort}/`);
  await sleep(1500);
  await page.eval(`(async () => {
    const store = await import('./core/store.js');
    const tpl = await import('./data/templates.js');
    store.setSettings({ onboarded: true, theme: 'dark', showDebug: false });
    const list = await store.listCharacters();
    const c1 = list[0] || await store.saveCharacter(tpl.templateToCharacter(tpl.CHARACTER_TEMPLATES[0]));
    const c2 = list[1] || await store.saveCharacter(tpl.templateToCharacter(tpl.CHARACTER_TEMPLATES[6] || tpl.CHARACTER_TEMPLATES[1]));
    localStorage.setItem('aichat.lastChar', c1.id);
    const msgs = await store.listMessages(c1.id);
    if (msgs.length < 4) {
      await store.clearMessages(c1.id);
      await store.appendMessage({ charId: c1.id, role: 'assistant', content: '……你来了。今天过得怎么样？我刚刚在画一幅海边的画。', status: 'done', emotion: 'happy', usage: { total: 128 } });
      await store.appendMessage({ charId: c1.id, role: 'user', content: '刚下班，有点累。你今天画得顺利吗？' });
      await store.appendMessage({ charId: c1.id, role: 'assistant', content: '还算顺利。不过总觉得少了点什么。（把画笔放下，歪头看你）', status: 'done', usage: { total: 96 } });
      await store.appendMessage({ charId: c1.id, role: 'user', content: '那要不要出去走走？我请客。', quoted: { id: 'x', role: 'assistant', content: '还算顺利。不过总觉得少了点什么。' } });
    }
    await new Promise(r => setTimeout(r, 400));
    return { c1: c1.id, c2: c2.id };
  })()`);

  await page.goto(`http://127.0.0.1:${argPort}/`);
  await sleep(2600);

  /* =============== 桌面 1440 =============== */
  console.log('\n=== 桌面 1440×900 ===');
  const d = await collect(page);

  // 顺便量一下"还没有选择好友"的空态是否居中（切到未选状态再切回来）
  const dEmpty = await (async () => {
    await page.eval(`(async () => { window.__AICHAT__.openChat(null); await new Promise(r => setTimeout(r, 500)); })()`);
    const snap = await collect(page);
    await page.eval(`(async () => { const id = window.__AICHAT__.state.characters[0] && window.__AICHAT__.state.characters[0].id; window.__AICHAT__.openChat(id); await new Promise(r => setTimeout(r, 600)); })()`);
    return snap;
  })();
  if (dEmpty.chatEmpty && dEmpty.main) {
    const dx = Math.abs(dEmpty.chatEmpty.rect.x + dEmpty.chatEmpty.rect.w / 2 - (dEmpty.main.rect.x + dEmpty.main.rect.w / 2));
    const dy = Math.abs(dEmpty.chatEmpty.rect.y + dEmpty.chatEmpty.rect.h / 2 - (dEmpty.main.rect.y + dEmpty.main.rect.h / 2));
    if (dx > 2 || dy > 4) problem('未选择好友的空态没有在会话区居中', `偏移 水平 ${dx.toFixed(1)}px / 垂直 ${dy.toFixed(1)}px`);
    if (dEmpty.chatEmpty.rect.h < dEmpty.main.rect.h * 0.8) {
      problem('空态没有撑满会话区（垂直居中的前提）', `空态高 ${dEmpty.chatEmpty.rect.h} vs 面板高 ${dEmpty.main.rect.h}`);
    }
    note(`空态居中：水平偏移 ${dx.toFixed(1)}px、垂直偏移 ${dy.toFixed(1)}px（面板 ${dEmpty.main.rect.w}×${dEmpty.main.rect.h}）`);
  }
  reports.desktop = d;

  // A. 左边缘对齐
  sameEdge('侧栏标题与搜索框左边缘', d.sideTitle?.rect?.x, d.sideSearch?.rect?.x, 2);
  sameEdge('侧栏搜索框与好友卡片左边缘', d.sideSearch?.rect?.x, d.friend?.rect?.x, 2);
  sameEdge('侧栏分组标题与好友卡片左边缘', d.groupHead?.rect?.x, d.friend?.rect?.x, 2);
  sameEdge('好友名与好友摘要左边缘', d.friendMain?.rect?.x, d.friendName?.rect?.x, 2);

  // B. 垂直居中：头像 vs 文本块
  if (d.friend?.rect && d.friendAvatar?.rect) {
    const avMid = d.friendAvatar.rect.y + d.friendAvatar.rect.h / 2;
    const rowMid = d.friend.rect.y + d.friend.rect.h / 2;
    if (!near(avMid, rowMid, 2)) problem('好友行头像未垂直居中', `头像中心 ${avMid.toFixed(1)} vs 行中心 ${rowMid.toFixed(1)}`);
  }
  if (d.chatHead?.rect && d.chatAvatar?.rect) {
    const avMid = d.chatAvatar.rect.y + d.chatAvatar.rect.h / 2;
    const headMid = d.chatHead.rect.y + d.chatHead.rect.h / 2;
    if (!near(avMid, headMid, 2.5)) problem('聊天头部头像未垂直居中', `头像中心 ${avMid.toFixed(1)} vs 头部中心 ${headMid.toFixed(1)}`);
  }

  // C. 内边距左右一致
  for (const key of ['sideHead', 'sideBody', 'chatHead', 'chatBody', 'chatFoot', 'rightHead', 'rightBody', 'modalBody', 'modalHead', 'modalFoot', 'sideFoot']) {
    const el = d[key];
    if (!el || !el.pad) continue;
    if (el.pad.l !== el.pad.r) {
      const diff = Math.abs(el.pad.l - el.pad.r);
      if (diff > 1) problem(`${key} 左右内边距不等`, `left=${el.pad.l} right=${el.pad.r}`);
    }
  }

  // C2. 三栏左右内边距是否统一（视觉整齐的关键）
  const pads = {
    sideHead: d.sideHead?.pad?.l,
    sideBody: d.sideBody?.pad?.l,
    sideFoot: d.sideFoot?.pad?.l,
    chatHead: d.chatHead?.pad?.l,
    chatBody: d.chatBody?.pad?.l,
    chatFoot: d.chatFoot?.pad?.l,
    rightHead: d.rightHead?.pad?.l,
    rightBody: d.rightBody?.pad?.l,
  };
  const sidePads = [pads.sideHead, pads.sideBody, pads.sideFoot].filter((v) => v != null);
  if (sidePads.length >= 2 && Math.max(...sidePads) - Math.min(...sidePads) > 1) {
    problem('左侧栏三段（头部/列表/底部）左右留白不统一', JSON.stringify(pads));
  }
  const chatPads = [pads.chatHead, pads.chatBody, pads.chatFoot].filter((v) => v != null);
  if (chatPads.length >= 2 && Math.max(...chatPads) - Math.min(...chatPads) > 1) {
    problem('中间栏三段（头部/消息区/输入区）左右留白不统一', JSON.stringify(pads));
  }
  const rightPads = [pads.rightHead, pads.rightBody].filter((v) => v != null);
  if (rightPads.length === 2 && Math.abs(rightPads[0] - rightPads[1]) > 1) {
    problem('右侧栏头部与内容左右留白不一致', JSON.stringify(pads));
  }

  // C3. 会话区：消息内容左边缘 == 输入框左边缘（同一条竖直栅格）
  sameEdge('消息区首行与输入框左边缘', d.msg?.rect?.x, d.composerInput?.rect?.x, 1);
  sameEdge('消息元信息与气泡左边缘', d.msgMeta?.rect?.x, d.bub?.rect?.x, 1);
  sameEdge('头部头像与消息区左边缘', d.chatAvatar?.rect?.x, d.composerInput?.rect?.x, 1);
  sameEdge('底部信息条与输入框左边缘', d.footBar?.rect?.x, d.composerInput?.rect?.x, 1);

  // F2. 左对齐操作行：三行图标必须同列，且贴着内边距
  if (d.actionRows && d.actionRows.length) {
    const xs = d.actionRows.map((r) => r.icX).filter((v) => v != null);
    if (xs.length >= 2 && Math.max(...xs) - Math.min(...xs) > 1) {
      problem('操作行图标不在同一列', `图标 x：${xs.join(' / ')}`);
    }
    const badJustify = d.actionRows.filter((r) => r.justify === 'center');
    if (badJustify.length) {
      problem('操作行被多余地水平居中（应有 justify-content:flex-start）', badJustify.map((r) => r.text).join(' / '));
    }
    const badAlign = d.actionRows.filter((r) => r.textAlign === 'center');
    if (badAlign.length) problem('操作行文字被居中对齐', badAlign.map((r) => r.text).join(' / '));
    for (const r of d.actionRows) {
      if (r.icX == null) continue;
      const expect = r.box.x + r.padL;
      if (Math.abs(r.icX - expect) > 1.5) problem('操作行图标未贴住内边距', `"${r.text}" 图标 ${r.icX} 期望 ${expect.toFixed(1)}`);
    }
  }

  // F3. 全页"文案靠左但排布居中"的按钮
  if (d.misplaced && d.misplaced.length) {
    for (const m of d.misplaced) problem(`按钮排版与文字对齐方式矛盾：${m.cls}`, `"${m.text}" text-align=left 却 justify-content=center`);
  }

  // I. 表单控件高度规范：单行控件必须落在 30~42px，且同一页内不超过 3 档高度
  if (d.controls && d.controls.length) {
    const singles = d.controls.filter((c) => !c.textarea);
    const tooBig = singles.filter((c) => c.h > 42);
    const tooSmall = singles.filter((c) => c.h < 24);
    for (const c of tooBig) problem('输入框过高（旁边控件会被挤）', `${c.tag} ${c.w}×${c.h} "${c.label}"`);
    for (const c of tooSmall) problem('输入框过矮', `${c.tag} ${c.w}×${c.h} "${c.label}"`);
    const buckets = [...new Set(singles.map((c) => c.h))].sort((a, b) => a - b);
    if (buckets.length > 3) problem('同一页里控件高度档位过多', `高度档：${buckets.join(' / ')}`);
    // 行高不能继承 body 的 1.65（14px × 1.65 ≈ 23px 会把控件撑高）
    const badLh = singles.filter((c) => parseFloat(c.lineHeight) > 22);
    for (const c of badLh) problem('控件行高过大（可能继承了 body 的 1.65）', `${c.tag} line-height=${c.lineHeight} "${c.label}"`);
  }

  // D. 图标按钮尺寸一致
  const sizeSet = (list, label) => {
    if (!list || list.length < 2) return;
    const ws = [...new Set(list.map((b) => Math.round(b.rect.w)))];
    const hs = [...new Set(list.map((b) => Math.round(b.rect.h)))];
    if (ws.length > 1 || hs.length > 1) problem(`${label}尺寸不一致`, `宽 ${ws.join('/')} 高 ${hs.join('/')}`);
  };
  sizeSet(d.chatToolsBtns, '聊天头部图标按钮');
  sizeSet(d.msgToolsBtns, '消息操作图标按钮');
  sizeSet(d.footButtons, '侧栏底栏按钮');

  // D2. 按钮垂直居中：图标按钮的 y 中心 vs 所在工具条中心
  if (d.chatTools?.rect && d.chatToolsBtns?.length) {
    const barMid = d.chatTools.rect.y + d.chatTools.rect.h / 2;
    for (const b of d.chatToolsBtns.slice(0, 4)) {
      const mid = b.rect.y + b.rect.h / 2;
      if (!near(mid, barMid, 1.5)) problem('聊天头部按钮未与工具条居中对齐', `按钮中心 ${mid.toFixed(1)} vs 工具条 ${barMid.toFixed(1)}`);
    }
  }

  // E. 面板首尾元素与容器边缘
  if (d.chatBody?.rect && d.msg?.rect) {
    const padTop = d.msg.rect.y - d.chatBody.rect.y;
    if (padTop < 6) problem('消息区顶部留白过小', `${padTop.toFixed(1)}px`);
  }
  if (d.sideFoot?.rect && d.sideBody?.rect) {
    const gap = d.sideFoot.rect.y - d.sideBody.rect.b;
    if (gap < -2) problem('侧栏底栏与列表重叠', `重叠 ${(-gap).toFixed(1)}px`);
  }

  // F. 消息行内部层级：头像 → 气泡 → 元信息/操作栏 左边缘
  if (d.msgWrap?.rect && d.bub?.rect) {
    sameEdge('气泡与消息列左边缘', d.msgWrap.rect.x, d.bub.rect.x, 1.5);
  }
  if (d.msgWrap?.rect && d.msgMeta?.rect) {
    sameEdge('消息元信息与消息列左边缘', d.msgWrap.rect.x, d.msgMeta.rect.x, 6);
  }
  if (d.msgAvatar?.rect && d.msgWrap?.rect) {
    const gap = d.msgWrap.rect.x - d.msgAvatar.rect.r;
    if (gap < 4 || gap > 16) problem('头像与气泡水平间距异常', `${gap.toFixed(1)}px（期望 6~12）`);
  }

  if (d.userWrap?.rect && d.userBubble?.rect && d.userMeta?.rect) {
    sameEdge('用户气泡与消息列右边缘', d.userWrap.rect.r, d.userBubble.rect.r, 1.5);
    sameEdge('用户元信息与气泡右边缘', d.userMeta.rect.r, d.userBubble.rect.r, 1.5);
  }
  if (d.userAvatar?.rect && d.userWrap?.rect) {
    const gap = d.userAvatar.rect.x - d.userWrap.rect.r;
    if (gap < 4 || gap > 16) problem('用户头像与气泡间距异常', `${gap.toFixed(1)}px`);
  }

  // G. 输入区：输入框 / 按钮底部对齐（都是 align-items:flex-end）
  if (d.composerInput?.rect && d.sendBtn?.rect) {
    const db = Math.abs(d.composerInput.rect.b - d.sendBtn.rect.b);
    if (db > 3) problem('输入框与发送按钮底边不齐', `相差 ${db.toFixed(1)}px`);
    if (d.sendBtn.rect.w !== d.sendBtn.rect.h) note(`发送按钮不是正方形：${d.sendBtn.rect.w}×${d.sendBtn.rect.h}`);
  }
  if (d.footBar?.rect && d.chatFoot?.rect) {
    const pb = d.chatFoot.rect.b - d.footBar.rect.b;
    const pr = d.chatFoot.rect.r - d.footBar.rect.r;
    if (pb < 0) problem('底部信息条溢出输入区容器', `超出 ${(-pb).toFixed(1)}px`);
  }

  // H. 文本溢出
  if (d.overflow?.length) {
    for (const o of d.overflow.slice(0, 8)) problem(`元素内容溢出：${o.cls}`, `"${o.text}" ${o.sw}>${o.cw} @(${o.x},${o.y})`);
  }

  /* =============== 名字排版（中文名被挤成竖排是典型回归） =============== */
  console.log('=== 名字排版 ===');
  {
    // 造一个"长名字 + 长职业"的群：名字以前会被后面的职业文本压窄成 1~2 个字一行
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const tpl = await import('./data/templates.js');
      const cast = [
        { name: '两面宿傩', emoji: '👹', job: '诅咒之王 / 特级咒物（二十根手指）' },
        { name: '五条悟', emoji: '🕶️', job: '特级咒术师 / 东京都立咒术高等专门学校教师' },
        { name: '老K', emoji: '😤', job: '自由职业 / 十年老网民' },
        { name: '程栖', emoji: '🌙', job: '深夜电台主播（节目《夜航船》）' },
        { name: '树洞', emoji: '🕳️', job: '一棵会回话的树洞' },
        { name: '沈雁', emoji: '📰', job: '《沪光日报》社会版记者' },
      ];
      const ids = [];
      for (const c of cast) {
        const saved = await store.saveCharacter({ ...tpl.templateToCharacter(tpl.CHARACTER_TEMPLATES[0]), ...c, tagline: '', persona: { personality: '测试' } });
        ids.push(saved.id);
      }
      const g = await store.saveGroup({ name: '名字排版测试群', members: ids, autoDelayMs: 0 });
      await new Promise(r => setTimeout(r, 500));
      await window.__AICHAT__.openGroup(g.id);
      await new Promise(r => setTimeout(r, 1600));
      document.querySelectorAll('.onboard, .modal-mask').forEach(n => n.remove());
    })()`);
    await sleep(700);
    const names = await page.eval(`(() => [...document.querySelectorAll('.pane-right .gp-member-name')].map((row) => {
      const b = row.querySelector('b');
      const job = row.querySelector('.small');
      const cs = getComputedStyle(b);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const br = b.getBoundingClientRect();
      // 职业那段文字每一行的实际起点（Range.getClientRects 能拿到换行后的行盒）
      let jobLines = [];
      if (job) {
        const range = document.createRange();
        range.selectNodeContents(job);
        jobLines = [...range.getClientRects()].map((x) => Math.round(x.left));
      }
      return {
        name: b.textContent,
        w: Math.round(br.width),
        nameLeft: Math.round(br.left),
        lines: Math.max(1, Math.round(br.height / lh)),
        jobLines,
      };
    }))()`);
    if (!names.length) {
      problem('群资料成员列表没有渲染出来', '找不到 .gp-member-name b，名字排版这一项无法审计');
    } else {
      let flushChecked = 0;
      for (const n of names) {
        if (n.lines > 1) problem('名字被挤成了竖排', `「${n.name}」只占 ${n.w}px 宽、被换成了 ${n.lines} 行`);
        // 职业换行后的第二行起必须与名字左边缘对齐（顶格），不能缩进到职业盒的位置
        for (const left of n.jobLines.slice(1)) {
          flushChecked++;
          if (Math.abs(left - n.nameLeft) > 2) {
            problem('名字旁的说明文字换行后没有顶格', `「${n.name}」的续行起点 x=${left}，名字左边缘 x=${n.nameLeft}（相差 ${Math.abs(left - n.nameLeft)}px）`);
          }
        }
      }
      note(`名字排版：${names.length} 位成员全部单行、${flushChecked} 处换行续行均顶格（${names.map((n) => n.name).join('、')}）`);
    }
    // 回到一对一会话，避免影响后面的检查
    await page.eval(`(async () => { const id = window.__AICHAT__.state.characters[0] && window.__AICHAT__.state.characters[0].id; await window.__AICHAT__.openChat(id); await new Promise(r => setTimeout(r, 600)); })()`);
    await sleep(500);
  }

  /* =============== 搜索结果行：正文必须左对齐（按钮默认居中会传染） =============== */
  console.log('=== 搜索结果行 ===');
  {
    // 先确保"当前会话里一定有能被搜到的消息"，否则这一项会变成看运气的检查
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const chat = await import('./ui/chat.js');
      const list = await store.listCharacters();
      const target = list[0];
      await store.appendMessage({ charId: target.id, role: 'user', content: '排版检查专用句子：老师，我是伏黑惠啊，你不认得我吗' });
      await new Promise(r => setTimeout(r, 400));
      await window.__AICHAT__.openChat(target.id);
      await new Promise(r => setTimeout(r, 900));
      document.querySelectorAll('.onboard, .modal-mask').forEach(n => n.remove());
      chat.openSearchDialog();
      await new Promise(r => setTimeout(r, 600));
      const input = document.querySelector('.search-bar input');
      input.value = '老师';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1100));
      document.querySelectorAll('.onboard').forEach(n => n.remove());
    })()`);
    await sleep(400);
    const hits = await page.eval(`(() => [...document.querySelectorAll('.hit')].map((hit) => {
      const nameEl = hit.querySelector('.h-top b');
      const text = hit.querySelector('.h-text');
      if (!nameEl || !text) return null;
      const range = document.createRange();
      range.selectNodeContents(text);
      const first = range.getClientRects()[0];
      const box = text.getBoundingClientRect();
      return {
        align: getComputedStyle(text).textAlign,
        btnAlign: getComputedStyle(hit).textAlign,
        nameLeft: Math.round(nameEl.getBoundingClientRect().left),
        textLeft: first ? Math.round(first.left) : null,
        boxLeft: Math.round(box.left),
        text: text.textContent.trim().slice(0, 14),
      };
    }).filter(Boolean))()`);
    if (!hits.length) {
      problem('会话内搜索没有渲染出结果行', '找不到 .hit（搜索结果排版无法审计）');
    } else {
      let bad = 0;
      for (const h of hits) {
        // <button> 的浏览器默认 text-align:center 会被里面的正文继承 → 正文看上去没顶格
        if (h.align !== 'left' && h.align !== 'start') {
          problem('搜索结果正文被居中了（按钮默认 text-align）', `「${h.text}…」text-align=${h.align}（.hit=${h.btnAlign}）`);
          bad++;
        }
        if (h.textLeft == null || Math.abs(h.textLeft - h.nameLeft) > 2) {
          problem('搜索结果正文没有顶格', `「${h.text}…」正文第一行 x=${h.textLeft}，名字 x=${h.nameLeft}`);
          bad++;
        }
      }
      if (!bad) note(`搜索结果行：${hits.length} 条正文均左对齐顶格（与名字同一条左边缘 x=${hits[0].nameLeft}）`);
    }
    await page.eval(`document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close())`);
    await sleep(400);
  }

  /* =============== 复选框尺寸（别被表单通用样式撑成方块） =============== */
  console.log('=== 复选框 ===');
  {
    const opened = await page.eval(`(async () => {
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      const st = await import('./ui/settings.js');
      st.openSettings('context'); // 记忆与上下文里开关最多
      await new Promise((r) => setTimeout(r, 900));
      return document.querySelectorAll('.modal-body input[type="checkbox"]').length;
    })()`);
    const boxes = await page.eval(`(() => [...document.querySelectorAll('.modal-body input[type="checkbox"]')].map((n) => {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, pad: cs.paddingTop, border: cs.borderTopWidth };
    }))()`);
    if (!boxes.length) {
      problem('设置面板里找不到复选框', `这一屏应当有开关（当前 ${opened} 个）`);
    } else {
      let bad = 0;
      for (const b of boxes) {
        // 通用表单控件样式是 height: --ctrl-h(≈35px) + 浅色底 + 内边距，勾选框不能被它影响
        if (b.h > 20) {
          problem('复选框被撑高了', `高 ${b.h}px（应≈13px）—— 多半又继承了表单控件的通用样式`);
          bad++;
        }
        if (b.bg !== 'rgba(0, 0, 0, 0)') {
          problem('复选框带了底色', `${b.bg}`);
          bad++;
        }
        if (parseFloat(b.border) > 0) {
          problem('复选框带了边框', `${b.border}`);
          bad++;
        }
      }
      if (!bad) note(`复选框尺寸正常：${boxes.length} 个，均 ${boxes[0].w}×${boxes[0].h}、无底色无边框`);
    }
    await page.eval(`document.querySelectorAll('.modal-mask').forEach((n) => n.__close && n.__close())`);
    await sleep(400);
  }

  /* =============== 弹层 =============== */
  console.log('=== 弹层（设置 / 编辑器 / 模板库）===');
  const modalChecks = [
    ['设置面板', `(async () => { const m = await import('./ui/settings.js'); m.openSettings('model'); await new Promise(r=>setTimeout(r,600)); })()`],
    ['角色卡编辑器', `(async () => { const s = await import('./core/store.js'); const e = await import('./ui/editor.js'); const c = (await s.listCharacters())[0]; e.openCharacterEditor(c); await new Promise(r=>setTimeout(r,600)); })()`],
    ['模板库', `(async () => { const e = await import('./ui/editor.js'); e.openTemplateGallery(); await new Promise(r=>setTimeout(r,700)); })()`],
  ];
  for (const [label, script] of modalChecks) {
    await page.eval(script);
    const m = await collect(page);
    reports[label] = { modal: m.modal, modalHead: m.modalHead, modalBody: m.modalBody, modalFoot: m.modalFoot, overflow: m.overflow };
    const md = m.modal;
    if (md) {
      // 弹层是否水平居中于视口
      const cx = md.rect.x + md.rect.w / 2;
      const vcx = 1440 / 2;
      if (!near(cx, vcx, 2)) problem(`${label} 未水平居中`, `中心 ${cx.toFixed(1)} vs 视口中心 ${vcx}`);
      // 头部/内容/底部三段左右留白
      const pads2 = [m.modalHead?.pad?.l, m.modalBody?.pad?.l, m.modalFoot?.pad?.l].filter((v) => v != null);
      if (pads2.length >= 2 && Math.max(...pads2) - Math.min(...pads2) > 1) {
        problem(`${label} 头/体/脚左右留白不一致`, JSON.stringify({ head: m.modalHead?.pad?.l, body: m.modalBody?.pad?.l, foot: m.modalFoot?.pad?.l }));
      }
      // 内容是否溢出
      if (m.modalBody?.scroll?.sw > m.modalBody?.scroll?.cw + 2) problem(`${label} 内容横向溢出`, `${m.modalBody.scroll.sw}>${m.modalBody.scroll.cw}`);
    } else {
      problem(`${label} 未打开`, '找不到 .modal');
    }
    if (m.overflow?.length) for (const o of m.overflow.slice(0, 5)) problem(`${label} 内元素溢出：${o.cls}`, `"${o.text}" ${o.sw}>${o.cw}`);
    for (const mm of m.misplaced || []) problem(`${label} 内按钮排版矛盾：${mm.cls}`, `"${mm.text}" text-align=left 却居中排布`);
    await page.eval(`document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close())`);
    await sleep(350);
  }

  /* =============== 多视口 =============== */
  console.log('=== 多视口（1024 / 768 / 390）===');
  for (const [w, h, mobile] of [[1024, 800, false], [768, 900, true], [390, 844, true]]) {
    await page.client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }, page.sessionId);
    await sleep(700);
    const v = await collect(page);
    reports[`${w}x${h}`] = v;
    // 横向溢出（页面出现横向滚动条 = 布局破了）
    const docOverflow = await page.eval(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
    if (docOverflow.sw > docOverflow.cw + 1) problem(`${w}px 视口出现横向滚动`, `${docOverflow.sw} > ${docOverflow.cw}`);
    // 关键元素不能跑到视口外
    const outside = [];
    for (const [k, el] of Object.entries(v)) {
      if (!el || !el.rect || Array.isArray(el) || k === 'overflow') continue;
      if (el.rect.w === 0 && el.rect.h === 0) continue;
      if (el.rect.x < -1 || el.rect.r > w + 1) outside.push(k);
    }
    if (outside.length) problem(`${w}px 视口下有元素越界`, outside.join(', '));
    if (v.overflow?.length) for (const o of v.overflow.slice(0, 4)) problem(`${w}px 视口元素溢出：${o.cls}`, `"${o.text}" ${o.sw}>${o.cw}`);
    // 每个视口下，可见面板的三段左右留白必须一致
    const visible = (e) => e && e.rect && e.rect.w > 0 && e.rect.h > 0;
    const seg = (a, b, c, label) => {
      const vals = [a, b, c].filter((e) => visible(e)).map((e) => e.pad.l);
      if (vals.length >= 2 && Math.max(...vals) - Math.min(...vals) > 1) {
        problem(`${w}px 视口下${label}三段留白不一致`, vals.join(' / '));
      }
    };
    seg(v.sideHead, v.sideBody, v.sideFoot, '侧栏');
    seg(v.chatHead, v.chatBody, v.chatFoot, '会话区');
    // 可见面板内，消息内容左边缘要与输入框一致
    if (visible(v.msg) && visible(v.composerInput)) sameEdge(`${w}px 视口消息与输入框左边缘`, v.msg.rect.x, v.composerInput.rect.x, 1);
    // 触摸目标尺寸（移动端可用性）
    if (w <= 768) {
      for (const [k, list] of [['输入区按钮', v.inputSideBtns], ['头部按钮', v.chatToolsBtns]]) {
        for (const b of list || []) {
          if (b.rect.w < 30 || b.rect.h < 30) problem(`${w}px 视口${k}过小`, `${b.rect.w}×${b.rect.h}`);
        }
      }
    }
    if (SHOTS) {
      const f = path.join(ROOT, 'tools', `align-${w}.png`);
      await page.shot(f);
      note(`截图 ${f}`);
    }
  }
  await page.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
  await sleep(400);

  /* =============== 主题对比 =============== */
  console.log('=== 浅色主题复检 ===');
  await page.eval(`(async () => { const s = await import('./ui/settings.js'); s.applyTheme('light', '#6c8cff'); })()`);
  await sleep(600);
  const light = await collect(page);
  reports.light = light;
  if (light.overflow?.length) for (const o of light.overflow.slice(0, 5)) problem(`浅色主题元素溢出：${o.cls}`, `"${o.text}" ${o.sw}>${o.cw}`);
  await page.eval(`(async () => { const s = await import('./ui/settings.js'); s.applyTheme('dark', '#6c8cff'); })()`);

  fs.writeFileSync(OUT, JSON.stringify(reports, null, 2));
  console.log(`\n原始数据：${OUT}`);
} catch (err) {
  problem('审计脚本执行失败', err.message);
} finally {
  console.log('\n================ 对齐审计结果 ================');
  if (!problems.length) {
    console.log('✅ 未发现对齐问题。');
  } else {
    const seen = new Set();
    console.log(`发现 ${problems.length} 处需要关注：`);
    for (const p of problems) {
      const key = p.title + p.detail;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  · ${p.title} —— ${p.detail}`);
    }
  }
  if (notes.length) {
    console.log('\n备注：');
    notes.forEach((n) => console.log('  - ' + n));
  }
  await page.close();
  child.kill('SIGKILL');
  try {
    fs.rmSync(TMP_DATA, { recursive: true, force: true });
  } catch {}
}
// 发现问题就用非零退出码：以前固定 exit(0)，批量跑测试或 CI 里"有布局问题"也会被判成通过
process.exit(problems.length ? 1 : 0);
