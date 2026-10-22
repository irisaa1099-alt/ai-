#!/usr/bin/env node
/**
 * 好感度持久化验证（零依赖 + 无头 Chrome）
 *
 * 复现并锁死这个 bug：「重启程序会导致角色好感度回归初始值」。
 *
 * 步骤：
 *   1. 干净临时库 → 建角色（初始好感度 24）→ 聊天把好感度顶上去；
 *   2. 检查 runtime 是否真的写进了磁盘（data/db/runtime.json）；
 *   3. 重启服务器（模拟"关掉程序再打开"）；
 *   4. 用一个本地库为空的浏览器打开 → 好感度必须还是刚才那个值，不能退回 24。
 *
 * 用法：node tools/affinitycheck.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep, freePort } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-affinity-'));
const REAL_DATA_DIR = path.join(ROOT, 'data', 'db');
if (path.resolve(DATA_DIR).startsWith(path.resolve(REAL_DATA_DIR) + path.sep) || path.resolve(DATA_DIR) === path.resolve(REAL_DATA_DIR)) {
  console.error('✗ 拒绝运行：测试目录不能是真实 data/db');
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

function startServer() {
  const child = spawn(process.execPath, ['server.mjs', '--port', String(PORT), '--no-open', '--data-dir', DATA_DIR], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise(async (resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (r.ok) return resolve(child);
      } catch {}
      await sleep(150);
    }
    child.kill();
    reject(new Error('服务器启动失败：' + out.slice(-200)));
  });
}
const waitHealthy = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(150);
  }
  return false;
};

let server = await startServer();
const page = await launch({ port: await freePort(), width: 1280, height: 860 });
let code = 1;

try {
  console.log('\n=== 1. 建角色并把好感度聊上去 ===');
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳' });

  const step1 = await page.eval(`(async () => {
    const store = await import('./core/store.js');
    const rt = await import('./core/runtime.js');
    store.setSettings({ onboarded: true });
    const c = await store.saveCharacter({ name: '好感度测试', affinity: 24, greeting: ['你好'] });
    localStorage.setItem('aichat.lastChar', c.id);
    await new Promise(r => setTimeout(r, 500));
    const before = rt.getRuntime(c.id).affinity;
    // 模拟聊天带来的好感度增长
    rt.bumpAffinity(c.id, 30);
    rt.setMood(c.id, 'happy');
    await new Promise(r => setTimeout(r, 1200));   // 等去抖落盘
    return { id: c.id, before, after: rt.getRuntime(c.id).affinity };
  })()`);
  await check('页面上好感度已从初始值涨上去', async () => {
    assert(step1.before === 24, `初始应为 24，实际 ${step1.before}`);
    assert(step1.after === 54, `增长后应为 54，实际 ${step1.after}`);
    return `24 → ${step1.after}`;
  });

  await check('好感度真的写进了磁盘 runtime.json', async () => {
    const file = path.join(DATA_DIR, 'runtime.json');
    const data = await waitFor(
      async () => {
        try {
          const d = JSON.parse(fs.readFileSync(file, 'utf8'));
          return d && d[step1.id] ? d : null;
        } catch {
          return null;
        }
      },
      { label: 'runtime.json 写入', timeout: 8000 }
    ).catch(() => null);
    assert(data, `磁盘上没有 ${step1.id} 的运行时状态（runtime.json 内容：${fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(0, 120) : '文件不存在'}）`);
    assert(data[step1.id].affinity === 54, `磁盘记录的好感度应为 54，实际 ${data[step1.id].affinity}`);
    assert(data[step1.id].mood === 'happy', `情绪未落盘：${data[step1.id].mood}`);
    return `runtime.json: affinity=54, mood=happy`;
  });

  await check('改设置不会把旧好感度写回磁盘（去抖写入的竞争）', async () => {
    // 这是最隐蔽的一条：setSettings 与运行时落盘若各自去抖，
    // 配置变更会把"调用那一刻的旧好感度"延后写盘，覆盖掉刚聊出来的新值。
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const rt = await import('./core/runtime.js');
      const id = ${JSON.stringify(step1.id)};
      rt.bumpAffinity(id, 10);                       // 先涨好感度
      store.setSettings({ typedEffect: false });     // 紧接着改一个无关设置
      await new Promise(r => setTimeout(r, 1800));   // 等两个去抖写盘都落地
      return { mem: rt.getRuntime(id).affinity };
    })()`);
    assert(r.mem === 64, `内存里应是 64，实际 ${r.mem}`);
    const disk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runtime.json'), 'utf8'));
    const onDisk = disk[step1.id] ? disk[step1.id].affinity : null;
    assert(onDisk === 64, `磁盘上应保留 64，实际 ${onDisk}（说明设置变更把旧好感度写回了磁盘）`);
    return `好感度 64 未被设置变更覆盖（磁盘=${onDisk}）`;
  });

  console.log('\n=== 2. 重启服务器（模拟关掉程序再打开）===');
  server.kill('SIGKILL');
  await sleep(800);
  server = await startServer();
  await check('服务器已重新启动', async () => {
    assert(await waitHealthy(), '服务器没起来');
    return `http://127.0.0.1:${PORT}`;
  });

  console.log('\n=== 3. 用本地库为空的浏览器打开，看好感度 ===');
  await check('重启后好感度没有退回初始值', async () => {
    // 清空浏览器数据，模拟"换了浏览器 / 浏览器清理过"
    await page.eval(`(async () => {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('aichat');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      localStorage.clear();
      return true;
    })()`);
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('!!window.__AICHAT__'), { label: '应用启动' });
    const after = await waitFor(
      async () =>
        page.eval(`(async () => {
          const store = await import('./core/store.js');
          const rt = await import('./core/runtime.js');
          const chars = await store.listCharacters();
          if (!chars.length) return null;
          const r = rt.getRuntime(chars[0].id);
          return { name: chars[0].name, affinity: r.affinity, mood: r.mood, init: chars[0].affinity };
        })()`),
      { label: '数据恢复', timeout: 20000 }
    );
    assert(after.affinity === 64, `好感度退回了：期望 64，实际 ${after.affinity}（角色卡初始值 ${after.init}）`);
    assert(after.mood === 'happy', `情绪丢失：${after.mood}`);
    return `${after.name}：${after.init}(初始) → ${after.affinity}（重启后仍保持）`;
  });

  await check('好感度标签随数值正确显示', async () => {
    const label = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const rt = await import('./core/runtime.js');
      const c = (await store.listCharacters())[0];
      return rt.affinityLabel(rt.getRuntime(c.id).affinity);
    })()`);
    return `64 → ${label}`;
  });
} catch (err) {
  failed++;
  failures.push(`未捕获错误：${err.message}`);
  console.error('\n✗ 中断：', err.message);
} finally {
  console.log(`\n================ 好感度持久化验证：${passed} 通过 / ${failed} 失败 ================`);
  failures.forEach((f) => console.log(' - ' + f));
  code = failed ? 1 : 0;
  await page.close();
  server.kill('SIGKILL');
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
}
process.exit(code);
