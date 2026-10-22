#!/usr/bin/env node
/**
 * 模型调用卡死（"投票投不完 = 整局卡死"）的回归用例 —— 零依赖 + 无头 Chrome
 *
 * 历史背景（详见 docs/ARCHITECTURE.md 5.11）：旧版 `core/llm.js` 的空闲看门狗**每收到一个字节就重置**，
 * 而 SSE 心跳（`: ping`）被当成"无内容"忽略 —— 于是中转站/网关只要周期性发心跳，
 * 调用就永不返回也永不报错；而投票是"一人一次调用串行"，任何一次挂住整局就停在那儿。
 * 实测复现：静默流 1.5 秒被掐断，心跳流（每 300 ms 一个心跳）6 秒后仍挂起。
 *
 * 这个工具把修复的每一层都钉住（全部离线、用假供应商，不需要任何真实密钥）：
 *   A. 心跳挂死：在一个上限内掐断，且**只发出 1 个请求**（掐断后不再白试一次非流式）
 *   B. 慢但一直在吐字：内容完整保留（计时按"有没有新内容"重置，不误杀慢模型）
 *   C. 连续没回应 → 改用短等待；供应商恢复 → 立刻复位
 *   D. 只支持非流式的中转（流式接口报 400）→ 仍然自动回退并拿到内容
 *   E. 投票阶段总预算 → 供应商整体很慢时"投票一定会结束"
 *   F. 心跳型供应商下整局仍能在有限时间内走完
 *
 * 用法：node tools/stallcheck.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launch, sleep, freePort } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
/**
 * 端口必须"问系统要一个空闲的"，不能"基址 + 随机数"。
 * 踩过的坑：原来在 5236~5255 / 5256~5275 这么窄的段里随机，第一次跑就撞上残留实例，
 * 直接 `EADDRINUSE` 让整套用例失败（重跑又通过了，看起来像随机故障）。
 */
const PORT = await freePort();
const MOCK_PORT = await freePort();
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-stall-'));
const REAL_DATA_DIR = path.join(ROOT, 'data', 'db');
if (path.resolve(TMP_DATA).startsWith(path.resolve(REAL_DATA_DIR) + path.sep)) {
  console.error('✗ 拒绝运行：测试目录不能是真实 data/db');
  process.exit(2);
}

/** 假供应商的各类"坏行为" */
const DELAY_VOTE_MS = 1200;   // E：每次投票调用慢 1.2 秒
const VOTE_BUDGET_MS = 800;   // E：投票阶段预算只给 0.8 秒 → 只问得到第 1 个人
const ASK_TIMEOUT_MS = 1200;  // A/B/C/D/F：单次调用的"多久没新内容就掐断"上限
const ASK_STALL_MS = 400;     // C/F：连续没回应后的短等待
const PK_SLOW_MS = 500;       // G：每次调用慢 0.5 秒（快于降级等待，只有预算能掐断它）
const PK_BUDGET_MS = 700;     // G：PK 重投自己那份预算 → 问到第 2 个人后收手

const stats = { hb: 0, hbNonStream: 0, slow: 0, fast: 0, nostreamStream: 0, nostreamFull: 0, voteSlow: 0, voteHb: 0 };
let pings = 0;
/** 诊断用：还开着的连接数 / 还在跑的心跳定时器（测试工具自己漏定时器会把进程拖死，表现为 CDP 超时） */
let openConns = 0;
let liveIntervals = 0;

const mock = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.url.startsWith('/stats')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...stats, pings, openConns, liveIntervals }));
  }
  openConns++;
  res.on('close', () => { openConns--; });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* 忽略 */
    }
    const model = String(payload.model || 'fast');
    const isStream = payload.stream !== false;
    const ask = [...(payload.messages || [])].reverse().find((m) => m.role === 'user');
    const prompt = String((ask && ask.content) || '');
    const seats = [...new Set([...prompt.matchAll(/(\d{1,2})\s*号/g)].map((m) => Number(m[1])))];
    const meSeat = Number((prompt.match(/你是\s*(\d{1,2})\s*号/) || [])[1] || 0);
    const target = seats.find((s) => s !== meSeat) || 1;
    const isVote = /投票：<编号>号/.test(prompt) && /只输出一行/.test(prompt);

    // ⚠️ 顺序很重要：**只有投票类提示词才回票**，发言类必须回一句真正的发言。
    // 踩过一次：原先默认回"我是 N 号。\n投票：X号"，于是 PK 发言拿到一句带投票的文本，
    // 引擎（正确地）判成"没有发言" → 空回复又累计成 missStreak → 触发降级 → 后面的调用全被提前掐断，
    // 用例测的就不再是"预算"，而是"假模型不像话"。
    let text = `我是 ${meSeat} 号，我说两句。`;
    if (/刀杀：/.test(prompt)) text = `刀杀：${target}号`;
    else if (/查验：/.test(prompt)) text = `查验：${target}号`;
    else if (/只输出一行，从下面这些里选一种/.test(prompt)) text = '不用药';
    else if (/开枪：/.test(prompt)) text = '开枪：放弃';
    else if (/遗言/.test(prompt)) text = '我是好人，别投我。';
    else if (isVote) text = `我是 ${meSeat} 号。\n投票：${target}号`;

    /** @param {string} t */
    const sendJson = (t) => {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: t } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
    };
    /** 只发 SSE 心跳、永远不发内容也不关连接（中转站/网关的典型坏行为） */
    const sendHeartbeatOnly = () => {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      liveIntervals++;
      const t = setInterval(() => {
        pings++;
        try {
          res.write(': ping\n\n');
        } catch {
          /* 连接已断 */
        }
      }, 150);
      res.on('close', () => { clearInterval(t); liveIntervals--; });
    };

    if (model === 'hb') {
      stats.hb++;
      if (!isStream) stats.hbNonStream++;
      return sendHeartbeatOnly();
    }
    if (model === 'slow') {
      // 慢但一直在吐字：每 700 ms 一段，共 5 段（总 3.5 秒 > 上限 1.2 秒）
      stats.slow++;
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '字' + n } }] })}\n\n`);
        if (n >= 5) {
          clearInterval(t);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 700);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (model === 'nostream') {
      // "只支持非流式"的中转：流式接口直接 400（报错，不是挂住）
      if (isStream) {
        stats.nostreamStream++;
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'streaming not supported' } }));
      }
      stats.nostreamFull++;
      return sendJson(text);
    }
    if (model === 'slowall') {
      // 每一次调用都慢一点点（含 PK 发言），但**快于降级等待** —— 专供"平票 PK 重投"那条用例：
      // 这样被掐断的只可能是预算，不会是降级
      stats.slowAll = (stats.slowAll || 0) + 1;
      setTimeout(() => sendJson(text), PK_SLOW_MS);
      return;
    }
    if (model === 'slowvote' && isVote) {
      stats.voteSlow++;
      setTimeout(() => sendJson(text), DELAY_VOTE_MS);
      return;
    }
    if (model === 'hbvote' && isVote) {
      stats.voteHb++;
      return sendHeartbeatOnly();
    }
    stats.fast++;
    return sendJson(text);
  });
});

/* ---------------- 测试框架 ---------------- */
let passed = 0;
let failed = 0;
const failures = [];
let currentPage = null;
let pageUrl = '';
const DEBUG_HEALTH = !!process.env.STALL_DEBUG;
async function health(tag) {
  if (!DEBUG_HEALTH || !currentPage) return;
  const t0 = Date.now();
  let pageMs = '无响应';
  try {
    await currentPage.eval('1+1');
    pageMs = `${Date.now() - t0}ms`;
  } catch (e) {
    pageMs = `失败(${e.message})`;
  }
  let st = {};
  try {
    st = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r) => r.json());
  } catch {
    /* 忽略 */
  }
  console.log(`      [健康 ${tag}] 页面响应 ${pageMs}｜开着连接 ${st.openConns}｜心跳定时器 ${st.liveIntervals}｜心跳累计 ${st.pings}`);
}
async function check(name, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      const d = await fn();
      passed++;
      console.log(`  ✓ ${name}${d ? `  → ${d}` : ''}${attempt > 1 ? '（第二次才过：上一次是 CDP 传输超时）' : ''}`);
      await health(name.slice(0, 2));
      return;
    } catch (err) {
      const msg = String((err && err.message) || err);
      // 只有"CDP 传输超时"才重跑：那是机器被别的进程占满、浏览器主线程被饿到 60 秒导致的，
      // 和被测逻辑无关（实测：同一条用例在机器空闲时 8/8 精确通过）。断言失败一律不重试。
      if (attempt === 1 && currentPage && /CDP 调用超时/.test(msg)) {
        console.log(`  ↻ ${name}\n      ${msg} → 刷新页面后重跑一次`);
        try {
          await currentPage.goto(pageUrl);
          await waitFor(async () => currentPage.eval('!!document.querySelector(".shell")'), { timeout: 20000, label: '刷新后外壳' });
        } catch {
          /* 刷新也失败就照常算失败 */
        }
        continue;
      }
      failed++;
      failures.push(`${name}：${msg}`);
      console.log(`  ✗ ${name}\n      ${msg}`);
      await health(name.slice(0, 2) + ' 失败后');
      return;
    }
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || '断言失败');
};
const sec = (ms) => `${(ms / 1000).toFixed(2)}s`;

async function waitFor(fn, { timeout = 25000, interval = 200, label = '条件' } = {}) {
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

/** 页内：开一局（默认 6 人 + 你），返回 game；真人全走脚本化 handler */
const PAGE_NEW_GAME = (model, extra = '') => `(async () => {
  const w = await import('./core/werewolf.js');
  const store = await import('./core/store.js');
  const tpl = await import('./data/templates.js');
  const base = { onboarded: true, provider: 'ollama', model: '${model}',
    baseUrls: { ollama: 'http://127.0.0.1:${MOCK_PORT}/v1' }, apiKeys: {}, useProxy: false,
    voice: { enabled: false }, proactive: { enabled: false } };
  store.setSettings(base);
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const c = await store.saveCharacter(tpl.templateToCharacter(tpl.CHARACTER_TEMPLATES[i]));
    ids.push({ id: c.id, name: c.name });
  }
  const g = await store.saveGroup({ name: '卡死回归', emoji: '🌙', members: ids.map((x) => x.id), autoTalk: false }, store.getSettings().group);
  window.__warns = [];
  const game = new w.WerewolfGame({ group: g, members: ids, settings: { ...base }, userName: '我', fastMode: false,
    askTimeoutMs: ${ASK_TIMEOUT_MS}, askStallMs: ${ASK_STALL_MS}, voteBudgetMs: ${VOTE_BUDGET_MS}, ${extra}
    human: {
      wolf: async (r) => ({ seat: (r.options[0] || {}).seat }),
      seer: async (r) => ({ seat: (r.options[0] || {}).seat }),
      witch: async (r) => (r.canSave ? { save: true } : { none: true }),
      vote: async (r) => ({ seat: (r.options[0] || {}).seat }),
      speech: async () => ({ text: '我是好人。' }),
      lastWords: async () => ({ text: '我是好人。' }),
      shoot: async () => null,
    },
    handlers: { onWarn: (t) => window.__warns.push(t) } });
  window.__game = game;
  return { gid: g.id, ids };
})()`;

/** 页内：直接打引擎的 askLLM（跳过整局，专测单次调用的看门狗） */
const PAGE_ASK = (model, prompt = '【狼人杀 · 第 1 天 · 白天发言】请说一句话') => `(async () => {
  const game = window.__game;
  game.settings.model = '${model}';
  const p = game.state.players[0];
  const t0 = Date.now();
  let text = '', err = '';
  try { text = await game.askLLM(p, ${JSON.stringify(prompt)}, 'day'); } catch (e) { err = String((e && e.message) || e); }
  return { ms: Date.now() - t0, text, err, miss: game.missStreak, wait: game.currentAskTimeoutMs() };
})()`;

const child = spawn(process.execPath, ['server.mjs', '--port', String(PORT), '--no-open', '--data-dir', TMP_DATA], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
/** 收集服务器输出：启动失败时要能说清原因（端口被占用 / 目录不可写…），而不是只报"等待超时" */
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d.toString()));
child.stderr.on('data', (d) => (serverLog += d.toString()));

let code = 1;
let page = null;
/**
 * 整体超时自爆：CDP 的等待不是每一处都有超时（实测踩过：浏览器进程被强杀后，
 * 剩下的等待永远不返回，工具会 55 分钟不声不响地挂着、CPU 只用了 0.5 秒）。
 * 到点就带着提示退出，别让人对着一个假死的终端等。
 */
const TOTAL_BUDGET_MS = Number(process.env.STALL_BUDGET_MS || 15 * 60 * 1000);
const hardStop = setTimeout(() => {
  console.log(`\n✗ 整体超时（${Math.round(TOTAL_BUDGET_MS / 60000)} 分钟）：某个 CDP 等待没有返回，强制退出。`);
  console.log('  排查顺序：① 有没有残留的无头浏览器（user-data-dir 里带 aichat-cdp 的）② 有没有残留的测试服务器（server.mjs --port）');
  process.exit(3);
}, TOTAL_BUDGET_MS);
if (hardStop && typeof hardStop.unref === 'function') hardStop.unref();
let IDS = '[]';
let GID = '';
try {
  await new Promise((r, j) => {
    mock.once('error', j);
    mock.listen(MOCK_PORT, '127.0.0.1', r);
  }).catch((err) => {
    throw new Error(`假供应商无法监听 127.0.0.1:${MOCK_PORT}：${err.message}${/EADDRINUSE/.test(err.message) ? '（端口被占用，请重跑本脚本）' : ''}`);
  });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok, { label: '服务器启动', timeout: 15000 });
  } catch (err) {
    const why = child.exitCode !== null ? `被测服务器已退出（exit ${child.exitCode}）` : `被测服务器在 127.0.0.1:${PORT} 上没有响应`;
    throw new Error(`${why}。服务器输出：${serverLog.trim().slice(-400) || '（无）'}`);
  }
  page = await launch({ width: 1200, height: 860 });
  currentPage = page;
  pageUrl = `http://127.0.0.1:${PORT}/`;
  await page.goto(pageUrl);
  await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '界面外壳' });

  console.log('\n================ 模型调用卡死回归 ================\n');
  console.log(`参数：单次上限 ${ASK_TIMEOUT_MS}ms｜降级上限 ${ASK_STALL_MS}ms｜投票预算 ${VOTE_BUDGET_MS}ms\n`);
  const setup = await page.eval(PAGE_NEW_GAME('fast'));
  IDS = JSON.stringify(setup.ids);
  GID = setup.gid;

  await check('A. 只发心跳的供应商：一个上限内掐断，且不再白试一次非流式', async () => {
    // 掐断耗时是墙钟量，机器被别的进程占满时会被拖长（实测偶发过一次 63 秒的离群），
    // 所以取 3 次里最好的一次：结构断言（只发 1 个请求、不重试非流式）每次都必须成立，
    // 而"有没有上限"这件事看最好的那次就够 —— 没有上限的话每次都会挂到 120 秒的空闲看门狗。
    const before = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r) => r.json());
    const tries = [];
    for (let i = 0; i < 3; i++) {
      const r = await page.eval(PAGE_ASK('hb'));
      assert(!r.text, `挂死的调用不该返回文字，实际 "${r.text}"`);
      tries.push(r.ms);
      if (r.ms <= ASK_TIMEOUT_MS + 700) break;
    }
    const after = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r2) => r2.json());
    const best = Math.min(...tries);
    const sent = (after.hb - before.hb) / tries.length;
    assert(best <= ASK_TIMEOUT_MS + 700, `应当在一个上限（${ASK_TIMEOUT_MS}ms）附近掐断，${tries.length} 次实测：${tries.map(sec).join('、')}`);
    assert(sent === 1, `被掐断后不该再重试，每次实际发了 ${sent} 个请求`);
    assert(after.hbNonStream === before.hbNonStream, `不该出现非流式重试，实际多了 ${after.hbNonStream - before.hbNonStream} 次`);
    return `${sec(best)} 掐断（共测 ${tries.length} 次：${tries.map(sec).join('、')}）｜每次只发 1 个请求、非流式重试 0 次｜心跳 ${after.pings} 个（都没能"喂饱"看门狗）`;
  });

  await check('B. 慢但一直在吐字：完整保留，不误杀', async () => {
    const r = await page.eval(PAGE_ASK('slow'));
    assert(r.text === '字1字2字3字4字5', `慢流的文字要完整保留，实际 "${r.text}"`);
    assert(r.ms > ASK_TIMEOUT_MS, `这条用例必须真的超过上限才有意义，实际 ${sec(r.ms)}`);
    assert(r.miss === 0, `正常吐字的一次调用不该算"没回应"，实际 missStreak=${r.miss}`);
    return `${sec(r.ms)}（> 上限 ${ASK_TIMEOUT_MS}ms）拿到完整的"${r.text}"｜missStreak 仍为 0`;
  });

  await check('C. 连续没回应 → 降级等待；供应商恢复 → 立刻复位', async () => {
    const hb1 = await page.eval(PAGE_ASK('hb'));
    const hb2 = await page.eval(PAGE_ASK('hb'));
    const hb3 = await page.eval(PAGE_ASK('hb'));
    assert(hb1.miss === 1 && hb2.miss === 2 && hb3.miss === 3, `missStreak 应当累计，实际 ${hb1.miss}/${hb2.miss}/${hb3.miss}`);
    assert(hb3.wait === ASK_STALL_MS, `连续没回应后等待上限应降到 ${ASK_STALL_MS}ms，实际 ${hb3.wait}ms`);
    assert(hb3.ms < hb1.ms * 0.6, `降级后应当明显更快：第 1 次 ${sec(hb1.ms)} vs 第 3 次 ${sec(hb3.ms)}`);
    const ok = await page.eval(PAGE_ASK('fast'));
    assert(ok.text && ok.miss === 0 && ok.wait === ASK_TIMEOUT_MS, `恢复正常后要清零并还原等待上限，实际 miss=${ok.miss} wait=${ok.wait}`);
    return `missStreak 1→2→3｜单次 ${sec(hb1.ms)} → ${sec(hb3.ms)}（降到 ${ASK_STALL_MS}ms）｜恢复后 miss=0、上限回到 ${ASK_TIMEOUT_MS}ms`;
  });

  await check('D. 只支持非流式的中转（流式报 400）：仍然回退成功', async () => {
    const before = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r) => r.json());
    const r = await page.eval(PAGE_ASK('nostream'));
    const after = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r2) => r2.json());
    assert(r.text, '流式接口报错时应当回退到非流式并拿到内容');
    assert(after.nostreamFull - before.nostreamFull >= 1, '应当真的发过非流式请求');
    return `流式失败 ${after.nostreamStream - before.nostreamStream} 次后走非流式成功拿到 "${r.text.slice(0, 12)}…"`;
  });

  await check('E. 投票阶段总预算：供应商整体很慢时"投票一定会结束"', async () => {
    await page.eval(PAGE_NEW_GAME('slowvote'));
    const r = await page.eval(`(async () => {
      const game = window.__game;
      const t0 = Date.now();
      await game.run();
      const alive = game.state.players.filter((p) => p.alive).length;
      return { ms: Date.now() - t0, over: !!game.state.over, ballots: (game.state.lastBallots || []).length,
        abstain: (game.state.lastBallots || []).filter((b) => b.seat == null).length, alive, day: game.state.day,
        warns: window.__warns.filter((t) => /投票等待超时/.test(t)) };
    })()`);
    assert(r.over, '整局应当走完');
    assert(r.warns.length > 0, '应当给出"投票等待超时"提醒');
    const s = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((x) => x.json());
    assert(s.voteSlow > 0, '这条用例必须真的发生过"慢投票"才有意义');
    return `投票调用各慢 ${DELAY_VOTE_MS}ms、预算只有 ${VOTE_BUDGET_MS}ms｜最后一轮只问了 ${r.ballots} 人（弃票 ${r.abstain}，当时场上 ${r.alive} 人）就收尾｜整局 ${sec(r.ms)} 走完于第 ${r.day} 天｜慢投票调用共 ${s.voteSlow} 次`;
  });

  await check('F. 心跳型供应商下整局仍能在有限时间内走完（就是"卡死"那条）', async () => {
    await page.eval(PAGE_NEW_GAME('hbvote'));
    const before = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r) => r.json());
    const r = await page.eval(`(async () => {
      const game = window.__game;
      const t0 = Date.now();
      const finished = game.run().then(() => true);
      const cap = new Promise((res) => setTimeout(() => res(false), 60000));
      const done = await Promise.race([finished, cap]);
      if (!done) { try { game.stop(); } catch {} }
      return { done, ms: Date.now() - t0, phase: game.state.phase, day: game.state.day,
        abstain: (game.state.lastBallots || []).filter((b) => b.seat == null).length };
    })()`);
    const after = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r2) => r2.json());
    assert(r.done, `整局没走完（停在 ${r.phase}），说明还有会永久挂住的调用`);
    assert(after.voteHb - before.voteHb > 0, '这条用例必须真的撞上"投票请求只发心跳"才有意义');
    assert(after.pings - before.pings > 0, '假供应商应当真的发过心跳（否则心跳没能重置看门狗，测不到根因）');
    return `投票请求全部只发心跳（${after.voteHb - before.voteHb} 次、${after.pings - before.pings} 个心跳）｜整局 ${sec(r.ms)} 走完，结束于第 ${r.day} 天`;
  });

  await check('G. 平票 PK 的重投有自己的预算：普通投票再慢也挤不掉 PK', async () => {
    // 这一条守的是"别把好局判坏"：PK 重投和普通投票**各有一份**预算。
    // 场景：6 人局、票已经全部预置成平票（普通投票那段一个人都不问），但 PK 前要发两段 PK 发言，
    // 各 0.5 秒 = 1 秒 > 预算 0.7 秒 —— 如果两段共用一份预算，重投一开始就已经超时、一个人都问不到；
    // 各一份的话，重投还能问满自己那 0.7 秒（每次调用 0.5 秒 → 问得到 2 个人）。
    // 实测 A/B（应用副本上把这两行去掉）：共用预算 6/6 次都是"重投 0 人、本轮无人出局"，
    // 各一份 6/6 次都是"重投问 2 个人"。
    await page.eval(PAGE_NEW_GAME('slowall', `voteBudgetMs: ${PK_BUDGET_MS}, askTimeoutMs: 4000, askStallMs: 4000,`));
    const r = await page.eval(`(async () => {
      const game = window.__game;
      const s = game.state;
      // 先把存活人数弄成偶数（下面要把票平分成两堆），再让**每个存活玩家都已经投过票**，
      // 这样普通投票那段一个人都不会问、平票也就不会被假模型的票打破。
      let alive = s.players.filter((p) => p.alive);
      if (alive.length % 2 === 1) {
        const victim = alive.find((p) => !p.isUser) || alive[alive.length - 1];
        victim.alive = false;
        alive = s.players.filter((p) => p.alive);
      }
      const X = alive[0], Y = alive[1];
      const tickets = [{ voterSeat: X.seat, seat: Y.seat }, { voterSeat: Y.seat, seat: X.seat }];
      alive.slice(2).forEach((p, i) => tickets.push({ voterSeat: p.seat, seat: i % 2 === 0 ? X.seat : Y.seat }));
      s.voteBallotsDay = s.day;
      s.voteBallots = tickets;
      const t0 = Date.now();
      const done = await Promise.race([game.phaseVote().then(() => true), new Promise((res) => setTimeout(() => res(false), 30000))]);
      const eligible = alive.filter((p) => p.seat !== X.seat && p.seat !== Y.seat).length;
      return { done, ms: Date.now() - t0, phase: s.phase,
        // 注意：分出胜负时引擎会把 s.pkBallots 清空，所以"重投收了几票"要看 lastBallots
        reVotes: (s.lastBallots || []).length, eligible, tied: X.seat + '/' + Y.seat,
        speechMissing: (s.log || []).some((t) => /没有发言/.test(t)) };
    })()`);
    assert(r.done, '这一轮投票没能结束（PK 重投那段可能又挂住了）');
    assert(!r.speechMissing, 'PK 发言被判成"没有发言"（假模型没按发言格式回话，这条用例就失去意义了）');
    assert(r.reVotes >= 1, `PK 重投一个人都没问到 —— 说明 PK 拿不到自己的预算（普通投票把预算吃光了）`);
    assert(r.reVotes < r.eligible, `重投应当受自己那份预算约束（${r.eligible} 个可投只该问到一部分），实际问了 ${r.reVotes} 人`);
    return `${r.tied} 平票进 PK（PK 发言就花了超过预算的时间）｜重投仍问到 ${r.reVotes}/${r.eligible} 人 → 收尾进入 ${r.phase}`;
  });

  await check('H. 投票投到一半刷新续玩：接着投、不重复问、能走完', async () => {
    const started = await page.eval(PAGE_NEW_GAME('hbvote'));
    await page.eval(`(() => { window.__game.run(); return true; })()`);
    await waitFor(async () => page.eval(`(window.__game.state.phase === 'vote' && (window.__game.state.voteBallots || []).length >= 1)`), { timeout: 20000, label: '投票进行中' });
    // 真的刷新页面：引擎状态只活在内存里，能不能接上全靠存档
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '界面外壳' });
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const ids = ${JSON.stringify(started.ids)};
      // 这里刻意用内存里的群对象，不去 listGroups() 里找：刷新后应用会以服务器侧数据为准，
      // 刚建的群可能还没同步过去（那是存储同步的时机问题，与"引擎能不能续玩"无关，
      // 拿它当前提会让这条用例时红时绿）。续玩只需要群 id + 成员表。
      const g = { id: ${JSON.stringify(started.gid)}, name: '卡死回归', members: ids.map((m) => m.id) };
      const s = w.loadGame(g.id);   // 界面"接着上一局"走的就是这条路
      if (!s) return { noSave: true };
      const game = new w.WerewolfGame({ group: g, members: ids, settings: store.getSettings(), userName: '我', state: s,
        askTimeoutMs: ${ASK_TIMEOUT_MS}, askStallMs: ${ASK_STALL_MS}, voteBudgetMs: ${VOTE_BUDGET_MS},
        human: { wolf: async (q) => ({ seat: (q.options[0] || {}).seat }), seer: async (q) => ({ seat: (q.options[0] || {}).seat }),
          witch: async (q) => (q.canSave ? { save: true } : { none: true }), vote: async (q) => ({ seat: (q.options[0] || {}).seat }),
          speech: async () => ({ text: '我是好人。' }), lastWords: async () => ({ text: '我是好人。' }), shoot: async () => null } });
      const t0 = Date.now();
      const done = await Promise.race([game.run().then(() => true), new Promise((res) => setTimeout(() => res(false), 40000))]);
      if (!done) { try { game.stop(); } catch { /* 忽略 */ } }
      const voters = (s.voteBallots || []).map((b) => b.voterSeat);
      return { done, ms: Date.now() - t0, over: !!s.over, day: s.day, dup: voters.length !== new Set(voters).size };
    })()`);
    assert(!r.noSave, '续玩存档丢了（loadGame 返回空）');
    assert(r.done && r.over, `续玩后这局没走完（done=${r.done} over=${r.over}）`);
    assert(!r.dup, '有玩家被重复问了一遍票（续玩没有认出已投的票）');
    return `投票中途刷新 → 续玩 ${sec(r.ms)} 走完整局（第 ${r.day} 天）｜已投的票没被重复问`;
  });

  await check('I. 挂住的调用进行中：暂停停得住、继续能接上', async () => {
    await page.eval(PAGE_NEW_GAME('hbvote'));
    const r = await page.eval(`(async () => {
      const game = window.__game;
      game.run();
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        if (game.state.phase === 'vote') break;
        await new Promise((res) => setTimeout(res, 100));
      }
      game.pause();
      const sig = () => JSON.stringify([game.state.day, game.state.phase, (game.state.voteBallots || []).length, (game.state.log || []).length]);
      const frozen = sig();
      await new Promise((res) => setTimeout(res, 2500));
      const stillFrozen = sig() === frozen;
      game.resume();
      const done = await Promise.race([game.run().then(() => true), new Promise((res) => setTimeout(() => res(false), 40000))]);
      if (!done) { try { game.stop(); } catch { /* 忽略 */ } }
      return { stillFrozen, done, over: !!game.state.over, day: game.state.day, phase: game.state.phase };
    })()`);
    assert(r.stillFrozen, '暂停期间引擎还在推进（暂停应当真的停住）');
    assert(r.done && r.over, `恢复后这局没走完（停在 ${r.phase}）`);
    return `暂停 2.5 秒期间状态完全不变｜恢复后走完整局（第 ${r.day} 天）`;
  });

  await check('J. 真人自己的回合绝不会被超时跳过（等待 3.5 秒 > 单次上限 1.2 秒）', async () => {
    await page.eval(PAGE_NEW_GAME('fast'));
    const r = await page.eval(`(async () => {
      const game = window.__game;
      const waits = [];
      const origHuman = game.askHuman.bind(game);
      game.askHuman = async (kind, req) => {
        const t0 = Date.now();
        await new Promise((res) => setTimeout(res, 3500));   // 模拟真人"想一会儿再点"
        const out = { seat: (req.options[0] || {}).seat, text: '我是好人。' };
        waits.push(Date.now() - t0);
        return out;
      };
      const done = await Promise.race([game.run().then(() => true), new Promise((res) => setTimeout(() => res(false), 60000))]);
      if (!done) { try { game.stop(); } catch { /* 忽略 */ } }
      return { done, over: !!game.state.over, maxWait: waits.length ? Math.max(...waits) : 0, answered: waits.length };
    })()`);
    assert(r.done && r.over, '整局没走完');
    assert(r.answered > 0, '这局真人一次都没轮到（这条用例没测到东西）');
    assert(r.maxWait >= 3400, `真人还没点，引擎就自己往下走了（最长只等了 ${r.maxWait}ms）`);
    return `真人回合等待 ${r.answered} 次、最长 ${r.maxWait}ms（远超单次上限 ${ASK_TIMEOUT_MS}ms 也没被跳过）｜整局正常走完`;
  });

  await check('K. 挂住的调用进行中"结束本局"：立刻收尾、不留控制器', async () => {
    await page.eval(PAGE_NEW_GAME('hbvote'));
    const r = await page.eval(`(async () => {
      const game = window.__game;
      const p = game.run();
      await new Promise((res) => setTimeout(res, 2000));
      const t0 = Date.now();
      game.stop('user');
      const done = await Promise.race([p.then(() => true), new Promise((res) => setTimeout(() => res(false), 8000))]);
      return { done, ms: Date.now() - t0, stopped: game.stopped, controller: game.controller };
    })()`);
    assert(r.done, '结束本局后 run() 没有收尾（还挂在那儿）');
    assert(r.stopped, 'stop() 没生效');
    assert(r.controller === null, `停止后还留着控制器：${r.controller}`);
    return `起局 2 秒后停止，${sec(r.ms)} 内 run() 正常收尾｜stopped=true｜controller 已清空`;
  });

  await check('L. 极速模式（fastMode）不受影响', async () => {
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const ids = ${IDS};
      const g = (await store.listGroups()).find((x) => x.id === ${JSON.stringify(GID)});
      const game = new w.WerewolfGame({ group: g, members: ids, settings: { ...store.getSettings(), model: 'fast' }, userName: '我',
        fastMode: true, askTimeoutMs: ${ASK_TIMEOUT_MS}, askStallMs: ${ASK_STALL_MS}, voteBudgetMs: ${VOTE_BUDGET_MS},
        human: { wolf: async (q) => ({ seat: (q.options[0] || {}).seat }), seer: async (q) => ({ seat: (q.options[0] || {}).seat }),
          witch: async (q) => (q.canSave ? { save: true } : { none: true }), vote: async (q) => ({ seat: (q.options[0] || {}).seat }),
          speech: async () => ({ text: '我是好人。' }), lastWords: async () => ({ text: '我是好人。' }), shoot: async () => null } });
      const t0 = Date.now();
      const done = await Promise.race([game.run().then(() => true), new Promise((res) => setTimeout(() => res(false), 40000))]);
      if (!done) { try { game.stop(); } catch { /* 忽略 */ } }
      return { done, over: !!game.state.over, ms: Date.now() - t0, phase: game.state.phase, winner: game.state.winner };
    })()`);
    assert(r.done && r.over, `极速模式没走完（停在 ${r.phase}）`);
    return `${sec(r.ms)} 走完，winner=${r.winner}`;
  });

  await check('M. 暂停超过投票预算：恢复后这一轮照样把票问完（暂停不吃预算）', async () => {
    // 预算只有 600ms，暂停 2 秒（3 倍多）。暂停期间不该算进预算，
    // 否则恢复后第一次检查就超时 → 还没投的人全被按弃票算（这是玩家按个暂停就会踩到的坑）。
    await page.eval(PAGE_NEW_GAME('fast', 'voteBudgetMs: 600, askTimeoutMs: 4000, askStallMs: 4000,'));
    const r = await page.eval(`(async () => {
      const game = window.__game;
      const s = game.state;
      const alive = s.players.filter((p) => p.alive);
      const runP = game.phaseVote();
      game.pause();
      await new Promise((res) => setTimeout(res, 2000));
      game.resume();
      const done = await Promise.race([runP.then(() => true), new Promise((res) => setTimeout(() => res(false), 30000))]);
      return { done, phase: s.phase, asked: (s.lastBallots || []).length, alive: alive.length,
        timeoutWarn: window.__warns.filter((t) => /投票等待超时/.test(t)).length };
    })()`);
    assert(r.done, '这一轮投票没结束');
    assert(r.asked >= r.alive, `暂停不该让投票被跳过：${r.alive} 人在场却只问了 ${r.asked} 人`);
    assert(r.timeoutWarn === 0, `不该出现"投票等待超时"（暂停的时间不该算进预算）`);
    return `预算 600ms、暂停 2 秒后恢复：${r.alive} 人在场、问到 ${r.asked} 人，无超时提醒 → 进入 ${r.phase}`;
  });

  await check('N. 全程无未捕获异常', async () => {
    // D 用例故意让流式接口报 400（模拟"只支持非流式"的中转），浏览器会把这次 400 记进 console。
    // 那是**预期内**的网络失败，不是脚本异常，所以要按 URL 排掉；其余控制台报错一律算失败。
    const problems = (page.problems || []).filter((t) => !(t.includes('Failed to load resource') && t.includes(`:${MOCK_PORT}/`)));
    assert(problems.length === 0, `控制台报错：${problems.slice(0, 3).join(' | ')}`);
    return `0 个异常（已排除 ${(page.problems || []).length - problems.length} 条 D 用例故意触发的 400）`;
  });

  code = failed === 0 ? 0 : 1;
} finally {
  try {
    const st = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`).then((r) => r.json());
    console.log(`\n诊断：心跳 ${st.pings} 个｜仍开着的连接 ${st.openConns}｜仍在跑的心跳定时器 ${st.liveIntervals}`);
  } catch {
    /* 忽略 */
  }
  console.log(`\n================ 卡死回归结果：${passed} 通过 / ${failed} 失败 ================`);
  if (failures.length) console.log(`\n失败详情：\n - ${failures.join('\n - ')}`);
  clearTimeout(hardStop);
  // 收尾也不能挂住：浏览器要是已经死了，page.close() 同样可能永不返回
  if (page) await Promise.race([page.close().catch(() => {}), sleep(3000)]);
  child.kill('SIGKILL');
  await Promise.race([new Promise((r) => mock.close(r)), sleep(3000)]);
  try {
    fs.rmSync(TMP_DATA, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}
process.exit(code);
