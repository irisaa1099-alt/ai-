#!/usr/bin/env node
/** 本地模型边界回归：隔离服务器、假上游，不读写用户数据库或密钥。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chat, chatStream, listModels, llmErrors } from '../core/llm.js';
import { LOCAL_MODEL, LOCAL_INPUT_BUDGET, LOCAL_MAX_OUTPUT_TOKENS, enforceLocalSettings } from '../core/local-model.js';
import { getSettings, setSettings } from '../core/store.js';
import { buildMessages } from '../core/prompt.js';
import { buildGroupMessages, GroupRound } from '../core/group.js';
import { preflight, WerewolfGame } from '../core/werewolf.js';
import { speaker as voiceSpeaker } from '../voice/tts.js';
import { estimateTokens } from '../core/util.js';
import { PROVIDERS_META } from '../data/models.js';
const nativeFetch = globalThis.fetch;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quliao-local-only-'));
const app = path.join(temp, 'app');
fs.mkdirSync(app);
const root = path.resolve(import.meta.dirname, '..');
fs.copyFileSync(path.join(root, 'server.mjs'), path.join(app, 'server.mjs'));
fs.cpSync(path.join(root, 'core'), path.join(app, 'core'), { recursive: true });
let child, passed = 0, failed = 0, calls = 0, lastBody;
async function check(name, run) {
  try { await run(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}: ${error.message}`); }
}
const json = (res, status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
const upstream = http.createServer(async (req, res) => {
  calls++;
  try {
    assert.equal(req.headers.authorization, undefined);
    if (req.method === 'GET') return json(res, 200, { data: [{ id: LOCAL_MODEL }, { id: 'cloud-model' }] });
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); lastBody = body;
    assert.equal(body.model, LOCAL_MODEL);
    assert.equal(body.thinking, undefined);
    assert.equal(body.apiKey, undefined);
    if (body.messages[0]?.content === 'redirect') { res.writeHead(302, { Location: 'https://example.invalid' }).end(); return; }
    if (!body.stream) return json(res, 200, { choices: [{ message: { content: '本地回复' }, finish_reason: 'stop' }] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const content of ['本地', '回复']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } catch (error) { json(res, 400, { error: { message: error.message } }); }
});
try {
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  const localFile = path.join(app, 'core/local-model.js');
  fs.writeFileSync(localFile, fs.readFileSync(localFile, 'utf8').replace('11435', String(upstreamPort)));
  const portReservation = http.createServer(); portReservation.listen(0, '127.0.0.1'); await once(portReservation, 'listening');
  const port = portReservation.address().port; await new Promise(resolve => portReservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|^AICHAT_|^HOST$|^PORT$/.test(key)));
  Object.assign(env, { DEEPSEEK_API_KEY: 'never-use', AICHAT_API_KEY: 'never-use', OLLAMA_API_KEY: 'never-use' });
  child = spawn(process.execPath, [path.join(app, 'server.mjs'), '--no-open', '--port', String(port)], { cwd: app, env, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await nativeFetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(ready, '测试服务器启动失败');
  globalThis.fetch = (url, init) => {
    assert.ok(String(url).startsWith('/api/'), '客户端不得访问外部模型地址');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    assert.equal(String(init.body).includes('must-not-leak'), false);
    return nativeFetch(origin + url, init);
  };
  for (const [status, message] of [[401, '访问口令不正确（AICHAT_PROXY_TOKEN）'], [403, '拒绝跨站请求（只允许本机页面访问本地接口）'], [403, '此版本禁止覆盖本地模型地址']]) {
    await check(`HTTP ${status} 保留真实拒绝原因：${message}`, async () => {
      const appFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message } }), { status });
      try {
        await assert.rejects(chat({ messages: [{ role: 'user', content: 'test' }] }), error => {
          const hint = llmErrors.humanize(error);
          assert.ok(hint.includes(message));
          assert.ok(!/API.?Key|API_KEY|关闭代理/.test(hint));
          return true;
        });
      } finally { globalThis.fetch = appFetch; }
    });
  }
  await check('断连提示使用项目启动脚本', () => {
    assert.match(llmErrors.humanize({ proxy: true, code: 'network' }), /项目的启动脚本/);
  });
  const post = (route, body) => nativeFetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await check('供应商仅有本地 Ollama', () => assert.deepEqual(Object.keys(PROVIDERS_META), ['ollama']));
  await check('旧设置与云语音配置自动迁移到本地', () => {
    setSettings({ provider: 'deepseek', model: 'old', useProxy: false, baseUrls: { ollama: 'https://example.invalid' }, voice: { provider: 'cloud' } }, { localOnly: true });
    const settings = getSettings();
    assert.equal(settings.provider, 'ollama'); assert.equal(settings.model, LOCAL_MODEL);
    assert.equal(settings.useProxy, true); assert.equal(settings.voice.provider, 'webspeech');
    assert.equal(settings.baseUrls.ollama, 'http://127.0.0.1:11435/v1');
  });
  const options = { provider: 'deepseek', model: 'old', apiKey: 'must-not-leak', baseUrl: 'https://example.invalid', useProxy: false,
    messages: [{ role: 'user', content: '你好' }], params: { maxTokens: 32, thinking: true } };
  await check('旧调用方的商业配置也只发往本地，且不带密钥', async () => assert.equal((await chat(options)).text, '本地回复'));
  await check('本地流式增量完整到达', async () => {
    let text = ''; const result = await chatStream(options, { onDelta: delta => text += delta });
    assert.equal(text, '本地回复'); assert.equal(result.text, text);
  });
  await check('模型列表仅返回项目内模型', async () => assert.deepEqual(await listModels('custom', 'must-not-leak', 'https://example.invalid'), [LOCAL_MODEL]));
  await check('模型列表查询失败保留原因，不伪装成未安装', async () => {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: '本地推理程序未启动' } }), { status: 502 });
      await assert.rejects(listModels(), error => llmErrors.humanize(error).includes('本地推理程序未启动'));
      globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
      await assert.rejects(listModels(), error => llmErrors.humanize(error).includes('项目的启动脚本'));
    } finally { globalThis.fetch = savedFetch; }
  });
  await check('历史云语音调用也不会访问网络', async () => {
    const savedFetch = globalThis.fetch;
    let requested = false;
    globalThis.fetch = async () => { requested = true; throw new Error('must not fetch'); };
    try {
      await voiceSpeaker.warm(['你好'], { provider: 'cloud', cache: true });
      await voiceSpeaker.speak('你好', { provider: 'cloud' });
      assert.equal(requested, false);
    } finally { globalThis.fetch = savedFetch; }
  });
  await check('修改网站口令后下一次请求立即使用新值', async () => {
    const savedFetch = globalThis.fetch;
    let seen;
    globalThis.fetch = async (_url, init) => { seen = new Headers(init.headers).get('X-Aichat-Token'); return new Response(JSON.stringify({ models: [LOCAL_MODEL] })); };
    try {
      setSettings({ proxyToken: 'old-test-token' }, { localOnly: true }); await listModels(); assert.equal(seen, 'old-test-token');
      setSettings({ proxyToken: 'new-test-token' }, { localOnly: true }); await listModels(); assert.equal(seen, 'new-test-token');
    } finally { setSettings({ proxyToken: '' }, { localOnly: true }); globalThis.fetch = savedFetch; }
  });
  const legacy = { provider: 'deepseek', model: 'old-cloud', useProxy: false, apiKeys: {},
    params: { maxTokens: 32000 }, context: { budgetTokens: 32000, summary: false, timeAware: false, affinity: false } };
  await check('旧32K配置受本地输入和输出预算限制', async () => {
    const normalized = enforceLocalSettings(legacy);
    assert.equal(normalized.context.budgetTokens, LOCAL_INPUT_BUDGET);
    assert.equal(normalized.params.maxTokens, LOCAL_MAX_OUTPUT_TOKENS);
    const speaker = { id: 'c_local_audit', name: '测试', model: { provider: 'openai', model: 'legacy' } };
    const history = [{ role: 'user', content: '中文长输入'.repeat(10000) }];
    for (const built of [buildMessages(speaker, history, { settings: legacy, budgetTokens: 32000, runtime: {} }),
      buildGroupMessages({ speaker, members: [speaker], group: { id: 'g_local_audit' }, history, settings: legacy, budgetTokens: 32000 })]) {
      assert.ok(built.messages.reduce((n, message) => n + estimateTokens(message.content), 0) <= LOCAL_INPUT_BUDGET);
    }
    await chat({ ...options, params: { maxTokens: 999999 } });
    assert.equal(lastBody.max_tokens, LOCAL_MAX_OUTPUT_TOKENS);
    const res = await post('/api/llm', { provider: 'ollama', model: LOCAL_MODEL, messages: options.messages, params: { maxTokens: 999999 } });
    assert.equal(res.status, 200); assert.equal(lastBody.max_tokens, LOCAL_MAX_OUTPUT_TOKENS);
  });
  await check('超长游戏或摘要输入在推理前明确拒绝，不静默截断', async () => {
    const before = calls;
    const messages = [{ role: 'user', content: '长'.repeat(20000) }];
    await assert.rejects(chat({ messages }), error => error.code === 'context-budget');
    const res = await post('/api/llm', { provider: 'ollama', model: LOCAL_MODEL, messages });
    assert.equal(res.status, 400); assert.equal((await res.json()).error.code, 'context-budget');
    assert.equal(calls, before);
  });
  await check('旧角色和旧游戏配置无需密钥即可调用本地模型', async () => {
    const speaker = { id: 'c_local_audit', name: '测试', model: { provider: 'openai', model: 'legacy' } };
    const round = new GroupRound({ group: { id: 'g_local_audit' }, members: [speaker], settings: legacy, history: [] });
    let persisted = false;
    round.persist = async (_speaker, text, result, model) => {
      assert.equal(text, '本地回复'); assert.equal(model, LOCAL_MODEL); persisted = true; return { content: text };
    };
    await round.speak(speaker, 0, 1); assert.ok(persisted);
    assert.equal((await preflight(legacy)).ok, true);
    const game = new WerewolfGame({ group: { id: 'g_local_audit' }, members: Array.from({ length: 5 }, (_, i) => ({ ...speaker, id: i ? `c_local_audit_${i}` : speaker.id })), settings: legacy });
    game.countUsage = async () => {};
    assert.equal(await game.askLLM({ id: speaker.id }, '只回复你好', 'night'), '本地回复');
  });
  for (const provider of ['deepseek', 'openai', 'anthropic', 'gemini', 'qwen', 'lmstudio', 'custom']) {
    await check(`后端拒绝 ${provider}`, async () => {
      const before = calls;
      assert.equal((await post('/api/llm', { provider, model: LOCAL_MODEL })).status, 400);
      assert.equal((await post('/api/models', { provider })).status, 400);
      assert.equal(calls, before);
    });
  }
  for (const baseUrl of ['https://example.invalid/v1', 'http://127.0.0.1:11434/v1', `http://127.0.0.1:${upstreamPort}/v1/../evil`]) {
    await check(`后端拒绝覆盖地址 ${baseUrl}`, async () => {
      const before = calls;
      assert.equal((await post('/api/llm', { provider: 'ollama', model: LOCAL_MODEL, baseUrl })).status, 403);
      assert.equal((await post('/api/models', { provider: 'ollama', baseUrl })).status, 403);
      assert.equal(calls, before);
    });
  }
  await check('后端拒绝云模型名', async () => assert.equal((await post('/api/llm', { provider: 'ollama', model: 'qwen3:cloud' })).status, 400));
  await check('后端拒绝云语音', async () => assert.equal((await post('/api/tts', { text: '你好', provider: 'openai' })).status, 400));
  await check('本地服务重定向不会转发到远程地址', async () => assert.equal((await post('/api/llm', { provider: 'ollama', model: LOCAL_MODEL, messages: [{ role: 'user', content: 'redirect' }] })).status, 502));
} finally {
  globalThis.fetch = nativeFetch;
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
