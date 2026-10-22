#!/usr/bin/env node
/**
 * 安全回归（零依赖，纯 HTTP，不需要浏览器）
 *
 * 守的是《项目Bug修复优先级清单》里的 P0 三项与 P1 的写盘一项：
 *   1. **静态路径保护不能被绕过**：`/x/../.env.example` 这种"先穿越再落地"的写法，
 *      以前在路径归一化**之前**就做敏感路径正则匹配，于是绕过检查读到 `.env` /
 *      `data/db/settings.json`（里面有 API Key）。现在必须先归一化再判断。
 *   2. **局域网接口必须有访问控制**：`--host 0.0.0.0` 时，以前任何能连上来的设备都能
 *      `GET /api/db/state`（含密钥）或 `POST /api/db/wipe {force:true}` 清空整库，
 *      `AICHAT_PROXY_TOKEN` 只管 /api/llm，保护不了数据库接口。
 *   3. **代理不能把服务器 Key 发到调用方指定的任意地址**：请求体里的 `baseUrl` 会让
 *      服务器带着自己的 Key 去请求那个地址；现在非本机请求进不来，并且可以用
 *      `AICHAT_ALLOWED_UPSTREAMS` 把允许的自定义地址显式列出来。
 *   4. **只改设置不得清空磁盘运行时状态**：`/api/db/settings` 只带 settings 时，
 *      runtime.json（好感度 / 未读）必须原样保留。
 *
 * 用法：node tools/securitycheck.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { freePort } from './cdp.mjs';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const REAL_DATA_DIR = path.join(ROOT, 'data', 'db');
/**
 * 每个服务器/假上游都向系统要一个空闲端口。
 * 不用"基址 + 随机偏移"：那在残留实例或并发测试下会撞 EADDRINUSE（P2 那条），
 * 而且这里同时要起 6 个服务器 + 2 个假上游，偏移写法更容易自己撞自己。
 */
const nextPort = () => freePort();

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`);
  } catch (err) {
    failed++;
    failures.push(`${name}：${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
function skip(name, why) {
  skipped++;
  console.log(`  ⊘ ${name}  → 跳过：${why}`);
}
const assert = (c, m) => {
  if (!c) throw new Error(m || '断言失败');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/** 本机局域网地址（用来模拟"另一台设备"访问）。取不到时相关用例会跳过。 */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) return i.address;
    }
  }
  return '';
}
const LAN = lanAddress();

const TEMP_DIRS = [];
/** 建一个测试专用数据目录（绝不能指向真实 data/db） */
function newDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-seccheck-'));
  if (path.resolve(dir) === path.resolve(REAL_DATA_DIR) || path.resolve(dir).startsWith(path.resolve(REAL_DATA_DIR) + path.sep)) {
    throw new Error('拒绝运行：测试数据目录不能是真实的 data/db');
  }
  TEMP_DIRS.push(dir);
  return dir;
}

/** 启动一个被测服务器 */
async function startServer({ port, host = '127.0.0.1', env = {} }) {
  const dataDir = newDataDir();
  const child = spawn(
    process.execPath,
    ['server.mjs', '--port', String(port), '--no-open', '--host', host, '--data-dir', dataDir],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));
  const local = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${local}/api/health`)).ok, { label: `服务器 :${port}`, timeout: 15000 });
  return {
    port,
    dataDir,
    local,
    lanOrigin: `http://${LAN}:${port}`,
    log: () => log,
    stop: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 发请求，返回 { status, text, json, headers } */
async function req(url, opts = {}) {  const res = await fetch(url, { redirect: 'manual', ...opts });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}
function postJson(url, body, headers = {}) {
  return req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const errCode = (r) => (r.json && r.json.error && r.json.error.code) || '';

/**
 * 用原始 socket 发一个请求行未经改动的 GET。
 *
 * 为什么需要：`fetch()`（undici）在发出前会**自己把 `/x/../y` 归一化成 `/y`**，
 * 于是用它根本测不到"服务器有没有被 `..` 绕过"——用例会假通过。
 * 报告里的复现（以及 curl 不带 --path-as-is 时）走的就是这种"原样路径"。
 * @param {number} port
 * @param {string} rawPath 原样写进请求行的路径
 * @param {string} [host]
 * @returns {Promise<{status:number, text:string}>}
 */
function rawRequest(port, rawPath, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    sock.setEncoding('utf8'); // Preserve multibyte characters split across TCP packets.
    let buf = '';
    const done = () => resolve({ status: Number((buf.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0), text: buf });
    sock.setTimeout(8000, () => {
      sock.destroy();
      done();
    });
    sock.on('connect', () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => (buf += d.toString('utf8')));
    sock.on('end', done);
    sock.on('close', done);
    sock.on('error', reject);
  });
}

/** 假上游：记录每一次收到的请求，用来证明 Key 有没有被发到某个地址 */
function startRecorder(port) {
  const hits = [];
  const server = http.createServer((sreq, sres) => {
    let body = '';
    sreq.on('data', (c) => (body += c));
    sreq.on('end', () => {
      if (sreq.url.startsWith('/__hits')) {
        sres.writeHead(200, { 'Content-Type': 'application/json' });
        return sres.end(JSON.stringify({ hits }));
      }
      hits.push({ url: sreq.url, auth: String(sreq.headers.authorization || ''), body: body.slice(0, 200) });
      sres.writeHead(200, { 'Content-Type': 'application/json' });
      if (sreq.url.endsWith('/models')) return sres.end(JSON.stringify({ data: [{ id: 'recorder-model' }] }));
      sres.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'recorder-ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        base: `http://127.0.0.1:${port}/v1`,
        hits: () => hits.filter((h) => !h.url.startsWith('/__hits')),
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}

const servers = [];
const recorders = [];
let code = 1;

try {
  /* ================================================================== *
   * 1. 静态路径保护（P0-1）
   * ================================================================== */
  console.log('\n=== 1. 静态路径保护不能被绕过（P0）===');
  const s1 = await startServer({ port: await nextPort() });
  servers.push(s1);

  // app/.env.example 是仓库里真实存在的文件：它若读得到，说明真实 .env 也读得到
  const marker = (fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n').find((l) => l.includes('=')) || 'AICHAT').trim();

  await check('穿越/编码/归一化后的敏感路径全部 403（原样请求行，不经 fetch 归一化）', async () => {
    const paths = [
      '/.env.example',
      '/x/../.env.example',
      '/ui/../.env.example',
      '/./.env.example',
      '/%2e%2e/.env.example',
      '/%2E%2E/.env.example',
      '/x/%2e%2e/.env.example',
      '/data/db/settings.json',
      '/x/../data/db/settings.json',
      '/data/db/../db/settings.json',
      '//data/db/settings.json',
      '/./data/db/runtime.json',
      '/x/../tools/e2e.mjs',
      '/tools/../tools/cdp.mjs',
      '/.gitignore',
    ];
    const bad = [];
    for (const p of paths) {
      const r = await rawRequest(s1.port, p);
      if (r.status !== 403) bad.push(`${p} → ${r.status}`);
    }
    assert(bad.length === 0, `以下路径没有被挡住：\n      ${bad.join('\n      ')}`);
    return `${paths.length} 个原样路径全部 403`;
  });

  await check('被挡的响应体里不含文件内容（没有泄露）', async () => {
    for (const p of ['/x/../.env.example', '//data/db/settings.json', '/x/../data/db/settings.json']) {
      const r = await rawRequest(s1.port, p);
      assert(r.status === 403, `${p} → ${r.status}`);
      assert(!r.text.includes(marker), `${p} 的响应体里出现了 .env.example 的内容：${r.text.slice(0, 120)}`);
      assert(!r.text.includes('AICHAT_API_KEY'), `${p} 的响应体里出现了环境变量名`);
      assert(!r.text.includes('"apiKeys"'), `${p} 的响应体里出现了设置内容`);
    }
    return '403 且无内容泄露';
  });

  await check('正常静态资源与模块仍可访问', async () => {
    const okPaths = ['/', '/index.html', '/ui/app.js', '/ui/chat.js', '/data/models.js', '/data/templates.js', '/styles/base.css', '/styles/app.css', '/manifest.webmanifest', '/icon.svg', '/sw.js'];
    const bad = [];
    for (const p of okPaths) {
      const r = await req(`${s1.local}${p}`);
      if (r.status !== 200) bad.push(`${p} → ${r.status}`);
    }
    assert(bad.length === 0, `以下资源取不到了：${bad.join(', ')}`);
    return `${okPaths.length} 个资源均 200`;
  });

  await check('多余的点/斜杠仍归一化到合法文件（不会误伤）', async () => {
    const bodyOf = (raw) => raw.text.slice(raw.text.indexOf('\r\n\r\n') + 4);
    const a = await rawRequest(s1.port, '/ui/app.js');
    const b = await rawRequest(s1.port, '/x/../ui/app.js');
    const c = await rawRequest(s1.port, '//ui//app.js');
    assert(a.status === 200, `/ui/app.js → ${a.status}`);
    assert(b.status === 200, `/x/../ui/app.js → ${b.status}`);
    assert(c.status === 200, `//ui//app.js → ${c.status}`);
    assert(bodyOf(b) === bodyOf(a) && bodyOf(c) === bodyOf(a), '归一化后拿到的内容不一致');
    return '三种写法都拿到同一份 app.js';
  });

  await check('非法百分号编码返回 400，且服务器不崩', async () => {
    const r = await rawRequest(s1.port, '/%zz');
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
    const alive = await req(`${s1.local}/api/health`);
    assert(alive.status === 200, '非法编码之后服务器不可用了');
    return '400 且服务器仍正常';
  });

  /* ================================================================== *
   * 2. 非本机请求必须带口令（P0-2）
   * ================================================================== */
  console.log('\n=== 2. 非本机请求必须带口令（P0）===');
  const s2 = await startServer({ port: await nextPort(), host: '0.0.0.0' });
  servers.push(s2);

  await check('本机（回环）请求照常可用 —— 桌面端不受影响', async () => {
    const state = await req(`${s2.local}/api/db/state`);
    assert(state.status === 200, `本机 /api/db/state → ${state.status}`);
    const health = await req(`${s2.local}/api/health`);
    assert(health.json && health.json.dataDir, '本机 health 应带 dataDir');
    return '/api/db/state 200、health 带 dataDir';
  });

  if (!LAN) {
    skip('局域网来源的数据/代理接口被拒绝', '本机没有可用的局域网 IPv4 地址');
    skip('局域网 health 只回 {ok:true}', '本机没有可用的局域网 IPv4 地址');
    skip('局域网 wipe 不会真的清数据', '本机没有可用的局域网 IPv4 地址');
  } else {
    await check('局域网来源的数据/代理接口被拒绝（未配置口令）', async () => {
      const cases = [
        ['GET /api/db/state', () => req(`${s2.lanOrigin}/api/db/state`)],
        ['POST /api/db/wipe', () => postJson(`${s2.lanOrigin}/api/db/wipe`, { force: true })],
        ['POST /api/llm', () => postJson(`${s2.lanOrigin}/api/llm`, { provider: 'openai', model: 'x', messages: [] })],
        ['POST /api/tts', () => postJson(`${s2.lanOrigin}/api/tts`, { text: 'hi' })],
      ];
      const bad = [];
      for (const [label, run] of cases) {
        const r = await run();
        if (r.status !== 403 || errCode(r) !== 'remote-needs-token') bad.push(`${label} → ${r.status}/${errCode(r)}`);
      }
      assert(bad.length === 0, `以下请求没有被挡住：${bad.join(', ')}`);
      return '4 个接口均 403（remote-needs-token）';
    });

    await check('局域网来源的 /api/health 只回 {ok:true}（不泄露路径与配置）', async () => {
      const r = await req(`${s2.lanOrigin}/api/health`);
      assert(r.status === 200, `health → ${r.status}`);
      assert(r.json && r.json.ok === true, 'health 应返回 ok:true');
      assert(!r.json.dataDir && !r.json.root && !r.json.providers, `泄露了本机信息：${r.text.slice(0, 120)}`);
      return JSON.stringify(r.json);
    });

    await check('局域网来源的 wipe 不会真的清掉磁盘数据', async () => {
      // 先在盘上放一个角色，再从"另一台设备"尝试清空
      const put = await postJson(`${s2.local}/api/db/characters/c_sec_check01`, {
        data: { id: 'c_sec_check01', name: '守护测试角色' },
      });
      assert(put.status === 200, `准备阶段写角色失败：${put.status}`);
      const dir = path.join(s2.dataDir, 'characters');
      const before = fs.readdirSync(dir).length;
      assert(before > 0, '准备阶段磁盘上没有角色');
      const r = await postJson(`${s2.lanOrigin}/api/db/wipe`, { force: true });
      assert(r.status === 403, `局域网 wipe → ${r.status}`);
      const after = fs.readdirSync(dir).length;
      assert(after === before, `磁盘数据被清掉了：${before} → ${after}`);
      return `wipe 被拒（403），磁盘上 ${after} 个角色完好`;
    });
  }

  /* ---- 配了口令之后：局域网可用，且只能靠口令 ---- */
  const TOKEN = 'sec-check-token-42';
  const s3 = await startServer({ port: await nextPort(), host: '0.0.0.0', env: { AICHAT_PROXY_TOKEN: TOKEN } });
  servers.push(s3);

  if (!LAN) {
    skip('局域网口令校验矩阵', '本机没有可用的局域网 IPv4 地址');
    skip('手机流程：?token= 种 Cookie', '本机没有可用的局域网 IPv4 地址');
    skip('同源局域网页面可用', '本机没有可用的局域网 IPv4 地址');
    skip('跨站来源仍被拒绝', '本机没有可用的局域网 IPv4 地址');
    skip('本机无口令仍可用', '本机没有可用的局域网 IPv4 地址');
  } else {
    await check('局域网：无口令/错口令 401，正确口令放行', async () => {
      const none = await req(`${s3.lanOrigin}/api/db/state`);
      assert(none.status === 401, `无口令 → ${none.status}`);
      assert(errCode(none) === 'bad-token', `错误码不对：${none.text.slice(0, 80)}`);
      const wrong = await req(`${s3.lanOrigin}/api/db/state`, { headers: { 'X-Aichat-Token': 'nope' } });
      assert(wrong.status === 401, `错口令 → ${wrong.status}`);
      const viaHeader = await req(`${s3.lanOrigin}/api/db/state`, { headers: { 'X-Aichat-Token': TOKEN } });
      assert(viaHeader.status === 200, `头口令 → ${viaHeader.status}`);
      const viaBearer = await req(`${s3.lanOrigin}/api/db/state`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert(viaBearer.status === 200, `Bearer → ${viaBearer.status}`);
      const viaQuery = await req(`${s3.lanOrigin}/api/db/state?token=${TOKEN}`);
      assert(viaQuery.status === 200, `查询串 → ${viaQuery.status}`);
      return '无口令 401 / 错口令 401 / 头·Bearer·查询串 200';
    });

    await check('手机流程：带 ?token= 打开页面即记住口令（Cookie）', async () => {
      const page = await req(`${s3.lanOrigin}/?token=${TOKEN}`);
      assert(page.status === 200, `页面 → ${page.status}`);
      const setCookie = String(page.headers.get('set-cookie') || '');
      assert(/aichat_token=/.test(setCookie), `没有种 Cookie：${setCookie}`);
      assert(/HttpOnly/i.test(setCookie), 'Cookie 缺少 HttpOnly');
      assert(/SameSite=Strict/i.test(setCookie), 'Cookie 缺少 SameSite=Strict');
      const cookie = setCookie.split(';')[0];
      const api = await req(`${s3.lanOrigin}/api/db/state`, { headers: { Cookie: cookie } });
      assert(api.status === 200, `带 Cookie 访问接口 → ${api.status}`);
      const badPage = await req(`${s3.lanOrigin}/?token=wrong-one`);
      assert(!/aichat_token=/.test(String(badPage.headers.get('set-cookie') || '')), '错误口令竟然也种了 Cookie');
      return `${cookie.slice(0, 22)}… 可授权后续接口请求`;
    });

    await check('同源局域网页面（带口令）可正常使用 —— 不再一律 403', async () => {
      const page = await req(`${s3.lanOrigin}/?token=${TOKEN}`);
      const cookie = String(page.headers.get('set-cookie') || '').split(';')[0];
      const r = await req(`${s3.lanOrigin}/api/db/state`, { headers: { Origin: s3.lanOrigin, Cookie: cookie } });
      assert(r.status === 200, `同源局域网请求 → ${r.status}（应当放行）`);
      return `Origin=${s3.lanOrigin} + Cookie → 200`;
    });

    await check('跨站来源即使带正确口令也仍被拒绝（CSRF 未被削弱）', async () => {
      const evil = { Origin: 'https://evil.example', 'X-Aichat-Token': TOKEN };
      const g = await req(`${s3.lanOrigin}/api/db/state`, { headers: evil });
      assert(g.status === 403, `跨站 GET → ${g.status}（应当 403）`);
      const w = await postJson(`${s3.lanOrigin}/api/db/wipe`, { force: true }, evil);
      assert(w.status === 403, `跨站 wipe → ${w.status}`);
      return '跨站 GET/POST 均 403';
    });

    await check('本机请求即使没有口令也照常可用', async () => {
      const r = await req(`${s3.local}/api/db/state`);
      assert(r.status === 200, `本机 → ${r.status}`);
      return '200';
    });
  }

  /* ================================================================== *
   * 3. 上游地址必须与凭据绑定（P0-3）
   * ================================================================== */
  console.log('\n=== 3. 上游地址必须与凭据明确绑定（P0）===');
  const recA = await startRecorder(await nextPort());
  const recB = await startRecorder(await nextPort());
  recorders.push(recA, recB);
  const KEY = 'sk-server-key-for-test';

  const s4 = await startServer({ port: await nextPort(), env: { OPENAI_API_KEY: KEY } });
  servers.push(s4);

  await check('本机自定义反代地址仍可用（既有功能没被破坏）', async () => {
    const r = await postJson(`${s4.local}/api/llm`, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: recA.base,
    });
    assert(r.status === 200, `代理 → ${r.status}：${r.text.slice(0, 120)}`);
    const hits = recA.hits();
    assert(hits.length === 1, `假上游收到 ${hits.length} 次请求（期望 1）`);
    assert(hits[0].auth === `Bearer ${KEY}`, `上游收到的 Authorization 不对：${hits[0].auth}`);
    return `本机请求 → ${recA.base}，带的是该供应商的服务器 Key`;
  });

  await check('本机设了访问口令也无需在 LLM 请求体重复填写', async () => {
    const local = await postJson(`${s3.local}/api/llm`, {
      provider: 'ollama', model: 'local-test', messages: [{ role: 'user', content: 'hi' }], baseUrl: recA.base,
    });
    assert(local.status === 200, `本机无请求体口令 → ${local.status}：${local.text.slice(0, 120)}`);
    return '无密钥本地模型 + 本机无口令 200';
  });

  if (LAN) {
    await check('局域网 Cookie 可直接授权 LLM 代理，不要求请求体再填口令', async () => {
      const page = await req(`${s3.lanOrigin}/?token=${TOKEN}`);
      const cookie = String(page.headers.get('set-cookie') || '').split(';')[0];
      const viaCookie = await postJson(`${s3.lanOrigin}/api/llm`, {
        provider: 'ollama', model: 'local-test', messages: [{ role: 'user', content: 'hi' }], baseUrl: recA.base,
      }, { Origin: s3.lanOrigin, Cookie: cookie });
      assert(viaCookie.status === 200, `Cookie 授权 → ${viaCookie.status}：${viaCookie.text.slice(0, 120)}`);
      return 'Cookie 授权 LLM 200';
    });
  }

  await check('代理模型列表由服务端带 Key 请求上游', async () => {
    const r = await postJson(`${s4.local}/api/models`, { provider: 'openai', baseUrl: recA.base });
    assert(r.status === 200, `/api/models → ${r.status}：${r.text.slice(0, 120)}`);
    assert(r.json?.models?.includes('recorder-model'), `模型列表不正确：${r.text.slice(0, 120)}`);
    const hit = recA.hits().at(-1);
    assert(hit.url.endsWith('/models') && hit.auth === `Bearer ${KEY}`, `上游请求未带正确 Key：${JSON.stringify(hit)}`);
    return '服务端 GET /models 且 Bearer Key 正确';
  });

  const s5 = await startServer({ port: await nextPort(), env: { OPENAI_API_KEY: KEY, AICHAT_ALLOWED_UPSTREAMS: recA.base } });
  servers.push(s5);

  await check('设置允许列表后：列表内可用；列表外 403 且上游收不到请求', async () => {
    const beforeB = recB.hits().length;
    const ok = await postJson(`${s5.local}/api/llm`, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: recA.base,
    });
    assert(ok.status === 200, `列表内地址 → ${ok.status}：${ok.text.slice(0, 120)}`);

    const bad = await postJson(`${s5.local}/api/llm`, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: recB.base,
    });
    assert(bad.status === 403, `列表外地址 → ${bad.status}（应当 403）`);
    assert(errCode(bad) === 'upstream-not-allowed', `错误码不对：${bad.text.slice(0, 120)}`);
    const afterB = recB.hits().length;
    assert(afterB === beforeB, `Key 被发到了未授权的地址：${JSON.stringify(recB.hits().slice(-1))}`);
    return '列表内 200；列表外 403，未授权上游 0 次请求';
  });

  await check('非 http(s) 的上游地址被拒绝', async () => {
    const r = await postJson(`${s5.local}/api/llm`, {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [],
      baseUrl: 'file:///etc/passwd',
    });
    assert(r.status === 403, `file:// 地址 → ${r.status}`);
    return '403';
  });

  if (!LAN) {
    skip('局域网来源无法借用服务器 Key', '本机没有可用的局域网 IPv4 地址');
  } else {
    await check('局域网来源连代理接口都进不去（不可能借用服务器 Key）', async () => {
      const before = recA.hits().length;
      const r = await postJson(`${s2.lanOrigin}/api/llm`, {
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [],
        baseUrl: recA.base,
      });
      assert(r.status === 403, `局域网 /api/llm → ${r.status}`);
      assert(recA.hits().length === before, '上游竟然收到了请求');
      return '403 且上游 0 次请求';
    });
  }

  /* ================================================================== *
   * 4. 只改设置不得清空磁盘运行时状态（P1）
   * ================================================================== */
  console.log('\n=== 4. 写盘：只改设置不清空运行时状态（P1）===');
  const s6 = await startServer({ port: await nextPort() });
  servers.push(s6);
  const runtimeFile = path.join(s6.dataDir, 'runtime.json');

  await check('只写 settings 时 runtime.json 原样保留', async () => {
    const first = await postJson(`${s6.local}/api/db/settings`, {
      data: { runtime: { c_sec_runtime1: { affinity: 77, mood: 'happy', unread: 3 } } },
    });
    assert(first.status === 200, `第一次写入 → ${first.status}`);
    const before = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert(before.c_sec_runtime1.affinity === 77, '准备阶段没写进 runtime');

    const second = await postJson(`${s6.local}/api/db/settings`, { data: { settings: { theme: 'light' } } });
    assert(second.status === 200, `只写设置 → ${second.status}`);
    const after = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert(after.c_sec_runtime1 && after.c_sec_runtime1.affinity === 77, `runtime 被清掉了：${JSON.stringify(after)}`);
    assert(after.c_sec_runtime1.unread === 3, '未读数被清掉了');
    const settings = JSON.parse(fs.readFileSync(path.join(s6.dataDir, 'settings.json'), 'utf8'));
    assert(settings.theme === 'light', '设置没写进去');
    return '只改设置后 affinity/unread 仍在，设置也写入成功';
  });

  await check('显式传 runtime:{} 仍可清空（清库语义没被破坏）', async () => {
    const r = await postJson(`${s6.local}/api/db/settings`, { data: { runtime: {} } });
    assert(r.status === 200, `${r.status}`);
    const after = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert(Object.keys(after).length === 0, `应当被清空：${JSON.stringify(after)}`);
    return 'runtime.json = {}';
  });

  await check('整库覆盖与消息追加并发时不报错，单会话重写也不死锁', async () => {
    const id = 'c_lock_check01';
    const char = { id, name: '并发锁测试' };
    const replace = postJson(`${s6.local}/api/db/replace`, { characters: [char], messages: [{ id: 'm_seed', charId: id, role: 'user', content: 'seed' }] });
    const appends = Array.from({ length: 12 }, (_, i) =>
      postJson(`${s6.local}/api/db/messages/${id}`, { messages: [{ id: `m_lock_${i}`, charId: id, role: 'user', content: String(i) }] })
    );
    const rewrite = postJson(`${s6.local}/api/db/messages/${id}/replace`, { messages: [{ id: 'm_rewrite', charId: id, role: 'user', content: 'rewrite' }] });
    const results = await Promise.race([
      Promise.all([replace, ...appends, rewrite]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('并发写入等待超时，可能出现锁顺序死锁')), 8000)),
    ]);
    assert(results.every((r) => r.status === 200), `并发请求出现非 200：${results.map((r) => r.status).join(',')}`);
    const raw = fs.readFileSync(path.join(s6.dataDir, 'messages', `${id}.ndjson`), 'utf8');
    assert(raw.trim().split('\n').every((line) => JSON.parse(line).id), '并发写入后 NDJSON 格式损坏');
    return `${results.length} 个请求均 200，消息文件可解析`;
  });

  /* ------------------------------------------------------------------ */
  console.log(`\n================ 安全回归：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''} ================`);
  failures.forEach((f) => console.log(' - ' + f));
  code = failed ? 1 : 0;
} catch (err) {
  failed++;
  console.error('\n✗ 中断：', err.message);
  code = 1;
} finally {
  for (const s of servers) s.stop();
  for (const r of recorders) await r.close().catch(() => {});
  for (const d of TEMP_DIRS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}
process.exit(code);
