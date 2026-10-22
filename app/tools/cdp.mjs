/**
 * 极简 CDP（Chrome DevTools Protocol）助手 —— 供测试脚本复用，零依赖。
 * 用无头 Chrome 打开页面、收集控制台错误、在页面里执行脚本、截图。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动 Chrome（无头）并返回操作句柄 */
export async function launch(opts = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('没有找到 Chrome / Edge / Chromium');
  const port = opts.port || 9333;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-cdp-'));
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      `--window-size=${opts.width || 1440},${opts.height || 900}`,
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  let wsUrl = '';
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        wsUrl = (await res.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(150);
  }
  if (!wsUrl) {
    child.kill('SIGKILL');
    throw new Error(`Chrome 启动失败：${stderr.slice(-400)}`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket 连接失败')));
  });

  const client = new Cdp(ws);
  const problems = [];
  const logs = [];

  client.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${p.type}] ${text}`);
    if (p.type === 'error' && !/favicon|icon\.svg|ERR_FILE/.test(text)) problems.push(text);
  });
  client.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    problems.push((d.exception?.description || d.text || '未知异常').split('\n')[0]);
  });
  client.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error' && !/favicon|icon\.svg|ERR_FILE/.test(e.text || '')) {
      problems.push(`${e.text} ${e.url || ''}`);
    } else if (e.level === 'warning') logs.push(`[warn] ${e.text}`);
  });

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Log.enable', {}, sessionId);
  await client.send('Page.enable', {}, sessionId);
  await client.send('Network.enable', {}, sessionId);
  await client.send(
    'Emulation.setDeviceMetricsOverride',
    { width: opts.width || 1440, height: opts.height || 900, deviceScaleFactor: 1, mobile: Boolean(opts.mobile) },
    sessionId
  );

  const session = {
    client,
    sessionId,
    problems,
    logs,
    async goto(url) {
      await client.send('Page.navigate', { url }, sessionId);
    },
    /** 在页面里执行脚本（支持 await） */
    async eval(expression) {
      const r = await client.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        sessionId
      );
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`页面脚本异常：${d.exception?.description || d.text}`);
      }
      return r.result?.value;
    },
    async shot(file) {
      const s = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      return file;
    },
    async close() {
      try {
        ws.close();
      } catch {}
      child.kill('SIGKILL');
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    },
  };
  return session;
}

/** 极简 CDP 客户端 */
export class Cdp {
  /**
   * @param {WebSocket} ws 已连接的调试 socket
   * @param {{timeoutMs?: number}} [opts] 单条命令的超时（默认 120s；测试里会调小）
   */
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    /**
     * 单条 CDP 命令的超时。默认 120 秒：一个 evaluate 里跑完一整局狼人杀是常态
     * （十几天的局 20~40s），60s 会把这类用例压成偶发失败。
     * @type {number}
     */
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
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
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
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
      // 超时定时器必须跟着响应一起清掉：一次狼人杀用例会发上千条 CDP 命令，
      // 每条都留一个 120 秒的定时器，事件循环里就一直堆着成千上万个待触发的 timer
      // （既拖慢后续断言的墙钟耗时，进程退出前也得挨个等）。
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return; // 已经返回过了（正常路径下这个定时器已被清掉）
        this.pending.delete(id);
        // 光 reject 是不够的：页面里那段脚本还在跑，它占着页面与定时器不放，
        // 下一条用例就会跟着超时 —— "一超时就连片超时"就是这么来的。
        // 这里顺手让浏览器停下当前执行（失败也不影响超时本身）。
        this.terminateExecution(sessionId);
        reject(new Error(`CDP 调用超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }
  /**
   * 让浏览器立刻停止当前正在执行的脚本（超时兜底，见 send()）。
   * 不登记进 pending：这条命令的回包不关心，失败也只是忽略。
   * @param {string} [sessionId]
   */
  terminateExecution(sessionId) {
    try {
      const id = ++this.id;
      const payload = { id, method: 'Runtime.terminateExecution', params: {} };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    } catch {
      /* 忽略：终止失败不影响超时处理 */
    }
  }
}

/**
 * 取一个当前空闲的端口（让系统分配，再立刻释放）。
 *
 * 为什么不用"基址 + 随机数"：在窄端口段里随机，跑几次就会撞上别的实例或上一次的残留
 * （`EADDRINUSE`，表现为"首次运行失败、重跑通过"）。测试脚本必须自己找得到空位。
 * @returns {Promise<number>}
 */
export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
