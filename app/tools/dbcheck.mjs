#!/usr/bin/env node
/**
 * 本地文件存储验证（零依赖 + 无头 Chrome）
 *
 * 验证需求：「角色直接保存在电脑本地文件里，关掉程序也不会消失」。
 * 步骤：
 *   1. 干净启动（清空 data/db），在浏览器里创建一个角色、发一条消息；
 *   2. 检查磁盘上真的出现了 characters/*.json 与 messages/*.ndjson，内容正确；
 *   3. **彻底清空浏览器数据**（IndexedDB + localStorage + Service Worker），模拟"浏览器数据被清理"；
 *   4. 重新打开页面，验证角色与聊天记录从磁盘文件自动恢复；
 *   5. 删除角色，验证磁盘文件与墓碑也同步删除。
 *
 * 用法：node tools/dbcheck.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, sleep, freePort } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
/**
 * 测试专用数据目录（**绝不能用真实的 data/db**）。
 * 这个脚本第一步就是"删掉数据目录从零开始"，一旦指向真实目录就会把用户的角色清空。
 * 所以这里强制建临时目录，并在启动服务器前断言它不在项目数据目录下。
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-dbcheck-'));
const REAL_DATA_DIR = path.join(ROOT, 'data', 'db');
if (path.resolve(DATA_DIR) === path.resolve(REAL_DATA_DIR) || path.resolve(DATA_DIR).startsWith(path.resolve(REAL_DATA_DIR) + path.sep)) {
  console.error('✗ 拒绝运行：测试数据目录不能是真实的 data/db');
  process.exit(2);
}

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
async function waitFor(fn, { timeout = 15000, interval = 200, label = '条件' } = {}) {
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

/* 干净启动：删掉 data/db，确保是从零开始 */
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const child = spawn(process.execPath, ['server.mjs', '--port', String(PORT), '--no-open', '--data-dir', DATA_DIR], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d.toString()));
child.stderr.on('data', (d) => (serverLog += d.toString()));
await new Promise(async (resolve, reject) => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return resolve();
    } catch {}
    await sleep(150);
  }
  child.kill();
  reject(new Error('服务器启动失败：' + serverLog.slice(-300)));
});

const page = await launch({ port: await freePort(), width: 1280, height: 860 });
let code = 1;

try {
  console.log('\n=== 1. 启动与目录 ===');
  await check('data/db 目录与子目录被创建', async () => {
    const dirs = ['characters', 'messages', 'memory', 'deleted'].map((d) => fs.existsSync(path.join(DATA_DIR, d)));
    assert(dirs.every(Boolean), `缺少子目录：${dirs.map((v, i) => (v ? '' : ['characters', 'messages', 'memory', 'deleted'][i])).filter(Boolean)}`);
    return DATA_DIR.replace(ROOT, '.');
  });

  await check('/api/health 报告了数据目录', async () => {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    // 数据目录必须等于本次测试的临时目录，且绝不能是真实的 data/db
    assert(h.dataDir, `没有返回 dataDir`);
    assert(
      path.resolve(h.dataDir) === path.resolve(DATA_DIR),
      `服务器数据目录与测试目录不一致：${h.dataDir} != ${DATA_DIR}`
    );
    assert(
      path.resolve(h.dataDir) !== path.resolve(REAL_DATA_DIR),
      `危险：测试服务器竟然指向了真实的 data/db！`
    );
    return h.dataDir.replace(ROOT, '.');
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });

  console.log('\n=== 2. 创建角色 → 立即落盘 ===');
  const created = await page.eval(`(async () => {
    const store = await import('./core/store.js');
    store.setSettings({ onboarded: true });
    const c = await store.saveCharacter({ name: '落盘测试角色', emoji: '💾', tagline: '用来验证本地文件存储', greeting: ['你好，我会被写进磁盘。'] });
    localStorage.setItem('aichat.lastChar', c.id);
    await new Promise(r => setTimeout(r, 300));
    await store.appendMessage({ charId: c.id, role: 'user', content: '这条消息应该出现在 ndjson 里' });
    await store.appendMessage({ charId: c.id, role: 'assistant', content: '这条回复也应该被写盘', status: 'done' });
    await new Promise(r => setTimeout(r, 700));
    return { id: c.id, name: c.name };
  })()`);

  await check('角色 JSON 文件已写入磁盘且内容正确', async () => {
    const file = path.join(DATA_DIR, 'characters', `${created.id}.json`);
    const t0 = Date.now();
    while (!fs.existsSync(file) && Date.now() - t0 < 5000) await sleep(150);
    assert(fs.existsSync(file), `没有找到 ${file}`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(data.name === '落盘测试角色', `角色名不对：${data.name}`);
    assert(data.id === created.id, 'id 不匹配');
    return `${path.basename(file)}（${fs.statSync(file).size} 字节）`;
  });

  await check('聊天记录 NDJSON 已写入磁盘', async () => {
    const file = path.join(DATA_DIR, 'messages', `${created.id}.ndjson`);
    const t0 = Date.now();
    while (!fs.existsSync(file) && Date.now() - t0 < 5000) await sleep(150);
    assert(fs.existsSync(file), `没有找到 ${file}`);
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert(lines.length >= 2, `只有 ${lines.length} 行`);
    const texts = lines.map((m) => m.content);
    assert(texts.some((t) => t.includes('ndjson')), '用户消息没写进去');
    assert(texts.some((t) => t.includes('也应该被写盘')), 'AI 回复没写进去');
    return `${lines.length} 条消息`;
  });

  await check('启动回填若消息请求失败，保留浏览器现有记录并报告错误', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const file = await import('./core/filestore.js');
      const id = ${JSON.stringify(created.id)};
      const before = (await store.listMessages(id)).map(m => m.content);
      const original = window.fetch;
      window.fetch = (input, init) => String(input).includes('/api/db/messages/' + id)
        ? Promise.reject(new Error('模拟消息接口中断'))
        : original(input, init);
      try {
        const result = await file.syncOnBoot();
        const after = (await store.listMessages(id)).map(m => m.content);
        return { action: result.action, before, after };
      } finally {
        window.fetch = original;
      }
    })()`);
    assert(r.action === 'error', `失败的消息请求没有使回填失败：${r.action}`);
    assert(JSON.stringify(r.after) === JSON.stringify(r.before), '回填失败后本地聊天记录被清掉或更改了');
    return `回填结果=${r.action}，原有 ${r.after.length} 条消息完整保留`;
  });

  console.log('\n=== 3. 清空浏览器数据（模拟浏览器清理）===');
  await check('清空 IndexedDB / localStorage / Service Worker', async () => {
    const r = await page.eval(`(async () => {
      const before = (await (await import('./core/store.js')).listCharacters()).length;
      // 断开数据库连接并删掉整个库
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('aichat');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      localStorage.clear();
      sessionStorage.clear();
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      return { before };
    })()`);
    assert(r.before >= 1, '清空前浏览器里就没有角色');
    await page.goto('about:blank');
    await sleep(400);
    return `清空前浏览器里有 ${r.before} 位好友，已全部清掉`;
  });

  console.log('\n=== 4. 重新打开 → 从磁盘恢复 ===');
  await check('重新打开页面后角色与聊天记录自动恢复', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });
    const r = await waitFor(
      async () =>
        page.eval(`(async () => {
          const store = await import('./core/store.js');
          const chars = await store.listCharacters();
          if (!chars.length) return null;
          const msgs = await store.listMessages(chars[0].id);
          return { chars: chars.length, name: chars[0].name, msgs: msgs.length, texts: msgs.map(m => m.content.slice(0, 12)) };
        })()`),
      { label: '数据恢复', timeout: 20000 }
    );
    assert(r.name === '落盘测试角色', `恢复出来的角色不对：${r.name}`);
    assert(r.msgs >= 2, `只恢复了 ${r.msgs} 条消息`);
    return `恢复 ${r.chars} 位好友、${r.msgs} 条消息（${r.texts.join(' / ')}）`;
  });

  await check('界面确实渲染出恢复后的好友', async () => {
    const r = await page.eval(`({ friends: document.querySelectorAll('.friend').length, hasName: document.body.innerText.includes('落盘测试角色'), storeLine: (document.querySelector('.store-line')||{}).innerText || '' })`);
    assert(r.friends >= 1, `侧栏没有好友行（${r.friends}）`);
    assert(r.hasName, '界面没有显示角色名');
    return `侧栏 ${r.friends} 行，底栏状态："${r.storeLine.trim()}"`;
  });

  console.log('\n=== 5. 删除同步 ===');
  await check('删除角色后磁盘文件与墓碑都被清理', async () => {
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      await store.deleteCharacter(chars[0].id);
      await new Promise(r => setTimeout(r, 800));
    })()`);
    const charFile = path.join(DATA_DIR, 'characters', `${created.id}.json`);
    const msgFile = path.join(DATA_DIR, 'messages', `${created.id}.ndjson`);
    const tomb = path.join(DATA_DIR, 'deleted', `${created.id}.json`);
    const t0 = Date.now();
    while ((fs.existsSync(charFile) || fs.existsSync(msgFile)) && Date.now() - t0 < 5000) await sleep(150);
    assert(!fs.existsSync(charFile), '角色文件还在');
    assert(!fs.existsSync(msgFile), '聊天记录文件还在');
    assert(fs.existsSync(tomb), '没有写删除墓碑');
    return '角色文件与聊天记录已删除，墓碑已写入';
  });

  console.log('\n=== 5.5 防误删闸门 ===');
  await check('空数据覆盖会被服务器拒绝（保护电脑上的角色）', async () => {
    // 先造一个角色，保证磁盘上有数据
    const id = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const c = await store.saveCharacter({ name: '闸门测试角色', greeting: ['hi'] });
      await new Promise(r => setTimeout(r, 600));
      return c.id;
    })()`);
    const onDisk = fs.readdirSync(path.join(DATA_DIR, 'characters')).length;
    assert(onDisk > 0, '磁盘上还没有角色');
    // 模拟"浏览器里什么都没有"的客户端来整体覆盖
    const res = await fetch(`http://127.0.0.1:${PORT}/api/db/replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characters: [], messages: [] }),
    });
    const body = await res.json().catch(() => ({}));
    assert(res.status === 409, `期望 409，实际 ${res.status}`);
    assert(body.error && body.error.code === 'replace-would-delete', `错误码不对：${JSON.stringify(body.error)}`);
    const after = fs.readdirSync(path.join(DATA_DIR, 'characters')).length;
    assert(after === onDisk, `角色文件被删了：${onDisk} → ${after}`);
    return `已拒绝（HTTP 409），磁盘上 ${after} 个角色完好`;
  });

  await check('不带 force 的整库清空会被拒绝，带 force 才放行', async () => {
    const a = await fetch(`http://127.0.0.1:${PORT}/api/db/wipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(a.status === 409, `期望 409，实际 ${a.status}`);
    const before = fs.readdirSync(path.join(DATA_DIR, 'characters')).length;
    assert(before > 0, '角色不该在这一步被删');
    // 带 force + 指定 id：只删指定角色，属于正常用法
    const b = await fetch(`http://127.0.0.1:${PORT}/api/db/wipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true, charIds: ['__not_exist__'] }),
    });
    assert(b.status === 200, `带 force 的指定删除应放行，实际 ${b.status}`);
    return '无 force → 409；带 force → 200';
  });

  console.log('\n=== 6. 导出接口不再暴露 ===');
  await check('GET /api/db/state 能列出磁盘上的数据', async () => {
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/db/state`)).json();
    assert(st.ok === true, '接口异常');
    assert(typeof st.counts.characters === 'number', 'counts 缺失');
    return `characters=${st.counts.characters} messageFiles=${st.counts.messageFiles}`;
  });

  await check('data 目录不能被静态服务访问', async () => {
    const a = await fetch(`http://127.0.0.1:${PORT}/data/db/settings.json`);
    const b = await fetch(`http://127.0.0.1:${PORT}/data/`);
    assert(a.status === 403 || a.status === 404, `settings.json 返回了 ${a.status}`);
    assert(b.status === 403 || b.status === 404, `data/ 目录返回了 ${b.status}`);
    return `settings.json → ${a.status}，data/ → ${b.status}`;
  });

  /* ------------------------------------------------------------------ */
  // 回归守：导入备份包时，群消息必须和角色 / 私聊 / 群资料一样**落盘**。
  // 曾经的 bug：importAll 只把群消息写进 IndexedDB，没写 groupmsgs/*.ndjson，
  // 于是"导入后暂时可见，一刷新就消失"—— 因为下次启动 syncOnBoot 会先清空本地库、
  // 再以磁盘为准回填，盘上没有群消息文件的群就被回填成空群。
  console.log('\n=== 7. 备份导入 → 刷新后群消息不丢 ===');
  const backup = await page.eval(`(async () => {
    const store = await import('./core/store.js');
    const a = await store.saveCharacter({ name: '导入甲', emoji: '🅰', greeting: ['hi'] });
    const b = await store.saveCharacter({ name: '导入乙', emoji: '🅱', greeting: ['hi'] });
    const g = await store.saveGroup({ name: '导入测试群', emoji: '💬', members: [a.id, b.id] });
    await store.appendGroupMessage({ groupId: g.id, role: 'user', content: '群消息一号' });
    await store.appendGroupMessage({ groupId: g.id, role: 'assistant', speakerId: a.id, speakerName: '导入甲', content: '群消息二号' });
    await store.appendGroupMessage({ groupId: g.id, role: 'assistant', speakerId: b.id, speakerName: '导入乙', content: '群消息三号', toIds: ['user'] });
    await new Promise(r => setTimeout(r, 300));
    const pack = JSON.parse(await (await store.exportAll()).text());
    await store.wipeAll();
    const res = await store.importAll(pack, { merge: false });
    const rightAfter = await store.listGroupMessages(g.id);
    return {
      gid: g.id,
      packGroupMsgs: pack.groupMessages.length,
      rightAfter: rightAfter.length,
      imported: res.groupMessages,
    };
  })()`);

  await check('导入包本身带上了群消息', async () => {
    assert(backup.packGroupMsgs === 3, `备份包里只有 ${backup.packGroupMsgs} 条群消息`);
    assert(backup.imported === 3, `importAll 报告导入了 ${backup.imported} 条群消息`);
    return `备份包 ${backup.packGroupMsgs} 条 → 导入 ${backup.imported} 条`;
  });

  await check('导入后群消息已写入磁盘（groupmsgs/<群id>.ndjson）', async () => {
    const file = path.join(DATA_DIR, 'groupmsgs', `${backup.gid}.ndjson`);
    const t0 = Date.now();
    while (!fs.existsSync(file) && Date.now() - t0 < 5000) await sleep(150);
    assert(fs.existsSync(file), `没有找到 ${file}（导入的数据只进了 IndexedDB，没落盘）`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const texts = lines.filter((m) => !m.deleted).map((m) => m.content);
    assert(texts.length === 3, `磁盘上有 ${texts.length} 条群消息（期望 3）：${texts.join(' / ')}`);
    assert(texts.includes('群消息一号') && texts.includes('群消息三号'), `内容缺失：${texts.join(' / ')}`);
    return `${path.basename(file)}（${texts.length} 条群消息）`;
  });

  await check('刷新页面后群消息仍在（不会被启动回填清掉）', async () => {
    await page.goto('about:blank');
    await sleep(300);
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });
    // 等启动回填把群聊恢复出来，再核对消息条数（回填没把群恢复出来会在这里超时）
    const r = await waitFor(
      async () =>
        page.eval(`(async () => {
          const store = await import('./core/store.js');
          const gs = await store.listGroups();
          const hit = gs.find((g) => g.id === ${JSON.stringify(backup.gid)});
          if (!hit) return null;
          const msgs = await store.listGroupMessages(hit.id);
          return { groups: gs.length, name: hit.name, n: msgs.length, texts: msgs.map((m) => m.content) };
        })()`),
      { label: '群聊回填', timeout: 20000 }
    );
    assert(r.n === 3, `刷新后群消息只剩 ${r.n} 条（期望 3）：${r.texts.join(' / ')}`);
    return `刷新后「${r.name}」仍有 ${r.n} 条群消息`;
  });

  /* ------------------------------------------------------------------ */
  // 回归守（P2）：零成员群也必须活得下来。
  // 两个坑：① importAll 见到 members 为空就 `continue`，备份里的空群被整个丢掉；
  //        ② syncOnBoot 以"磁盘有角色"为回填条件，角色被删光后磁盘上只剩群文件，
  //           清掉浏览器数据再打开就什么都回填不出来，群与记录看着就没了。
  console.log('\n=== 7.5 零成员群：导入与回填都不能丢 ===');
  const emptyGroup = await page.eval(`(async () => {
    const store = await import('./core/store.js');
    const a = await store.saveCharacter({ name: '待删甲', emoji: '①', greeting: ['hi'] });
    const b = await store.saveCharacter({ name: '待删乙', emoji: '②', greeting: ['hi'] });
    const g = await store.saveGroup({ name: '会变成空群的群', emoji: '👥', members: [a.id, b.id], topic: '解散后也要留着' });
    await store.appendGroupMessage({ groupId: g.id, role: 'user', content: '解散前的最后一句话' });
    await store.appendGroupMessage({ groupId: g.id, role: 'assistant', speakerId: a.id, speakerName: '待删甲', content: '嗯，我记下了。' });
    await new Promise(r => setTimeout(r, 700));
    // 删掉全部成员 → 群变成零成员（这是产品里的合法状态）
    await store.deleteCharacter(a.id);
    await store.deleteCharacter(b.id);
    await new Promise(r => setTimeout(r, 900));
    const groups = await store.listGroups();
    const g2 = groups.find((x) => x.id === g.id);
    return { gid: g.id, members: g2 ? g2.members.length : -1, msgs: (await store.listGroupMessages(g.id)).length };
  })()`);

  await check('删光成员后：群仍在本地，且磁盘上的群文件变成零成员', async () => {
    assert(emptyGroup.members === 0, `群里还剩 ${emptyGroup.members} 位成员（期望 0）`);
    assert(emptyGroup.msgs === 2, `群消息少了：${emptyGroup.msgs}`);
    const file = path.join(DATA_DIR, 'groups', `${emptyGroup.gid}.json`);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      try {
        const g = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(g.members) && g.members.length === 0) return `groups/${path.basename(file)} members=0`;
      } catch {}
      await sleep(150);
    }
    throw new Error('磁盘上的群文件没有更新成零成员');
  });

  await check('清空浏览器数据后重开：零成员群与它的聊天记录被回填', async () => {
    // 模拟"换浏览器 / 清了站点数据"：IndexedDB + localStorage 全清，磁盘上只剩这个群
    await page.eval(`(async () => {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('aichat');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      localStorage.clear();
      sessionStorage.clear();
    })()`);
    await page.goto('about:blank');
    await sleep(300);
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });
    const r = await waitFor(
      async () =>
        page.eval(`(async () => {
          const store = await import('./core/store.js');
          const g = (await store.listGroups()).find((x) => x.id === ${JSON.stringify(emptyGroup.gid)});
          return g ? { name: g.name, members: g.members.length, msgs: (await store.listGroupMessages(g.id)).length } : null;
        })()`),
      { label: '零成员群回填', timeout: 20000 }
    );
    assert(r.members === 0, `成员数不对：${r.members}`);
    assert(r.msgs === 2, `群消息没被回填：${r.msgs} 条（期望 2）`);
    return `「${r.name}」0 成员、${r.msgs} 条记录，刷新后仍在`;
  });

  await check('空群备份导入时不被跳过', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const pack = JSON.parse(await (await store.exportAll()).text());
      const inPack = pack.groups.filter((g) => g.members.length === 0).length;
      const res = await store.importAll(pack, { merge: false });
      const g = (await store.listGroups()).find((x) => x.id === ${JSON.stringify(emptyGroup.gid)});
      return { inPack, groups: res.groups, found: g ? g.members.length : -1, msgs: g ? (await store.listGroupMessages(g.id)).length : -1 };
    })()`);
    assert(r.inPack >= 1, '备份包里没有零成员群（导出就把空群漏了）');
    assert(r.groups >= 1, `导入报告了 ${r.groups} 个群（空群被跳过）`);
    assert(r.found === 0, `导入后找不到这个零成员群：${r.found}`);
    assert(r.msgs === 2, `导入后群消息不对：${r.msgs}`);
    return `备份含 ${r.inPack} 个空群 → 导入后仍在（0 成员、${r.msgs} 条记录）`;
  });

  await check('收藏夹：私聊 + 群聊合并、时间倒序、取消收藏会移除，且 bookmarked 跟着消息落盘', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      const c = chars[0];
      const g = (await store.listGroups()).find((x) => (x.members || []).length) || (await store.listGroups())[0];
      const keep = await store.appendMessage({ charId: c.id, role: 'assistant', content: '收藏用例：私聊这条留着', bookmarked: true });
      const drop = await store.appendMessage({ charId: c.id, role: 'user', content: '收藏用例：这条待会取消', bookmarked: true });
      const gm = await store.appendGroupMessage({
        groupId: g.id, role: 'assistant', speakerId: g.members[0], speakerName: '甲',
        content: '收藏用例：群里这条也留着', bookmarked: true,
      });
      const all = await store.listBookmarks();
      const n = await store.countBookmarks();
      // 时间倒序（最新的在最前）
      let sorted = true;
      for (let i = 1; i < all.length; i += 1) if (all[i - 1].at < all[i].at) sorted = false;
      await store.updateMessage(drop.id, { bookmarked: false });
      const after = await store.listBookmarks();
      return {
        cid: c.id, gid: g.id, keep: keep.id, drop: drop.id, gm: gm.id,
        kinds: all.map((x) => x.kind),
        hasChar: all.some((x) => x.id === keep.id && x.kind === 'char'),
        hasGroup: all.some((x) => x.id === gm.id && x.kind === 'group' && x.groupId === g.id),
        count: n, sorted,
        stillThere: after.some((x) => x.id === drop.id),
        afterCount: after.length,
        // 界面要用的两个字段：来源 id 与群里的发言人
        speaker: (all.find((x) => x.id === gm.id) || {}).speakerName || '',
      };
    })()`);
    assert(r.hasChar && r.hasGroup, `收藏夹应当同时有私聊与群聊条目（kinds=${r.kinds.join(',')}）`);
    assert(r.count === 3, `countBookmarks 应当是 3，实际 ${r.count}`);
    assert(r.sorted, '收藏夹应当按时间倒序（最新的在最上面）');
    assert(!r.stillThere, '取消收藏后不该还在收藏夹里');
    assert(r.afterCount === 2, `取消一条后应当剩 2 条，实际 ${r.afterCount}`);
    assert(r.speaker === '甲', `群聊条目要带上发言人，实际「${r.speaker}」`);

    // 落盘：both 文件的对应行里都得有 "bookmarked":true（收藏是消息自己的字段）
    const pfile = path.join(DATA_DIR, 'messages', `${r.cid}.ndjson`);
    const gfile = path.join(DATA_DIR, 'groupmsgs', `${r.gid}.ndjson`);
    const readAll = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const p = readAll(pfile);
      const g = readAll(gfile);
      if (p.includes('私聊这条留着') && p.includes('"bookmarked":true') && g.includes('群里这条也留着') && g.includes('"bookmarked":true')) break;
      await sleep(150);
    }
    const ptext = readAll(pfile);
    const gtext = readAll(gfile);
    assert(ptext.includes('私聊这条留着') && ptext.includes('"bookmarked":true'), '私聊收藏没有带着 bookmarked 落盘');
    assert(gtext.includes('群里这条也留着') && gtext.includes('"bookmarked":true'), '群聊收藏没有带着 bookmarked 落盘');

    // 收尾：把用例造的消息删掉
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      await store.deleteMessage(${JSON.stringify(r.keep)});
      await store.deleteMessage(${JSON.stringify(r.drop)});
      await store.deleteGroupMessage(${JSON.stringify(r.gm)});
    })()`);
    return `私聊 + 群聊共 ${r.count} 条、时间倒序 ✓、取消收藏即时移除 ✓、两个 ndjson 里都写了 bookmarked:true`;
  });

  // 回归守（P2）：消息入库失败时，用户刚打的话必须留在输入框/草稿里。
  // 以前是"先清空再保存"，保存失败只剩一个 toast，用户得重打一遍。
  await check('消息保存失败时原文留在输入框与草稿（单聊）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const c = await store.saveCharacter({ name: '草稿守护', emoji: '✍️', greeting: ['hi'] });
      await store.appendMessage({ charId: c.id, role: 'user', content: '占位消息' });
      // 新角色是直接写 store 建的，得先让应用刷新自己的角色列表，否则 openChat 会因为
      // "列表里没这个人"而退回空态，输入框根本不会渲染出来
      await globalThis.__AICHAT__.ctx.reloadCharacters();
      await globalThis.__AICHAT__.openChat(c.id);
      // 等会话真的渲染出来（从群聊切到单聊时中栏是整块重建的，固定 sleep 容易踩空）
      for (let i = 0; i < 50 && !document.querySelector('#composerInput'); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const input = document.querySelector('#composerInput');
      if (!input) return { err: '没有找到输入框' };
      // 模拟 IndexedDB 写失败：把 store 已经打开的连接关掉，之后的写事务会直接抛错
      const db = await store.openDB();
      db.close();
      const text = '这句话在保存失败后必须还在：' + Date.now();
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn').click();
      await new Promise(r => setTimeout(r, 900));
      return { text, inputValue: document.querySelector('#composerInput').value, draft: localStorage.getItem('aichat.draft.' + c.id) };
    })()`);
    assert(!r.err, r.err);
    assert(r.inputValue === r.text, `输入框被清空了：${JSON.stringify(r.inputValue)}`);
    assert(r.draft === r.text, `草稿里没有留下原文：${JSON.stringify(r.draft)}`);
    // 重新加载，让 store 重新打开数据库连接，后面的用例照常
    await page.goto('about:blank');
    await sleep(200);
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });
    return '原文与草稿都保留了下来';
  });

  // 群聊那条发送路径同理（ui/groupchat.js）：以前也是"先清空输入框与草稿、再保存"
  await check('消息保存失败时原文留在输入框与草稿（群聊）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const c = await store.saveCharacter({ name: '群草稿守护', emoji: '💬', greeting: ['hi'] });
      const g = await store.saveGroup({ name: '草稿守护群', emoji: '🛡', members: [c.id] });
      await globalThis.__AICHAT__.ctx.reloadCharacters();
      await globalThis.__AICHAT__.ctx.reloadGroups();
      await globalThis.__AICHAT__.openGroup(g.id);
      for (let i = 0; i < 50 && !document.querySelector('#groupComposerInput'); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const input = document.querySelector('#groupComposerInput');
      if (!input) return { err: '没有找到群输入框' };
      const db = await store.openDB();
      db.close(); // 让写事务失败
      const text = '群里这句话在保存失败后必须还在：' + Date.now();
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#groupSendBtn').click();
      await new Promise(r => setTimeout(r, 900));
      return { text, inputValue: document.querySelector('#groupComposerInput').value, draft: localStorage.getItem('aichat.groupDraft.' + g.id) };
    })()`);
    assert(!r.err, r.err);
    assert(r.inputValue === r.text, `群输入框被清空了：${JSON.stringify(r.inputValue)}`);
    assert(r.draft === r.text, `群草稿里没有留下原文：${JSON.stringify(r.draft)}`);
    await page.goto('about:blank');
    await sleep(200);
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });
    return '群聊路径同样保留了原文与草稿';
  });

  /* ------------------------------------------------------------------ */
  // 回归守（P1）：只改了设置就立刻关页时，磁盘上的 runtime.json（好感度 / 未读）
  // 必须原样保留。以前关窗兜底 flushStateNow() 会无条件发 `runtime:{}`，
  // 服务端看到 truthy 就整份覆盖 —— 进度就这么没了。
  console.log('\n=== 8. 关页兜底：只改设置不得清空运行时状态 ===');
  const runtimeBefore = await page.eval(`(async () => {
    const store = await import('./core/store.js');
    const runtime = await import('./core/runtime.js');
    const c = await store.saveCharacter({ name: '关页测试角色', emoji: '⏳', affinity: 40, greeting: ['hi'] });
    runtime.setRuntime(c.id, { affinity: 88, mood: 'shy', unread: 5 });
    await new Promise(r => setTimeout(r, 900));
    return { id: c.id, affinity: 88 };
  })()`);

  await check('准备阶段：好感度已写进磁盘 runtime.json', async () => {
    const file = path.join(DATA_DIR, 'runtime.json');
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      try {
        const rt = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (rt[runtimeBefore.id] && rt[runtimeBefore.id].affinity === 88) return `affinity=${rt[runtimeBefore.id].affinity}`;
      } catch {}
      await sleep(150);
    }
    throw new Error('磁盘上没写进好感度');
  });

  await check('只改设置 + 立刻触发关页兜底 → runtime.json 不被清空', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      // 默认主题已是 light，先切到 dark，确保本用例确实产生待保存的修改。
      store.setSettings({ theme: 'dark' });
      await (await import('./core/filestore.js')).syncNow();
      // 记录真正发出去的请求体：必须**不带** runtime 字段
      const sent = [];
      const orig = window.fetch;
      window.fetch = (u, o) => { if (String(u).includes('/settings')) sent.push(String(o && o.body)); return orig(u, o); };
      // 只有设置待写（没有 runtime 待写），随后立刻走关窗兜底那条路
      store.setSettings({ theme: 'light' });
      window.dispatchEvent(new Event('pagehide'));
      await new Promise(r => setTimeout(r, 700));
      window.fetch = orig;
      return { theme: store.getSettings().theme, sent };
    })()`);
    assert(r.theme === 'light', '设置没生效');
    assert(r.sent.length >= 1, '关页兜底没有发出 /settings 请求');
    const withRuntime = r.sent.filter((b) => b.includes('"runtime"'));
    assert(withRuntime.length === 0, `请求体里不该出现 runtime 字段：${withRuntime[0] && withRuntime[0].slice(-60)}`);
    const rt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runtime.json'), 'utf8'));
    assert(rt[runtimeBefore.id], `runtime.json 里的角色条目被清掉了：${JSON.stringify(rt).slice(0, 160)}`);
    assert(rt[runtimeBefore.id].affinity === 88, `好感度被写成 ${rt[runtimeBefore.id].affinity}（期望 88）`);
    assert(rt[runtimeBefore.id].unread === 5, `未读数被写成 ${rt[runtimeBefore.id].unread}（期望 5）`);
    const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    assert(settings.theme === 'light', '设置变更没写盘');
    return `请求体不含 runtime；设置写盘成功，好感度/未读仍在`;
  });

  await check('只改设置 + 走去抖写盘（不关页）→ runtime.json 同样不被清空', async () => {
    // 两条发送路径（去抖定时器 / 关窗兜底）必须都只写"确实待写"的字段
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const sent = [];
      const orig = window.fetch;
      window.fetch = (u, o) => { if (String(u).includes('/settings')) sent.push(String(o && o.body)); return orig(u, o); };
      store.setSettings({ accent: '#ff0000' });
      await new Promise(r => setTimeout(r, 1100));
      window.fetch = orig;
      return { sent };
    })()`);
    assert(r.sent.length >= 1, '去抖写盘没有发出 /settings 请求');
    const withRuntime = r.sent.filter((b) => b.includes('"runtime"'));
    assert(withRuntime.length === 0, `去抖路径的请求体里不该出现 runtime 字段：${withRuntime[0] && withRuntime[0].slice(-60)}`);
    const rt = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runtime.json'), 'utf8'));
    assert(rt[runtimeBefore.id] && rt[runtimeBefore.id].affinity === 88, `runtime 被清掉了：${JSON.stringify(rt).slice(0, 160)}`);
    return '去抖写盘后好感度仍在（88）';
  });

  // 回归守（P1）：磁盘清空失败时 wipeAll() 必须如实报告，
  // 磁盘失败时浏览器数据也必须保留，不能只清掉其中一份。
  await check('磁盘不可用时 wipeAll() 如实返回失败（不再假成功）', async () => {
    // 把服务器停掉，模拟"磁盘清空失败"（文件存储此前已探测为可用，但请求发不出去）
    const beforeCount = await page.eval(`(async () => (await (await import('./core/store.js')).listCharacters()).length)()`);
    child.kill('SIGKILL');
    await sleep(600);
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      return await store.wipeAll();
    })()`);
    assert(r && typeof r === 'object', `wipeAll 应返回结果对象，实际 ${JSON.stringify(r)}`);
    assert(r.ok === false, `磁盘清空失败时 ok 应为 false，实际 ${JSON.stringify(r)}`);
    assert(r.fileError, '没有给出失败原因（fileError 为空）');
    const chars = await page.eval(`(async () => (await (await import('./core/store.js')).listCharacters()).length)()`);
    assert(chars === beforeCount && chars > 0, `磁盘失败时浏览器数据应保留：${beforeCount} → ${chars}`);
    return `ok=false、fileError="${String(r.fileError).slice(0, 36)}…"、浏览器数据已保留`;
  });

  const remaining = page.problems.filter((p) => !/icon\.svg|manifest|404|favicon|Failed to fetch|ERR_CONNECTION_REFUSED/i.test(p));
  await check('全程无控制台错误', async () => {
    assert(remaining.length === 0, remaining.slice(0, 2).join(' | '));
    return '0 个错误';
  });
} catch (err) {
  failed++;
  failures.push(`未捕获错误：${err.message}`);
  console.error('\n✗ 中断：', err.message);
} finally {
  console.log(`\n================ 本地文件存储验证：${passed} 通过 / ${failed} 失败 ================`);
  failures.forEach((f) => console.log(' - ' + f));
  console.log('\n磁盘目录内容：');
  try {
    for (const sub of ['characters', 'messages', 'memory', 'groups', 'groupmsgs', 'deleted']) {
      const dir = path.join(DATA_DIR, sub);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      console.log(`  ${sub}/: ${files.length ? files.join(', ') : '（空）'}`);
    }
    const root = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
    console.log(`  根目录: ${root.join(', ') || '（无）'}`);
  } catch (err) {
    console.log('  读取失败：' + err.message);
  }
  code = failed ? 1 : 0;
  await page.close();
  child.kill('SIGKILL');
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
}
process.exit(code);
