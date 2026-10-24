#!/usr/bin/env node
/** 多厂商接入回归：仅使用虚构密钥、本机假上游和临时服务器副本，不读写真实配置/数据库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chat, chatStream, listModels } from '../core/llm.js';
import { PROVIDERS_META } from '../data/models.js';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-providers-'));
const app = path.join(temp, 'app');
fs.mkdirSync(app);
fs.copyFileSync(path.join(root, 'server.mjs'), path.join(app, 'server.mjs'));
fs.cpSync(path.join(root, 'core'), path.join(app, 'core'), { recursive: true });
const nativeFetch = globalThis.fetch;
const envNames = { deepseek: 'DEEPSEEK', openai: 'OPENAI', moonshot: 'MOONSHOT', zhipu: 'ZHIPU',
  qwen: 'DASHSCOPE', siliconflow: 'SILICONFLOW', openrouter: 'OPENROUTER', anthropic: 'ANTHROPIC',
  gemini: 'GEMINI', ollama: 'OLLAMA', lmstudio: 'LMSTUDIO', custom: 'CUSTOM' };
const keys = Object.fromEntries(Object.keys(PROVIDERS_META).map((id) => [id,
  id === 'ollama' || id === 'lmstudio' ? '' : `${id}-dummy.ABC_123:xyz+=-`]));
const calls = [];
let passed = 0, failed = 0, child;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.error(`✗ ${name}: ${err.message}`); }
}
const json = (res, status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
const upstream = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const provider = url.pathname.split('/')[1];
    const meta = PROVIDERS_META[provider];
    assert.ok(meta, '未知上游');
    const kind = meta.kind;
    const key = keys[provider];
    if (key) {
      const received = kind === 'anthropic' ? req.headers['x-api-key'] : kind === 'gemini'
        ? (req.headers['x-goog-api-key'] || url.searchParams.get('key'))
        : (req.headers.authorization || '').replace(/^Bearer /, '');
      assert.equal(received, key, '密钥必须匹配当前厂商且不含多余空格');
    } else assert.equal(req.headers.authorization, undefined, '本地模型不应收到其他厂商密钥');
    if (kind === 'anthropic') assert.equal(req.headers['anthropic-version'], '2023-06-01');
    if (req.method === 'GET') {
      assert.equal(url.pathname, `/${provider}/models`);
      calls.push({ provider, method: 'GET' });
      return json(res, 200, kind === 'gemini' ? { models: [{ name: 'models/test-model' }] } : { data: [{ id: 'test-model' }] });
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const stream = kind === 'gemini' ? url.pathname.endsWith(':streamGenerateContent') : body.stream;
    const suffix = kind === 'anthropic' ? '/messages' : kind === 'gemini'
      ? `/models/test-model:${stream ? 'streamGenerateContent' : 'generateContent'}` : '/chat/completions';
    assert.equal(url.pathname, `/${provider}${suffix}`);
    if (kind === 'gemini') {
      assert.equal(body.systemInstruction.parts[0].text, '测试系统');
      assert.equal(body.contents[0].role, 'user');
      if (stream) assert.equal(url.searchParams.get('alt'), 'sse');
    } else if (kind === 'anthropic') {
      assert.equal(body.system, '测试系统');
      assert.equal(body.messages[0].role, 'user');
      assert.ok(body.max_tokens > 0);
      assert.equal(body.presence_penalty, undefined);
    } else {
      assert.equal(body.messages[0].role, 'system');
      if (provider !== 'deepseek') assert.equal(body.thinking, undefined, 'DeepSeek 专用字段不能发给其他厂商');
    }
    calls.push({ provider, method: 'POST', body, headers: req.headers });
    const text = '连接正常';
    if (!stream) return json(res, 200, kind === 'anthropic'
      ? { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } }
      : kind === 'gemini' ? { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }
      : { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = kind === 'anthropic'
      ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]
      : kind === 'gemini' ? [{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }]
      : [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end(kind === 'anthropic' || kind === 'gemini' ? '' : 'data: [DONE]\n\n');
  } catch (err) { json(res, 400, { error: { message: err.message } }); }
});

try {
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/API_KEY|^AICHAT_|^HOST$|^PORT$/.test(k)));
  for (const [id, prefix] of Object.entries(envNames)) env[`${prefix}_API_KEY`] = keys[id];
  // dotenv 引号中或环境变量中的首尾空格应与浏览器输入一样被清理。
  env.DASHSCOPE_API_KEY = `  ${keys.qwen}  `;
  // 聚合配置中的冒号属于 key 本身，不能被截断。
  delete env.CUSTOM_API_KEY;
  env.AICHAT_API_KEYS = `custom:${keys.custom}`;
  env.AICHAT_ALLOWED_UPSTREAMS = upstreamUrl;
  let log = '';
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(app, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1',
    '--no-open', '--data-dir', path.join(temp, 'db')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { if ((await nativeFetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(ready, `测试服务器未启动：${log}`);
  globalThis.fetch = (url, init) => nativeFetch(String(url).startsWith('/') ? `${origin}${url}` : url, init);
  for (const [provider] of Object.entries(PROVIDERS_META)) {
    for (const useProxy of [false, true]) {
      const label = `${provider} / ${useProxy ? '代理' : '直连'}`;
      const opts = { provider, model: 'test-model', baseUrl: `${upstreamUrl}/${provider}/`,
        apiKey: keys[provider] ? `  ${keys[provider]}  ` : '', useProxy,
        messages: [{ role: 'system', content: '测试系统' }, { role: 'user', content: '你好' }],
        params: { maxTokens: 64, thinking: false }, proxyToken: 'test-token', timeoutMs: 2000, totalTimeoutMs: 4000 };
      await check(`${label} 非流式鉴权与回复`, async () => {
        assert.equal((await chat(opts)).text, '连接正常');
      });
      await check(`${label} 流式鉴权与回复`, async () => {
        let output = '';
        const result = await chatStream(opts, { onDelta: (delta) => { output += delta; } });
        assert.equal(result.text, '连接正常'); assert.equal(output, '连接正常');
      });
      await check(`${label} 模型列表确实来自上游`, async () => {
        const before = calls.length;
        assert.deepEqual(await listModels(provider, opts.apiKey, opts.baseUrl, { useProxy }), ['test-model']);
        assert.equal(calls.length, before + 1); // 避免内置兜底列表造成假成功。
      });
    }
  }
  await check('代理请求不携带浏览器 API Key', async () => {
    let sent;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      assert.equal(new Headers(init.headers).has('Authorization'), false);
      return new Response(JSON.stringify({ choices: [{ message: { content: '连接正常' } }] }));
    };
    await chat({ provider: 'deepseek', model: 'test-model', apiKey: 'must-not-leak', useProxy: true,
      proxyToken: 'test-token', messages: [{ role: 'user', content: '你好' }] });
    assert.equal(sent.apiKey, undefined); assert.equal(JSON.stringify(sent).includes('must-not-leak'), false);
  });
} finally {
  globalThis.fetch = nativeFetch;
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
  }
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
