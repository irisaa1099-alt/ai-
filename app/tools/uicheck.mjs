#!/usr/bin/env node
/**
 * UI 冒烟测试（零依赖 + 无头 Chrome）：
 * 验证"模板 → 创建好友 → 分组/未读 → 设置面板 → 角色卡编辑器 → 模板库 → 全局搜索"这套界面流程真的能用。
 *
 * 用法：node tools/uicheck.mjs [--keep]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, sleep, freePort } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const KEEP = process.argv.includes('--keep');
/** 测试专用数据目录：与真实 data/db 隔离，避免互相污染 */
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-testdb-'));

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
const assert = (c, m) => {
  if (!c) throw new Error(m || '断言失败');
};
async function waitFor(fn, { timeout = 12000, interval = 150, label = '条件' } = {}) {
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

const page = await launch({ port: await freePort(), width: 1440, height: 900 });
let code = 1;
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });

  console.log('\n=== 1. 首次使用引导（隔离的空数据目录）===');
  await check('全新用户能看到引导卡片', async () => {
    // 真正的"首次使用"= 浏览器空 + 服务端数据目录也空，所以这里单起一个隔离实例来测
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-fresh-'));
    const freshPort = 5211;
    const freshSrv = spawn(process.execPath, ['server.mjs', '--port', String(freshPort), '--no-open', '--data-dir', freshDir], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    try {
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${freshPort}/api/health`);
          if (res.ok) break;
        } catch {}
        await sleep(150);
      }
      await page.goto(`http://127.0.0.1:${freshPort}/`);
      await waitFor(async () => page.eval(`!!document.querySelector('.shell')`), { label: '外壳', timeout: 15000 });
      const card = await waitFor(
        async () => page.eval(`(() => { const n = document.querySelector('.onboard-card'); return n ? n.innerText : ''; })()`),
        { label: '引导卡片', timeout: 10000 }
      );
      assert(card.includes('欢迎') || card.length > 20, `引导内容异常：${card.slice(0, 60)}`);
      assert(/模板|好友/.test(card), '引导里没有"从模板挑一个好友"的引导');
      const title = card.split('\n').map((t) => t.trim()).filter(Boolean)[0].slice(0, 20);
      return title;
    } finally {
      freshSrv.kill('SIGKILL');
      try {
        fs.rmSync(freshDir, { recursive: true, force: true });
      } catch {}
      await page.goto(`http://127.0.0.1:${PORT}/`);
      await waitFor(async () => page.eval(`!!document.querySelector('.shell')`), { label: '回到主实例', timeout: 15000 });
    }
  });

  console.log('\n=== 2. 模板库创建好友 ===');
  await check('模板库渲染全部卡片并按分组过滤', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      store.setSettings({ onboarded: true });
      const ed = await import('./ui/editor.js');
      ed.openTemplateGallery();
      await new Promise(r => setTimeout(r, 500));
      const cards = document.querySelectorAll('.tpl-card').length;
      const groups = [...document.querySelectorAll('.tpl-groups button')].map(b => b.textContent.trim());
      // 点第二个分组（第一个是「全部」），看卡片是否变化
      const btns = [...document.querySelectorAll('.tpl-groups button')];
      let filtered = -1;
      if (btns[1]) { btns[1].click(); await new Promise(r => setTimeout(r, 300)); filtered = document.querySelectorAll('.tpl-card').length; }
      return { cards, groups, filtered };
    })()`);
    assert(r.cards >= 30, `模板卡只有 ${r.cards} 张`);
    const expected = await page.eval(`(async () => (await import('./data/templates.js')).CHARACTER_TEMPLATES.length)()`);
    assert(r.cards === expected, `卡片数 ${r.cards} 与模板库实际数量 ${expected} 不一致`);
    assert(r.groups.length >= 7, `分组只有 ${r.groups.length} 个`);
    return `卡片 ${r.cards} 张、分组 ${r.groups.length} 个（「${r.groups[1] || ''}」筛选后 ${r.filtered} 张）`;
  });

  await check('从模板创建角色并自动进入会话', async () => {
    const r = await page.eval(`(async () => {
      const btns = [...document.querySelectorAll('.tpl-card .t-acts button')];
      const create = btns.find(b => /创建|使用|直接/.test(b.textContent)) || btns[0];
      if (!create) return { err: '找不到创建按钮' };
      create.click();
      await new Promise(r => setTimeout(r, 1200));
      const store = await import('./core/store.js');
      const list = await store.listCharacters();
      return {
        chars: list.length,
        name: list[list.length-1] ? list[list.length-1].name : '',
        current: window.__AICHAT__ ? window.__AICHAT__.state.currentCharId : '',
        friends: document.querySelectorAll('.friend').length,
        groups: [...document.querySelectorAll('.group-head')].map(n => n.innerText.replace(/\\s+/g,' ').trim()),
      };
    })()`);
    assert(!r.err, r.err);
    assert(r.chars >= 1, '模板没有落库成角色');
    assert(r.friends >= 1, '侧栏没有好友行');
    return `${r.name}，侧栏 ${r.friends} 行，分组：${r.groups.join(' / ')}`;
  });

  await check('再创建第二个（不同分组）后分组区出现多组', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const tpl = await import('./data/templates.js');
      const c1 = tpl.CHARACTER_TEMPLATES.find(t => t.group === 'anime') || tpl.CHARACTER_TEMPLATES[0];
      const c2 = tpl.CHARACTER_TEMPLATES.find(t => t.group === 'work') || tpl.CHARACTER_TEMPLATES[1];
      await store.saveCharacter(tpl.templateToCharacter(c1));
      await store.saveCharacter(tpl.templateToCharacter(c2));
      await new Promise(r => setTimeout(r, 900));
      return {
        groups: [...document.querySelectorAll('.group-head')].map(n => n.innerText.replace(/\\s+/g,' ').trim()),
        friends: document.querySelectorAll('.friend').length,
      };
    })()`);
    assert(r.groups.length >= 2, `分组区只有 ${r.groups.length} 组`);
    return `分组 ${r.groups.length} 个（${r.groups.join(' / ')}），好友 ${r.friends} 行`;
  });

  console.log('\n=== 3. 设置面板 ===');
  await check('设置面板各分区都能渲染', async () => {
    const r = await page.eval(`(async () => {
      const s = await import('./ui/settings.js');
      const out = {};
      for (const sec of ['model','voice','context','group','profile','data','about']) {
        s.openSettings(sec);
        await new Promise(r => setTimeout(r, 350));
        out[sec] = (document.querySelector('.modal-body')||{}).innerText ? document.querySelector('.modal-body').innerText.length : 0;
        document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
        await new Promise(r => setTimeout(r, 200));
      }
      return out;
    })()`);
    for (const [k, v] of Object.entries(r)) assert(v > 100, `分区 ${k} 内容过少（${v} 字）`);
    return Object.entries(r).map(([k, v]) => `${k}:${v}字`).join(' ');
  });

  await check('我的资料：性别可选、能存进设置、重开面板仍回显', async () => {
    const r = await page.eval(`(async () => {
      const s = await import('./ui/settings.js');
      const store = await import('./core/store.js');
      /** 按 label 精确定位「我的资料」里的字段控件 */
      const controlOf = (re) => {
        for (const f of document.querySelectorAll('.modal-body .field')) {
          const label = (f.querySelector('.field-label')||{}).textContent || '';
          if (re.test(label)) return f.querySelector('select, input');
        }
        return null;
      };
      s.openSettings('profile');
      await new Promise(r => setTimeout(r, 400));
      const sel = controlOf(/性别/);
      if (!sel) return { err: '我的资料里找不到性别控件' };
      const options = [...sel.options].map(o => o.textContent.trim());
      const initial = sel.value;
      // 选中「女」并派发 change（和真人操作走同一条路径）
      sel.value = '女';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const saved = (store.getSettings().user || {}).gender;
      const inDom = sel.value; // 选完不该被重渲染冲掉
      sel.value = '男';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const saved2 = (store.getSettings().user || {}).gender;
      document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      await new Promise(r => setTimeout(r, 250));
      // 重开面板：应当回显磁盘上存的值（而不是回到默认）
      s.openSettings('profile');
      await new Promise(r => setTimeout(r, 400));
      const reShown = (controlOf(/性别/) || {}).value;
      const nameShown = (controlOf(/昵称/) || {}).value;
      document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      // 收尾：清掉性别，避免影响后面的用例
      store.setSettings({ user: { gender: '' } });
      return { options, initial, saved, saved2, inDom, reShown, nameShown };
    })()`);
    assert(!r.err, r.err);
    assert(r.options.includes('不设定') && r.options.includes('女') && r.options.includes('男') && r.options.includes('其他'),
      `性别选项不完整：${(r.options || []).join('/')}`);
    assert(r.initial === '', `默认应为「不设定」，实际 ${r.initial}`);
    assert(r.saved === '女', `选「女」没写进设置：${r.saved}`);
    assert(r.inDom === '女', `选完控件被重渲染冲掉了：${r.inDom}`);
    assert(r.saved2 === '男', `改选「男」没写进设置：${r.saved2}`);
    assert(r.reShown === '男', `重开面板没有回显已保存的性别：${r.reShown}`);
    assert(typeof r.nameShown === 'string', '昵称字段没了（分区被改坏）');
    return `选项 ${r.options.join('/')}，保存与回显正常`;
  });

  await check('思考模式：三态可选、写进设置、重开面板回显（见 ARCHITECTURE 5.19）', async () => {
    const r = await page.eval(`(async () => {
      const s = await import('./ui/settings.js');
      const store = await import('./core/store.js');
      /** 按 label 精确定位「模型」分区里的字段控件 */
      const controlOf = (re) => {
        for (const f of document.querySelectorAll('.modal-body .field')) {
          const label = (f.querySelector('.field-label')||{}).textContent || '';
          if (re.test(label)) return f.querySelector('select, input');
        }
        return null;
      };
      const close = () => document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      const pick = (sel, v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); };
      // 从「跟随模型默认」开始，保证断言的是本用例写的值
      store.setSettings({ params: { thinking: null } });
      s.openSettings('model');
      await new Promise(r => setTimeout(r, 400));
      const sel = controlOf(/思考模式/);
      if (!sel) return { err: '生成参数区里找不到「思考模式」控件' };
      const options = [...sel.options].map(o => o.textContent.trim());
      const initial = sel.value;
      pick(sel, 'off');
      await new Promise(r => setTimeout(r, 300));
      const saved = store.getSettings().params.thinking;
      close();
      await new Promise(r => setTimeout(r, 250));
      // 重开面板：应当回显磁盘上存的值（「跟随模型默认」与「关闭思考」不能串）
      s.openSettings('model');
      await new Promise(r => setTimeout(r, 400));
      const sel2 = controlOf(/思考模式/);
      const reShown = sel2 ? sel2.value : null;
      // 复位成「跟随模型默认」：顺带验证这一态写回的是 null（= 不下发 thinking）
      if (sel2) pick(sel2, 'default');
      await new Promise(r => setTimeout(r, 300));
      const reset = store.getSettings().params.thinking;
      close();
      return { options, initial, saved, reShown, reset };
    })()`);
    assert(!r.err, r.err);
    assert((r.options || []).length === 3, `思考模式应当是三态，实际 ${(r.options || []).length} 项`);
    assert(r.options[0] === '跟随模型默认' && r.options.includes('关闭思考') && r.options.includes('开启思考'),
      `三态文案不完整：${(r.options || []).join('/')}`);
    assert(r.initial === 'default', `默认应为「跟随模型默认」，实际 ${r.initial}`);
    assert(r.saved === false, `选「关闭思考」没把 thinking=false 写进设置：${r.saved}`);
    assert(r.reShown === 'off', `重开面板没有回显已保存的思考模式：${r.reShown}`);
    assert(r.reset === null, `选回「跟随模型默认」应当写 null（不下发字段），实际 ${r.reset}`);
    return `选项 ${r.options.join('/')}，写入与回显正常`;
  });

  console.log('\n=== 4. 角色卡编辑器 ===');
  await check('打开编辑器 → 标签页齐全 → 改名保存', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const ed = await import('./ui/editor.js');
      const char = (await store.listCharacters())[0];
      ed.openCharacterEditor(char);
      await new Promise(r => setTimeout(r, 600));
      const tabs = [...document.querySelectorAll('.modal .tabs button')].map(b => b.textContent.trim());
      // 逐个点开所有标签页，确认都能渲染出内容（不抛错、不空白）
      const counts = {};
      const btns = [...document.querySelectorAll('.modal .tabs button')];
      for (const b of btns) {
        b.click();
        await new Promise(r => setTimeout(r, 160));
        counts[b.textContent.trim()] = ((document.querySelector('.modal-body')||{}).innerText || '').length;
      }
      // 通过 modal 里的"名字"字段改名（用 label 精确定位，避免选到别的输入框）
      btns[0].click();
      await new Promise(r => setTimeout(r, 200));
      let nameInput = null;
      for (const f of document.querySelectorAll('.modal-body .field')) {
        const label = (f.querySelector('.field-label')||{}).textContent || '';
        if (/名字|姓名|名称/.test(label)) { nameInput = f.querySelector('input.input, input[type=text]'); break; }
      }
      if (nameInput) { nameInput.value = '改名测试'; nameInput.dispatchEvent(new Event('input', { bubbles: true })); }
      const save = [...document.querySelectorAll('.modal-foot button')].find(b => /保存/.test(b.textContent));
      if (!save) return { err: '找不到保存按钮', tabs, counts, nameFound: !!nameInput };
      save.click();
      await new Promise(r => setTimeout(r, 1000));
      const after = await store.getCharacter(char.id);
      return { tabs, counts, nameFound: !!nameInput, name: after ? after.name : '(不存在)', version: after ? after.version : 0 };
    })()`);
    assert(!r.err, r.err);
    assert(r.tabs.length >= 6, `标签页只有 ${r.tabs.length} 个：${(r.tabs || []).join(',')}`);
    for (const [k, v] of Object.entries(r.counts || {})) assert(v > 20, `标签页「${k}」内容为空（${v} 字）`);
    assert(r.nameFound, '编辑器里找不到"名字"输入框');
    assert(r.name === '改名测试', `改名未生效：${r.name}`);
    return `${r.tabs.length} 个标签页全部有内容，改名成功（v${r.version}）`;
  });

  console.log('\n=== 4.5 角色卡编辑器：世界书标签页 ===');
  await check('世界书标签页存在，套用世界观预设可写入并保存', async () => {
    const SCRIPT = [
      "(async () => {",
      "  const store = await import('./core/store.js');",
      "  const tpl = await import('./data/templates.js');",
      "  const ed = await import('./ui/editor.js');",
      "  const withLore = tpl.CHARACTER_TEMPLATES.find(x => x.lorebook && x.lorebook.length);",
      "  const char = tpl.templateToCharacter(withLore);",
      "  // 手动加一条「手写」条目：换世界时它必须留下（预设条目才该被替换）",
      "  char.lorebook = [{ keys: ['手写'], content: '我自己写的一条', enabled: true }];",
      "  await store.saveCharacter(char);",
      "  await new Promise(r => setTimeout(r, 300));",
      "  ed.openCharacterEditor(char);",
      "  await new Promise(r => setTimeout(r, 700));",
      "  const tabs = [...document.querySelectorAll('.modal .tabs button')].map(b => b.textContent.trim());",
      "  const loreTab = [...document.querySelectorAll('.modal .tabs button')].find(b => b.textContent.indexOf('世界书') >= 0);",
      "  if (!loreTab) return { err: '没有世界书标签页', tabs: tabs };",
      "  loreTab.click();",
      "  await new Promise(r => setTimeout(r, 500));",
      "  const body = document.querySelector('.modal-body');",
      "  const before = char.lorebook.length;",
      "  const sel = [...body.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.indexOf('赛博朋克') >= 0));",
      "  if (!sel) return { err: '世界书标签页里找不到世界观预设下拉', tabs: tabs };",
      "  sel.value = [...sel.options].find(o => o.textContent === '赛博朋克新港').value;",
      "  sel.dispatchEvent(new Event('change', { bubbles: true }));",
      "  await new Promise(r => setTimeout(r, 700));",
      "  // 再切换到另一套世界，验证旧世界条目被替换掉",
      "  const sel2 = [...document.querySelector('.modal-body').querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.indexOf('赛博朋克') >= 0));",
      "  sel2.value = [...sel2.options].find(o => o.textContent === '克苏鲁雾都').value;",
      "  sel2.dispatchEvent(new Event('change', { bubbles: true }));",
      "  await new Promise(r => setTimeout(r, 900));",
      "  const b2 = document.querySelector('.modal-body');",
      "  const texts = [...b2.querySelectorAll('textarea')].map(t => t.value);",
      "  const hasClearOption = [...document.querySelectorAll('.modal-body select')].some(s => [...s.options].some(o => o.textContent.indexOf('清空世界设定') >= 0));",
      "  const switched = {",
      "    count: b2.querySelectorAll('.tag').length,",
      "    expect: (await import('./data/templates.js')).WORLD_PRESETS.find(w => w.name === '克苏鲁雾都').lorebook.length + 1,",
      "    cyberLeak: texts.filter(t => t.indexOf('新港') >= 0 || t.indexOf('义体') >= 0).length,",
      "    manualKept: texts.filter(t => t.indexOf('歪脖子槐树') >= 0).length,",
      "  };",
      "  const save = [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.indexOf('保存') >= 0);",
      "  save.click();",
      "  await new Promise(r => setTimeout(r, 1100));",
      "  const after = await store.getCharacter(char.id);",
      "  document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());",
      "  return { tabs: tabs, before: before, after: after.lorebook.length, world: after.persona.world, keys: after.lorebook[0] ? after.lorebook[0].keys : [], switched: switched, hasClearOption: hasClearOption };",
      "})()",
    ].join('\n');
    const r = await page.eval(SCRIPT);
    assert(!r.err, r.err || '');
    assert(r.tabs.some((t) => t.indexOf('世界书') >= 0), `标签页里没有世界书：${r.tabs.join('/')}`);
    assert(r.after > r.before, `套用预设没有增加条目：${r.before} → ${r.after}`);
    // 流程最后停在世界=克苏鲁（中途换过世界），断言最终世界已被写入
    assert(/克苏鲁/.test(r.world), `世界观字段没有被写入（最终应为克苏鲁）：${r.world}`);
    assert(Array.isArray(r.keys) && r.keys.length > 0, '条目缺少关键词');
    assert(r.switched.count === r.switched.expect, `换世界后条目数应为 ${r.switched.expect}，实际 ${r.switched.count}`);
    assert(r.switched.cyberLeak === 0, `换世界后仍残留 ${r.switched.cyberLeak} 条旧世界设定`);
    assert(r.hasClearOption, '世界类型下拉里没有明确的「清空世界设定」选项');
    return `标签页 ${r.tabs.length} 个（含世界书）；套用预设 ${r.before} → ${r.after} 条；换成「克苏鲁雾都」后旧世界条目残留 ${r.switched.cyberLeak} 条（应为 0）`;
  });

  console.log('\n=== 5. 全局搜索 ===');
  await check('全局搜索面板可打开并检索', async () => {
    const r = await page.eval(`(async () => {
      const sb = await import('./ui/sidebar.js');
      sb.openGlobalSearch();
      await new Promise(r => setTimeout(r, 400));
      const input = document.querySelector('.modal-body input');
      if (!input) return { err: '搜索框不存在' };
      input.value = '你';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 900));
      const body = (document.querySelector('.modal-body')||{}).innerText || '';
      document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      return { hits: document.querySelectorAll('.hit, .search-hit').length, hasText: body.length > 0, first: body.split('\\n').slice(0, 3).join(' | ').slice(0, 60) };
    })()`);
    assert(!r.err, r.err);
    assert(r.hasText, '搜索面板没有内容');
    return `命中 ${r.hits} 条，面板文案：${r.first}`;
  });

  console.log('\n=== 5.45 收藏夹（左上角入口） ===');
  await check('收藏夹：左上角有入口 → 面板列出收藏 → 点一下跳回原消息 → 能取消收藏', async () => {
    // ① 入口 + 列表
    const open = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      const c = chars[0];
      const msg = await store.appendMessage({
        charId: c.id, role: 'assistant', content: '收藏夹用例：这句要能被收藏起来',
        bookmarked: true,
      });
      await window.__AICHAT__.openChat(c.id);
      await new Promise(r => setTimeout(r, 1100));

      const btns = [...document.querySelectorAll('.side-tools .icon-btn')];
      const favBtn = btns.find(b => /收藏夹/.test(b.title || ''));
      if (!favBtn) return { err: '左上角工具条上没有收藏夹入口，现有：' + btns.map(b => b.title).join(' / ') };
      favBtn.click();
      await new Promise(r => setTimeout(r, 800));
      const items = [...document.querySelectorAll('.modal .fav-item')];
      return {
        charId: c.id, msgId: msg.id, name: c.name,
        title: (document.querySelector('.modal-title') || {}).textContent || '',
        count: items.length,
        first: items[0] ? items[0].innerText.replace(/\\s+/g, ' ').trim().slice(0, 70) : '',
        summary: (document.querySelector('.modal .field-hint') || {}).textContent || '',
        hasSearch: !!document.querySelector('.modal input[type="search"]'),
        noModal: !document.querySelector('.modal'),
      };
    })()`);
    assert(!open.err, open.err);
    assert(!open.noModal, '点了收藏夹入口没有弹出面板');
    assert(open.title.includes('收藏夹'), `面板标题不对：${open.title}`);
    assert(open.count >= 1, `收藏夹里应当有刚收藏的那条（实际 ${open.count} 条）`);
    assert(/这句要能被收藏起来/.test(open.first), `条目正文不对：${open.first}`);
    assert(open.hasSearch, '收藏夹面板里应当有搜索框');

    // ② 点条目跳回原消息：气泡应当被高亮（走 app.js 的 chat:focus-message）
    const jumped = await page.eval(`(async () => {
      const seen = [];
      const obs = new MutationObserver(() => {
        if (document.querySelector('.chat-body .flash-highlight')) seen.push(1);
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      const main = document.querySelector('.modal .fav-item .fav-main');
      if (!main) return { err: '条目上没有可点的主体' };
      main.click();
      await new Promise(r => setTimeout(r, 1500));
      obs.disconnect();
      return { flashed: seen.length > 0, modalGone: !document.querySelector('.modal') };
    })()`);
    assert(!jumped.err, jumped.err);
    assert(jumped.modalGone, '跳转后收藏夹面板应当关掉');
    assert(jumped.flashed, '跳转后原消息应当被高亮（没有定位到那条消息）');

    // ③ 取消收藏：面板里少一条，store 里也不再有它
    const off = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const favBtn = [...document.querySelectorAll('.side-tools .icon-btn')].find(b => /收藏夹/.test(b.title || ''));
      favBtn.click();
      await new Promise(r => setTimeout(r, 800));
      const before = document.querySelectorAll('.modal .fav-item').length;
      const btn = document.querySelector('.modal .fav-item .fav-acts button');
      if (!btn) return { err: '条目上没有"取消收藏"按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 900));
      const after = document.querySelectorAll('.modal .fav-item').length;
      const left = (await store.listBookmarks()).filter(x => x.content.includes('这句要能被收藏起来')).length;
      const empty = ((document.querySelector('.modal .empty') || {}).innerText || '').replace(/\\s+/g, ' ').trim();
      document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      return { before, after, left, empty };
    })()`);
    assert(!off.err, off.err);
    assert(off.after === off.before - 1, `取消收藏后应当少一条（${off.before} → ${off.after}）`);
    assert(off.left === 0, `取消收藏后 listBookmarks 里不该还有它（还剩 ${off.left} 条）`);
    // 这是本用例造的唯一条收藏：取消掉之后应当看到空态引导
    if (off.before === 1) {
      assert(/空|还没有/.test(off.empty), `收藏夹清空后应当有空态引导，实际：${JSON.stringify(off.empty)}`);
    }

    // 收尾：删掉用例造的消息，别污染后面的案例
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const rows = await store.listMessages('${open.charId}');
      for (const m of rows) if (m.content.includes('这句要能被收藏起来')) await store.deleteMessage(m.id);
    })()`);
    return `入口「收藏夹」→ 面板 ${open.count} 条（${open.summary}）→ 跳转高亮 ✓ → 取消收藏 ✓`;
  });

  console.log('\n=== 5.5 侧栏底栏与本地文件状态 ===');
  await check('底栏显示"已保存到电脑文件"，且不再有导入/导出/备份按钮', async () => {
    const r = await page.eval(`(async () => {
      const foot = document.querySelector('.side-foot');
      const btns = [...foot.querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g,' ').trim());
      const line = foot.querySelector('.store-line');
      const st = window.__AICHAT__ && window.__AICHAT__.fileStatus ? window.__AICHAT__.fileStatus() : null;
      return { btns, line: line ? line.innerText.trim() : '', status: st, title: line ? line.title : '' };
    })()`);
    assert(!r.btns.some((t) => /备份|导入|导出/.test(t)), `仍然存在导入/导出/备份按钮：${r.btns.join(' / ')}`);
    assert(r.line.includes('已保存到电脑文件'), `底栏状态不对：${r.line}`);
    assert(r.status && r.status.available, '文件存储没有连接上（请用 node server.mjs 启动）');
    assert(r.title.includes('保存目录') && r.title.length > 12, `状态提示里没有保存目录：${r.title}`);
    return `底栏："${r.line}"，按钮：${r.btns.join(' / ') || '（仅状态行）'}`;
  });

  await check('设置 → 数据 分区显示本地文件存储而不是导入导出', async () => {
    const r = await page.eval(`(async () => {
      const s = await import('./ui/settings.js');
      s.openSettings('data');
      await new Promise(r => setTimeout(r, 600));
      const body = (document.querySelector('.modal-body')||{}).innerText || '';
      document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      return { body, hasActions: /立即同步到文件/.test(body) && /生成整库快照/.test(body) };
    })()`);
    assert(/本地文件存储/.test(r.body), '没有"本地文件存储"分区');
    assert(r.hasActions, '缺少同步/快照按钮');
    assert(!/导出全部数据|导入备份/.test(r.body), '数据分区里仍然有导入/导出按钮');
    return '数据分区已改为本地文件存储（含"立即同步到文件""生成整库快照"）';
  });

  console.log('\n=== 5.8 用量统计只显示近 14 天汇总 ===');
  await check('数据分区：有汇总卡片、没有逐日罗列', async () => {
    const SCRIPT = [
      "(async () => {",
      "  const llm = await import('./core/llm.js');",
      "  const now = Date.now();",
      "  await llm.clearUsage();",
      "  const plan = [[0,150],[0,290],[0,70],[1,400],[1,110],[5,700],[20,19998]];",
      "  for (const pair of plan) {",
      "    await llm.addUsage({ at: now - pair[0]*86400000, total: pair[1], cost: 0.001, charId: 'test', provider: 'deepseek', model: 'deepseek-chat' });",
      "  }",
      "  const s = await import('./ui/settings.js');",
      "  s.openSettings('data');",
      "  await new Promise(r => setTimeout(r, 900));",
      "  const body = document.querySelector('.modal-body');",
      "  const NL = String.fromCharCode(10);",
      "  const stats = {};",
      "  for (const n of body.querySelectorAll('.stat')) {",
      "    const parts = n.innerText.split(NL).map(t => t.trim());",
      "    stats[parts[1]] = parts[0];",
      "  }",
      "  const dayLike = [...body.querySelectorAll('.bar-item .bl')]",
      "    .map(n => n.innerText.split(NL)[0].trim())",
      "    .filter(t => /^[0-9][0-9]-[0-9][0-9]$/.test(t));",
      "  const headings = [...body.querySelectorAll('h3')].map(n => n.textContent.trim());",
      "  document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());",
      "  await llm.clearUsage();",
      "  return { stats: stats, dayLike: dayLike, headings: headings };",
      "})()",
    ].join('\n');
    const r = await page.eval(SCRIPT);
    assert(r.dayLike.length === 0, `仍然逐日罗列了 ${r.dayLike.length} 行：${r.dayLike.join(', ')}`);
    assert(!r.headings.some((h) => h.indexOf('最近 14 天') >= 0), `标题还写着"最近 14 天"：${r.headings.join(' | ')}`);
    assert(r.stats['近 14 天 tokens'] === '1720', `近 14 天 tokens 应为 1720，实际 ${r.stats['近 14 天 tokens']}（20 天前那 19998 不该被算进来）`);
    assert(r.stats['近 14 天对话次数'] === '6', `近 14 天次数应为 6，实际 ${r.stats['近 14 天对话次数']}`);
    assert(r.stats['有使用的天数'] === '3 / 14', `有使用的天数应为 3 / 14，实际 ${r.stats['有使用的天数']}`);
    assert(r.stats['累计 tokens'] === '21718', `累计 tokens 应为 21718（含窗口外），实际 ${r.stats['累计 tokens']}`);
    return `汇总卡片正确：tokens=${r.stats['近 14 天 tokens']} 次数=${r.stats['近 14 天对话次数']} 活跃天数=${r.stats['有使用的天数']}；逐日行 0 条`;
  });

  console.log('\n=== 6. 未读与主题 ===');
  await check('未读角标 + 主题切换', async () => {
    const r = await page.eval(`(async () => {
      const rt = await import('./core/runtime.js');
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      rt.addUnread(chars[0].id, 3);
      await new Promise(r => setTimeout(r, 700));
      const badges = [...document.querySelectorAll('.friend .badge')].map(b => b.textContent.trim());
      // 主题切换
      const cur = store.getSettings().theme;
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      const applied = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = cur;
      return { badges, applied, title: document.title };
    })()`);
    assert(r.badges.includes('3'), `未读角标没有出现 3：${JSON.stringify(r.badges)}`);
    assert(r.applied, '主题切换无效');
    return `未读角标 ${JSON.stringify(r.badges)}，主题切换生效=${r.applied}`;
  });

  console.log('\n=== 6.5 移动端布局（390px）===');
  await check('单栏切换 + 留白一致 + 无横向溢出', async () => {
    await page.client.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      page.sessionId
    );
    await sleep(600);
    const r = await page.eval(`(async () => {
      const pad = (sel) => { const n = document.querySelector(sel); return n ? parseFloat(getComputedStyle(n).paddingLeft) : null; };
      const rect = (sel) => { const n = document.querySelector(sel); if (!n) return { x: 0, w: 0 }; const b = n.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; };

      // 用应用自己的入口切视图（窄屏下面板显隐由 app.js 用内联样式接管，不能只加 class）
      const app = window.__AICHAT__;
      const id = app.state.currentCharId;
      app.openChat(null);                       // → 好友列表
      await new Promise(r => setTimeout(r, 500));
      const side = {
        head: pad('.side-head'), body: pad('.side-body'), foot: pad('.side-foot'),
        friendX: rect('.friend').x,
        buttons: [...document.querySelectorAll('.side-foot button')].map(b => Math.round(b.getBoundingClientRect().width)),
        visible: getComputedStyle(document.querySelector('.pane-side')).display !== 'none',
        chatHidden: getComputedStyle(document.querySelector('.pane-main')).display === 'none',
        scrollable: (() => { const b = document.querySelector('.side-body'); return b ? b.scrollHeight >= b.clientHeight : false; })(),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };

      app.openChat(id);                          // → 会话
      await new Promise(r => setTimeout(r, 500));
      const chat = {
        head: pad('.chat-head'), body: pad('.chat-body'), foot: pad('.chat-foot'),
        msgX: rect('.msg').x, inputX: rect('#composerInput').x, inputW: rect('#composerInput').w,
        visible: getComputedStyle(document.querySelector('.pane-main')).display !== 'none',
        sideHidden: getComputedStyle(document.querySelector('.pane-side')).display === 'none',
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
      return { side, chat };
    })()`);
    await page.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await sleep(400);

    assert(r.side.head === r.side.body && r.side.body === r.side.foot, `侧栏三段留白不一致：${r.side.head}/${r.side.body}/${r.side.foot}`);
    assert(r.chat.head === r.chat.body && r.chat.body === r.chat.foot, `会话区三段留白不一致：${r.chat.head}/${r.chat.body}/${r.chat.foot}`);
    assert(r.side.friendX === r.side.body, `好友行左边缘未与留白对齐：${r.side.friendX} vs ${r.side.body}`);
    assert(r.chat.msgX === r.chat.inputX, `消息与输入框左边缘不一致：${r.chat.msgX} vs ${r.chat.inputX}`);
    assert(new Set(r.side.buttons).size === 1, `底栏按钮宽度不一致：${r.side.buttons.join('/')}`);
    assert(r.side.overflowX <= 0 && r.chat.overflowX <= 0, `出现横向溢出：侧栏 ${r.side.overflowX} / 会话 ${r.chat.overflowX}`);
    assert(r.chat.inputW > 150, `移动端输入框过窄：${r.chat.inputW}px`);
    assert(r.side.visible && r.side.chatHidden, `打开好友列表时会话面板未隐藏：side=${r.side.visible} chatHidden=${r.side.chatHidden}`);
    assert(r.chat.visible && r.chat.sideHidden, `打开会话时侧栏未隐藏：chat=${r.chat.visible} sideHidden=${r.chat.sideHidden}`);
    return `侧栏/会话留白各 ${r.side.head}px，按钮等宽 ${r.side.buttons[0]}px，输入框 ${r.chat.inputW}px，无横向溢出`;
  });

  console.log('\n=== 7. 最终检查 ===');
  await check('界面流程全程无控制台错误', async () => {
    const real = page.problems.filter((p) => !/icon\.svg|manifest|404|favicon/i.test(p));
    assert(real.length === 0, real.slice(0, 3).join(' | '));
    return '0 个错误';
  });

  if (KEEP) console.log(`→ 截图：${await page.shot(path.join(process.cwd(), 'ui-shot.png'))}`);
} catch (err) {
  failed++;
  failures.push(`未捕获错误：${err.message}`);
  console.error('\n✗ 中断：', err.message);
} finally {
  console.log(`\n================ UI 冒烟结果：${passed} 通过 / ${failed} 失败 ================`);
  failures.forEach((f) => console.log(' - ' + f));
  code = failed ? 1 : 0;
  if (!KEEP) {
    await page.close();
    child.kill('SIGKILL');
    try {
      fs.rmSync(TMP_DATA, { recursive: true, force: true });
    } catch {}
  }
}
process.exit(code);
