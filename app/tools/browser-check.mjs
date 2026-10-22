#!/usr/bin/env node
/**
 * 浏览器自检脚本（零依赖）
 *
 * 用无头 Chrome 打开应用，收集控制台错误 / 未捕获异常 / 失败请求，
 * 并执行一段页面内脚本检查关键 DOM 是否渲染成功。
 *
 * 用法：
 *   node tools/browser-check.mjs                    # 默认检查 http://127.0.0.1:5180
 *   node tools/browser-check.mjs http://127.0.0.1:5199
 *   node tools/browser-check.mjs --port 5181        # 直接指定被测端口
 */

import { spawn } from 'node:child_process';
import { freePort } from './cdp.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
function flagVal(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=').slice(1).join('=') : def;
}
const PORT = flagVal('port', '5180');
const URL_ARG = args.find((a) => a.startsWith('http')) || `http://127.0.0.1:${PORT}`;
// 没显式给 --cdp-port 时向系统要一个空闲端口：固定/推算出来的端口可能被上一次残留的无头浏览器占着
const CDP_PORT = Number(flagVal('cdp-port', 0)) || (await freePort());
const KEEP = args.includes('--keep');
const SHOT = flagVal('shot', '');
const WAIT = Number(flagVal('wait', 3500));

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('✗ 没有找到 Chrome / Edge / Chromium，无法进行浏览器自检。');
  process.exit(2);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-chrome-'));

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,900',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);

let chromeStderr = '';
chrome.stderr.on('data', (d) => {
  chromeStderr += d.toString();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('等待 Chrome DevTools 端口超时');
}

/** 极简 CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const list = this.handlers.get(msg.method) || [];
        for (const fn of list) fn(msg.params, msg.sessionId);
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 30000);
    });
  }
}

const problems = [];
const logs = [];
const failedRequests = [];

function ignoreText(t) {
  return (
    !t ||
    /favicon|DevTools|Autofill|Failed to load resource: net::ERR_FILE|chrome-extension/i.test(t)
  );
}

async function main() {
  const version = await waitForDevtools();
  console.log(`→ 浏览器：${version.Browser}`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('连接 DevTools WebSocket 失败')));
  });
  const cdp = new CDP(ws);

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || [])
      .map((a) => a.value ?? a.description ?? a.preview?.description ?? a.type)
      .join(' ');
    if (p.type === 'error' || p.type === 'warning') {
      logs.push(`[console.${p.type}] ${text}`);
      if (p.type === 'error' && !ignoreText(text)) problems.push(`控制台错误：${text}`);
    } else {
      logs.push(`[console.${p.type}] ${text}`);
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const text = d.exception?.description || d.text || '未知异常';
    problems.push(`未捕获异常：${text.split('\n').slice(0, 3).join(' | ')}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error' && !ignoreText(e.text)) problems.push(`日志错误：${e.text} ${e.url || ''}`);
    else if (e.level === 'warning') logs.push(`[log.warning] ${e.text}`);
  });
  cdp.on('Network.loadingFailed', (p) => {
    if (p.type === 'Fetch' || p.type === 'XHR' || p.type === 'Document' || p.type === 'Script' || p.type === 'Stylesheet') {
      const text = `${p.type} 请求失败：${p.errorText}`;
      if (!ignoreText(text)) failedRequests.push(text);
    }
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  console.log(`→ 打开：${URL_ARG}`);
  await cdp.send('Page.navigate', { url: URL_ARG }, sessionId);
  await sleep(WAIT);

  const probe = `(() => {
    const q = (s) => document.querySelector(s);
    const out = {
      title: document.title,
      hasApp: !!q('#app'),
      shell: !!q('.shell'),
      sidebar: !!q('.pane-side'),
      chatPane: !!q('.pane-main'),
      rightPane: !!q('.pane-right'),
      friendRows: document.querySelectorAll('.friend').length,
      templateCards: document.querySelectorAll('.tpl-card').length,
      modals: document.querySelectorAll('.modal-mask').length,
      toasts: document.querySelectorAll('.toast').length,
      onboard: !!q('.onboard'),
      bodyText: (document.body.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
      errorsInDom: (document.body.innerText || '').includes('模块加载失败'),
      theme: document.documentElement.dataset.theme || '',
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    };
    return out;
  })()`;

  let probeResult = null;
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: false }, sessionId);
    probeResult = r.result?.value || null;
  } catch (err) {
    problems.push(`页面探针执行失败：${err.message}`);
  }

  // 额外的深挖：打开模板库看看是否渲染
  let galleryProbe = null;
  try {
    const r = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          try {
            const m = await import('./ui/editor.js');
            if (typeof m.openTemplateGallery === 'function') { m.openTemplateGallery(); await new Promise(r=>setTimeout(r,400)); }
            return { cards: document.querySelectorAll('.tpl-card').length, groups: document.querySelectorAll('.tpl-groups button').length };
          } catch (e) { return { error: String(e && e.message || e) }; }
        })()`,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId
    );
    galleryProbe = r.result?.value || null;
  } catch (err) {
    galleryProbe = { error: err.message };
  }
  await sleep(300);

  if (SHOT) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log(`→ 截图已保存：${SHOT}`);
    } catch (err) {
      console.warn('截图失败：', err.message);
    }
  }

  console.log('\n--- 页面探针 ---');
  console.log(JSON.stringify(probeResult, null, 2));
  console.log('--- 模板库探针 ---');
  console.log(JSON.stringify(galleryProbe, null, 2));

  console.log('\n--- 控制台输出（最多 40 条）---');
  console.log(logs.slice(0, 40).join('\n') || '（无）');

  if (failedRequests.length) {
    console.log('\n--- 失败请求 ---');
    console.log([...new Set(failedRequests)].slice(0, 20).join('\n'));
  }

  const importantFailures = failedRequests.filter((t) => !/favicon|\.map\b/i.test(t));

  console.log('\n================ 自检结论 ================');
  if (!probeResult?.shell) problems.push('页面未渲染出 .shell 骨架');
  if (problems.length === 0 && importantFailures.length === 0) {
    console.log('✅ 通过：页面无 JS 异常、无控制台错误、无关键请求失败。');
  } else {
    console.log(`❌ 发现 ${problems.length} 个脚本问题、${importantFailures.length} 个请求问题：`);
    [...new Set(problems)].forEach((p) => console.log('   · ' + p));
    [...new Set(importantFailures)].forEach((p) => console.log('   · ' + p));
  }

  if (!KEEP) {
    ws.close();
  }
  return problems.length === 0 && importantFailures.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error('\n✗ 自检脚本执行失败：', err.message);
  if (chromeStderr) console.error(chromeStderr.split('\n').slice(-8).join('\n'));
} finally {
  if (!KEEP) {
    chrome.kill('SIGKILL');
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  } else {
    console.log(`\n（--keep 模式：Chrome 仍在运行，CDP 端口 ${CDP_PORT}，user-data-dir ${userDataDir}）`);
  }
}
process.exit(ok ? 0 : 1);
