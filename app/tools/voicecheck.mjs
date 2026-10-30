#!/usr/bin/env node
/** 语音交互回归：真实页面 + 模拟识别/播放事件，独立数据目录，不使用真实麦克风或模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launch, sleep, freePort } from './cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quliao-voicecheck-'));
const port = await freePort();
const env = { ...process.env };
for (const key of Object.keys(env)) if (/API_KEY|^AICHAT|^PORT$|^HOST$/.test(key)) delete env[key];
const server = spawn(process.execPath, ['server.mjs', '--host', '127.0.0.1', '--port', String(port), '--no-open', '--data-dir', dataDir], { cwd: root, env, stdio: 'ignore' });
let page;
const results = [];
async function wait(fn) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('等待页面状态超时');
}
async function check(name, expression, verify) {
  try {
    const detail = await page.eval(expression);
    verify(detail);
    results.push({ name, passed: true, detail });
    console.log(`✓ ${name}: ${JSON.stringify(detail)}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error(`✗ ${name}: ${error.message}`);
  }
}
const settings = `const store = await import('./core/store.js');`;
const mic = `document.querySelector('.mic-btn').click();`;
const recording = `document.querySelector('.chat-foot').classList.contains('recording')`;
const result = `audit.recognizers.at(-1)`;
async function checkLongMessage() {
  await check('长消息完整分段且不切断组合字符', String.raw`(async () => {
    const t = await import('./voice/tts.js');
    const text = '测'.repeat(299) + '👨‍👩‍👧' + ' 长回复\n'.repeat(110);
    audit.utterances = [];
    await t.speakText(text, { voiceId: 'voice-A', rate: 1, pitch: 1 });
    return {
      complete: audit.utterances.map(u => u.text).join('') === text.trim(),
      chunks: audit.utterances.length,
      lengths: audit.utterances.map(u => u.text.length),
      intact: audit.utterances.some(u => u.text.includes('👨‍👩‍👧')),
      overlap: audit.utterances.some(u => u.overlap)
    };
  })()`, r => {
    assert.equal(r.complete, true);
    assert.ok(r.chunks > 1);
    assert.ok(r.lengths.every(n => n <= 300));
    assert.equal(r.intact, true);
    assert.equal(r.overlap, false);
  });
}
const mockSource = `
window.audit = { starts: 0, stops: 0, utterances: [], recognizers: [], mode: 'normal', active: null };
class SR {
  constructor() { audit.recognizers.push(this); }
  start() {
    audit.starts++;
    if (audit.mode === 'throw') throw new Error('mock startup failed');
    if (audit.mode === 'error') this.onerror?.({ error: 'not-allowed' });
  }
  stop() { audit.stops++; }
  result(text) { const r = [{ transcript: text }]; r.isFinal = true; this.onresult?.({ resultIndex: 0, results: [r] }); }
}
Object.defineProperty(window, 'SpeechRecognition', { value: SR, configurable: true });
Object.defineProperty(window, 'webkitSpeechRecognition', { value: SR, configurable: true });
Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } }, configurable: true });
const voices = [{ voiceURI: 'voice-A', name: 'A', lang: 'zh-CN', localService: true }, { voiceURI: 'voice-B', name: 'B', lang: 'zh-CN', localService: true }];
Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
  getVoices: () => voices, addEventListener() {}, removeEventListener() {}, resume() {}, pause() {}, paused: false,
  get speaking() { return !!audit.active; },
  speak(u) {
    audit.utterances.push({ text: u.text, voice: u.voice?.voiceURI, rate: u.rate, pitch: u.pitch, overlap: !!audit.active });
    audit.active = u; u.onstart?.();
    setTimeout(() => { if (audit.active === u) { audit.active = null; u.onend?.(); } }, 5);
  },
  cancel() { const u = audit.active; audit.active = null; u?.onerror?.({ error: 'canceled' }); }
} });
const nativeFetch = window.fetch.bind(window);
window.fetch = async function(url, opts) {
  if (String(url).includes('/api/llm')) {
    const body = JSON.parse(opts.body);
    const content = '这是一条角色语音诊断回复。';
    if (body.stream) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
  }
  return nativeFetch(url, opts);
};
`;
try {
  await wait(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } });
  page = await launch({ port: await freePort() });
  await page.client.send('Page.addScriptToEvaluateOnNewDocument', { source: mockSource }, page.sessionId);
  await page.goto(`http://127.0.0.1:${port}/`);
  await wait(() => page.eval('!!window.__AICHAT__'));
  await page.eval(`(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('直接跳过'))?.click();
    ${settings}
    store.setSettings({ onboarded: true, typedEffect: false, voice: { enabled: true, autoplay: 'always', stt: { enabled: false, autoSend: false } }, context: { summary: false, timeAware: false, affinity: false }, proactive: { enabled: false } });
    window.chars = [];
    for (let i = 0; i < 2; i++) chars.push(await store.saveCharacter({ name: '语音回归' + i, greeting: [], voice: { voiceId: i ? 'voice-B' : 'voice-A', autoplay: 'always' } }));
    window.groups = [];
    for (let i = 0; i < 2; i++) groups.push(await store.saveGroup({ name: '语音回归群' + i, members: chars.map(c => c.id), autoTalk: true, maxAutoTurns: 2, autoDelayMs: 0, autoVoice: true }));
    await __AICHAT__.ctx.reloadCharacters(); await __AICHAT__.ctx.reloadGroups();
    await __AICHAT__.ctx.openChat(chars[0].id);
  })()`);

  if (process.argv.includes('--long-message-only')) {
    await checkLongMessage();
  } else {
  for (const kind of ['private', 'group']) {
    const open = kind === 'private' ? `__AICHAT__.ctx.openChat(chars[0].id)` : `__AICHAT__.ctx.openGroup(groups[0].id)`;
    const input = kind === 'private' ? '#composerInput' : '#groupComposerInput';
    await page.eval(`(async () => { ${settings} store.setSettings({ voice: { stt: { enabled: false, autoSend: false } } }); await ${open}; })()`);
    await check(`${kind}: 关闭开关不启动识别`, `(() => { const before = audit.starts; ${mic} return { starts: audit.starts - before, recording: ${recording} }; })()`, r => { assert.equal(r.starts, 0); assert.equal(r.recording, false); });
    await check(`${kind}: 正常启动与多段拼接`, `(async () => { ${settings} store.setSettings({ voice: { stt: { enabled: true } } }); const input = document.querySelector('${input}'); input.value = ''; ${mic} ${result}.result('你好'); ${result}.result('世界'); return { text: input.value, recording: ${recording} }; })()`, r => { assert.equal(r.text, '你好世界'); assert.equal(r.recording, true); });
    await check(`${kind}: 录音中关闭立即停止并忽略迟到结果`, `(async () => { ${settings} const old = ${result}; const before = audit.stops; store.setSettings({ voice: { stt: { enabled: false } } }); old.result('不应写入'); return { stops: audit.stops - before, recording: ${recording}, text: document.querySelector('${input}').value }; })()`, r => { assert.ok(r.stops > 0); assert.equal(r.recording, false); assert.equal(r.text, '你好世界'); });
    for (const mode of ['throw', 'error']) {
      await check(`${kind}: ${mode} 启动失败无录音残留`, `(async () => { ${settings} store.setSettings({ voice: { stt: { enabled: true } } }); audit.mode = '${mode}'; ${mic} const old = ${result}; const starts = audit.starts; old.onend?.(); await new Promise(r => setTimeout(r, 450)); audit.mode = 'normal'; return { recording: ${recording}, restarted: audit.starts - starts }; })()`, r => { assert.equal(r.recording, false); assert.equal(r.restarted, 0); });
    }
    await check(`${kind}: 手动结束保留最后一段`, `(() => { const input = document.querySelector('${input}'); input.value = ''; ${mic} const old = ${result}; ${mic} old.result('最后一段'); old.onend?.(); return { text: input.value, recording: ${recording} }; })()`, r => { assert.equal(r.text, '最后一段'); assert.equal(r.recording, false); });
    await check(`${kind}: 同会话重新录音隔离旧回调`, `(() => { const input = document.querySelector('${input}'); input.value = ''; ${mic} const old = ${result}; ${mic} ${mic} old.result('旧结果'); old.onerror?.({ error: 'network' }); old.onend?.(); const active = ${recording}; ${result}.result('新结果'); ${mic} return { text: input.value, active }; })()`, r => { assert.equal(r.text, '新结果'); assert.equal(r.active, true); });
    const switchTo = kind === 'private' ? `__AICHAT__.ctx.openChat(chars[1].id)` : `__AICHAT__.ctx.openGroup(groups[1].id)`;
    await check(`${kind}: 切换后不覆盖草稿或自动发错会话`, `(async () => { ${settings} store.setSettings({ voice: { stt: { autoSend: true } } }); ${mic} const old = ${result}; await ${switchTo}; const input = document.querySelector('${input}'); input.value = '新会话草稿'; ${mic} const current = ${result}; old.result('不能发到新会话'); old.onerror?.({ error: 'network' }); old.onend?.(); await new Promise(r => setTimeout(r, 60)); const rows = await store.${kind === 'private' ? 'listMessages(chars[1].id)' : 'listGroupMessages(groups[1].id)'}; const detail = { text: input.value, recording: ${recording}, messages: rows.length, newRecognizer: current !== old }; ${mic} store.setSettings({ voice: { stt: { autoSend: false } } }); return detail; })()`, r => { assert.equal(r.text, '新会话草稿'); assert.equal(r.recording, true); assert.equal(r.messages, 0); assert.equal(r.newRecognizer, true); });
  }

  for (const direction of ['private-group', 'group-private']) {
    const from = direction === 'private-group' ? 'openChat(chars[0].id)' : 'openGroup(groups[0].id)';
    const to = direction === 'private-group' ? 'openGroup(groups[0].id)' : 'openChat(chars[0].id)';
    await check(`${direction}: 切换界面停止麦克风`, `(async () => { await __AICHAT__.ctx.${from}; ${mic} const old = ${result}; const before = audit.stops; await __AICHAT__.ctx.${to}; const input = document.querySelector('.composer-input'); input.value = '跨类型草稿'; old.result('旧回调'); return { stopped: audit.stops > before, text: input.value, recording: ${recording} }; })()`, r => { assert.equal(r.stopped, true); assert.equal(r.text, '跨类型草稿'); assert.equal(r.recording, false); });
  }

  await check('角色音色、语速、音调', `(async () => { const t = await import('./voice/tts.js'); audit.utterances = []; await t.speakText('角色声线测试', t.voiceFor({ voice: { voiceId: 'voice-B', rate: 1.25, pitch: 0.8 } }, {})); return audit.utterances; })()`, r => { assert.equal(r.length, 1); assert.equal(r[0].voice, 'voice-B'); assert.equal(r[0].rate, 1.25); assert.equal(r[0].pitch, 0.8); });
  await checkLongMessage();
  await check('长消息中途停止不继续播放后续段', `(async () => { const t = await import('./voice/tts.js'); audit.utterances = []; await t.speakText('停止测试'.repeat(250), { rate: 1, pitch: 1, onStart: () => t.stopSpeaking() }); return { chunks: audit.utterances.length, speaking: t.speaker.speaking }; })()`, r => { assert.equal(r.chunks, 1); assert.equal(r.speaking, false); });

  await page.eval(`(async () => { await __AICHAT__.ctx.openChat(chars[0].id); ${settings} store.setSettings({ voice: { stt: { autoSend: true } } }); audit.utterances = []; document.querySelector('#composerInput').value = ''; ${mic} ${result}.result('正常语音自动发送'); })()`);
  await wait(() => page.eval(`(async () => { ${settings} return (await store.listMessages(chars[0].id)).filter(m => m.role === 'assistant').length === 1 && audit.utterances.length > 0 && !audit.active; })()`));
  await check('私聊语音自动发送及自动朗读', `(async () => { ${settings} return { messages: (await store.listMessages(chars[0].id)).map(m => ({ role: m.role, content: m.content })), voices: audit.utterances.map(u => u.voice), recording: ${recording} }; })()`, r => { assert.equal(r.messages[0].content, '正常语音自动发送'); assert.equal(r.messages.length, 2); assert.deepEqual(r.voices, ['voice-A']); assert.equal(r.recording, false); });

  await page.eval(`(async () => { ${settings} store.setSettings({ voice: { stt: { autoSend: false } } }); await __AICHAT__.ctx.openGroup(groups[0].id); audit.utterances = []; document.querySelector('#groupComposerInput').value = '群聊朗读'; document.querySelector('#groupSendBtn').click(); })()`);
  await wait(() => page.eval(`(async () => { const g = await import('./ui/groupchat.js'); ${settings} return !g.isGroupBusy() && (await store.listGroupMessages(groups[0].id)).filter(m => m.role === 'assistant').length === 2; })()`));
  await check('群聊逐个朗读并使用各角色音色', `(async () => { ${settings} const rows = (await store.listGroupMessages(groups[0].id)).filter(m => m.role === 'assistant'); return { expected: rows.map(m => chars.find(c => c.id === m.speakerId).voice.voiceId), actual: audit.utterances.map(u => u.voice), overlap: audit.utterances.some(u => u.overlap) }; })()`, r => { assert.equal(r.actual.length, 2); assert.deepEqual(r.actual, r.expected); assert.equal(r.overlap, false); });
  await check('浏览器无未处理异常', 'true', () => assert.deepEqual(page.problems, []));
  }
} catch (error) {
  results.push({ name: '测试运行', passed: false, error: error.stack });
  console.error(error);
} finally {
  if (page) await page.close();
  server.kill();
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  fs.rmSync(dataDir, { recursive: true, force: true });
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  if (process.env.VOICECHECK_RESULT) fs.writeFileSync(process.env.VOICECHECK_RESULT, JSON.stringify({ passed, failed, results }, null, 2));
  process.exitCode = failed ? 1 : 0;
}
