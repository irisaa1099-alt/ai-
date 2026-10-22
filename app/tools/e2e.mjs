#!/usr/bin/env node
/**
 * 端到端测试（零依赖）：假模型服务器 + 无头 Chrome 真实跑一遍完整链路。
 *
 * 覆盖：
 *   1. 应用启动、模板库、创建角色
 *   2. 发送消息 → 流式逐字回复 → 落库 → 好感度上升 → 用量统计
 *   3. 多版本重新生成（◀ 2/2 ▶）
 *   4. 停止生成（abort 不落库）
 *   5. 语音：/api/tts 代理请求真的被打出去（用假音频应答）
 *   6. 备份导出 / 恢复导入
 *   7. 移动端布局不崩
 *
 * 用法：node tools/e2e.mjs [--keep]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, sleep, freePort } from './cdp.mjs';
import { startMockLLM } from './mock-llm.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const MOCK_PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const KEEP = process.argv.includes('--keep');
/** 测试专用数据目录：与真实 data/db 隔离，避免互相污染 */
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-testdb-'));
/** 测试用语音密钥（只注入被测服务器进程，不碰真实 .env） */
const TTS_TEST_KEY = 'sk-dashscope-test-key';

let passed = 0;
let failed = 0;
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

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
    if (Date.now() - t0 > timeout) throw new Error(`等待${label}超时（${timeout}ms）`);
    await sleep(interval);
  }
}

/** 启动被测服务器 */
let serverLog = '';
function startServer() {
  const child = spawn(process.execPath, ['server.mjs', '--port', String(PORT), '--no-open', '--data-dir', TMP_DATA], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 给"代理模式的语音"备一把 Qwen（DashScope）的密钥：用来验证 /api/tts
    // 确实带着**所选供应商**的密钥打到**所选地址**，而不是一律打 OpenAI。
    // 刻意只给 DASHSCOPE_API_KEY、不给 AICHAT_API_KEY / OPENAI_API_KEY，
    // 这样"用错供应商"就会明显失败（缺 openai 密钥 / 打到 openai 地址）。
    env: { ...process.env, DASHSCOPE_API_KEY: TTS_TEST_KEY },
  });
  return new Promise(async (resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (r.ok) return resolve(child);
      } catch {}
      await sleep(150);
    }
    child.kill();
    reject(new Error(`服务器启动失败：${out.slice(-400)}`));
  });
}

const serverChild = await startServer();
const mock = await startMockLLM(MOCK_PORT);
console.log(`→ 应用服务器 http://127.0.0.1:${PORT}，假模型 http://127.0.0.1:${MOCK_PORT}/v1`);

const START_TS = Date.now();
const page = await launch({ port: await freePort(), width: 1440, height: 900 });
let exitCode = 1;
let ttsRequests = 0;
/** 最近一次拦截到的 /api/tts 请求体（核对客户端有没有把 provider / baseUrl 带上） */
let lastTtsRequest = null;

// 拦截 /api/tts，返回一段真实的静音 WAV（验证语音代理链路真的打通）
const SILENT_WAV = makeSilentWav(0.35);
async function enableTtsInterception() {
  page.client.on('Fetch.requestPaused', async (p) => {
    try {
      if (p.request.url.includes('/api/tts')) {
        ttsRequests++;
        try {
          lastTtsRequest = JSON.parse(p.request.postData || '{}');
        } catch {
          lastTtsRequest = null;
        }
        await page.client.send(
          'Fetch.fulfillRequest',
          {
            requestId: p.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'audio/wav' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body: SILENT_WAV.toString('base64'),
          },
          page.sessionId
        );
        return;
      }
      await page.client.send('Fetch.continueRequest', { requestId: p.requestId }, page.sessionId);
    } catch {
      /* 忽略 */
    }
  });
  await page.client.send(
    'Fetch.enable',
    { patterns: [{ urlPattern: '*/api/tts*', requestStage: 'Request' }] },
    page.sessionId
  );
}

/** 生成一段指定时长的 8kHz 单声道静音 WAV */
function makeSilentWav(seconds) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

try {
  /* ------------------------------------------------------------------ */
  console.log('\n=== 1. 启动与首屏 ===');
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '应用外壳' });
  await enableTtsInterception();

  await check('页面标题正确', async () => {
    const t = await page.eval('document.title');
    assert(t.includes('AI'), `标题异常：${t}`);
    return t;
  });

  await check('控制台无报错', async () => {
    // 过滤掉 PWA 图标尚未就绪这类无害提示
    const real = page.problems.filter((p) => !/icon\.svg|manifest|404/i.test(p));
    assert(real.length === 0, real.join(' | '));
    return `0 个错误`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 2. 写入测试配置与角色 ===');
  await check('配置指向假模型 + 创建角色', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const tpl = await import('./data/templates.js');
      store.setSettings({
        onboarded: true,
        provider: 'ollama',
        model: 'mock-model',
        baseUrls: { ollama: 'http://127.0.0.1:${MOCK_PORT}/v1' },
        apiKeys: {},
        useProxy: false,
        typedEffect: false,
        voice: { enabled: true, autoplay: 'off' },
        context: { maxMessages: 20, budgetTokens: 4000, summary: false, timeAware: true, affinity: true },
        proactive: { enabled: false },
      });
      const char = await store.saveCharacter(tpl.templateToCharacter(tpl.CHARACTER_TEMPLATES[0]));
      localStorage.setItem('aichat.lastChar', char.id);
      // 等 IndexedDB 事务真正提交后再返回（导航会中断未完成的事务）
      await new Promise((r) => setTimeout(r, 400));
      const verify = await store.listCharacters();
      return { id: char.id, name: char.name, persisted: verify.length };
    })()`);
    assert(r && r.id, '角色创建失败');
    assert(r.persisted >= 1, `角色没有落库（listCharacters 返回 ${r.persisted}）`);
    return `${r.name} (${r.id.slice(0, 10)}…)，已落库 ${r.persisted} 个角色`;
  });

  await check('刷新后进入会话（角色独立聊天框）', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    // 等到应用真正就绪：外壳 + 输入框 + 当前角色已确定
    await waitFor(
      async () =>
        page.eval(
          '!!document.querySelector("#composerInput") && !!window.__AICHAT__ && !!window.__AICHAT__.state.currentCharId'
        ),
      { label: '会话就绪', timeout: 15000 }
    );
    await sleep(700); // 让 chat.js 完成首次渲染与事件绑定
    const info = await page.eval(`(() => ({
      friends: document.querySelectorAll('.friend').length,
      name: (document.querySelector('.chat-head-name')||document.querySelector('.chat-name')||{}).textContent || '',
      empty: document.body.innerText.includes('还没有选择好友'),
    }))()`);
    assert(info.friends >= 1, `侧栏好友数为 ${info.friends}`);
    assert(!info.empty, '仍显示"还没有选择好友"');
    return `侧栏 ${info.friends} 位好友，当前会话：${info.name.trim()}`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 3. 流式对话 ===');
  await check('发送消息 → 流式回复落库', async () => {
    const before = mock.calls();
    const sent = await page.eval(`(() => {
      const i = document.querySelector('#composerInput');
      const b = document.querySelector('#sendBtn');
      if (!i || !b) return '元素缺失';
      i.value = '你在忙吗？';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      b.click();
      return 'ok';
    })()`);
    assert(sent === 'ok', sent);
    // 等到用户消息落库（说明点击确实生效）
    const userMsg = await waitFor(
      async () =>
        page.eval(`(async () => {
          const store = await import('./core/store.js');
          const list = await store.listMessages(window.__AICHAT__.state.currentCharId);
          return list.find(m => m.role === 'user' && m.content === '你在忙吗？') || null;
        })()`),
      { label: '用户消息落库', timeout: 8000 }
    );
    // 再等 AI 回复落库
    const res = await waitFor(
      async () =>
        page.eval(`(async () => {
          const store = await import('./core/store.js');
          const rt = await import('./core/runtime.js');
          const id = window.__AICHAT__.state.currentCharId;
          const list = await store.listMessages(id);
          const ai = list.filter(m => m.role === 'assistant' && m.status === 'done' && /歪头/.test(m.content));
          if (!ai.length) return null;
          const all = list.map(m => m.role + '(' + m.status + '):' + m.content.slice(0, 16));
          return { ai: ai[ai.length-1], affinity: rt.getRuntime(id).affinity, count: list.length, all };
        })()`),
      { label: 'AI 回复落库', timeout: 20000 }
    );
    assert(res.ai.content.includes('歪头') || res.ai.content.length > 5, `回复内容异常：${JSON.stringify(res.ai.content)}`);
    assert(res.ai.usage && res.ai.usage.total > 0, `未记录 token 用量（usage=${JSON.stringify(res.ai.usage)}）｜消息：${res.all.join(' / ')}`);
    assert(mock.calls() > before, '假模型没有被调用');
    return `回复 ${res.ai.content.length} 字，tokens=${res.ai.usage.total}，消息 ${res.count} 条`;
  });

  await check('界面渲染出两条气泡 + 元信息', async () => {
    const dom = await page.eval(`(() => ({
      bubbles: document.querySelectorAll('.bub').length,
      hasReply: document.body.innerText.includes('歪头'),
      hasUser: document.body.innerText.includes('你在忙吗'),
      tokensShown: /\\d+\\s*tokens/.test(document.body.innerText),
      dayLine: !!document.querySelector('.day-line'),
    }))()`);
    assert(dom.hasReply, '界面没有出现回复文本');
    assert(dom.hasUser, '界面没有出现用户消息');
    assert(dom.bubbles >= 2, `气泡数偏少：${dom.bubbles}`);
    return `气泡 ${dom.bubbles} 个，日期分割线 ${dom.dayLine}，token 显示 ${dom.tokensShown}`;
  });

  await check('好感度上升', async () => {
    const r = await page.eval(`(async () => {
      const rt = await import('./core/runtime.js');
      const id = window.__AICHAT__.state.currentCharId;
      const cur = rt.getRuntime(id).affinity;
      const init = window.__AICHAT__.state.characters.find(c => c.id === id).affinity;
      return { cur, init, label: rt.affinityLabel(cur) };
    })()`);
    assert(r.cur > r.init, `好感度没有上升：初始 ${r.init} → 现在 ${r.cur}`);
    return `${r.init} → ${r.cur}（${r.label}）`;
  });

  await check('侧栏摘要显示最后一条消息', async () => {
    const t = await page.eval('(document.querySelector(".friend-preview")||{}).textContent || ""');
    assert(t.trim().length > 0, '侧栏摘要为空');
    return t.trim().slice(0, 24);
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 3.5 思考模式开关 → 上游请求体（见 ARCHITECTURE 5.19）===');
  await check('设置里选「关闭思考」后真实请求带 thinking=disabled，「跟随模型默认」不带该字段', async () => {
    /** 用界面上的真实控件改思考模式（不走 store，确保开关本身接线正确） */
    const pickThinking = async (value) => page.eval(`(async () => {
      const s = await import('./ui/settings.js');
      s.openSettings('model');
      await new Promise(r => setTimeout(r, 400));
      let ctl = null;
      for (const f of document.querySelectorAll('.modal-body .field')) {
        const label = (f.querySelector('.field-label')||{}).textContent || '';
        if (/思考模式/.test(label)) ctl = f.querySelector('select');
      }
      if (!ctl) return '找不到「思考模式」控件';
      ctl.value = ${JSON.stringify(value)};
      ctl.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      await new Promise(r => setTimeout(r, 250));
      return 'ok';
    })()`);

    /** 发一条消息并等回复落库，返回假模型收到的那个请求体 */
    const sendAndRead = async (text) => {
      const count = () => page.eval(`(async () => {
        const store = await import('./core/store.js');
        return (await store.listMessages(window.__AICHAT__.state.currentCharId)).length;
      })()`);
      const before = await count();
      await page.eval(`(() => {
        const i = document.querySelector('#composerInput');
        const b = document.querySelector('#sendBtn');
        i.value = ${JSON.stringify(text)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        b.click();
      })()`);
      await waitFor(async () => ((await count()) > before + 1 ? 1 : 0), { label: '思考模式用例的回复落库', timeout: 20000 });
      const r = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/last`)).json();
      return r.last;
    };

    // 指到假模型：provider 必须是 deepseek，请求体里才会带这个专用字段
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      store.setSettings({
        provider: 'deepseek',
        model: 'deepseek-flash',
        apiKeys: { deepseek: 'test-key' },
        baseUrls: { deepseek: 'http://127.0.0.1:${MOCK_PORT}/v1' },
        useProxy: false,
        params: { thinking: null },
      });
    })()`);
    try {
      const picked = await pickThinking('off');
      assert(picked === 'ok', picked);
      const off = await sendAndRead('思考开关：关闭这一档');
      assert(
        off && off.thinking && off.thinking.type === 'disabled',
        `选「关闭思考」后请求体里应有 thinking.disabled，实际 ${JSON.stringify(off && off.thinking)}`
      );
      const back = await pickThinking('default');
      assert(back === 'ok', back);
      const def = await sendAndRead('思考开关：跟随默认这一档');
      assert(
        def && !Object.hasOwn(def, 'thinking'),
        `「跟随模型默认」不该下发 thinking，实际 ${JSON.stringify(def && def.thinking)}`
      );
      return `关闭 → ${JSON.stringify(off.thinking)}；跟随默认 → 请求体里没有 thinking 字段`;
    } finally {
      // 还原成 ollama 假模型：后面几节仍按原来的配置跑
      await page.eval(`(async () => {
        const store = await import('./core/store.js');
        store.setSettings({
          provider: 'ollama',
          model: 'mock-model',
          baseUrls: { ollama: 'http://127.0.0.1:${MOCK_PORT}/v1' },
          params: { thinking: null },
        });
      })()`);
    }
  });

  await check('代理模式：服务端同样只对 DeepSeek 下发 thinking（见 5.19）', async () => {
    /** 直接打服务端的 /api/llm（浏览器侧那条链路上面已经验过） */
    const post = async (payload) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {}
      return { status: res.status, body };
    };
    const lastFromMock = async () => (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/last`)).json()).last;

    // keySlot=qwen：借测试服务器上唯一那把密钥（服务端只从 env 取密钥），
    // 而 provider 仍是 deepseek —— 只有它是 deepseek 时服务端才会写这个字段。
    const off = await post({
      provider: 'deepseek',
      keySlot: 'qwen',
      model: 'deepseek-flash',
      stream: false,
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      messages: [{ role: 'user', content: '代理模式：关思考' }],
      params: { temperature: 0.5, maxTokens: 64, thinking: false },
    });
    assert(off.status === 200, `代理请求失败：${off.status} ${JSON.stringify(off.body)}`);
    const viaProxy = await lastFromMock();
    assert(
      viaProxy && viaProxy.thinking && viaProxy.thinking.type === 'disabled',
      `代理模式应带 thinking.disabled，实际 ${JSON.stringify(viaProxy && viaProxy.thinking)}`
    );

    // 同一个开关值发给别的供应商：服务端必须**丢掉**它（OpenAI 兼容站不认这个字段）
    const other = await post({
      provider: 'qwen',
      model: 'mock-model',
      stream: false,
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      messages: [{ role: 'user', content: '代理模式：非 DeepSeek' }],
      params: { temperature: 0.5, maxTokens: 64, thinking: false },
    });
    assert(other.status === 200, `非 DeepSeek 代理请求失败：${other.status} ${JSON.stringify(other.body)}`);
    const viaProxy2 = await lastFromMock();
    assert(
      viaProxy2 && !Object.hasOwn(viaProxy2, 'thinking'),
      `非 DeepSeek 供应商不该收到 thinking，实际 ${JSON.stringify(viaProxy2 && viaProxy2.thinking)}`
    );
    return `deepseek → ${JSON.stringify(viaProxy.thinking)}；qwen → 请求体里没有 thinking 字段`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 4. 多版本重新生成 ===');
  await check('重新生成 → 版本数变 2', async () => {
    const clicked = await page.eval(`(() => {
      const acts = [...document.querySelectorAll('[data-act]')].map(n => n.dataset.act);
      const btn = document.querySelector('[data-act="regen"]');
      if (!btn) return { ok: false, acts: acts.slice(0, 14) };
      btn.click();
      return { ok: true, acts: acts.slice(0, 14) };
    })()`);
    assert(clicked.ok, `找不到重新生成按钮，当前可用动作：${(clicked.acts || []).join(',')}`);
    const r = await waitFor(
      async () => {
        const v = await page.eval(`(async () => {
          const store = await import('./core/store.js');
          const id = window.__AICHAT__.state.currentCharId;
          const list = await store.listMessages(id);
          const ai = list.filter(m => m.role === 'assistant');
          const last = ai[ai.length - 1];
          return {
            n: last && last.variants ? last.variants.list.length : 0,
            idx: last && last.variants ? last.variants.index : -1,
            total: list.length,
            tail: list.slice(-3).map(m => m.role + ':' + m.content.slice(0, 10)),
          };
        })()`);
        return v && v.n >= 2 ? v : null;
      },
      { label: '第二个版本', timeout: 15000 }
    );
    const navText = await page.eval(
      `(() => { const n = document.querySelector('.variant-nav'); return n ? n.innerText.replace(/\\s+/g, '') : '(无)'; })()`
    );
    return `variants=${r.n}，当前第 ${r.idx + 1} 版，界面显示 ${navText}`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 5. 停止生成（打断）===');
  await check('生成中点停止 → 不落库', async () => {
    const countBefore = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      return (await store.listMessages(window.__AICHAT__.state.currentCharId)).length;
    })()`);
    // 让假模型切到超慢速流，便于中途停止
    await page.eval(`fetch('http://127.0.0.1:${MOCK_PORT}/slow').then(r=>r.json())`);
    await page.eval(`(() => {
      const i = document.querySelector('#composerInput');
      i.value = '说点很长的话';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn').click();
      return true;
    })()`);
    // 等按钮切换为"停止"，然后点击
    const isStop = await waitFor(
      async () =>
        page.eval(`(() => {
          const b = document.querySelector('#sendBtn');
          return b && (b.classList.contains('stop') || /停止/.test(b.title));
        })()`),
      { label: '停止按钮出现', timeout: 6000 }
    );
    assert(isStop, '生成中发送按钮没有切换成"停止"');
    await page.eval(`document.querySelector('#sendBtn').click()`);
    await sleep(1800);
    const after = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const list = await store.listMessages(window.__AICHAT__.state.currentCharId);
      return { n: list.length, lastRole: list[list.length-1].role, streaming: list.some(m => m.status === 'streaming') };
    })()`);
    // 用户消息会新增 1 条，但被中断的 AI 回复不应落库
    assert(after.n <= countBefore + 1, `停止后仍落库了 AI 消息：${countBefore} → ${after.n}`);
    assert(!after.streaming, '仍有 streaming 状态的消息残留');
    return `消息数 ${countBefore} → ${after.n}（被中断的回复未落库）`;
  });

  await check('停止后立刻重发 → 旧请求收尾不解除新请求的忙状态', async () => {
    const callsBefore = mock.calls();
    const aiBefore = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      return (await store.listMessages(window.__AICHAT__.state.currentCharId)).filter((m) => m.role === 'assistant').length;
    })()`);
    await page.eval(`fetch('http://127.0.0.1:${MOCK_PORT}/slow').then((r) => r.json())`);
    await page.eval(`(() => {
      const i = document.querySelector('#composerInput');
      i.value = '第一条马上取消';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn').click();
    })()`);
    await waitFor(() => mock.calls() > callsBefore, { label: '第一条请求到达假模型', timeout: 8000 });
    await page.eval(`(() => {
      document.querySelector('#sendBtn').click();
      const i = document.querySelector('#composerInput');
      i.value = '第二条应当正常完成';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn').click();
    })()`);
    await waitFor(() => mock.calls() >= callsBefore + 2, { label: '第二条请求到达假模型', timeout: 8000 });
    await sleep(500);
    const busyNow = await page.eval(`document.querySelector('#sendBtn').classList.contains('stop')`);
    assert(busyNow, '旧请求收尾错误地解除新请求的忙状态');
    const done = await waitFor(async () => page.eval(`(async () => {
      const store = await import('./core/store.js');
      const list = await store.listMessages(window.__AICHAT__.state.currentCharId);
      const ai = list.filter((m) => m.role === 'assistant');
      return ai.length > ${aiBefore} && !document.querySelector('#sendBtn').classList.contains('stop')
        ? { n: ai.length, last: ai[ai.length - 1].content } : null;
    })()`), { label: '第二条回复完成', timeout: 30000 });
    assert(done.last.length >= 10, `第二条回复异常：${done.last}`);
    return `新请求保持忙状态并完成，回复 ${done.last.length} 字`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 6. 语音：云端 TTS 代理 ===');
  await check('/api/tts 请求被真实发出并拿到音频', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const tts = await import('./voice/tts.js');
      store.setSettings({
        useProxy: true,
        apiKeys: { qwen: '${TTS_TEST_KEY}' },
        baseUrls: { qwen: 'https://relay.example.test/qwen/v1' },
        voice: { enabled: true, provider: 'cloud', ttsProvider: 'qwen', ttsModel: 'cosyvoice-v1', voiceId: 'alloy', rate: 1, pitch: 1, autoplay: 'off', cache: false },
      });
      await new Promise((res) => setTimeout(res, 250));
      if (typeof tts.primeSettings === 'function') tts.primeSettings();
      const cfg = { provider: 'cloud', voiceId: 'alloy', rate: 1, pitch: 1, autoplay: 'off', cache: false };
      let ok = false, err = '';
      try { await tts.speakText('测试一下语音好不好用', cfg); ok = true; }
      catch (e) { err = String((e && e.message) || e); }
      const avail = tts.voiceAvailable();
      store.setSettings({ useProxy: false });
      return { ok, err, avail };
    })()`);
    assert(ttsRequests > 0, `没有观察到 /api/tts 请求（播放 ok=${r.ok} err=${r.err}）`);
    // 回归守：代理模式必须把**所选供应商与地址**一起交给服务器。
    // 以前客户端只送 { text, voice, model, rate }，服务端于是永远用默认的 openai 上游，
    // 用户选了 Qwen（或填了自建地址）在代理模式下被悄悄改成 OpenAI。
    assert(lastTtsRequest, '没有读到 /api/tts 的请求体');
    assert(lastTtsRequest.provider === 'qwen', `请求体里的 provider 应是 qwen，实际 ${lastTtsRequest.provider}`);
    assert(
      lastTtsRequest.baseUrl === 'https://relay.example.test/qwen/v1',
      `请求体里应带上用户为 Qwen 配的地址，实际 ${lastTtsRequest.baseUrl}`
    );
    assert(lastTtsRequest.model === 'cosyvoice-v1', `模型名没带上：${lastTtsRequest.model}`);
    return `发出 ${ttsRequests} 次 /api/tts 请求（provider=qwen、带自定义地址），播放${r.ok ? '成功' : `失败(${r.err || '静默降级'})`}`;
  });

  // 回归守：云端语音的**磁盘缓存**必须真的能用。
  // 主库 aichat 由 store.js 以 v2 创建，而 tts.js 以前写 `indexedDB.open('aichat', 1)` ——
  // 用较低版本打开已存在的库会直接 VersionError，磁盘缓存永远打不开：
  // 刷新后每句都重新请求（更慢、更费钱），"清空缓存"也只能清掉内存里那一份。
  await check('云端语音的磁盘缓存能写入也能清空（IndexedDB 版本没打架）', async () => {
    const readCache = `(async () => {
      const db = await new Promise((resolve) => {
        const req = indexedDB.open('aichat');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
      if (!db) return { version: -1, count: -1 };
      const version = db.version;
      if (!db.objectStoreNames.contains('ttsCache')) { db.close(); return { version, count: -2 }; }
      const n = await new Promise((resolve) => {
        const c = db.transaction('ttsCache', 'readonly').objectStore('ttsCache').count();
        c.onsuccess = () => resolve(c.result);
        c.onerror = () => resolve(-3);
      });
      db.close();
      return { version, count: n };
    })()`;
    const r = await page.eval(`(async () => {
      const tts = await import('./voice/tts.js');
      const cfg = { provider: 'cloud', voiceId: 'alloy', rate: 1, pitch: 1, autoplay: 'off', cache: true };
      await tts.speakText('缓存测试：这句话应当被写进磁盘缓存。' + Date.now(), cfg);
      const afterSpeak = await ${readCache};
      const cleared = await tts.clearVoiceCache();
      const afterClear = await ${readCache};
      return { afterSpeak, cleared, afterClear };
    })()`);
    assert(r.afterSpeak.version === 2, `主库版本应为 2，实际 ${r.afterSpeak.version}（-1 表示库都没打开）`);
    assert(r.afterSpeak.count >= 1, `磁盘缓存里没有写入音频（count=${r.afterSpeak.count}）`);
    assert(r.afterClear.count === 0, `"清空缓存"没清掉磁盘上的音频（还剩 ${r.afterClear.count}）`);
    return `库 v${r.afterSpeak.version}：写入 ${r.afterSpeak.count} 条 → 清空后 ${r.afterClear.count} 条`;
  });

  // 回归守：客户端取消（点停止 / 关页）后，服务器必须**掐断上游连接**。
  // 以前上游 fetch 没接取消信号：客户端走了，服务器还在原地读上游的流 ——
  // 上游继续算 token（白花钱），连接与额度也一直占着。
  await check('客户端取消后上游连接被切断（不再空跑计费）', async () => {
    await fetch(`http://127.0.0.1:${MOCK_PORT}/slow`); // 让假上游逐字慢发，方便中途打断
    const before = (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/aborts`)).json()).abortedStreams;
    const ctrl = new AbortController();
    const pending = fetch(`http://127.0.0.1:${PORT}/api/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 用 qwen：测试服务器进程里配了 DASHSCOPE_API_KEY，能过密钥校验；
        // 上游地址指向假供应商（本机地址，允许列表未开启时按既有功能放行）
        provider: 'qwen',
        model: 'mock-model',
        stream: true,
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        messages: [{ role: 'user', content: '慢一点，我马上要打断你' }],
      }),
      signal: ctrl.signal,
    }).catch(() => null);
    await sleep(700);
    ctrl.abort();
    await pending;
    const r = await waitFor(
      async () => {
        const j = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/aborts`)).json();
        return j.abortedStreams > before ? j : null;
      },
      { label: '上游连接被关闭', timeout: 6000 }
    );
    return `假上游观察到连接被对端掐断（累计 ${r.abortedStreams} 次）`;
  });

  await check('代理模式按 provider / baseUrl 选上游，并用对那把密钥', async () => {
    // 这一条打的是**真实**的 server.mjs /api/tts（浏览器侧那条被 CDP 拦截了，测不到服务端逻辑）
    const post = async (payload) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {}
      return { status: res.status, body };
    };

    const ok = await post({
      text: '代理供应商测试',
      voice: 'alloy',
      model: 'cosyvoice-v1',
      rate: 1,
      provider: 'qwen',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    });
    assert(ok.status === 200, `期望 200，实际 ${ok.status}：${JSON.stringify(ok.body)}`);
    const upstream = mock.lastTts();
    assert(upstream, '假供应商没有收到 /audio/speech 请求（说明请求没发到所选地址）');
    assert(upstream.url.startsWith('/v1/audio/speech'), `上游路径不对：${upstream.url}`);
    assert(
      upstream.auth === `Bearer ${TTS_TEST_KEY}`,
      `应当带所选供应商（qwen/DASHSCOPE）的密钥，实际 Authorization=${upstream.auth || '（空）'}`
    );
    assert(upstream.model === 'cosyvoice-v1', `上游收到的模型名不对：${upstream.model}`);

    // provider=custom 且没填地址时，必须明确报错，而不是悄悄打到 OpenAI
    const noBase = await post({ text: 'x', provider: 'custom' });
    assert(noBase.status === 400, `custom 缺地址应 400，实际 ${noBase.status}`);
    assert(/接口地址/.test((noBase.body && noBase.body.error && noBase.body.error.message) || ''), `错误信息没说清是地址问题：${JSON.stringify(noBase.body)}`);

    // 选了 openai 但没有 openai 的密钥：不能拿别的供应商的密钥顶上
    const noKey = await post({ text: 'x', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` });
    assert(noKey.status === 400, `openai 缺密钥应 400，实际 ${noKey.status}`);
    assert(
      /openai/i.test((noKey.body && noKey.body.error && noKey.body.error.message) || ''),
      `错误信息应指明 openai 缺密钥：${JSON.stringify(noKey.body)}`
    );
    return `qwen → ${upstream.url}（密钥正确）；custom 缺地址与 openai 缺密钥都明确报错`;
  });

  // 回归守：曾经在"AudioContext.state=running 但 currentTime 几乎不推进"的机器上（无音频输出设备 /
  // 远程桌面 / 虚拟机），src.onended 永不触发、playBlob 又没看门狗 → speakText 永久 pending、朗读卡在第一句。
  // 这里用一个"时钟不走"的 AudioContext 桩把这个场景固定下来。
  await check('音频设备"时钟不走"时朗读不会卡死（playBlob 看门狗）', async () => {
    const STUB = `(() => {
      window.__audioPlays = 0;
      class FakeCtx {
        constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; this.currentTime = 0; }
        createAnalyser() { return { fftSize: 0, connect() {} }; }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        createBufferSource() { return { buffer: null, onended: null, connect() {}, start() { window.__audioPlays++; }, stop() {} }; }
        decodeAudioData(arr, ok) { const b = { duration: 0.8 }; if (ok) setTimeout(() => ok(b), 0); return Promise.resolve(b); }
        resume() { return Promise.resolve(); }
      }
      window.AudioContext = FakeCtx;
      window.webkitAudioContext = FakeCtx;
      // TTS 合成直接给一段静音 WAV（不走 /api/tts 代理，免得依赖密钥）
      const realFetch = window.fetch.bind(window);
      const head = new Uint8Array(44);
      const dv = new DataView(head.buffer);
      head.set([82, 73, 70, 70], 0); dv.setUint32(4, 36 + 12800, true); head.set([87, 65, 86, 69], 8);
      head.set([102, 109, 116, 32], 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      head.set([100, 97, 116, 97], 36); dv.setUint32(40, 12800, true);
      const wav = new Blob([head, new Uint8Array(12800)], { type: 'audio/wav' });
      window.fetch = (url, opts) => {
        if (String(url).includes('/audio/speech')) {
          return Promise.resolve(new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } }));
        }
        return realFetch(url, opts);
      };
    })();`;
    // 桩必须赶在应用加载前注入（AudioContext 是懒创建、但只会建一次），所以开一个全新的 target
    const t = await page.client.send('Target.createTarget', { url: 'about:blank' });
    const att = await page.client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = att.sessionId;
    const ev = async (expr) => {
      const res = await page.client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result?.value;
    };
    await page.client.send('Page.enable', {}, sid);
    await page.client.send('Runtime.enable', {}, sid);
    await page.client.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB }, sid);
    await page.client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sid);
    await waitFor(async () => ev('!!document.querySelector(".shell")'), { label: '桩页面外壳' });
    const r = await ev(`(async () => {
      const store = await import('./core/store.js');
      const tts = await import('./voice/tts.js');
      store.setSettings({ onboarded: true, useProxy: false,
        voice: { enabled: true, provider: 'cloud', ttsProvider: 'openai', ttsModel: 'tts-1',
                 baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x' } });
      if (typeof tts.primeSettings === 'function') await tts.primeSettings();
      // UI 就是靠这个钩子提示"当前设备无法播放语音"的（ui/app.js 里挂的是 toast）
      let skipped = '';
      tts.speaker.onPlaybackSkipped = (reason) => { skipped = String(reason || ''); };
      const t0 = performance.now();
      let ok = false, err = '';
      try { await tts.speakText('时钟不走的设备上这句必须被略过，不能挂住。', { provider: 'cloud', voiceId: 'alloy', rate: 1, autoplay: 'off', cache: false }); ok = true; }
      catch (e) { err = String((e && e.message) || e); }
      return { ok, err, ms: Math.round(performance.now() - t0), plays: window.__audioPlays || 0, skipped };
    })()`);
    await page.client.send('Target.closeTarget', { targetId: t.targetId });
    assert(r.ok, `speakText 不该抛错：${r.err}`);
    assert(r.plays > 0, '应当真的走到过播放（否则这条没测到东西）');
    assert(r.ms < 5000, `时钟不走时必须被看门狗略过，实际卡了 ${r.ms}ms`);
    assert(r.skipped, '设备放不出声时必须通知 UI（speaker.onPlaybackSkipped），不能静默略过');
    return `假设备下 ${r.ms}ms 返回（走过 ${r.plays} 次播放），并通知了 UI（${r.skipped}）`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 7. 备份导出与恢复 ===');
  await check('exportAll → wipeAll → importAll 还原', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const before = { chars: (await store.listCharacters()).length, msgs: (await store.dbStats()).messages };
      const blob = await store.exportAll();
      const text = await blob.text();
      const pack = JSON.parse(text);
      await store.wipeAll();
      const mid = { chars: (await store.listCharacters()).length, msgs: (await store.dbStats()).messages };
      const res = await store.importAll(pack, { merge: false });
      const after = { chars: (await store.listCharacters()).length, msgs: (await store.dbStats()).messages };
      return { before, mid, after, res, settingsKept: !!pack.settings, bytes: text.length };
    })()`);
    assert(r.before.chars > 0 && r.before.msgs > 0, '导出前数据为空');
    assert(r.mid.chars === 0, '清空后仍有角色');
    assert(r.after.chars === r.before.chars, `角色数不一致：${r.before.chars} → ${r.after.chars}`);
    assert(r.after.msgs === r.before.msgs, `消息数不一致：${r.before.msgs} → ${r.after.msgs}`);
    return `备份 ${(r.bytes / 1024).toFixed(1)}KB；还原 ${r.after.chars} 角色 / ${r.after.msgs} 条消息`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 8. 移动端布局 ===');
  await check('375×812 移动端不崩且可切换视图', async () => {
    const r = await page.eval(`(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise(r => setTimeout(r, 400));
      const shell = document.querySelector('.shell');
      return {
        mobileClass: shell.classList.contains('mobile'),
        sideHidden: getComputedStyle(document.querySelector('.pane-side')).display,
        rightHidden: getComputedStyle(document.querySelector('.pane-right')).display,
      };
    })()`);
    // 通过 CDP 真正改视口再测一次
    await page.client.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 375, height: 812, deviceScaleFactor: 2, mobile: true },
      page.sessionId
    );
    await sleep(500);
    const r2 = await page.eval(`(() => ({
      mobileClass: document.querySelector('.shell').classList.contains('mobile'),
      side: getComputedStyle(document.querySelector('.pane-side')).display,
      chat: getComputedStyle(document.querySelector('.pane-main')).display,
      hero: document.querySelectorAll('.friend').length,
    }))()`);
    assert(r2.mobileClass, '没有加上 mobile 类名');
    // 移动端单栏：任意时刻只显示一侧（侧栏或会话），且两者不能同时隐藏
    const oneVisible = (r2.side !== 'none') !== (r2.chat !== 'none');
    assert(oneVisible, `移动端单栏切换异常：side=${r2.side} chat=${r2.chat}`);
    await page.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await sleep(300);
    return `mobile=${r2.mobileClass}, side=${r2.side}, chat=${r2.chat}（移动端采用单栏切换：一次只显示一侧）`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 9. 最终控制台检查 ===');
  await check('全程无未捕获异常', async () => {
    const real = page.problems.filter((p) => !/icon\.svg|manifest|404|favicon/i.test(p));
    assert(real.length === 0, real.slice(0, 3).join(' | '));
    return '0 个异常';
  });

  if (KEEP) {
    const shot = path.join(process.cwd(), 'e2e-shot.png');
    await page.shot(shot);
    console.log(`→ 截图：${shot}`);
  }
} catch (err) {
  failed++;
  failures.push(`未捕获的测试错误：${err.message}`);
  console.error('\n✗ 测试中断：', err.message);
} finally {
  console.log(`\n================ 端到端结果：${passed} 通过 / ${failed} 失败 ================`);
  if (failures.length) {
    console.log('\n失败详情：');
    failures.forEach((f) => console.log(' - ' + f));
  }
  if (process.env.E2E_SHOW_SERVER) {
    console.log('\n服务器输出（末尾 40 行）：');
    console.log(serverLog.split('\n').slice(-40).join('\n'));
  }
  console.log('\n控制台输出（最后 20 条）：');
  console.log(page.logs.slice(-20).join('\n') || '（无）');
  exitCode = failed ? 1 : 0;
  if (!KEEP) {
    await page.close();
    await mock.close();
    serverChild.kill('SIGKILL');
    try {
      fs.rmSync(TMP_DATA, { recursive: true, force: true });
    } catch {}
  }
}
process.exit(exitCode);
