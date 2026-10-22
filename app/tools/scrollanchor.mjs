#!/usr/bin/env node
/**
 * 侧栏折叠 / 展开时的滚动位置回归测试（零依赖 + 无头 Chrome）。
 *
 * 起因：点左边分组标题折叠或展开，只要列表比视口长，列表就会"啪"地弹回最顶端。
 * 根因：renderList() 用 mount() 整块重建 .side-body。被清空的滚动容器 scrollTop 必然归零
 *       （实测：先设 scrollTop=300，再移除全部子节点，scrollTop 立刻变 0，把节点加回去也回不来），
 *       所以"重绘 = 回到列表顶部"。
 * 守的是 ui/sidebar.js 里的 captureScrollAnchor() / restoreScrollAnchor()：
 * 重绘前记下视口内第一个带 data-key 的行（分组块 / 好友行 / 群聊行），
 * 重绘后找到同一个元素，按它挪动的距离补偿 scrollTop。
 *
 * 注意：测试会强制 `.side-body { overflow-anchor: none }`。
 * Chrome 原生的滚动锚定会在内容变动时替我们保住位置、把这里的 bug 盖住，
 * 关掉它，位置能不能保住才只取决于我们自己的实现（用户浏览器上原生锚定不一定生效）。
 *
 * 用法：node tools/scrollanchor.mjs [--keep]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, sleep, freePort } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = await freePort();
const KEEP = process.argv.includes('--keep');
/** 测试专用数据目录：与真实 data/db 隔离 */
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-scrolldb-'));

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const d = await fn();
    passed++;
    console.log(`  ✓ ${name}${d ? `  → ${d}` : ''}`);
  } catch (err) {
    failed++;
    failures.push(`${name}：${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

async function waitFor(fn, { timeout = 15000, interval = 150, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待${label}超时`);
    await sleep(interval);
  }
}

/**
 * 页面内助手。每次 eval 都是独立脚本，所以每次都内联声明一遍；
 * window 是持久的，所以不用额外记状态。
 */
const HELPERS = `
window.__SA__ = {
  /** 造 4 个分组 × 5 个好友（id 用 ASCII：服务端 /api/db 会拒绝非 ASCII id） */
  seed: async () => {
    const store = await import('./core/store.js');
    const names = ['甲组', '乙组', '丙组', '丁组'];
    for (let gi = 0; gi < names.length; gi++) {
      for (let i = 1; i <= 5; i++) {
        await store.saveCharacter({ id: 'sa_g' + gi + '_' + i, name: names[gi] + i, group: names[gi], greeting: ['hi'] });
      }
    }
    return (await store.listCharacters()).length;
  },
  box: () => document.querySelector('.side-body'),
  state: () => {
    const box = window.__SA__.box();
    if (!box) return null;
    return {
      scrollTop: Math.round(box.scrollTop),
      max: Math.round(box.scrollHeight - box.clientHeight),
      groups: Array.from(box.querySelectorAll('.group')).map((g) => g.dataset.key).filter(Boolean),
      collapsed: Array.from(box.querySelectorAll('.group-head.collapsed')).map((h) => h.parentElement.dataset.key),
    };
  },
  /** 某个带 data-key 的行相对滚动容器顶边的偏移（= 用户看到的纵向位置） */
  offsetOf: (key) => {
    const box = window.__SA__.box();
    const row = Array.from(box.querySelectorAll('[data-key]')).find((n) => n.dataset.key === key);
    if (!row) return null;
    return Math.round(row.getBoundingClientRect().top - box.getBoundingClientRect().top);
  },
  /** 某个行被哪些分组块包含着（好友行的 key 是 friend:xxx，光看名字判断不出它属于哪个分组） */
  groupsOf: (key) => {
    const box = window.__SA__.box();
    const row = Array.from(box.querySelectorAll('[data-key]')).find((n) => n.dataset.key === key);
    if (!row) return [];
    return Array.from(box.querySelectorAll('.group'))
      .filter((g) => g.contains(row))
      .map((g) => g.dataset.key);
  },
  /** 视口内所有行的位置（挑一个"稳定参照物"时用） */
  visibleRows: () => {
    const box = window.__SA__.box();
    const top = box.getBoundingClientRect().top;
    const bottom = top + box.clientHeight;
    return Array.from(box.querySelectorAll('[data-key]'))
      .map((n) => ({ key: n.dataset.key, offset: Math.round(n.getBoundingClientRect().top - top) }))
      .filter((r) => r.offset > -160 && r.offset < bottom - top);
  },
  /** 视口内第一行（它就是重绘时会被当作锚点的那一行） */
  firstVisible: () => {
    const box = window.__SA__.box();
    const top = box.getBoundingClientRect().top;
    const row = Array.from(box.querySelectorAll('[data-key]')).find((n) => n.getBoundingClientRect().bottom > top);
    if (!row) return null;
    return { key: row.dataset.key, offset: Math.round(row.getBoundingClientRect().top - top), scrollTop: Math.round(box.scrollTop) };
  },
  scrollTo: (ratio) => {
    const box = window.__SA__.box();
    box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) * ratio);
    return Math.round(box.scrollTop);
  },
  scrollToBottom: () => {
    const box = window.__SA__.box();
    box.scrollTop = box.scrollHeight;
    return Math.round(box.scrollTop);
  },
  /**
   * 触发某个区块的标题（好友分组是 .group-head，群聊区是 .group-head-toggle）。
   * 故意不用 HTMLElement.click()：标题是 <button>，click() 会把它 focus 上，
   * 浏览器为了露出聚焦元素会顺手滚动容器 —— 那会污染"滚动位置有没有变"的观测。
   * 派发一个不触发默认焦点行为的事件即可。
   */
  clickGroup: (key) => {
    const g = document.querySelector('.side-body .group[data-key="' + key + '"]');
    if (!g) throw new Error('找不到分组 ' + key);
    const head = g.querySelector('.group-head') || g.querySelector('.group-head-toggle');
    if (!head) throw new Error('分组 ' + key + ' 没有可点的标题');
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  },
  clickSection: () => {
    const t = document.querySelector('.gchat-group-head .group-head-toggle');
    if (!t) throw new Error('找不到群聊区标题');
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  },

  /* ------------------------------------------------------------------ *
   * 建群 / 拉人弹层里的成员列表（.ge-member-list）
   *
   * 同一类根因的第二处现场：勾一个角色，列表（max-height:240 + overflow:auto）
   * 就自己弹回最上方。这里只做"打开弹层 + 读写列表"的小助手，
   * 断言放在用例里。点行一律用**真实鼠标事件**（CDP Input）——
   * 只有真实点击才会把焦点给到行上，而"焦点是否被重建吃掉"正是要守的东西之一。
   * ------------------------------------------------------------------ */
  geOpen: () => {
    const btn = document.querySelector('.gchat-group-block [data-role="new-group"]');
    if (!btn) throw new Error('找不到「新建群聊」按钮');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  },
  geList: () => document.querySelector('.ge-member-list'),
  geState: () => {
    const box = window.__SA__.geList();
    if (!box) return null;
    const rows = Array.from(box.querySelectorAll('.ge-member'));
    return {
      scrollTop: Math.round(box.scrollTop),
      max: Math.round(box.scrollHeight - box.clientHeight),
      rows: rows.length,
      on: rows.filter((n) => n.classList.contains('on')).length,
      chips: document.querySelectorAll('.ge-chip').length,
      /** 当前焦点元素的类名（用来判断焦点有没有被重建吃掉） */
      focusClass: (document.activeElement && document.activeElement.className) || String(document.activeElement && document.activeElement.tagName),
    };
  },
  /** 滚到成员列表最底部 —— 真实用户找靠后的角色时就是这么滚的，也正是这条 bug 的触发位置 */
  geScrollToBottom: () => {
    const box = window.__SA__.geList();
    box.scrollTop = box.scrollHeight;
    return Math.round(box.scrollTop);
  },
  /** 把弹层主体滚到"成员列表看得见"的位置（用户要先滚这一层才点得到列表） */
  geBodyScrollTo: (where) => {
    const mb = document.querySelector('.modal-body');
    const box = window.__SA__.geList();
    if (where === 'partial') {
      // 列表底部压出可视区 120px：更接近"没滚到底、列表下半截被裁掉"的真实状态
      mb.scrollTop = Math.round(mb.scrollTop + box.getBoundingClientRect().bottom - (mb.getBoundingClientRect().top + mb.clientHeight) + 120);
    } else {
      mb.scrollTop = Math.round(mb.scrollTop + box.getBoundingClientRect().top - mb.getBoundingClientRect().top - 30);
    }
    return Math.round(mb.scrollTop);
  },
  /**
   * 挑一行"视口里真的点得到"的行：必须是完整可见、且 elementFromPoint 命中的就是列表里的元素
   * （弹层里可能有 toast 之类的浮层压在上面，压着的行点不到）。
   * @param {'first'|'last'} which
   */
  gePickRow: (which) => {
    const box = window.__SA__.geList();
    const rows = Array.from(box.querySelectorAll('.ge-member'));
    const boxTop = box.getBoundingClientRect().top;
    const cands = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      const cy = Math.round(r.top + r.height / 2);
      const cx = Math.round(r.left + r.width / 2);
      if (cy < 4 || cy > innerHeight - 4) continue; // 视口外的点不到
      if (r.top < boxTop || r.bottom > boxTop + box.clientHeight) continue; // 列表自己裁掉的部分点不到
      const el = document.elementFromPoint(cx, cy);
      if (el && box.contains(el)) {
        cands.push({ i, x: cx, y: cy, name: (rows[i].querySelector('.ge-member-name') || {}).textContent || '', on: rows[i].classList.contains('on') });
      }
    }
    if (!cands.length) return null;
    return which === 'first' ? cands[0] : cands[cands.length - 1];
  },
  /** 记录成员列表的 scroll 事件（"跳了一下又跳回来"也要被抓到：只要发生过就算） */
  geWatchScroll: () => {
    const box = window.__SA__.geList();
    window.__GE_SCROLLS__ = [];
    if (box.__geWatch) box.removeEventListener('scroll', box.__geWatch);
    box.__geWatch = () => window.__GE_SCROLLS__.push(Math.round(box.scrollTop));
    box.addEventListener('scroll', box.__geWatch);
    return true;
  },
  geScrolls: () => window.__GE_SCROLLS__ || [],
  geClickChipX: (i) => {
    const x = document.querySelectorAll('.ge-chip .x')[i];
    if (!x) throw new Error('没有第 ' + i + ' 个 chip 的 ×');
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  },
  geSearch: (kw) => {
    const input = document.querySelector('.ge-members input[type="search"]');
    if (!input) throw new Error('找不到搜索框');
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  /**
   * 根因复核用的探针：另外造一个同款滚动容器（.ge-member-list），
   * 滚到中间后把子节点全部移除，看 scrollTop 会不会归零。
   * 不碰真列表，所以不影响别的用例。
   * 子节点必须 flex:0 0 44px：.ge-member-list 是 flex 列容器，
   * 空 div 会被 flex-shrink 压成 6px，那样根本撑不出滚动条（探针会假成功）。
   */
  geProbeCleared: () => {
    const box = document.createElement('div');
    box.className = 'ge-member-list';
    box.style.position = 'absolute';
    box.style.left = '-9999px';
    box.style.top = '0';
    for (let i = 0; i < 40; i++) {
      const d = document.createElement('div');
      d.style.cssText = 'flex:0 0 44px;height:44px';
      box.appendChild(d);
    }
    document.body.appendChild(box);
    box.scrollTop = 160;
    const before = Math.round(box.scrollTop);
    const max = Math.round(box.scrollHeight - box.clientHeight);
    // 滚到最底部再清空：底部的 scrollTop 是这条 bug 真正丢掉的场景，两种都量一下
    box.scrollTop = max;
    const atBottom = Math.round(box.scrollTop);
    while (box.firstChild) box.removeChild(box.firstChild);
    const afterClearBottom = Math.round(box.scrollTop);
    box.remove();
    return { before, max, atBottom, afterClearBottom };
  },
};
true;`;

const withHelpers = (body) => `(() => { ${HELPERS} ${body} })()`;
/** 折叠 / 展开后等一下：让 requestAnimationFrame 里的二次校正也跑完 */
const settle = () => sleep(260);

const child = spawn(process.execPath, ['server.mjs', '--port', String(PORT), '--no-open', '--data-dir', TMP_DATA], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise(async (resolve, reject) => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return resolve();
    } catch {}
    await sleep(150);
  }
  child.kill();
  reject(new Error('服务器启动失败'));
});

const page = await launch({ port: await freePort(), width: 1280, height: 720 });
let code = 1;

try {
  // ① Service Worker 的 PRECACHE 里有 ui/sidebar.js：装过 SW 的 profile 会一直拿到旧模块，
  //    测到的就不是磁盘上这一份。禁用它并顺手注销。
  await page.client.send('Network.setBypassServiceWorker', { bypass: true }, page.sessionId);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!document.querySelector(".side-body")'), { label: '侧栏' });
  await page
    .eval('(async () => { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); return rs.length; })()')
    .catch(() => 0);
  // ② 关掉浏览器原生滚动锚定（见文件头）
  await page.eval(
    `(() => { const st = document.createElement('style'); st.textContent = '.side-body{overflow-anchor:none}.ge-member-list{overflow-anchor:none}'; st.dataset.role = 'scrollanchor-test'; document.head.appendChild(st); return true; })()`
  );

  // ③ 确认原生锚定真的被关掉了：否则测到的是浏览器的功劳，不是我们的
  const anchorOff = await page.eval('(() => getComputedStyle(document.querySelector(".side-body")).overflowAnchor)()');
  assert(anchorOff === 'none', `overflow-anchor 没生效（${anchorOff}）`);
  /** 建群弹层里的成员列表同样要关掉原生锚定（它在弹层里，只有打开后才量得到） */
  const geAnchorOff = async () =>
    page.eval('(() => { const b = document.querySelector(".ge-member-list"); return b ? getComputedStyle(b).overflowAnchor : "(没有列表)"; })()');

  console.log('\n=== 1. 造一个比视口长的好友列表 ===');
  const seeded = await page.eval(withHelpers('return window.__SA__.seed();'));
  assert(seeded >= 20, `角色数量不足（${seeded}）`);
  await waitFor(
    async () =>
      page.eval('(() => { const b = document.querySelector(".side-body"); return b ? b.scrollHeight > b.clientHeight + 40 : false; })()'),
    { label: '可滚动的侧栏列表' }
  );
  await check('侧栏列表可滚动（内容高于视口）', async () => {
    const s = await page.eval(
      '(() => { const b = document.querySelector(".side-body"); return { h: Math.round(b.scrollHeight), v: Math.round(b.clientHeight) }; })()'
    );
    assert(s.h > s.v + 40, `scrollHeight=${s.h} clientHeight=${s.v}`);
    return `${s.h}px 内容 / ${s.v}px 视口`;
  });

  console.log('\n=== 2. 折叠"视口上方"的分组：视线锁定的那一行不能跳 ===');
  await check('滚到底后折叠最上面的分组，位置不回顶', async () => {
    await page.eval(withHelpers('return window.__SA__.scrollToBottom();'));
    await settle();
    const before = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
    assert(before, '没有可见行');
    assert(before.scrollTop > 40, `没能滚动（scrollTop=${before.scrollTop}）`);
    // 甲组此刻在视口上方：折叠它 = 上面少掉 5 行，不做补偿就会整体跳上去
    await page.eval(withHelpers(`return window.__SA__.clickGroup('group:甲组');`));
    await settle();
    const after = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
    assert(after, '重绘后没有可见行');
    assert(after.scrollTop > 0, `折叠后回到了列表顶部（scrollTop=${after.scrollTop}）`);
    // 折叠掉的内容正好在视口上方 → 视口里看到的东西必须"原地不动"。
    // 两种可接受的结果：
    //   ① 锚点行还是那一行、像素位置也没变（补偿生效）；
    //   ② 内容变短、原来的位置超出新底部 → 被夹到最底部（scrollTop == max），这是合理下限。
    // 唯一不可接受的就是"回到列表顶部"。
    const drift = Math.abs(after.offset - before.offset);
    const atBottom = after.scrollTop >= (await page.eval(withHelpers('return window.__SA__.state().max;'))) - 2;
    assert(drift <= 2 || atBottom, `视线位置抖动了 ${drift}px 且没有夹到底部（${before.key}@${before.offset} → ${after.key}@${after.offset}，scrollTop ${before.scrollTop}→${after.scrollTop}）`);
    return `视口行 ${before.key}@${before.offset} → ${after.key}@${after.offset}，scrollTop ${before.scrollTop}→${after.scrollTop}${atBottom ? '（夹到新底部）' : ''}`;
  });

  await check('再展开这个分组，位置同样不跳', async () => {
    const before = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
    await page.eval(withHelpers(`return window.__SA__.clickGroup('group:甲组');`));
    await settle();
    const after = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
    assert(after, '重绘后没有可见行');
    assert(after.key === before.key, `盯着的行从 ${before.key} 变成了 ${after.key}`);
    const drift = Math.abs(after.offset - before.offset);
    assert(drift <= 2, `锚点行「${before.key}」抖动了 ${drift}px（${before.offset} → ${after.offset}）`);
    return `scrollTop ${before.scrollTop}→${after.scrollTop}，漂移 ${drift}px`;
  });

  console.log('\n=== 3. 折叠视口内的分组 / 群聊整块 ===');
  await check('折叠视口内的分组：滚动位置保持', async () => {
    const before = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
    const state = await page.eval(withHelpers('return window.__SA__.state();'));
    // 只挑真正的"分组"标题（群聊区那一块是 .gchat-group-head，结构不同，另有用例）
    const target = state.groups.filter((k) => k !== 'gchat-section').find((k) => k !== before.key && !state.collapsed.includes(k));
    assert(target, '没有可折叠的分组');
    await page.eval(withHelpers(`return window.__SA__.clickGroup(${JSON.stringify(target)});`));
    await settle();
    const after = await page.eval(withHelpers('return window.__SA__.state();'));
    assert(after.collapsed.includes(target), `${target} 没有被折叠`);
    const offset = await page.eval(withHelpers(`return window.__SA__.offsetOf(${JSON.stringify(before.key)});`));
    assert(offset != null, `找不到锚点行 ${before.key}`);
    const drift = Math.abs(offset - before.offset);
    assert(drift <= 2, `锚点行「${before.key}」抖动了 ${drift}px`);
    return `折叠 ${target}，锚点 ${before.key} 漂移 ${drift}px`;
  });

  await check('折叠「群聊」整块：滚动位置不回顶', async () => {
    await page.eval(withHelpers('return window.__SA__.scrollTo(0.1);'));
    await settle();
    const before = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
    await page.eval(withHelpers('return window.__SA__.clickSection();'));
    await settle();
    const state = await page.eval(withHelpers('return window.__SA__.state();'));
    assert(state.collapsed.includes('gchat-section'), '群聊区没有被折叠');
    assert(state.scrollTop > 0, `折叠群聊区后回到了顶部（scrollTop=${state.scrollTop}）`);
    const offset = await page.eval(withHelpers(`return window.__SA__.offsetOf(${JSON.stringify(before.key)});`));
    assert(offset != null, `找不到锚点行 ${before.key}`);
    const drift = Math.abs(offset - before.offset);
    assert(drift <= 8, `锚点行「${before.key}」抖动了 ${drift}px`);
    return `锚点 ${before.key}：scrollTop ${before.scrollTop}→${state.scrollTop}，漂移 ${drift}px`;
  });

  console.log('\n=== 4. 边界：本来就在顶部 / 锚点所属分组被折叠 ===');
  await check('在顶部点折叠不会莫名其妙往下跳', async () => {
    await page.eval('(() => { document.querySelector(".side-body").scrollTop = 0; return true; })()');
    await settle();
    const state = await page.eval(withHelpers('return window.__SA__.state();'));
    const target = state.groups.find((k) => !state.collapsed.includes(k)) || state.groups[0];
    await page.eval(withHelpers(`return window.__SA__.clickGroup(${JSON.stringify(target)});`));
    await settle();
    const scrollTop = await page.eval('(() => Math.round(document.querySelector(".side-body").scrollTop))()');
    assert(scrollTop <= 2, `scrollTop=${scrollTop}，应该还停在顶部`);
    return `折叠 ${target} 后 scrollTop=${scrollTop}`;
  });

  await check('锚点所属分组被折叠时，退回原滚动位置而不是回顶', async () => {
    await page.eval(withHelpers('return window.__SA__.scrollTo(0.6);'));
    await settle();
    const before = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
    assert(before.scrollTop > 40, `没能滚动（${before.scrollTop}）`);
    const state = await page.eval(withHelpers('return window.__SA__.state();'));
    assert(!state.collapsed.includes(before.key), `锚点分组 ${before.key} 已经是折叠态`);
    await page.eval(withHelpers(`return window.__SA__.clickGroup(${JSON.stringify(before.key)});`));
    await settle();
    const after = await page.eval(withHelpers('return window.__SA__.state();'));
    assert(after.collapsed.includes(before.key), `${before.key} 没有被折叠`);
    // 锚点分组自己没了 → 只能退回原 scrollTop（可能被压缩到新的最大值）
    assert(after.scrollTop === Math.min(before.scrollTop, after.max), `期望退回到 ${Math.min(before.scrollTop, after.max)}，实际 ${after.scrollTop}（max=${after.max}）`);
    return `锚点分组 ${before.key} 被折叠：scrollTop ${before.scrollTop}→${after.scrollTop}（max=${after.max}）`;
  });

  await check('折叠视口上方任意一个分组：位置都不许回顶', async () => {
    // 前面几条各自只点了一个分组。这里把"所有折叠后会带动上方内容变少"的情形都过一遍：
    // 逐个把每个分组滚出视口上方，再折叠它，检查滚动位置没有被重置。
    await page.eval(withHelpers("localStorage.setItem('aichat.groups.collapsed', '[]'); return true;"));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('document.querySelectorAll(".side-body [data-key]").length'), { label: '列表重载' });
    await page.eval(
      `(() => { const st = document.createElement('style'); st.textContent = '.side-body{overflow-anchor:none}'; document.head.appendChild(st); return true; })()`
    );

    const covered = [];
    for (const key of ['group:丙组', 'group:丁组', 'group:甲组', 'group:乙组']) {
      // 把这个分组滚到视口上方：先定位到它自己，再往下多滚一点
      // 把这个分组整块滚到视口上方再折叠 —— 只有"整块在视口外"时，
      // "视口里的像素位置不许动"才是可断言的不变量。
      const pos = await page.eval(
        withHelpers(`
          const box = window.__SA__.box();
          const g = document.querySelector('.side-body .group[data-key="${key}"]');
          if (!g) return null;
          const rel = (n) => n.getBoundingClientRect().bottom - box.getBoundingClientRect().top + box.scrollTop;
          box.scrollTop = Math.min(box.scrollHeight, Math.round(rel(g) + 10));
          return { scrollTop: Math.round(box.scrollTop), bottomRel: Math.round(g.getBoundingClientRect().bottom - box.getBoundingClientRect().top) };`)
      );
      assert(pos, `找不到 ${key}`);
      await settle();
      const before = await page.eval(withHelpers('return window.__SA__.firstVisible();'));
      assert(before, `${key} 前没有可见行`);
      const above = await page.eval(
        withHelpers(`return Math.round(document.querySelector('.side-body .group[data-key="${key}"]').getBoundingClientRect().bottom - window.__SA__.box().getBoundingClientRect().top);`)
      );
      if (before.scrollTop <= 0 || above > 0) {
        covered.push(`${key}：整块滚不出视口上方，跳过`);
        continue;
      }
      await page.eval(withHelpers(`return window.__SA__.clickGroup(${JSON.stringify(key)});`));
      await settle();
      const after = await page.eval(withHelpers('return window.__SA__.state();'));
      assert(after.collapsed.includes(key), `${key} 没有被折叠`);
      assert(after.scrollTop > 0, `折叠视口上方的 ${key} 之后回到了列表顶部（scrollTop=0）`);
      // 参照物：折叠前位于视口顶部那一行，折叠后它的像素位置不能变
      // （折叠掉的内容在它上方 → 必须被补偿；在它下方 → 它本来就不该动）
      const offset = await page.eval(withHelpers(`return window.__SA__.offsetOf(${JSON.stringify(before.key)});`));
      assert(offset != null, `折叠 ${key} 后参照行 ${before.key} 不见了`);
      const drift = Math.abs(offset - before.offset);
      assert(drift <= 2, `折叠 ${key}：参照行「${before.key}」抖动了 ${drift}px（${before.offset} → ${offset}）`);
      covered.push(`${key} ${drift}px`);
    }
    return covered.join('，');
  });

  /* ------------------------------------------------------------------ *
   * 5. 建群 / 拉人弹层：勾一个角色，成员列表不许弹回顶部
   *
   * 与上面同根（同样是"清空滚动容器 → scrollTop 归零"，见下面第 2 条用例的探针），
   * 但触发条件更挑：成员列表滚到**中段**时，Chrome 里"清空 + 同步重建"侥幸能保住位置；
   * 一旦滚到**底部**（找靠后的角色就是常态），点一下就会掉回 scrollTop=0 —— 实测
   * 1546 → 0，而且真的冒出一条 scroll 事件（用户看得见）。所以这条用例的姿势是
   * "滚到底 + 真实鼠标点击"。
   *
   * 守的是 ui/groupeditor.js 的 memberPicker()：
   *   · 勾选 / 取消勾选**就地更新那一行**（不重建列表）→ 滚动位置与焦点都不受影响；
   *   · 不得已要重建时（点 chip 的 ×）用 renderList({keepScroll:true}) 把 scrollTop 放回去；
   *   · 只有搜索词变化才允许回到顶部（用户主动换了结果集）。
   * ------------------------------------------------------------------ */
  console.log('\n=== 5. 建群弹层：勾选成员不能让成员列表回顶 ===');
  // 上一条用例 goto 过一次页面，这里把"关掉成员列表原生锚定"的样式补上
  await page.eval(
    `(() => { if (document.querySelector('style[data-role="ge-anchor-test"]')) return true; const st = document.createElement('style'); st.textContent = '.ge-member-list{overflow-anchor:none}'; st.dataset.role = 'ge-anchor-test'; document.head.appendChild(st); return true; })()`
  );
  await page.eval(withHelpers('return window.__SA__.geOpen();'));
  await waitFor(async () => page.eval('document.querySelectorAll(".ge-member").length > 10'), { label: '建群弹层的成员列表' });
  // 弹层打开后会 focus 群名输入框（setTimeout 80ms），等它落定再量焦点
  await sleep(400);

  await check('成员列表可滚动，且原生锚定已关闭（测的是我们自己的实现）', async () => {
    const anchor = await geAnchorOff();
    assert(anchor === 'none', `成员列表 overflow-anchor 没生效（${anchor}）`);
    const s = await page.eval(withHelpers('const s = window.__SA__.geState(); return s && { rows: s.rows, max: s.max };'));
    assert(s && s.rows > 10, `成员行只有 ${s && s.rows}`);
    assert(s.max > 60, `列表不可滚动（max=${s.max}）`);
    return `${s.rows} 位好友，可滚动 ${s.max}px`;
  });

  await check('根因复核：被清空的滚动容器 scrollTop 一定归零', async () => {
    // 这条不是为了守修复，而是把"为什么必须就地更新"量成事实：
    // 只要走"清空 + 重建"，scrollTop 就回不到原来的值（尤其是已经滚到底的时候）。
    const r = await page.eval(withHelpers('return window.__SA__.geProbeCleared();'));
    assert(r.before > 100, `探针没能滚动（scrollTop=${r.before}）`);
    assert(r.max > 100, `探针撑不出滚动条（max=${r.max}）`);
    assert(r.afterClearBottom === 0, `清空后 scrollTop=${r.afterClearBottom}，与预期（0）不符——根因判断需要重新核对`);
    return `滚到中段 ${r.before}px、滚到底 ${r.atBottom}px（max=${r.max}）→ 清空后 ${r.afterClearBottom}px`;
  });

  await check('滚到列表底部，真实点击勾选一位角色：不回顶、焦点还在这一行', async () => {
    // 触发条件就是"滚到底"：旧代码里滚动位置在中间时重建能侥幸保住，
    // 一旦滚到底（找靠后的角色就是常态），点一下就会掉回 scrollTop=0。
    await page.eval(withHelpers("return window.__SA__.geBodyScrollTo('partial');"));
    await settle();
    const bottom = await page.eval(withHelpers('return window.__SA__.geScrollToBottom();'));
    await settle();
    assert(bottom > 100, `成员列表没能滚到底（scrollTop=${bottom}）`);

    const target = await page.eval(withHelpers("return window.__SA__.gePickRow('last');"));
    assert(target, '列表底部没有可点的行');
    const before = await page.eval(withHelpers('return window.__SA__.geState();'));
    await page.eval(withHelpers('return window.__SA__.geWatchScroll();'));
    // 真实鼠标事件：只有真实点击才会把焦点交给这一行，而"焦点有没有被重建吃掉"也是要守的东西
    await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y }, page.sessionId);
    await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }, page.sessionId);
    await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }, page.sessionId);
    await settle();
    const after = await page.eval(withHelpers('return window.__SA__.geState();'));
    const scrolls = await page.eval(withHelpers('return window.__SA__.geScrolls();'));
    assert(after.scrollTop === bottom, `滚到底时点「${target.name}」，列表从 ${bottom} 跳到了 ${after.scrollTop}${after.scrollTop === 0 ? '（回到了最上方）' : ''}`);
    assert(scrolls.length === 0, `点击过程中列表被滚动了（记录的 scroll 值：${JSON.stringify(scrolls)}）`);
    assert(after.on === before.on + 1, `选中行数没变（${before.on} → ${after.on}）`);
    assert(after.chips === before.chips + 1, `上方 chip 数量没变（${before.chips} → ${after.chips}）`);
    assert(after.focusClass.includes('ge-member'), `焦点被重建吃掉了（activeElement=${after.focusClass}）`);
    return `点「${target.name}」（第 ${target.i + 1} 行）：scrollTop 保持 ${bottom}，0 次滚动，焦点留在 .ge-member`;
  });

  await check('滚到底后连续勾选 / 再取消勾选：位置始终不动', async () => {
    const seq = [];
    for (let n = 0; n < 4; n++) {
      const before = await page.eval(withHelpers('return window.__SA__.geState();'));
      const target = await page.eval(withHelpers(`return window.__SA__.gePickRow(${JSON.stringify(n % 2 ? 'last' : 'first')});`));
      assert(target, `第 ${n + 1} 次点击找不到可点的行`);
      await page.eval(withHelpers(`document.querySelectorAll('.ge-member')[${target.i}].click(); return true;`));
      await settle();
      const after = await page.eval(withHelpers('return window.__SA__.geState();'));
      assert(after.scrollTop === before.scrollTop, `第 ${n + 1} 次点击后 scrollTop ${before.scrollTop}→${after.scrollTop}`);
      seq.push(`${before.scrollTop}→${after.scrollTop}`);
    }
    return seq.join('，');
  });

  await check('滚到底后点 chip 的 × 取消选中：位置同样不动', async () => {
    // 这条走的是"不得已才重建"的分支：renderList({keepScroll:true})
    const bottom = await page.eval(withHelpers('return window.__SA__.geScrollToBottom();'));
    await settle();
    const before = await page.eval(withHelpers('return window.__SA__.geState();'));
    assert(before.chips > 0, '还没有任何 chip');
    assert(before.scrollTop === bottom, `点 × 之前应当还在底部（${before.scrollTop} ≠ ${bottom}）`);
    await page.eval(withHelpers('return window.__SA__.geClickChipX(0);'));
    await settle();
    const after = await page.eval(withHelpers('return window.__SA__.geState();'));
    assert(after.chips === before.chips - 1, `chip 数没有减少（${before.chips} → ${after.chips}）`);
    assert(after.scrollTop === before.scrollTop, `移除 chip 后列表从 ${before.scrollTop} 跳到了 ${after.scrollTop}${after.scrollTop === 0 ? '（回到了最上方）' : ''}`);
    return `chip ${before.chips}→${after.chips}，scrollTop 保持 ${after.scrollTop}`;
  });

  await check('搜索是唯一允许回到顶部的入口', async () => {
    const before = await page.eval(withHelpers('return window.__SA__.geState();'));
    assert(before.scrollTop > 0, `搜索前列表应当在滚动状态（${before.scrollTop}）`);
    // 「组」会命中全部好友（分组名里都有"组"）：结果集仍然比视口长，
    // 所以"回到 0"是真的重置，而不是内容变短后被夹回顶部
    await page.eval(withHelpers("return window.__SA__.geSearch('组');"));
    await settle();
    const after = await page.eval(withHelpers('return window.__SA__.geState();'));
    assert(after.max > 60, `搜索结果应当仍然可滚动（max=${after.max}）`);
    assert(after.scrollTop === 0, `换了结果集应当回到顶部，实际 ${after.scrollTop}`);
    return `搜索后 ${before.scrollTop}→0（仍可滚动 ${after.max}px，结果集变了所以允许回顶）`;
  });

  await check('全程没有控制台异常', async () => {
    const problems = page.problems.filter((p) => !/favicon|icon\.svg|ERR_FILE/.test(String(p)));
    assert(!problems.length, problems.slice(0, 3).join(' | '));
    return `${page.problems.length} 条`;
  });

  code = failed ? 1 : 0;
} catch (err) {
  console.error('\n测试中断：', err.message);
  code = 1;
} finally {
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
  if (KEEP) console.log(`（--keep）数据目录保留在 ${TMP_DATA}`);
  await page.close();
  child.kill();
  if (!KEEP) {
    try {
      fs.rmSync(TMP_DATA, { recursive: true, force: true });
    } catch {}
  }
}
process.exit(code);
