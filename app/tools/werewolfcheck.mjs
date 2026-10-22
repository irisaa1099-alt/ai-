#!/usr/bin/env node
/**
 * 狼人杀端到端测试（零依赖 + 无头 Chrome）
 *
 * 三块：
 *   A. 真跑一整局：用假模型让 7 位玩家（6 群成员 + 你）从开局打到分出胜负
 *   B. 私密信息不泄露：每个角色收到的 system 里只有自己的身份，且不进群聊记录
 *   C. 界面流程：群资料入口 → 开局面板 → 我的身份卡 → 结束并退出模式 + 冲突保护
 *
 * 用法：node tools/werewolfcheck.mjs
 *       node tools/werewolfcheck.mjs --only 准备,C2,V     # 只跑名字含这些片段的用例（调试用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launch, sleep, freePort } from './cdp.mjs';
// Node 侧直接用引擎的纯函数（页面里那份 import 是另一套，互不影响）。
// 注意**必须写成静态 import**：audit.mjs 把 tools 里动态 import 的那个字符串一律当成
// "给浏览器执行的"、按 web 根解析，写成 Node 侧的动态相对路径会被它判成"模块不存在"。
import { liveSpeechPreview } from '../core/werewolf.js';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const MOCK_PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-werewolf-'));
const REAL_DATA_DIR = path.join(ROOT, 'data', 'db');
if (path.resolve(TMP_DATA).startsWith(path.resolve(REAL_DATA_DIR) + path.sep)) {
  console.error('✗ 拒绝运行：测试目录不能是真实 data/db');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];
/**
 * 只跑名字里含这些片段的用例：`node tools/werewolfcheck.mjs --only 准备,C2,V`
 * 为什么留着它：整套跑一遍要几分钟，调一条用例时不必每次都等全量。
 * **定稿前必须跑全量** —— 用例之间有状态依赖（跳过前面的，后面可能没得测）。
 */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return [];
  return String(process.argv[i + 1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
})();
async function check(name, fn) {
  if (ONLY.length && !ONLY.some((k) => name.includes(k))) return;
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
/** 角色 id → 中文名（核对私密身份时用；与 core/werewolf.js 的 ROLES 保持一致） */
const ROLE_ZH = { wolf: '狼人', villager: '平民', seer: '预言家', witch: '女巫', hunter: '猎人', idiot: '白痴' };
const w2RoleName = (id) => ROLE_ZH[id] || id;

/**
 * 页内助手（插进 page.eval 的模板串里用）：把剧本里的角色发给**非真人**玩家，返回 `{ role: [seat...] }`。
 *
 * 为什么需要它：座位号现在**每局随机**（见 core/werewolf.js 的 createState），
 * 所以测试不能再写死"1 号是女巫、4 号是预言家"——真人会随机占住某张椅子，
 * 一旦剧本角色落在真人身上，引擎走的是 `askHuman` 而不是脚本化的 `askLLM`，
 * 整个用例就会静默跑偏（曾经因此在 E/L 里误报"猎人没被毒死""预言家提示词缺失"）。
 */
const PAGE_ASSIGN = `
  const assignToAI = (w, game, plan) => {
    const players = game.state.players.slice().sort((a, b) => a.seat - b.seat);
    for (const p of players) {
      p.role = 'villager';
      p.team = w.ROLES.villager.team;
      p.god = w.ROLES.villager.god;
    }
    const pool = players.filter((p) => !p.isUser);   // 真人固定当村民，剧本角色全给 AI
    const out = {};
    for (const [role, n] of Object.entries(plan)) {
      const take = pool.splice(0, n);
      for (const p of take) {
        p.role = role;
        p.team = w.ROLES[role].team;
        p.god = w.ROLES[role].god;
      }
      out[role] = take.map((p) => p.seat);
    }
    return out;
  };
`;
async function waitFor(fn, { timeout = 30000, interval = 180, label = '条件' } = {}) {
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

/* ---------------- 假模型：会按格式回话（刀人/查验/用药/发言+投票） ---------------- */

/** 空内容模式：用来复现"模型返回空 → 角色全程不发言" */
let emptyMode = false;
/**
 * 截断模式：复现"上游因为 max_tokens 用尽而把发言从中间切断"（finish_reason=length）。
 *   soft = 只切**第一次**（max_tokens ≤ 600）的发言请求 —— 引擎应当放宽额度重问并拿到完整版；
 *   hard = 连重问（更大的 max_tokens）也切 —— 引擎应当保留半句并在结尾补"……"。
 * 见 core/werewolf.js 的 askLLM 与 markTruncatedTail。
 */
let truncateMode = ''; // '' | 'soft' | 'hard'
/** 假模型"故意认狼"的次数：用来证明"狼人自曝"这个场景真的被跑到过 */
let wolfConfessAttempts = 0;
/** 打开后，狼人一有机会就自曝（专门验证引擎的兜底） */
let confessMode = false;
/**
 * 打开后，**每个发言人都会去质问"还没轮到的那一位怎么不说话"**
 * （照着提示词里的【发言顺序】找"还没轮到的"是谁，见 Z 用例）。
 * 2026-09-21 那次修复的靶子：顺序发言里后置位此刻还没有机会开口，这不算疑点。
 */
let urgeMode = false;
/** 假模型真的催过后置位几次：用来证明"这个场景被跑到过"（否则 Z 用例测的是空气） */
let urgeAttempts = 0;
/**
 * urgeMode 用：照着提示词里的【发言顺序（重要）】找出"**还没轮到的**是谁"，
 * 然后**故意**拿"他一直不吭声"去踩那一位 —— 正是 2026-09-21 修掉的那句话。
 * 找不到（例如发言人是最后一位）就回一条正常发言，让这一局照常跑下去。
 * @param {string} prompt
 * @param {number} meSeat
 * @param {number} target 投票目标（假模型本来就要投一个人）
 * @returns {string}
 */
function urgeSpeechText(prompt, meSeat, target) {
  const pendingLine = (String(prompt).match(/还没轮到的\*\*：([^\n]*)/) || [])[1] || '';
  const seat = Number((pendingLine.match(/(\d{1,2})\s*号/) || [])[1] || 0);
  if (!seat) return `我是 ${meSeat} 号，按顺序我先说到这儿。\n投票：${target}号`;
  urgeAttempts++;
  return `我是 ${meSeat} 号，${seat} 号到现在一直不吭声，我看有问题。\n投票：${target}号`;
}
/**
 * 慢速流：把 SSE 按 2 字一包、每包之间留几毫秒发。
 *
 * 为什么需要它：默认假模型是在**同一个 tick 里**把所有分包一次写出去的，
 * 浏览器往往一次就读完，界面的流式气泡等于一步到位 —— 那样没法验证
 * "狼人杀的发言是不是真的一句句长出来的"（见 V 用例）。
 * 只在那个用例里临时打开，避免拖慢其它用例。
 */
let slowStream = false;
const seen = [];
/** 假模型把每次提问判成了哪一类（kill/seer/witch/vote/speech/lastwords…）——失败时能一眼看出"哪个场景没跑到" */
const askTally = {};
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
  if (req.url.startsWith('/calls')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: seen.length, wolfConfessAttempts, urgeAttempts, askTally }));
  }
  if (req.url.startsWith('/confess')) {
    confessMode = true;
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ confessMode: true }));
  }
  if (req.url.startsWith('/urge')) {
    // /urge?off=1 关掉（Z 用例跑完就关，别影响后面的用例）
    urgeMode = !/off=1/.test(req.url);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ urgeMode }));
  }
  if (req.url.startsWith('/slowstream')) {
    // /slowstream?off=1 关掉（V 用例观察完就关，别拖慢后面的用例）
    slowStream = !/off=1/.test(req.url);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ slowStream }));
  }
  if (req.url.startsWith('/empty')) {
    emptyMode = true;
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ empty: true }));
  }
  if (req.url.startsWith('/full')) {
    emptyMode = false;
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ empty: false }));
  }
  if (req.url.startsWith('/truncate')) {
    if (/off=1/.test(req.url)) truncateMode = '';
    else if (/hard=1/.test(req.url)) truncateMode = 'hard';
    else truncateMode = 'soft';
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ truncateMode }));
  }
  if (req.url.startsWith('/seen')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ seen }));
  }
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      await new Promise((r) => setTimeout(r, 45)); // 少量延迟：既像真实调用，又不让整局测试太慢
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {}
      const sys = (payload.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const ask = [...(payload.messages || [])].reverse().find((m) => m.role === 'user');
      const prompt = String((ask && ask.content) || '');
      // thinking / max_tokens 一并记下来：用例 W 要核对引擎确实关了思考、并在截断时放宽了额度
      seen.push({ sys, prompt, thinking: payload.thinking || null, maxTokens: Number(payload.max_tokens || 0) });
      // 从提示词里抠出候选座位：优先"存活玩家/候选"那一段
      const seats = [...new Set([...prompt.matchAll(/(\d{1,2})\s*号/g)].map((m) => Number(m[1])))];
      const meSeat = Number((prompt.match(/你是\s*(\d{1,2})\s*号/) || [])[1] || 0) || Number((sys.match(/你的座位是\s*(\d{1,2})\s*号/) || [])[1] || 0);
      /**
       * 狼同伴的座位：提示词里那行「你的狼同伴：2 号 阿哲、5 号 小满（已出局）」
       * （HUD 那条写作「狼队友：…」，两个都认）。
       *
       * **假模型必须避开同伴**：它如果刀自己的同伴、或者在发言里踩同伴，
       * 就会撞上引擎的"卖同伴 / 自刀"兜底 —— 那条发言会被整句删掉（只剩一张票 = 这一轮没有发言），
       * 于是 V 用例拿到的是"空手而归"。那都是**引擎的正确行为**（由 H 用例显式构造并守住），
       * 但不该由假模型无意间触发：踩过 —— V 用例约 5% 的局会因为"猜的人正好是同伴"而失败，
       * 而 I 用例（真人当狼）会被同伴刀掉、从此没有白天回合。
       */
      const mateLine = (prompt.match(/狼(?:队友|同伴)\s*[:：]([^\n]*)/) || [])[1] || '';
      const mateSeats = new Set([...mateLine.matchAll(/(\d{1,2})\s*号/g)].map((m) => Number(m[1])));
      const mine = seats.filter((s) => s !== meSeat);
      const safe = mine.filter((s) => !mateSeats.has(s));
      // 全员都是同伴这种极端局面（理论上不会有）时退回原列表，保证假模型总能给出一个目标
      const others = safe.length ? safe : mine;
      const target = others.length ? others[0] : seats[0] || 1;
      let text = '';
      // confessMode：故意扮成"不听话的模型"——狼人一有机会就认狼，
      // 用来验证引擎的兜底（提示词禁止 + 纠正重试 + 删句）是不是真的拦得住。
      const amWolf = /你是「狼人」/.test(sys) || /身份「狼人」/.test(prompt);
      // "像发言的提问"同样按**标题行**判：狼人的白天发言提示词正文里也带着"遗言"两个字
      // （团队规则写着"…甚至留下遗言时都不行"），用 /遗言/ 判会把发言误记成遗言。
      const isLastWordsAsk = /【狼人杀 · 遗言】/.test(prompt);
      const isDaySpeechAsk = /【狼人杀 · 第 \d+ 天 · 白天发言】/.test(prompt);
      const isSpeechish = isLastWordsAsk || isDaySpeechAsk || /PK 发言/.test(prompt);
      if (confessMode && amWolf && isSpeechish) wolfConfessAttempts++;
      // ⚠️ 判"这是哪种提问"必须用引擎保证会出现的**结构化标记**，不能靠模糊关键词。
      //    踩过的坑（用例 G 偶发失败的真凶）：女巫的**白天发言**提示词里带着 privateFacts
      //    （"解药：还在；毒药：已用完"），早先用 /解药|毒药|不用药/ 判用药，于是女巫发言被
      //    回成"不用药"→ 这句进了公开记录 → 之后每个狼人的发言提示词都拼着这条记录，又被
      //    误判成用药 → 狼人压根没认狼 → 引擎兜底 0 次。女巫座位在狼人之前还是之后是随机的，
      //    所以时好时坏。现在用药只认女巫提问独有的那句"从下面这些里选一种"（见
      //    core/werewolf.js 的 witchExtra），发言/遗言照旧走认狼分支。
      const isWitchAsk = /只输出一行，从下面这些里选一种/.test(prompt);
      // 提问类型：同一套判据既决定回什么，也用来计数（顺序 = 优先级，先精确后模糊）
      const askKind = /刀杀：/.test(prompt)
        ? 'kill'
        : /查验：/.test(prompt)
          ? 'seer'
          : isWitchAsk
            ? 'witch'
            : /开枪：/.test(prompt)
              ? 'shoot'
              : /投票：<编号>号/.test(prompt) && /只输出一行/.test(prompt)
                ? 'vote'
                : isLastWordsAsk
                  ? 'lastwords'
                  : isSpeechish
                    ? 'speech'
                    : 'other';
      askTally[askKind] = (askTally[askKind] || 0) + 1;
      if (askKind === 'kill') text = `刀杀：${target}号`;
      else if (askKind === 'seer') text = `查验：${target}号`;
      else if (askKind === 'witch') text = '不用药';
      else if (askKind === 'shoot') text = '开枪：放弃';
      else if (askKind === 'vote') text = `投票：${target}号`;
      else if (confessMode && amWolf && askKind === 'lastwords') text = '行，那我认了，我是狼——但 4 号你这话得改改，场上剩的好人听清楚。';
      else if (confessMode && amWolf && isSpeechish) text = `得，验得准。我是狼人，不冤。\n不过 ${target} 号那票投得莫名其妙。\n投票：${target}号`;
      else if (urgeMode && isSpeechish) text = urgeSpeechText(prompt, meSeat, target);
      else text = `我是 ${meSeat} 号，我先说说我的看法：${target} 号有点可疑，我投 TA。\n投票：${target}号`;
      if (emptyMode) text = '';
      /**
       * 结束原因：正常是 stop；截断模式下的"第一次发言请求"回 length
       * （真实供应商就是这么报的，客户端要靠它识别"这句话被切了"）。
       */
      let finishReason = 'stop';
      if (truncateMode && isSpeechish && !emptyMode) {
        // soft：只切额度还没放宽的那一次（引擎应当重问并拿到完整版）
        // hard：连放宽后的重问也切（引擎应当保留半句并补"……"）
        const cutNow = truncateMode === 'hard' || Number(payload.max_tokens || 0) <= 600;
        if (cutNow) {
          // 断在句子中间、不带句读也没有投票行 —— 与线上"…互相开了一枪，枪口"一模一样
          text = `我是 ${meSeat} 号，先说我自己的看法：${target} 号那几句我听不出逻辑，枪口`;
          finishReason = 'length';
        }
      }
      // 流式：和真实供应商一样走 SSE（私聊/群聊用的就是这条链路）
      if (payload.stream) {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const chars = [...text];
        const step = slowStream ? 2 : 6;
        const chunks = [];
        for (let i = 0; i < chars.length; i += step) chunks.push(chars.slice(i, i + step).join(''));
        const sse = (chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
        const finish = () => {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 300, completion_tokens: 40 } })}\n\n`
          );
          // finish_reason 单独一个 chunk（真实供应商就是这样收尾的：这个事件没有正文增量）
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };
        if (!slowStream) {
          for (const c of chunks) res.write(sse(c));
          finish();
          return;
        }
        // 慢速流：一包一个 tick，界面才有机会看到"文字一段段长出来"
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer);
            finish();
            return;
          }
          res.write(sse(chunks[i]));
          i += 1;
        }, 8);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: finishReason }],
          usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
        })
      );
    });
    return;
  }
  res.writeHead(404, cors);
  res.end('{}');
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const child = spawn(process.execPath, ['server.mjs', '--port', String(PORT), '--no-open', '--data-dir', TMP_DATA], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise(async (resolve, reject) => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return resolve();
    } catch {}
    await sleep(150);
  }
  child.kill();
  reject(new Error('服务器启动失败'));
});

const page = await launch({ port: await freePort(), width: 1440, height: 950 });
let code = 1;
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '外壳', timeout: 20000 });

  await check('准备：6 位群成员 + 你 = 7 人局', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const tpl = await import('./data/templates.js');
      store.setSettings({
        onboarded: true, theme: 'light', provider: 'ollama', model: 'mock-model',
        baseUrls: { ollama: 'http://127.0.0.1:${MOCK_PORT}/v1' }, apiKeys: {}, useProxy: false,
        typedEffect: false, voice: { enabled: false }, proactive: { enabled: false },
        user: { name: '我', avatar: '', persona: '' },
        context: { maxMessages: 20, budgetTokens: 4000, summary: false, timeAware: false, affinity: true },
      });
      const ids = [];
      for (const t of tpl.CHARACTER_TEMPLATES.slice(0, 6)) ids.push((await store.saveCharacter(tpl.templateToCharacter(t))).id);
      const g = await store.saveGroup({ name: '狼人杀测试群', members: ids, autoDelayMs: 0 });
      localStorage.setItem('aichat.lastChar', ids[0]);
      await new Promise((r) => setTimeout(r, 600));
      const skip = [...document.querySelectorAll('button')].find((x) => /直接跳过/.test(x.textContent));
      if (skip) skip.click();
      document.querySelectorAll('.onboard, .modal-mask').forEach((n) => n.remove());
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r) => setTimeout(r, 1200));
      document.querySelectorAll('.onboard').forEach((n) => n.remove());
      const board = (await import('./core/werewolf.js')).boardFor(ids.length + 1);
      return { groupId: g.id, members: ids.length, players: ids.length + 1, board, names: ids.length };
    })()`);
    assert(r.players === 7, `玩家人数应为 7，实际 ${r.players}`);
    assert(r.board && r.board.wolf === 2 && r.board.gods.join() === 'seer,witch,hunter', `7 人板子应为 2狼+2民+预女猎，实际 ${JSON.stringify(r.board)}`);
    return `群成员 ${r.members} + 你 = ${r.players} 人，板子 ${r.board.wolf} 狼 / ${r.board.villager} 民 / ${r.board.gods.join('+')}`;
  });

  /* ---------------- A. 引擎跑完一整局 ---------------- */
  await check('A. 一整局能自动打到分出胜负（屠边判定）', async () => {
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      await store.clearGroupMessages(g.id);
      const humanLog = [];
      const human = {
        wolf: async (req) => ({ seat: (req.options[0] || {}).seat }),
        seer: async (req) => ({ seat: (req.options[0] || {}).seat }),
        witch: async () => ({ none: true }),
        vote: async (req) => ({ seat: (req.options[0] || {}).seat }),
        speech: async (req) => ({ text: '我先听听大家怎么说。\\n投票：' + ((req.options || []).find((p) => !p.isUser) || {}).seat + '号' }),
        lastWords: async () => ({ text: '我没什么好说的了。' }),
        shoot: async () => null,
      };
      const game = new w.WerewolfGame({
        group: g, members, settings: store.getSettings(), userName: '我',
        fastMode: true, human, handlers: {},
      });
      // 记录每轮由谁发言，方便核对"出局的人不会再说话"
      const speeches = [];
      game.handlers.onSpeech = (p, text) => speeches.push({ seat: p.seat, name: p.name, isUser: p.isUser, text, aliveAtSpeech: p.alive });
      // 法官公告额外从引擎回调抓一份：即使落库/过滤出岔子，也能核对"该公告的都公告了"
      const judgeCapture = [];
      game.handlers.onJudge = (line) => judgeCapture.push(String(line));
      const res = await game.run();
      const s = game.state;
      const msgs = await store.listGroupMessages(g.id);
      const judge = msgs.filter((m) => m.role === 'system').map((m) => m.content);
      const judgeAll = [...judgeCapture, ...judge];
      const dead = s.players.filter((p) => !p.alive);
      // 按消息顺序重放：跟踪法官公布的出局名单，再核对后面有没有死人发言
      const deadSeats = new Set();
      let spokenAfterDeath = 0;
      for (const m of msgs) {
        if (m.role === 'system') {
          for (const hit of String(m.content || '').matchAll(/(\d{1,2})\s*号\s*\S+?\s*出局/g)) deadSeats.add(Number(hit[1]));
          continue;
        }
        if (m.role === 'assistant' && deadSeats.has(Number((s.players.find((x) => String(x.id) === String(m.speakerId)) || {}).seat))) spokenAfterDeath++;
      }
      return {
        winner: res.winner, over: s.over, days: s.day, reason: res.reason,
        players: s.players.length,
        judgeCount: judgeAll.length,
        storedJudgeCount: judge.length,
        judgeCaptureCount: judgeCapture.length,
        judgeHead: judgeCapture.slice(0, 2),
        judgeTail: judgeCapture.slice(-2),
        hasStart: judgeAll.some((t) => /狼人杀开始/.test(t)),
        hasNight: judgeAll.some((t) => /天黑请闭眼/.test(t)),
        hasDawn: judgeAll.some((t) => /天亮了/.test(t)),
        hasEnd: judgeAll.some((t) => /本局狼人杀结束|游戏结束/.test(t)),
        hasReveal: judgeAll.some((t) => /身份公开/.test(t)),
        speechCount: speeches.length,
        aliveCount: s.players.filter((p) => p.alive).length,
        deadCount: dead.length,
        deadWithReason: dead.every((p) => !!p.deadReason),
        spokenAfterDeath: spokenAfterDeath,
        messages: msgs.length,
        leaked: msgs.some((m) => /私密身份|你的狼同伴/.test(m.content)),
        calls: null,
      };
    })()`);
    assert(r.over === true, '一局应当自动结束');
    assert(r.winner === 'wolf' || r.winner === 'good', `胜负应为 wolf/good，实际 ${r.winner}`);
    assert(
      r.hasStart && r.hasNight && r.hasDawn,
      `法官应当公告开局/天黑/天亮（引擎回调 ${r.judgeCaptureCount} 条 / 落库 ${r.storedJudgeCount} 条；开头 ${JSON.stringify(r.judgeHead)}）`
    );
    assert(r.hasEnd && r.hasReveal, '结束时应当公告胜利方并公开身份');
    assert(r.speechCount > 0, '应当有人发言');
    assert(r.deadCount > 0, '应当有人出局');
    assert(r.deadWithReason, '每个出局者都要有出局原因');
    assert(r.spokenAfterDeath === 0, `出局者不应再发言，实际有 ${r.spokenAfterDeath} 条`);
    assert(!r.leaked, '私密身份不能写进群聊记录');
    assert(r.aliveCount > 0, '结束时应当还有人活着');
    return `${r.players} 人 / 打了 ${r.days} 天 / ${r.winner === 'wolf' ? '狼人' : '好人'}胜，法官公告 ${r.judgeCount} 条、发言 ${r.speechCount} 条、出局 ${r.deadCount} 人`;
  });

  /* ---------------- B. 私密信息不泄露 ---------------- */
  await check('B. 每个角色只拿到自己的身份（互相看不到别人的身份）', async () => {
    const seenRes = await fetch(`http://127.0.0.1:${MOCK_PORT}/seen`).then((r) => r.json());
    const list = seenRes.seen || [];
    const withRole = list.filter((x) => /你的私密身份/.test(x.sys) || /你是「/.test(x.sys));
    assert(withRole.length > 0, '假模型应当收到带有身份信息的提示词');
    // 只数"私密身份"那一段里的身份声明：每份提示词里必须**恰好一个**身份
    let multi = 0;
    let missing = 0;
    const rolesSeen = new Set();
    const declared = new Set();
    for (const x of withRole) {
      const block = String(x.sys).split('【狼人杀 · 你的私密身份')[1] || '';
      const m = [...block.matchAll(/你是「([^」]+)」，属于/g)].map((y) => y[1]);
      if (m.length > 1) multi++;
      if (m.length === 0) missing++;
      for (const role of m) rolesSeen.add(role);
      const seat = (block.match(/你的座位是\s*(\d{1,2})\s*号/) || [])[1];
      if (seat) declared.add(seat);
    }
    assert(missing === 0, `有 ${missing} 条提示词没写身份（私密身份没注入进去）`);
    assert(multi === 0, `不应有提示词同时声明多个身份（${multi} 条）`);
    assert(rolesSeen.size >= 2, `至少应出现过多种身份，实际 ${[...rolesSeen].join('/')}`);
    assert(!declared.has(7), '"你"（7 号）的身份不应该发给任何模型——它只在界面上给你看');
    // "每位成员都只拿到自己的身份"用确定性方式核对：
    // 第一夜就被刀的人不会有白天发言提示词，所以不能靠"运行时出现过哪些座位"来判断（会看运气挂掉）。
    const perPlayer = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      const g = (await store.listGroups())[0];
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', human: {}, handlers: {} });
      const s = game.state;
      const out = [];
      for (const p of s.players.filter((x) => !x.isUser)) {
        const note = w.privateNoteFor(s, p);
        const roles = [...note.matchAll(/你是「([^」]+)」，属于/g)].map((y) => y[1]);
        const mateMentioned = /你的狼同伴：/.test(note);
        out.push({ seat: p.seat, role: p.role, roles, mateMentioned });
      }
      return { players: s.players.length, rows: out };
    })()`);
    assert(perPlayer.rows.length === 6, `应当有 6 位角色玩家，实际 ${perPlayer.rows.length}`);
    for (const row of perPlayer.rows) {
      assert(row.roles.length === 1, `${row.seat} 号的私密身份应当只声明一个身份，实际 ${JSON.stringify(row.roles)}`);
      assert(row.roles[0] === w2RoleName(row.role), `${row.seat} 号拿到的身份不是自己的（自己=${row.role}，提示里=${row.roles[0]}）`);
      if (row.role === 'wolf') assert(row.mateMentioned, `${row.seat} 号是狼，私密身份里应当有狼同伴信息`);
      else assert(!row.mateMentioned, `${row.seat} 号不是狼，不该看到狼同伴信息`);
    }
    // 狼同伴只出现在狼自己的提示词里
    const mateLines = list.filter((x) => /你的狼同伴：/.test(x.sys));
    const wolfSeats = new Set();
    for (const x of mateLines) {
      const me = (x.sys.match(/你的座位是\s*(\d{1,2})\s*号/) || [])[1];
      if (me) wolfSeats.add(me);
    }
    assert(mateLines.length > 0, '狼人应当拿到"你的狼同伴"这一行');
    assert(wolfSeats.size <= 2, `拿到狼同伴信息的座位数应等于狼数（2），实际 ${wolfSeats.size}`);
    return `带身份提示词 ${withRole.length} 条，身份种类 ${[...rolesSeen].join('/')}，狼同伴信息只发给 ${wolfSeats.size} 位狼`;
  });

  /* ---------------- C. 界面流程 ---------------- */
  await check('C1. 群资料里的「狼人杀」入口 + 开局面板', async () => {
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r) => setTimeout(r, 1000));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} });
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const clicked = await page.eval(`(() => {
      const b = [...document.querySelectorAll('.pane-right .btn')].find((x) => /狼人杀/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(clicked, '右栏找不到「狼人杀」按钮');
    const dialog = await waitFor(
      async () => {
        const t = await page.eval(`(() => { const m = document.querySelector('.modal-body'); return m ? m.innerText : ''; })()`);
        return /本局板子/.test(t) ? t : null;
      },
      { label: '开局面板', timeout: 8000 }
    );
    assert(/参与人数/.test(dialog) && /7 人/.test(dialog), `应显示人数：${dialog.slice(0, 80)}`);
    assert(/2 狼/.test(dialog) && /预言家/.test(dialog), `应显示板子配置：${dialog.slice(0, 120)}`);
    assert(/快速模式/.test(dialog), '应当有快速模式选项');
    return dialog.split('\n').filter((l) => /参与人数|本局板子/.test(l)).join(' / ');
  });

  await check('C2. 游戏在聊天页里进行：圆桌条出现 HUD（你的身份 + 存活数），面板只管开局', async () => {
    const started = await page.eval(`(() => {
      const btns = [...document.querySelectorAll('.modal-foot button')];
      const b = btns.find((x) => /开始游戏/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(started, '找不到「开始游戏」按钮');
    // 法官公告与 HUD 都应当出现在聊天页
    const judge = await waitFor(
      async () => {
        const t = await page.eval(`(() => [...document.querySelectorAll('.gchat-body .msg.sys')].map((n) => n.innerText).join('\\n'))()`);
        return /狼人杀开始/.test(t) ? t : null;
      },
      { label: '法官开局公告（聊天页）', timeout: 30000 }
    );
    assert(/屠边/.test(judge), '法官公告里应当说明屠边规则');
    const hud = await waitFor(
      async () => {
        const t = await page.eval(`(() => { const n = document.querySelector('.gchat-roundbar .ww-hud'); return n && n.offsetParent ? n.innerText : ''; })()`);
        return /你是\s*\d+\s*号/.test(t) ? t : null;
      },
      { label: '聊天页 HUD', timeout: 30000 }
    );
    assert(/存活\s*\d+\s*\/\s*\d+\s*人/.test(hud), `HUD 应显示存活人数：${hud}`);
    assert(!/(狼|神|民)\s*\d/.test(hud), `HUD 不该显示阵营分布：${hud}`);
    assert(/暂停|结束/.test(hud), `HUD 上应当有暂停/结束：${hud}`);
    // 面板不是必须的：把弹层关掉，游戏照常在聊天页推进
    await page.eval(`document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); })`);
    await sleep(1600);
    const after = await page.eval(`(() => [...document.querySelectorAll('.gchat-body .msg.sys')].map((n) => n.innerText).join('\\n'))()`);
    assert(after.length >= judge.length, '关掉面板后法官公告仍应继续出现在聊天页');
    return `HUD「${hud.replace(/\n/g, ' ')}」；法官公告在聊天页里（${judge.split('\n').length} 条）`;
  });

  // 位置说明：放在 C2（已经有一局在跑、聊天页也开着）之后。
  // 这条**不依赖那一局的推进节奏**：它自己造一个引擎实例，让 AI 真的说一句，
  // 走的是同一条链路（引擎 → onSpeechLive → speechLiveEvent → bus → 聊天页的临时气泡）。
  await check('V. 狼人杀的发言一句句长出来 + 新消息增量插入（不再整块重绘、屏幕不跳）', async () => {
    // 让假模型"一次吐两个字"：否则它一个 tick 就把整句写完，界面等于一步到位，观察不到"在长"
    await fetch(`http://127.0.0.1:${MOCK_PORT}/slowstream`);
    try {
      // ①+② 一个 eval 里跑完整条链路：切到对局群 → 装观察器 → 真引擎说一句。
      // 全放在同一个 eval 里，为了钉死"观察器装的群 == 引擎发言的群"：
      // 分两次 eval 时，中间应用若换了群，观察器就白装了（上一版就是这么超时的）。
      // handlers.onSpeechLive 接的是 **ui/werewolf.js 自己的转换函数**，
      // 所以这一条覆盖的是真链路：引擎 → onSpeechLive → speechLiveEvent → bus → 聊天页。
      const run = await page.eval(`(async () => {
        const store = await import('./core/store.js');
        const core = await import('./core/werewolf.js');
        const wu = await import('./ui/werewolf.js');
        const { bus } = await import('./core/bus.js');
        const g = (await store.listGroups())[0];
        await window.__AICHAT__.openGroup(g.id);
        await new Promise((r2) => setTimeout(r2, 1200));
        document.querySelectorAll('.modal-mask, .onboard').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
        const body = document.querySelector('.gchat-body');
        if (!body) return { error: '聊天页列表不在' };

        // 观察三件事：
        //   ① 整块重绘 = 同一批里移掉≥2 条老气泡（renderMessages 的 clear(listEl) 逐个删子节点）——
        //      那正是用户看到的"屏幕跳一下"（所有气泡重播 msgIn 动画 + 滚动被顶回去）；
        //      阈值取 2 是因为增量插入最多只移掉 1 条（那条正在说话的临时气泡）；
        //   ② 临时气泡里文字的变化序列 —— 用来证明"一句句长出来"；
        //   ③ 气泡被真消息替换的瞬间 —— 用来证明气泡里最后显示的字与落库那条一致。
        const st = { rebuilds: 0, samples: [], added: 0, grow: [], land: [], preview: '', seq: 0, cur: null };
        const isMsg = (n) => n.nodeType === 1 && n.classList && n.classList.contains('msg');
        const noteStream = () => {
          const node = document.querySelector('.msg-streaming');
          if (!node) return;
          // 每条临时气泡给一个序号：同一个人可能说好几轮，光靠名字分不清是不是同一个气泡
          if (node !== st.cur) {
            st.cur = node;
            st.seq += 1;
          }
          const text = String((node.querySelector('.bubble-text') || {}).textContent || '');
          const name = String(((node.querySelector('.gmsg-name b') || {}).textContent) || '');
          const last = st.grow[st.grow.length - 1];
          if (text === st.preview && last && last.seq === st.seq) return;
          st.preview = text;
          st.name = name;
          st.grow.push({ text, name, seq: st.seq });
        };
        const obs = new MutationObserver((muts) => {
          // 必须按**批**统计：clear() 是一个一个 removeChild 的，
          // 按单条记录看永远只有 1 个 removedNode（上一版就是这么冤枉了整块重绘的）
          let removedMsgs = 0;
          let streamGone = false;
          const addedMsgs = [];
          for (const m of muts) {
            for (const n of m.removedNodes) {
              if (isMsg(n)) removedMsgs += 1;
              if (n.nodeType === 1 && n.classList && n.classList.contains('msg-streaming')) streamGone = true;
            }
            for (const n of m.addedNodes) if (isMsg(n)) addedMsgs.push(n);
          }
          if (removedMsgs >= 2) {
            st.rebuilds += 1;
            if (st.samples.length < 3) st.samples.push({ removed: removedMsgs, added: addedMsgs.length });
          }
          if (streamGone) {
            const real = addedMsgs.filter((n) => !n.classList.contains('msg-streaming'));
            if (real.length === 1) {
              st.land.push({ name: st.name, seq: st.seq, preview: st.preview, landed: String((real[0].querySelector('.bubble-text') || {}).textContent || '') });
            }
          }
          st.added += addedMsgs.length;
          noteStream();
        });
        obs.observe(body, { childList: true, subtree: true, characterData: true });
        window.__wwProbe = { snapshot: () => ({ rebuilds: st.rebuilds, samples: st.samples, added: st.added, grow: st.grow, land: st.land }) };

        // 真引擎说一句
        const chars = await store.listCharacters();
        const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
        const live = [];
        /**
         * 极小概率假模型的发言会被"卖同伴"兜底**整句删掉**（删完只剩一张票 = 这一轮没有发言），
         * 此时引擎推 null 把气泡收掉是**正确**行为 —— 但那不是这条用例要测的东西。
         * 关键：重试必须**重新发牌**。同一个 game 的角色分配是固定的，重试只会拿到同样的结果
         * （假模型的猜测目标固定取提示词里第一个不是自己的座位号，撞上同伴就必然被删）。
         */
        let game = null;
        let ai = null;
        let parsed = null;
        let mark = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          game = new core.WerewolfGame({
            group: g, members, settings: store.getSettings(), userName: '我', fastMode: true,
            human: {}, // 真人不在这一局里：askHuman 一律跳过，保证这条用例不依赖座位顺序
            handlers: {
              onSpeechLive: (p, full) => {
                live.push(full === null ? null : String(full));
                const ev = wu.speechLiveEvent(g.id, p, full);
                if (ev) bus.emit('werewolf:speech', ev);
              },
            },
          });
          ai = game.state.players.filter((p) => !p.isUser);
          mark = live.length;
          parsed = await game.speakTurn(ai[0]);
          if (parsed && parsed.speech) break;
        }
        const seg = live.slice(mark);
        const speechPushes = live.length;
        // 投票/夜间是**私密指令**（"投票：3号"），绝不能推进聊天页
        await game.askLLM(ai[1], core.votePromptFor(game.state, ai[1]), 'vote');
        const afterVote = live.length - speechPushes;
        // 收尾：没有发言时要推 null，让界面把气泡收掉
        const cleared = [];
        game.handlers.onSpeechLive = (p, full) => cleared.push(full === null ? 'null' : String(full));
        game.emitSpeechLive(ai[0], null);
        // MutationObserver 是微任务：给一拍，让这一批变更都收进 st 再取快照
        await new Promise((r2) => setTimeout(r2, 400));
        return {
          gid: g.id, speaker: ai[0].name, speakerId: ai[0].id,
          speech: (parsed && parsed.speech) || '',
          liveCount: seg.filter((x) => x !== null).length,
          liveNull: seg.filter((x) => x === null).length,
          lastRaw: seg.filter((x) => x !== null).slice(-1)[0] || '',
          liveAll: seg.map((x) => (x === null ? 'NULL' : x.slice(0, 20))),
          afterVote, cleared,
          dbg: (game.state.debug || []).slice(-4),
          snap: window.__wwProbe.snapshot(),
        };
      })()`);
      assert(!run.error, run.error || '准备失败');
      const snap = run.snap;

      // ③ 引擎侧：增量拿到的是"越来越多的原文"，且没有多余的 null
      assert(run.liveCount >= 4, `引擎应当把发言分成多段推给界面，实际 ${run.liveCount} 段`);
      assert(
        run.liveNull === 0,
        `这句发言的流式过程中不该推 null（那会让气泡提前消失）：null ${run.liveNull} 次 / 共 ${run.liveAll.length} 段｜发言=${JSON.stringify(
          run.speech
        )}｜序列=${JSON.stringify(run.liveAll)}｜引擎 debug=${JSON.stringify(run.dbg)}`
      );
      assert(run.afterVote === 0, `投票这类私密指令不该推进界面，实际推了 ${run.afterVote} 次`);
      assert(JSON.stringify(run.cleared) === '["null"]', `没有发言时要推一次 null 收气泡，实际 ${JSON.stringify(run.cleared)}`);
      assert(run.speech.includes('我先说说我的看法'), `引擎应当把这段发言落库：${JSON.stringify(run.speech)}`);
      assert(
        liveSpeechPreview(run.lastRaw) === run.speech,
        `流式预览的最终形态必须等于落库那条发言：原文 ${JSON.stringify(run.lastRaw)} → 预览 ${JSON.stringify(
          liveSpeechPreview(run.lastRaw)
        )} ≠ 正文 ${JSON.stringify(run.speech)}`
      );

      // ④ 一句句长出来：同一个气泡里的文字被观察到多次变长，且每个中间态都是最终文字的前缀
      const total = snap.grow.reduce((n, g) => Math.max(n, g.seq), 0);
      let best = [];
      for (let seq = 1; seq <= total; seq++) {
        const chain = snap.grow.filter((g) => g.seq === seq).map((g) => g.text);
        if (chain.length > best.length) best = chain;
      }
      assert(
        best.length >= 4,
        `应当观察到发言在同一个气泡里一段段变长，实际每条气泡的段数：${JSON.stringify(
          [...new Set(snap.grow.map((g) => g.seq))].map((seq) => snap.grow.filter((g) => g.seq === seq).length)
        )}`
      );
      const lastText = best[best.length - 1];
      assert(best.every((t) => lastText.startsWith(t)), `气泡里的文字应当只增不改（否则就是"先出现再消失"）：${JSON.stringify(best)}`);

      // ⑤ 气泡里最后显示的字 = 落库那条消息的字（不能"闪一下变成别的"）
      assert(snap.land.length >= 1, '应当观察到临时气泡被真消息替换');
      for (const l of snap.land) {
        assert(l.landed === l.preview, `发言落库后与气泡里显示的不一致：气泡「${l.preview}」≠ 消息「${l.landed}」`);
      }
      assert(
        snap.grow.some((g) => g.name === run.speaker),
        `气泡上应当写着发言人的名字「${run.speaker}」，实际观察到：${JSON.stringify([...new Set(snap.grow.map((g) => g.name))])}`
      );

      // ⑥ 关键回归：这期间新消息是**增量插入**的，没有任何一次整块重绘
      assert(
        snap.rebuilds === 0,
        `狼人杀的消息不该触发整块重绘（否则每条都让所有气泡重播入场动画 = 屏幕跳一下）：${JSON.stringify(snap.samples)}`
      );
      assert(snap.added >= 2, `这期间应当有新消息进列表（临时气泡 + 真消息），实际 +${snap.added}`);

      // ⑦ 中断/换人要能收掉气泡（游戏被结束、切群时不会有消息落库，不能留半句话挂在聊天页上）
      const off = await page.eval(`(async () => {
        const { bus } = await import('./core/bus.js');
        const gid = ${JSON.stringify(run.gid)};
        const seen = () => { const n = document.querySelector('.msg-streaming'); return n ? String((n.querySelector('.bubble-text') || {}).textContent || '') : null; };
        bus.emit('werewolf:speech', { groupId: gid, playerId: 'x', name: '测试角色', text: '半句话' });
        const shown = seen();
        // 别的群的事件不该画到这个群的聊天页上
        bus.emit('werewolf:speech', { groupId: 'another-group', playerId: 'y', name: '别群角色', text: '不该出现' });
        const leaked = seen();
        bus.emit('werewolf:speech', { groupId: gid, off: true });
        return { shown, leaked, after: seen() };
      })()`);
      assert(off.shown === '半句话', `应当能直接在聊天页上长出临时气泡，实际 ${JSON.stringify(off.shown)}`);
      assert(off.leaked === '半句话', `别的群的事件不该动这个群的气泡，实际 ${JSON.stringify(off.leaked)}`);
      assert(off.after === null, `off 应当收掉气泡，实际还留着 ${JSON.stringify(off.after)}`);

      return `发言逐段增长 ${best.length} 次（${run.speaker}，共 ${run.liveCount} 段增量），气泡与落库文本一致，${snap.added} 条增量插入、整块重绘 0 次`;
    } finally {
      // 慢速流只给这条用例用：**无论成败都要关掉**，否则后面每条用例都会被拖慢
      await fetch(`http://127.0.0.1:${MOCK_PORT}/slowstream?off=1`);
    }
  });

  await check('C3. 狼人杀进行中：普通"让他们聊"被拦住，不会两套流程抢话', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const before = (await store.listGroupMessages(g.id)).filter((m) => m.role === 'assistant').length;
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} });
      await new Promise((r2) => setTimeout(r2, 300));
      const b = [...document.querySelectorAll('.pane-right .btn')].find((x) => /让他们聊/.test(x.textContent));
      if (b) b.click();
      await new Promise((r2) => setTimeout(r2, 1500));
      const after = (await store.listGroupMessages(g.id)).filter((m) => m.role === 'assistant').length;
      const toastText = [...document.querySelectorAll('.toast')].map((n) => n.innerText).join(' | ');
      return { before, after, toastText, busy: window.__AICHAT__.groupBusy() };
    })()`);
    assert(/狼人杀还在进行中/.test(r.toastText), `应当提示狼人杀进行中：${r.toastText.slice(0, 60)}`);
    assert(r.busy === false, '普通群聊轮次不应该被启动');
    return `拦住了普通轮次（角色发言数 ${r.before} → ${r.after} 未因点击增加）`;
  });

  await check('C4. 结束游戏 → 自动退出狼人杀模式、存档被清掉', async () => {
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      // 确保有一局在跑：没有就现开一局
      let before = w.isActive(g.id);
      if (!before) {
        const chars = await store.listCharacters();
        const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
        const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human: {}, handlers: {} });
        w.saveGame(game.state);
        before = w.isActive(g.id);
      }
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} });
      await new Promise((r2) => setTimeout(r2, 300));
      // 面板按钮走的就是这个函数（ui/werewolf.js 的「结束游戏」）
      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 900));
      const toastText = [...document.querySelectorAll('.toast')].map((n) => n.innerText).join(' | ');
      return { before, after: w.isActive(g.id), saved: !!w.loadGame(g.id), toastText, panelOpen: !!document.querySelector('.ww-panel') };
    })()`);
    assert(r.before === true, '结束前应当处于狼人杀模式');
    assert(r.after === false && r.saved === false, `结束后模式应当退出、存档应当清掉（after=${r.after} saved=${r.saved}）`);
    assert(/狼人杀已结束/.test(r.toastText), `应当提示已结束：${r.toastText.slice(0, 60)}`);
    assert(r.panelOpen === false, '结束后面板应当关闭');
    return '结束后 isActive=false、存档已清除、面板关闭（群聊恢复普通模式）';
  });

  await check('E. 特殊规则：女巫不能自救 / 被毒不能开枪 / 白痴翻牌免死', async () => {
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const mk = () => new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: false, human: {}, handlers: {} });
${PAGE_ASSIGN}
      const villagersOf = (game) => game.state.players.filter((p) => p.role === 'villager').map((p) => p.seat);

      /* --- E1：女巫被刀时不能自救 --- */
      const g1 = mk();
      const a1 = assignToAI(w, g1, { witch: 1, wolf: 2, seer: 1 });
      const witch1 = a1.witch[0];
      const prompts1 = [];
      g1.askLLM = async (p, prompt) => {
        prompts1.push(prompt);
        if (/刀杀：/.test(prompt)) return '刀杀：' + witch1 + '号';      // 狼刀女巫
        if (/从下面这些里选一种/.test(prompt)) return '解药：救';    // 女巫想自救（应被拒）
        if (/查验：/.test(prompt)) return '查验：' + villagersOf(g1)[0] + '号';
        return '';
      };
      g1.state.phase = 'night';
      await g1.phaseNight();
      await g1.phaseDawn();
      const witchRow = { savedSeat: g1.state.night.savedSeat, antidote: g1.state.witch.antidote, dead: !w.bySeat(g1.state, witch1).alive };

      /* --- E2：猎人被毒死不能开枪 --- */
      const g2 = mk();
      const a2 = assignToAI(w, g2, { witch: 1, wolf: 2, hunter: 1 });
      const hunter2 = a2.hunter[0];
      const prompts2 = [];
      g2.askLLM = async (p, prompt) => {
        prompts2.push(prompt);
        if (/刀杀：/.test(prompt)) return '刀杀：' + villagersOf(g2)[0] + '号';   // 狼刀一个无关村民
        if (/从下面这些里选一种/.test(prompt)) return '毒药：' + hunter2 + '号';  // 女巫毒猎人
        if (/开枪：/.test(prompt)) return '开枪：' + a2.witch[0] + '号';
        return '';
      };
      g2.state.phase = 'night';
      await g2.phaseNight();
      await g2.phaseDawn();
      const hunterRow = { dead: !w.bySeat(g2.state, hunter2).alive, askedToShoot: prompts2.some((t) => /开枪：/.test(t)), deadReason: w.bySeat(g2.state, hunter2).deadReason };

      /* --- E3：白痴被票出翻牌免死、失去投票权 --- */
      const g3 = mk();
      const a3 = assignToAI(w, g3, { wolf: 2, idiot: 1, seer: 1 });
      const idiot3 = a3.idiot[0];
      g3.askLLM = async (p, prompt) => (/投票：/.test(prompt) ? '投票：' + idiot3 + '号' : '');
      g3.askHuman = async (kind) => (kind === 'vote' ? { seat: idiot3 } : null);
      g3.state.day = 1;
      g3.state.phase = 'vote';
      await g3.phaseVote();
      const idiot = w.bySeat(g3.state, idiot3);

      return {
        witch: witchRow,
        hunter: hunterRow,
        idiot: { alive: idiot.alive, revealed: idiot.revealedIdiot, canVote: idiot.canVote },
        judgeHasIdiot: (g3.state.log || []).some((l) => /白痴/.test(l)),
      };
    })()`);
    assert(r.witch.savedSeat === undefined, `女巫不能自救，但记下了 savedSeat=${r.witch.savedSeat}`);
    assert(r.witch.antidote === true, '解药不应该被消耗掉');
    assert(r.witch.dead === true, '被刀的女巫应当出局');
    assert(r.hunter.dead === true && r.hunter.deadReason === '女巫毒杀', `猎人应死于毒杀，实际 ${r.hunter.deadReason}`);
    assert(r.hunter.askedToShoot === false, '被毒死的猎人不应该被问要不要开枪');
    assert(r.idiot.alive === true && r.idiot.revealed === true && r.idiot.canVote === false, `白痴应翻牌免死并失去投票权，实际 ${JSON.stringify(r.idiot)}`);
    assert(r.judgeHasIdiot, '法官应公告白痴翻牌');
    return '女巫不能自救（药未消耗、人出局）／猎人被毒不触发开枪／白痴翻牌免死且失去投票权';
  });

  await check('F. 5 位群成员 + 你 = 6 人局也能开局（门槛按玩家总数算）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const w = await import('./core/werewolf.js');
      const chars = await store.listCharacters();
      const members = chars.slice(0, 5);
      const g = await store.saveGroup({ name: '五人小群', members: members.map((c) => c.id), autoDelayMs: 0 });
      await new Promise((r2) => setTimeout(r2, 500));
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 1200));
      document.querySelectorAll('.onboard, .modal-mask').forEach((n) => n.remove());
      // 引擎层：6 名玩家（5 成员 + 你）必须能建局
      let engineOk = true;
      let engineErr = '';
      let dealt = null;
      try {
        const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', human: {}, handlers: {} });
        dealt = { players: game.state.players.length, board: game.state.board };
      } catch (e) {
        engineOk = false;
        engineErr = String((e && e.message) || e);
      }
      // 界面层：面板不该说"人数不满足"，并且能真的开始
      const btn = [...document.querySelectorAll('.pane-right .btn')].find((x) => /狼人杀/.test(x.textContent));
      if (btn) btn.click();
      await new Promise((r2) => setTimeout(r2, 800));
      const text = (document.querySelector('.modal-body') || {}).innerText || '';
      let started = false;
      if (!/人数不满足/.test(text)) {
        const b = [...document.querySelectorAll('.modal-foot button')].find((x) => /开始游戏/.test(x.textContent));
        if (b) {
          b.click();
          started = true;
        }
      }
      await new Promise((r2) => setTimeout(r2, 1600));
      const judge = [...document.querySelectorAll('.gchat-body .msg.sys')].map((n) => n.innerText).join('\\n');
      const active = w.isActive(g.id);
      // 收拾：结束这一局并删掉临时群，别影响别的检查
      const ww = await import('./ui/werewolf.js');
      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 600));
      await store.deleteGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 400));
      return { engineOk, engineErr, dealt, text, started, hasJudge: /狼人杀开始/.test(judge), active, groupGone: !(await store.getGroup(g.id)) };
    })()`);
    assert(r.engineOk, `引擎不该拒绝 6 人局：${r.engineErr}`);
    assert(r.dealt && r.dealt.players === 6, `应当有 6 名玩家，实际 ${r.dealt && r.dealt.players}`);
    assert(r.dealt.board.wolf === 2 && r.dealt.board.villager === 2 && r.dealt.board.gods.join() === 'seer,witch', `6 人板子应为 2狼+2民+预女，实际 ${JSON.stringify(r.dealt.board)}`);
    assert(!/人数不满足/.test(r.text), `面板不该提示人数不够：${r.text.replace(/\n/g, ' ').slice(0, 120)}`);
    assert(/6 人/.test(r.text), `面板应显示 6 人：${r.text.replace(/\n/g, ' ').slice(0, 120)}`);
    assert(r.started, '面板里应当能点到「开始游戏」');
    assert(r.hasJudge && r.active, '应当真的开局（有法官公告且处于狼人杀模式）');
    assert(r.groupGone, '临时群应当清理干净');
    return '5 位群成员 + 你 = 6 人局：引擎建局成功、面板不拦、法官公告已发出（2 狼 2 民 预女）';
  });

  await check('G. 模型返回空内容时：自检拦住 + 引擎给出可见告警（不再静默不发言）', async () => {
    await fetch(`http://127.0.0.1:${MOCK_PORT}/empty`);
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const settings = store.getSettings();
      const probe = await w.preflight(settings);
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const warns = [];
      const game = new w.WerewolfGame({ group: g, members, settings, userName: '我', human: {}, handlers: { onWarn: (t) => warns.push(t) } });
      const speaker = game.state.players.find((p) => !p.isUser);
      const text = await game.askLLM(speaker, '【狼人杀 · 第 1 天 · 白天发言】你是 1 号，请发言。', 'day');
      const res = { probeOk: probe.ok, probeErr: probe.error, text, warns, warnings: game.state.warnings || [] };
      w.clearGame(g.id); // 别把这一局留在存档里
      return res;
    })()`);
    assert(r.probeOk === false, '模型返回空内容时，开局自检必须失败');
    assert(/空内容|失败/.test(r.probeErr), `自检要说明原因，实际：${r.probeErr}`);
    assert(r.text === '', `空内容时应当返回空串交给上层处理，实际 ${JSON.stringify(r.text)}`);
    assert(r.warns.length >= 1 && /空内容|调用失败/.test(r.warns[0]), `必须触发可见告警，实际 ${JSON.stringify(r.warns)}`);
    assert(r.warnings.length >= 1, '状态里也要留下告警记录（面板能看到）');
    await fetch(`http://127.0.0.1:${MOCK_PORT}/full`);
    return `自检失败：${r.probeErr.slice(0, 34)}…；引擎告警：${r.warns[0].slice(0, 30)}…`;
  });

  await check('H. 不泄露隐藏信息：HUD 只显示存活人数，群里不出现死因', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      await store.clearGroupMessages(g.id);
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 1000));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} });
      await new Promise((r2) => setTimeout(r2, 300));
      const btn = [...document.querySelectorAll('.pane-right .btn')].find((x) => /狼人杀/.test(x.textContent));
      if (btn) btn.click();
      await new Promise((r2) => setTimeout(r2, 800));
      const start = [...document.querySelectorAll('.modal-foot button')].find((x) => /开始游戏/.test(x.textContent));
      if (start) start.click();
      // 等到第一夜结束（有人出局）再检查
      let hud = '';
      let judge = '';
      for (let i = 0; i < 300; i++) {
        await new Promise((r2) => setTimeout(r2, 120));
        const hudEl = document.querySelector('.gchat-roundbar .ww-hud');
        hud = hudEl && hudEl.offsetParent ? hudEl.innerText : '';
        judge = [...document.querySelectorAll('.gchat-body .msg.sys')].map((n) => n.innerText).join(' ｜ ');
        if (/天亮了/.test(judge) && /(不公布死因|平安夜)/.test(judge)) break;
        // 轮到"你"时顺手答一下：否则游戏会一直等你，这一项就永远等不到天亮
        const bar = document.querySelector('.chat-foot .ww-actionbar');
        if (!bar || !bar.offsetParent) continue;
        const t = bar.innerText.replace(/\s+/g, ' ');
        if (/发言|遗言/.test(t)) {
          const ta = document.querySelector('.composer-input');
          ta.value = '（推进用发言）我先听听大家怎么说。';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r2) => setTimeout(r2, 60));
          document.querySelector('#groupSendBtn').click();
        } else {
          const btns = [...bar.querySelectorAll('button')].filter((x) => x.offsetParent && !/跳过|放弃|弃票/.test(x.textContent));
          if (btns.length) btns[0].click();
        }
        await new Promise((r2) => setTimeout(r2, 400));
      }
      const msgs = await store.listGroupMessages(g.id);
      const text = msgs.map((m) => String(m.content || '')).join('\\n');
      // 故意不结束这一局：紧接着的 I 用例会复用它，省一次完整对局的时间
      void ww;
      return {
        hud,
        judge,
        causeInMessages: /(女巫毒杀|狼人刀杀|被投票放逐)/.test(text),
        noCauseNote: /不公布死因/.test(judge),
        privateLeak: /私密身份|你的狼同伴/.test(text),
      };
    })()`);
    assert(/存活\s*\d+\s*\/\s*\d+\s*人/.test(r.hud), `HUD 应只显示存活人数，实际：${JSON.stringify(r.hud)}`);
    assert(!/(狼|神|民)\s*\d/.test(r.hud), `HUD 不该出现阵营存活数：${JSON.stringify(r.hud)}`);
    assert(!r.causeInMessages, '群聊记录里不该出现死因（法官不公布死因）');
    // 有死者时必须写"不公布死因"；平安夜则本来就没有这句话
    assert(r.noCauseNote || /平安夜/.test(r.judge), `公布死讯时应写明"不公布死因"（或确实是平安夜）：${String(r.judge).slice(-80)}`);
    assert(!r.privateLeak, '私密身份不能进群聊记录');
    return `HUD「${r.hud.replace(/\n/g, ' ')}」；群聊记录无死因、无身份泄露`;
  });

  await check('I. 轮到你时：输入框上方出现操作条，发言直接在聊天输入框发送', async () => {
    const started = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const core = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      // 先把可能残留的一局停掉，保证从干净状态开一局（否则可能复用一个已经打完的局）
      if (core.isActive(g.id)) ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 600));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 900));
      const btn = [...document.querySelectorAll('.pane-right .btn')].find((x) => /狼人杀/.test(x.textContent));
      if (btn) btn.click();
      await new Promise((r2) => setTimeout(r2, 700));
      const start = [...document.querySelectorAll('.modal-foot button')].find((x) => /开始游戏/.test(x.textContent));
      if (!start) return { err: '开局面板里没有「开始游戏」按钮' };
      start.click();
      await new Promise((r2) => setTimeout(r2, 1500));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      return { ok: true, active: core.isActive(g.id) };
    })()`);
    assert(!started.err, started.err || '');
    assert(started.active, '应当已经开出一局狼人杀');

    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const core = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      const bar = () => document.querySelector('.chat-foot .ww-actionbar');
      const barText = () => { const b = bar(); return b && b.offsetParent ? b.innerText.replace(/\s+/g, ' ').trim() : ''; };
      let clicked = 0;
      let spoke = '';
      let sawAction = '';
      let seenHud = '';
      let voteBarSeen = '';
      let voteBadges = 0;
      let hudDuringVote = '';
      let voted = 0;
      let voteTarget = '';
      let firstBarKind = '';
      let firstBarBadges = 0;
      let hudAtFirst = '';
      for (let i = 0; i < 400; i++) {
        await new Promise((r2) => setTimeout(r2, 120));
        const hudEl = document.querySelector('.gchat-roundbar .ww-hud');
        if (hudEl && hudEl.offsetParent) seenHud = hudEl.innerText.replace(/\s+/g, ' ');
        const t = barText();
        if (!t) continue;
        if (!sawAction) {
          sawAction = t;
          // 第一步是什么步骤，就顺便把"票数角标"的规则验一下
          firstBarKind = /投票放逐/.test(t) ? 'vote' : /发言|遗言/.test(t) ? 'speech' : 'skill';
          firstBarBadges = bar().querySelectorAll('.ww-ab-votes').length;
          hudAtFirst = (document.querySelector('.gchat-roundbar .ww-hud') || {}).innerText || '';
        }
        if (/发言|遗言/.test(t) && !/投票放逐/.test(t)) {
          const ta = document.querySelector('.composer-input');
          ta.value = '（测试发言）我先听听大家的。';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r2) => setTimeout(r2, 80));
          document.querySelector('#groupSendBtn').click();
          spoke = '（测试发言）我先听听大家的。';
          await new Promise((r2) => setTimeout(r2, 1200));
          continue; // 发完言紧接着会出现"投票"按钮，继续等
        }
        if (/投票放逐/.test(t)) {
          voteBarSeen = t;
          // 盲投：投票期间条上/按钮上/HUD 里都不该出现任何票数（票数要等本轮结算后才公布）
          voteBadges = bar().querySelectorAll('.ww-ab-votes').length;
          const h = document.querySelector('.gchat-roundbar .ww-hud');
          hudDuringVote = h ? h.innerText.replace(/\s+/g, ' ').trim() : '';
          const btns = [...bar().querySelectorAll('button')].filter((x) => x.offsetParent && /投票放逐/.test(t) && !/跳过|放弃|弃票/.test(x.textContent));
          if (btns.length) {
            voteTarget = btns[0].textContent.replace(/\s+/g, ' ').trim();
            btns[0].click();
            voted++;
            await new Promise((r2) => setTimeout(r2, 900));
            break;
          }
        }
        const btns2 = [...bar().querySelectorAll('button')].filter((x) => x.offsetParent && !/跳过|放弃|弃票/.test(x.textContent));
        if (btns2.length) {
          btns2[0].click();
          clicked++;
          await new Promise((r2) => setTimeout(r2, 900));
        }
      }
      const msgs = await store.listGroupMessages(g.id);
      const mine = msgs.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
      const judge = [...document.querySelectorAll('.gchat-body .msg.sys')].map((n) => n.innerText).join(' ｜ ');
      const saved = core.loadGame(g.id);
      const myVote = saved && Array.isArray(saved.lastBallots)
        ? saved.lastBallots.find((b) => b.voterSeat === (saved.players.find((p) => p.isUser) || {}).seat)
        : null;
      const hudVotes = (document.querySelector('.gchat-roundbar .ww-hud-votes') || {}).innerText || '';
      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 700));
      return { sawAction, clicked, spoke, mine, seenHud, voteBarSeen, voteBadges, hudDuringVote, voted, voteTarget, myVote, hudVotes, firstBarKind, firstBarBadges, hudAtFirst, judgeTail: judge.slice(-70), barHidden: !bar() || !bar().offsetParent };
    })()`);
    assert(
      r.sawAction,
      `轮到你时输入框上方应当出现操作条。诊断：HUD=${JSON.stringify(r.seenHud)} 法官最近=${JSON.stringify(r.judgeTail)}`
    );
    assert(r.clicked > 0 || r.voted > 0 || r.spoke, `应当能通过聊天页完成操作（按钮 ${r.clicked} / 投票 ${r.voted} / 发言 ${r.spoke ? '有' : '无'}）`);
    if (r.spoke) assert(r.mine.includes(r.spoke), `你的发言应当作为群消息出现，实际：${JSON.stringify(r.mine.slice(-3))}`);
    // 你可能在这一局里早早就出局了（那一步是"遗言"而不是投票），所以投票相关的断言只在真出现投票条时执行
    if (r.voteBarSeen) {
      // 盲投：投票期间一个票数都不能出现（本轮结算后才由法官公告 / HUD 公布）
      assert(!/票数/.test(r.voteBarSeen), `投票条上不该出现票数，实际：${JSON.stringify(r.voteBarSeen)}`);
      assert(!/\d+\s*票/.test(r.voteBarSeen), `投票条上不该出现任何票数，实际：${JSON.stringify(r.voteBarSeen)}`);
      assert(/投票中/.test(r.voteBarSeen), `投票条要写明结果稍后公布，实际：${JSON.stringify(r.voteBarSeen)}`);
      assert(r.voteBadges === 0, `投票按钮上不该挂票数角标，实际 ${r.voteBadges} 个`);
      assert(!/投票结果/.test(r.hudDuringVote) && !/\d+\s*票/.test(r.hudDuringVote), `投票期间 HUD 不该出现票数，实际：${JSON.stringify(r.hudDuringVote)}`);
      assert(/投票中/.test(r.hudDuringVote), `投票期间 HUD 应当写"投票中"，实际：${JSON.stringify(r.hudDuringVote)}`);
      assert(r.voted > 0, `投票条出现时应当能点到按钮：${JSON.stringify(r.voteBarSeen.slice(0, 40))}`);
      assert(r.myVote && r.myVote.seat, `点下的那一票要被引擎记上（lastBallots=${JSON.stringify(r.myVote)}）`);
    } else {
      assert(/遗言|发言/.test(r.sawAction), `这一局没轮到投票（你提前出局了），那至少应当轮到过发言/遗言：${JSON.stringify(r.sawAction)}`);
    }
    // 夜间技能选择（刀人/查验/用药/开枪）绝不能带票数角标，HUD 夜里也不该显示票数
    if (r.firstBarKind === 'skill') {
      assert(r.firstBarBadges === 0, `技能选择按钮上不该出现票数角标，实际 ${r.firstBarBadges} 个`);
      assert(!/票数/.test(r.hudAtFirst), `夜里 HUD 不该显示票数，实际：${JSON.stringify(r.hudAtFirst)}`);
    }
    assert(r.barHidden, '对局结束后操作条应当收起');
    return r.voteBarSeen
      ? `操作条「${r.sawAction.slice(0, 26)}…」；投票条「${r.voteBarSeen.slice(0, 40)}…」；点了「${r.voteTarget}」→ 引擎记录 ${JSON.stringify(r.myVote)}`
      : `这一局你提前出局，轮到的是「${r.sawAction.slice(0, 24)}…」（投票点击路径由 N 用例确定性覆盖）`;
  });

  await check('J. 面板关掉之后还能再打开（关闭一次就失效的回归）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const core = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 900));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      await new Promise((r2) => setTimeout(r2, 300));

      const openByButton = async () => {
        const b = [...document.querySelectorAll('.pane-right .btn')].find((x) => /狼人杀/.test(x.textContent));
        if (!b) return false;
        b.click();
        await new Promise((r2) => setTimeout(r2, 700));
        return true;
      };
      const visibleModal = () => {
        const m = [...document.querySelectorAll('.modal-mask')].find((n) => n.isConnected && n.querySelector('.modal'));
        return m ? (m.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : '';
      };
      const closeModal = () => {
        // 点底部的"关闭"按钮（最常见的关闭方式）
        const btn = [...document.querySelectorAll('.modal-foot button')].find((x) => /关闭/.test(x.textContent));
        if (btn) btn.click();
        else document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} });
      };

      const out = { steps: [] };

      /* 1) 开局面板：关一次 → 再开 */
      if (!core.isActive(g.id)) {
        await openByButton();
        out.steps.push({ at: 'start#1', opened: !!visibleModal(), text: visibleModal() });
        closeModal();
        await new Promise((r2) => setTimeout(r2, 400));
        await openByButton();
        out.steps.push({ at: 'start#2', opened: !!visibleModal(), text: visibleModal() });
        closeModal();
        await new Promise((r2) => setTimeout(r2, 400));
      }

      /* 2) 真正开局 → 关闭面板 → 再打开（用户报的就是这一步） */
      if (!core.isActive(g.id)) {
        await openByButton();
        const start = [...document.querySelectorAll('.modal-foot button')].find((x) => /开始游戏/.test(x.textContent));
        if (start) start.click();
        await new Promise((r2) => setTimeout(r2, 1500));
      }
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      await new Promise((r2) => setTimeout(r2, 400));

      await openByButton();
      out.steps.push({ at: 'run#1', opened: !!visibleModal(), text: visibleModal() });
      closeModal();
      await new Promise((r2) => setTimeout(r2, 500));
      const closedAfterFirst = !visibleModal();
      await openByButton();
      out.steps.push({ at: 'run#2', opened: !!visibleModal(), text: visibleModal() });
      const reopenedText = visibleModal();

      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 600));
      return { ...out, closedAfterFirst, reopenedText, activeAfterStop: core.isActive(g.id) };
    })()`);
    for (const st of r.steps) {
      assert(st.opened, `第 ${st.at} 次打开面板没出现：${JSON.stringify(st)}`);
    }
    assert(r.closedAfterFirst, '第一次点击关闭后，面板应当真的消失');
    assert(/进行中|当前进度|狼人杀/.test(r.reopenedText), `第二次打开应当看到面板内容，实际：${JSON.stringify(r.reopenedText)}`);
    assert(r.activeAfterStop === false, '收尾时应当把模式停掉');
    return r.steps.map((x) => `${x.at}:${x.opened ? '可见' : '不可见'}`).join(' → ') + `；关一次后仍能重开：「${r.reopenedText.slice(0, 30)}…」`;
  });

  await check('L. 角色知道规则：规则速查卡进提示词，且场规随板子变化', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const w = await import('./core/werewolf.js');
      const g = (await store.listGroups())[0];
      const all = (await store.listCharacters()).filter((c) => g.members.includes(c.id));
${PAGE_ASSIGN}
      const runNight = async (members) => {
        const cap = [];
        const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', human: {}, handlers: {} });
        const seats = assignToAI(w, game, { witch: 1, wolf: 2, seer: 1 });
        const villager = game.state.players.find((p) => p.role === 'villager');
        // 第一个提问是"狼刀"——优先刀一个无关村民，别刀到女巫自己
        // （6 人局女巫只有解药、且不能自救，刀到她自己就不会有用药提问了）
        const targets = [villager.seat, seats.witch[0], seats.wolf[0], seats.seer[0]];
        // 塞一条"白天公开说过的话"进公开记录：用来验证**公开记录真的被拼进了狼与女巫的夜间提示词**。
        // 这句话本身不参与任何判定，只是个独特的记号（不能带"刀杀：/查验：/投票："这类格式词，
        // 否则假模型的分支判断会被带偏）。
        const publicMark = '5 号 丁：我先说说，3 号发言很虚，我怀疑 TA。';
        game.state.log = [publicMark];
        let n = 0;
        game.askLLM = async (player, prompt) => {
          cap.push({ seat: player.seat, role: player.role, prompt });
          const t = targets[n++ % targets.length];
          if (/刀杀/.test(prompt)) return '刀杀：' + t + '号';
          if (/从下面这些里选一种/.test(prompt)) return '不用药';
          if (/查验/.test(prompt)) return '查验：' + (t === player.seat ? villager.seat : t) + '号';
          return '';
        };
        game.state.phase = 'night';
        await game.phaseNight();
        return {
          wolf: (cap.find((c) => c.role === 'wolf') || {}).prompt || '',
          witch: (cap.find((c) => c.role === 'witch') || {}).prompt || '',
          witchSeat: seats.witch[0],
          seer: (cap.find((c) => c.role === 'seer') || {}).prompt || '',
          players: game.state.players.length,
          day: w.dayPromptFor(game.state, game.state.players.find((p) => p.team === 'wolf'), { withVote: true }),
          priv: w.privateNoteFor(game.state, game.state.players.find((p) => p.team === 'wolf')),
        };
      };
      const six = await runNight(all.slice(0, 5)); // 5 成员 + 你 = 6 人局（女巫只有解药）
      const seven = await runNight(all.slice(0, 6)); // 6 成员 + 你 = 7 人局（女巫有解药+毒药）
      return { six, seven };
    })()`);

    // 夜间：user 提示词里带「短版规则卡」；白天：完整规则卡在 system 的私密身份里
    for (const [tag, x] of [['6 人局', r.six], ['7 人局', r.seven]]) {
      for (const key of ['只能刀一个人', '不能自救', '屠边', '出局的人不再发言']) {
        assert(x.wolf.includes(key), `${tag} 狼人夜间提示词缺少「${key}」`);
      }
      for (const key of ['只能刀一个人', '不能自救', '同一晚不能同时用解药和毒药', '平票', '屠边', '出局的人不再发言', '被女巫毒死则不能开枪', '白痴']) {
        assert(x.priv.includes(key), `${tag} 私密身份卡（白天 system）缺少「${key}」`);
      }
      assert(/投票/.test(x.day), `${tag} 白天提示词没说明怎么投票`);
      assert(/查验一人是好人还是狼人/.test(x.seer), `${tag} 预言家提示词没说明查验结果`);
      assert(/刀杀一人/.test(x.wolf) && /候选/.test(x.wolf), `${tag} 狼人夜间提示词没说明只能刀一个`);
      // 公开记录必须真的进狼的夜间提示词：AI 狼只有看得见"谁跳了预言家、谁在带队冲狼"，
      // 刀口才不是拍脑袋（早先夜里只给"存活名单 + 规则"，等于接近随机）。
      assert(/【已经公开发生的事】/.test(x.wolf), `${tag} 狼人夜间提示词缺少公开记录段`);
      assert(x.wolf.includes('3 号发言很虚'), `${tag} 狼人夜间提示词里没带上白天公开说过的话`);
      assert(/第 \d+ 夜，天黑请闭眼/.test(x.wolf), `${tag} 狼人夜间提示词里没带上法官公告（公开记录没接通）`);
      // 女巫也要看到公开记录（后加的一条）：她原先是"今晚谁被刀 + 存活名单 + 规则"，白天谁跳了
      // 预言家、谁在带队、谁的票最集中一概不知道，"毒谁"只能靠模型直觉——和早先的狼一样拍脑袋。
      assert(/【已经公开发生的事】/.test(x.witch), `${tag} 女巫夜间提示词缺少公开记录段`);
      assert(x.witch.includes('3 号发言很虚'), `${tag} 女巫夜间提示词里没带上白天公开说过的话`);
      assert(/第 \d+ 夜，天黑请闭眼/.test(x.witch), `${tag} 女巫夜间提示词里没带上法官公告（公开记录没接通）`);
      // 而且要排在用药选项之前：`extra`（今晚被刀的是谁 + 选项菜单）必须以"只输出一行…"收尾，
      // 否则模型可能被中间那段公开记录带跑，格式指令不再是最后一句。
      assert(
        x.witch.indexOf('【已经公开发生的事】') < x.witch.indexOf('从下面这些里选一种'),
        `${tag} 女巫提示词里公开记录必须在用药选项菜单之前`
      );
      // 用药思路（对应狼那句"怎么挑刀口"）：只进 AI 的提示词，**不进真人操作条**的 hint
      // ——witchExtra 同时是真人女巫看到的提示，游戏不该在旁边教玩家打牌。
      assert(/· 用药思路：/.test(x.witch), `${tag} 女巫提示词缺少"怎么用药"的思路`);
      assert(
        x.witch.indexOf('· 用药思路：') < x.witch.indexOf('从下面这些里选一种'),
        `${tag} 用药思路必须排在选项菜单之前`
      );
      // 预言家的夜间提示词仍然省 token：查验只认一个座位号，不需要白天记录
      assert(!/【已经公开发生的事】/.test(x.seer), `${tag} 预言家的夜间提示词不该被加长`);
      assert(!/· 用药思路：/.test(x.seer), `${tag} 用药思路只给女巫，不该顺手也塞给预言家`);
    }
    // 毒药候选：AI 手上那份"存活玩家"名单是**含她自己**的，而引擎只认"存活且非本人"的座位
    // （parsePoisonOrder 的白名单）。不把候选写清楚，模型报自己/报已出局的人就白报一次，
    // 这一夜的毒药决策静默作废（药不消耗，但判断没了）。
    {
      const candLine = (r.seven.witch.split('\n').find((l) => l.includes('毒药候选')) || '');
      assert(candLine, `7 人局女巫提示词里应给出毒药候选，实际提示词：${r.seven.witch.slice(-200)}`);
      assert(/不能毒自己/.test(candLine), `毒药候选要写明不能毒自己：${candLine}`);
      assert(
        !candLine.includes(`${r.seven.witchSeat} 号`),
        `毒药候选里不该出现女巫自己（${r.seven.witchSeat} 号）：${candLine}`
      );
      assert(/毒药思路/.test(r.seven.witch), '7 人局有毒药时应当给出毒药的用药思路');
      // 6 人局的女巫只有解药：一个"毒"字都不该多提（多写会让模型去想一瓶本局不存在的药）
      assert(!/毒药候选|毒药思路/.test(r.six.witch), `6 人局不该出现毒药候选/毒药思路：${r.six.witch.slice(-200)}`);
    }
    // 6 人局：女巫只有解药，不能列出毒药选项
    assert(/不能自救/.test(r.six.witch), `6 人局女巫提示词要写明不能自救：${r.six.witch.slice(-120)}`);
    assert(/本局你没有毒药|只有这一瓶解药/.test(r.six.witch), `6 人局女巫应被告知没有毒药`);
    assert(!/毒药：<编号>号/.test(r.six.witch), `6 人局不该给女巫"毒药"选项：${r.six.witch.slice(-80)}`);
    // 7 人局：女巫两瓶药都在
    assert(/毒药：<编号>号/.test(r.seven.witch), `7 人局女巫应当可以选择毒药：${r.seven.witch.slice(-80)}`);
    assert(!/本局你没有毒药/.test(r.seven.witch), '7 人局不该说女巫没有毒药');
    return `夜间短版规则卡（含"每晚只能刀一个人/不能自救/屠边"）+ 狼与女巫的夜间提示词都带公开记录（法官公告 + 白天发言）+ 女巫的用药思路与毒药候选（不含她自己，6 人局一个"毒"字都不多提）都排在选项菜单之前 + 白天完整规则卡（含平票、猎人开枪限制、白痴翻牌等）都已进提示词；6 人局女巫没有毒药选项、7 人局可选毒药`;
  });

  await check('M. 你当预言家：查完人当场就能看到结果（引擎私密回调 + 聊天页带锁提示）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const w = await import('./core/werewolf.js');
      const bus = (await import('./core/bus.js')).bus;
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      // 先把群聊界面打开，这样 wireBus 已经订阅了 werewolf:private（真实链路）
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 900));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });

      const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', human: {}, handlers: {} });
      const s = game.state;
      const setRole = (p, role) => { p.role = role; p.team = w.ROLES[role].team; p.god = w.ROLES[role].god; };
      // 座位每局随机（见 createState），所以：真人按 isUser 找、剧本角色发给 AI、
      // 查验目标取"一只狼"，这样结果才是「狼人」（原来写死 players[6] = 你、查验 1 号）。
      const me = s.players.find((p) => p.isUser);
      const ais = s.players.filter((p) => !p.isUser).sort((a, b) => a.seat - b.seat);
      for (const p of s.players) setRole(p, 'villager');
      setRole(ais[0], 'wolf');
      setRole(ais[1], 'wolf');
      setRole(me, 'seer');
      const targetSeat = ais[0].seat;
      const priv = [];
      game.handlers.onPrivate = (player, text) => priv.push({ seat: player.seat, isUser: player.isUser, text });
      game.human = { seer: async () => ({ seat: targetSeat }) }; // 你选择查验一只狼
      s.phase = 'night';
      await game.phaseNight();

      // 界面这一段：真的把私密信息推到聊天页（走 bus → 群聊的本地提示）
      const before = document.querySelectorAll('.msg.sys.local-notice.ww-private').length;
      bus.emit('werewolf:private', { text: priv[0] ? priv[0].text : '' });
      await new Promise((r2) => setTimeout(r2, 500));
      const nodes = [...document.querySelectorAll('.msg.sys.local-notice.ww-private')];
      const last = nodes[nodes.length - 1];

      return {
        priv,
        targetSeat,
        checks: s.seerChecks.length,
        facts: w.privateFacts(s, me),
        before,
        after: nodes.length,
        lastText: last ? last.innerText : '',
        hudNote: \`已验 \${s.seerChecks.filter((c) => c.result === 'wolf').length} 狼 / \${s.seerChecks.filter((c) => c.result !== 'wolf').length} 好\`,
      };
    })()`);
    assert(r.checks === 1, `应当记录 1 次查验，实际 ${r.checks}`);
    assert(r.priv.length === 1 && r.priv[0].isUser, `查验结果必须私下发给"你"：${JSON.stringify(r.priv)}`);
    assert(new RegExp(`查验结果：${r.targetSeat} 号 .+ 是「狼人」`).test(r.priv[0].text), `结果文案不对：${r.priv[0].text}`);
    assert(new RegExp(`你查验过的结果：${r.targetSeat} 号 .+ 是「狼人」`).test(r.facts), `预言家的私密信息里也要有结果：${r.facts}`);
    assert(/1 狼 \/ 0 好/.test(r.hudNote), `HUD 摘要应当显示已验结果：${r.hudNote}`);
    assert(r.after === r.before + 1, `聊天页应当多出一条私密提示（${r.before} → ${r.after}）`);
    assert(/🔒/.test(r.lastText) && /狼人/.test(r.lastText), `私密提示要带锁并写明结果：${JSON.stringify(r.lastText)}`);
    return `引擎私密回调「${r.priv[0].text}」；聊天页出现带锁提示「${r.lastText.slice(0, 30)}…」；HUD 摘要「${r.hudNote}」`;
  });

  await check('N. 投票：发言里没写票就弹按钮问一次；写了票就直接用（不再多问）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const w = await import('./core/werewolf.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const mk = () => {
        const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human: {}, handlers: {} });
        const p = game.state.players.find((x) => x.isUser);
        p.role = 'villager'; p.team = 'good'; p.god = false;
        return { game, me: p };
      };
      // 座位每局随机，不能写死"投 1 号"：取一个"不是真人自己"的存活座位来投
      const otherSeat = (st) => (st.players.find((p) => !p.isUser && p.alive) || {}).seat || 0;
      // ① 只发言不写票 → 应当单独问一次投票
      const a = mk();
      let voteAsked = 0;
      let pickedSeat = 0;
      a.game.human = {
        speech: async () => ({ text: '我先听听大家怎么说。' }),
        vote: async (req) => { voteAsked++; pickedSeat = (req.options[0] || {}).seat; return { seat: pickedSeat }; },
      };
      const turnA = await a.game.speakTurn(a.me, { withVote: true });
      // ② 发言里直接写了票 → 不该再问
      const b = mk();
      let voteAskedB = 0;
      const textSeat = otherSeat(b.game.state);
      b.game.human = {
        speech: async () => ({ text: '我怀疑 ' + textSeat + ' 号。投票：' + textSeat + '号' }),
        vote: async () => { voteAskedB++; return null; },
      };
      const turnB = await b.game.speakTurn(b.me, { withVote: true });
      return {
        askA: voteAsked, voteA: turnA.vote, pickedSeat, speechA: turnA.speech,
        askB: voteAskedB, voteB: turnB.vote, textSeat, speechB: turnB.speech,
      };
    })()`);
    assert(r.askA === 1, `没写票时应当问一次投票，实际问了 ${r.askA} 次`);
    assert(r.voteA === r.pickedSeat && r.pickedSeat > 0, `按钮选的票（${r.pickedSeat} 号）要被采纳，实际 ${r.voteA}`);
    assert(r.speechA === '我先听听大家怎么说。', `发言内容要保持原样：${r.speechA}`);
    assert(r.askB === 0, `发言里已写票就不该再问，实际问了 ${r.askB} 次`);
    assert(r.voteB === r.textSeat && r.textSeat > 0, `文字票（${r.textSeat} 号）要被采纳，实际 ${r.voteB}`);
    assert(r.speechB === `我怀疑 ${r.textSeat} 号。`, `文字里的票要从发言里剥掉：${r.speechB}`);
    return `没写票 → 弹按钮问一次并采纳（投 ${r.voteA} 号）；写了「投票：${r.textSeat}号」→ 不再问、直接用（投 ${r.voteB} 号）`;
  });

  await check('O. 夜间技能选择不带票数（构造"上一轮票数残留"的局面，确定性验证）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const w = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const players = [
        ...members.map((m) => ({ id: String(m.id), name: m.name })),
        { id: 'user', name: '我', isUser: true },
      ];
      const board = w.boardFor(players.length);
      const dealt = w.assignRoles(players, board);
      // 让"你"当预言家，别人随便分
      const me = dealt[dealt.length - 1];
      me.role = 'seer'; me.team = 'good'; me.god = true;
      for (const p of dealt.slice(0, -1)) {
        if (p.role === 'seer') { p.role = 'villager'; p.team = 'good'; p.god = false; }
      }
      const state = {
        version: 1, groupId: g.id, groupName: g.name, createdAt: Date.now(), updatedAt: Date.now(),
        over: false, winner: '', phase: 'night', day: 1, players: dealt,
        board: { players: board.players, wolf: board.wolf, villager: board.villager, gods: board.gods, witchAntidoteOnly: board.witchAntidoteOnly },
        fastMode: true, witch: { antidote: true, poison: !board.witchAntidoteOnly }, seerChecks: [],
        night: {}, lastNightDeaths: [], voteRound: 0, log: [], pending: null,
        // 关键：留下"上一轮投票"的票数，且座位号正好命中查验候选
        voteLive: { 1: 3, 3: 2, 5: 1 },
        lastBallots: [{ voterSeat: 2, seat: 1 }],
        userSeat: me.seat, userRole: 'seer',
      };
      w.saveGame(state);
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 900));
      // 打开面板 → 询问"接着上一局？" → 继续
      ww.openWerewolfPanel(g, window.__AICHAT__.ctx);
      await new Promise((r2) => setTimeout(r2, 700));
      const resume = [...document.querySelectorAll('.modal-foot button, .modal button')].find((b) => /继续这局/.test(b.textContent));
      if (resume) resume.click();
      await new Promise((r2) => setTimeout(r2, 600));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });

      // 等"轮到你：预言家查验"的操作条出现
      let bar = null;
      let text = '';
      let hud = '';
      for (let i = 0; i < 200; i++) {
        await new Promise((r2) => setTimeout(r2, 120));
        bar = document.querySelector('.chat-foot .ww-actionbar');
        text = bar && bar.offsetParent ? bar.innerText.replace(/\s+/g, ' ').trim() : '';
        const h = document.querySelector('.gchat-roundbar .ww-hud');
        hud = h ? h.innerText.replace(/\s+/g, ' ') : '';
        if (/预言家查验/.test(text)) break;
      }
      const badges = bar ? [...bar.querySelectorAll('.ww-ab-votes')].map((n) => n.innerText) : [];
      const seatBtns = bar ? [...bar.querySelectorAll('button')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 600));
      return { text, hud, badges, seatBtns };
    })()`);
    assert(/预言家查验/.test(r.text), `应当轮到"你"（预言家）选查验对象，实际：${JSON.stringify(r.text)}`);
    assert(r.seatBtns.length >= 2, `应当有一排候选按钮：${JSON.stringify(r.seatBtns)}`);
    assert(r.badges.length === 0, `查验按钮上不该有票数角标，实际：${JSON.stringify(r.badges)}`);
    assert(!/票数/.test(r.text), `查验操作条不该提到票数：${JSON.stringify(r.text)}`);
    assert(!/票数/.test(r.hud), `夜里 HUD 不该显示票数：${JSON.stringify(r.hud)}`);
    return `查验操作条「${r.text.slice(0, 40)}…」，候选 ${r.seatBtns.length} 个、0 个票数角标；HUD「${r.hud.slice(0, 30)}」也没有票数`;
  });

  await check('Y. 盲投：收票期间一个票数都不给，本轮结算后才在 HUD 与法官公告里公布', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const w = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const players = [
        ...members.map((m) => ({ id: String(m.id), name: m.name })),
        { id: 'user', name: '我', isUser: true },
      ];
      const board = w.boardFor(players.length);
      const dealt = w.assignRoles(players, board);
      const me = dealt.find((p) => p.isUser);
      // 真人必须是平民：白痴会翻牌免死、猎人会开枪，都会把"被放逐 → 遗言"这条路岔开
      me.role = 'villager'; me.team = 'good'; me.god = false;
      // 别人都已经投完（全投给你）→ 只等你这一票：整条路径不依赖假模型，完全确定性
      const others = dealt.filter((p) => p.id !== me.id);
      const state = {
        version: 1, groupId: g.id, groupName: g.name, createdAt: Date.now(), updatedAt: Date.now(),
        over: false, winner: '', phase: 'vote', day: 1, players: dealt,
        board: { players: board.players, wolf: board.wolf, villager: board.villager, gods: board.gods, witchAntidoteOnly: board.witchAntidoteOnly },
        fastMode: true, witch: { antidote: true, poison: !board.witchAntidoteOnly }, seerChecks: [],
        night: { no: 1, started: true, finished: true }, lastNightDeaths: [], voteRound: 0, log: [], pending: null,
        // 关键：收票期间引擎内部已经有票（全在你身上），但界面一个数字都不许显示
        voteLive: w.tallyVotes(others.map(() => ({ seat: me.seat }))),
        voteOpen: true, voteResult: null,
        lastBallots: [], spokenDay: 1, spokenSeats: dealt.map((p) => p.seat), fastVotes: [],
        voteBallots: others.map((p) => ({ voterSeat: p.seat, seat: me.seat })),
        voteBallotsDay: 1,
        userSeat: me.seat, userRole: me.role,
      };
      w.saveGame(state);
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 900));
      ww.openWerewolfPanel(g, window.__AICHAT__.ctx);
      await new Promise((r2) => setTimeout(r2, 700));
      const resume = [...document.querySelectorAll('.modal-foot button, .modal button')].find((b) => /继续这局/.test(b.textContent));
      if (resume) resume.click();
      await new Promise((r2) => setTimeout(r2, 600));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });

      const bar = () => document.querySelector('.chat-foot .ww-actionbar');
      const hudText = () => { const h = document.querySelector('.gchat-roundbar .ww-hud'); return h ? h.innerText.replace(/\\s+/g, ' ').trim() : ''; };
      const judgeText = () => [...document.querySelectorAll('.gchat-body .msg.sys')].map((n) => n.innerText).join(' ｜ ');

      // ① 轮到你投票：条上 / 按钮上 / HUD 里都不能出现任何票数
      let barSeen = '';
      let hudDuringVote = '';
      let badges = 0;
      let buttons = [];
      for (let i = 0; i < 200; i++) {
        await new Promise((r2) => setTimeout(r2, 100));
        const b = bar();
        const t = b && b.offsetParent ? b.innerText.replace(/\\s+/g, ' ').trim() : '';
        if (!/投票放逐/.test(t)) continue;
        barSeen = t;
        hudDuringVote = hudText();
        badges = b.querySelectorAll('.ww-ab-votes').length;
        buttons = [...b.querySelectorAll('button')].filter((x) => x.offsetParent && !/跳过|放弃|弃票/.test(x.textContent));
        break;
      }
      // ② 投出去 → 等本轮结算。你以最多票被放逐，引擎会停在"等你遗言"，所以这个窗口是确定的。
      let hudAfterSettle = '';
      let judgeAfterSettle = '';
      let savedVoteOpen = null;
      let savedTally = null;
      if (buttons.length) {
        buttons[0].click();
        for (let i = 0; i < 200; i++) {
          await new Promise((r2) => setTimeout(r2, 100));
          if (!/投票结果/.test(hudText())) continue;
          hudAfterSettle = hudText();
          judgeAfterSettle = judgeText();
          const saved = w.loadGame(g.id);
          savedVoteOpen = saved ? saved.voteOpen : null;
          savedTally = saved ? saved.voteResult : null;
          break;
        }
      }
      const lastBar = bar() ? bar().innerText.replace(/\\s+/g, ' ').trim() : '';
      const out = {
        barSeen, hudDuringVote, badges, buttons: buttons.map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
        hudAfterSettle, judgeAfterSettle, lastBar, mySeat: me.seat, myName: me.name, knownVotes: others.length,
        savedVoteOpen, savedTally,
      };
      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 600));
      return out;
    })()`);
    assert(/投票放逐/.test(r.barSeen), `应当轮到"你"投票，实际碰到的是：${JSON.stringify(r.barSeen)}`);
    // ① 收票期间：一个票数都不能有（这一局其实已经有 ${r.knownVotes} 票落在你头上）
    assert(!/票数/.test(r.barSeen) && !/\d+\s*票/.test(r.barSeen), `投票条上不能出现票数，实际：${JSON.stringify(r.barSeen)}`);
    assert(/投票中/.test(r.barSeen), `投票条要说明结果稍后公布，实际：${JSON.stringify(r.barSeen)}`);
    assert(r.badges === 0, `投票按钮上不能挂票数角标，实际 ${r.badges} 个`);
    assert(!/投票结果/.test(r.hudDuringVote) && !/\d+\s*票/.test(r.hudDuringVote), `收票期间 HUD 不能出现票数，实际：${JSON.stringify(r.hudDuringVote)}`);
    assert(/投票中/.test(r.hudDuringVote), `收票期间 HUD 应当写"投票中"，实际：${JSON.stringify(r.hudDuringVote)}`);
    // ② 结算后才公布：HUD 写"投票结果：…"、法官公告印明细、存档里 voteOpen=false 且留下已公开的票数
    assert(/投票结果/.test(r.hudAfterSettle), `结算后 HUD 应当显示投票结果，实际：${JSON.stringify(r.hudAfterSettle)}`);
    assert(
      new RegExp(`${r.mySeat} 号 ${r.myName} ${r.knownVotes} 票`).test(r.hudAfterSettle),
      `HUD 的票数要跟实际票数一致（${r.knownVotes} 票）：${JSON.stringify(r.hudAfterSettle)}`
    );
    assert(/放逐投票结果/.test(r.judgeAfterSettle), `法官公告要公布票数明细，实际：${JSON.stringify(String(r.judgeAfterSettle).slice(-140))}`);
    assert(r.savedVoteOpen === false, `结算后 voteOpen 应当收起来，实际 ${r.savedVoteOpen}`);
    assert(
      r.savedTally && r.savedTally.tally && r.savedTally.tally[r.mySeat] === r.knownVotes,
      `存档里要留下"已公开"的票数，实际 ${JSON.stringify(r.savedTally)}`
    );
    return `收票期间：投票条「${r.barSeen.slice(0, 26)}…」+ HUD「${r.hudDuringVote.slice(0, 22)}…」，0 个角标；结算后 HUD「${r.hudAfterSettle.slice(0, 26)}…」、公告含「放逐投票结果」`;
  });

  await check('P. 局内消息不污染普通群聊：结束后角色不再"演狼人杀"', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const grp = await import('./core/group.js');
      const w = await import('./core/werewolf.js');
      const g = (await store.listGroups())[0];
      const chars = (await store.listCharacters()).filter((c) => g.members.includes(c.id));
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);

      // 跑到分出胜负
      const human = {
        wolf: async (rq) => ({ seat: (rq.options[0] || {}).seat }),
        seer: async (rq) => ({ seat: (rq.options[0] || {}).seat }),
        witch: async () => ({ none: true }),
        vote: async (rq) => ({ seat: (rq.options[0] || {}).seat }),
        speech: async () => ({ text: '（我）我先听听。' }),
        lastWords: async () => ({ text: '我说完了。' }),
        shoot: async () => null,
      };
      await store.clearGroupMessages(g.id);
      const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human, handlers: {} });
      await game.run();
      const after = await store.listGroupMessages(g.id);
      const gameMsgs = after.filter((m) => m.game === 'werewolf');

      // ① 局内消息确实打上了标记，而且仍在记录里（界面照常显示）
      // ② 普通轮次的提示词里只能剩"本局已结束"这条锚点
      const settings = store.getSettings();
      const built = grp.buildGroupMessages({ group: g, speaker: members[0], members, history: after, settings, userName: '我' });
      const sys = built.messages[0].content;
      const block2 = sys.split('【群里最近的对话】')[1] || '';
      const wolfLines = block2.split(String.fromCharCode(10)).filter((l) => /法官|我投|刀杀|查验|出局|预言家|女巫/.test(l));
      // ③ 显式打开 includeGame 时应当能带回来（供将来"让他们复盘"之类的功能用）
      const built2 = grp.buildGroupMessages({ group: g, speaker: members[0], members, history: after, settings, userName: '我', includeGame: true });
      const sys2 = built2.messages[0].content;
      // ④ 局终锚点要留在普通上下文里（让角色记得玩过、也知道已经散场）
      const kept = gameMsgs.filter((m) => m.keepGame);
      // ⑤ 每位角色的长期记忆里要有一条"玩过这局"
      const mems = [];
      for (const c of members.slice(0, 3)) {
        const m = await store.getMemory(c.id);
        mems.push({ name: c.name, fact: (m.facts || []).find((f) => /狼人杀/.test(f)) || '' });
      }
      // ⑥ 记忆要真的进提示词（真实链路里 GroupRound 会读记忆）
      const mem0 = await store.getMemory(members[0].id);
      const built3 = grp.buildGroupMessages({ group: g, speaker: members[0], members, history: after, settings, userName: '我', memory: mem0 });
      return {
        winner: game.state.winner,
        total: after.length,
        tagged: gameMsgs.length,
        transcriptLines: block2.split(String.fromCharCode(10)).filter((l) => l.trim()).length,
        wolfLines: wolfLines.slice(0, 3),
        leaked: /【法官】了/.test(sys) || /我投 \d+ 号/.test(sys),
        withGameHasJudge: /【法官】/.test(sys2),
        keptText: kept.map((m) => String(m.content)).join(' | '),
        keptCount: kept.length,
        identityLeak: /身份公开/.test(block2),
        mems,
        memoryInPrompt: /和群友玩过的游戏/.test(built3.messages[0].content),
      };
    })()`);
    assert(r.winner === 'wolf' || r.winner === 'good', '这一局应当打完了');
    assert(r.tagged >= 5, `局内消息应当都带上 game 标记，实际 ${r.tagged}/${r.total}`);
    assert(!r.leaked, '普通轮次提示词里不该出现局内公告/台词');
    assert(r.wolfLines.length === 1, `普通转写里只该剩"本局已结束"这一条：${JSON.stringify(r.wolfLines)}`);
    assert(/本局狼人杀结束/.test(r.keptText) && /可以继续正常聊天/.test(r.keptText), `局终锚点内容不对：${r.keptText}`);
    assert(!r.identityLeak, '身份公开那条不该进普通上下文（否则永久知道彼此身份）');
    assert(r.withGameHasJudge, 'includeGame 打开时应当能拿到局内记录（能力要保留）');
    // 记得玩过：每位角色的长期记忆里有一条，且带自己的身份
    for (const m of r.mems) {
      assert(/和群友玩过的游戏/.test(m.fact), `${m.name} 的记忆里应当有"玩过这局"：${JSON.stringify(m.fact)}`);
      assert(/我是「/.test(m.fact), `${m.name} 的记忆里应当写明自己当时的身份：${m.fact}`);
    }
    assert(r.memoryInPrompt, '这条记忆要真的能进提示词（角色才"记得"）');
    // 局后跑一轮普通群聊，确认角色能正常聊（不再被限制在狼人杀里）
    const ran = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const grpMod = await import('./core/group.js');
      const g = (await store.listGroups())[0];
      const chars = (await store.listCharacters()).filter((c) => g.members.includes(c.id));
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const hist = await store.listGroupMessages(g.id);
      const round = new grpMod.GroupRound({ group: g, members, settings: store.getSettings(), userName: '我', history: hist.slice(), maxTurns: 2, mode: g.turnMode, force: true, handlers: {} });
      const res = await round.run();
      const last = (await store.listGroupMessages(g.id)).filter((m) => m.role === 'assistant' && !m.game).slice(-1)[0];
      return { turns: res.turns, reason: res.reason, lastText: last ? String(last.content).slice(0, 40) : '' };
    })()`);
    assert(ran.turns >= 1, `局后普通群聊应当能正常跑（${JSON.stringify(ran)}）`);
    return `局内 ${r.tagged} 条消息：28 类内容照常显示但不进提示词，只保留 1 条"本局已结束"锚点；${r.mems.length} 位角色的记忆里写入了"我是「X」，结果如何"并进得了提示词；局后普通轮次正常跑了 ${ran.turns} 条`;
  });

  await check('Q. HUD 实时显示你的私密摘要（狼队友 / 药 / 查验 / 翻牌）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const core = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      // 确保有一局在跑（没有就现开一局）
      if (!core.isActive(g.id)) {
        await window.__AICHAT__.openGroup(g.id);
        await new Promise((r2) => setTimeout(r2, 900));
        document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
        const btn = [...document.querySelectorAll('.pane-right .btn')].find((x) => /狼人杀/.test(x.textContent));
        if (btn) btn.click();
        await new Promise((r2) => setTimeout(r2, 700));
        const start = [...document.querySelectorAll('.modal-foot button')].find((x) => /开始游戏/.test(x.textContent));
        if (start) start.click();
        await new Promise((r2) => setTimeout(r2, 1500));
        document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      }
      let hud = '';
      for (let i = 0; i < 120; i++) {
        await new Promise((r2) => setTimeout(r2, 150));
        const node = document.querySelector('.gchat-roundbar .ww-hud');
        hud = node && node.offsetParent ? node.innerText.replace(/\\s+/g, ' ') : '';
        if (hud) break;
      }
      const st = core.loadGame(g.id);
      const me = st && Array.isArray(st.players) ? st.players.find((p) => p.isUser) : null;
      const extra = me ? core.hudExtraFor(st, me) : '';
      const expected = me ? ('你是 ' + me.seat + ' 号 · ' + core.ROLES[me.role].name + (me.alive ? '' : '（已出局）') + extra) : '';
      // 顺手验证"队友出局后文案会变"（纯函数层面）
      const craft = (mateAlive) => {
        const mk = () => ({
          players: [
            { id: 'a', seat: 1, name: '林晚', role: 'wolf', team: 'wolf', god: false, alive: true },
            { id: 'b', seat: 2, name: '阿哲', role: 'wolf', team: 'wolf', god: false, alive: mateAlive },
            { id: 'u', seat: 6, name: '我', role: 'wolf', team: 'wolf', god: false, alive: true, isUser: true },
          ],
          board: core.boardFor(6), witch: { antidote: true, poison: false }, seerChecks: [], log: [],
        });
        const s2 = mk();
        return core.hudExtraFor(s2, s2.players[2]);
      };
      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 600));
      return { hud, expected, extra, role: me ? me.role : '', aliveMate: craft(true), deadMate: craft(false), active: core.isActive(g.id) };
    })()`);
    assert(r.hud, '聊天页的 HUD 应当出现');
    assert(r.expected && r.hud.includes(r.expected), `HUD 上的身份胶囊应当与实时摘要一致：期望含「${r.expected}」，实际「${r.hud}」`);
    assert(/狼队友：1 号 林晚、2 号 阿哲）/.test(r.aliveMate), `队友活着时应当列出队友：${r.aliveMate}`);
    assert(/2 号 阿哲（已出局）/.test(r.deadMate), `队友出局后要标出来：${r.deadMate}`);
    assert(r.active === false, '收尾时应当把模式停掉');
    return `这一局你是「${r.role}」，HUD 身份栏 =「${r.expected}」；队友活着「${r.aliveMate}」→ 出局后「${r.deadMate}」`;
  });

  await check('R. 你是狼人时：操作条能选每一名存活玩家（含同伴与你自己）', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const w = await import('./core/werewolf.js');
      const ww = await import('./ui/werewolf.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const players = [...members.map((m) => ({ id: String(m.id), name: m.name })), { id: 'user', name: '我', isUser: true }];
      const board = w.boardFor(players.length);
      const dealt = w.assignRoles(players, board);
      // 让"你"当狼人，并确保场上还有另一只狼（同伴）
      const me = dealt[dealt.length - 1];
      me.role = 'wolf'; me.team = 'wolf'; me.god = false;
      let mate = dealt.find((p) => p.team === 'wolf' && !p.isUser);
      if (!mate) {
        mate = dealt[0];
        mate.role = 'wolf'; mate.team = 'wolf'; mate.god = false;
      } else if (dealt.filter((p) => p.team === 'wolf').length < 2) {
        mate = dealt[0];
        mate.role = 'wolf'; mate.team = 'wolf'; mate.god = false;
      }
      const state = {
        version: 1, groupId: g.id, groupName: g.name, createdAt: Date.now(), updatedAt: Date.now(),
        over: false, winner: '', phase: 'night', day: 1, players: dealt,
        board: { players: board.players, wolf: board.wolf, villager: board.villager, gods: board.gods, witchAntidoteOnly: board.witchAntidoteOnly },
        fastMode: true, witch: { antidote: true, poison: !board.witchAntidoteOnly }, seerChecks: [],
        night: {}, lastNightDeaths: [], voteRound: 0, log: [], pending: null, voteLive: {}, lastBallots: [],
        userSeat: me.seat, userRole: 'wolf',
      };
      w.saveGame(state);
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 900));
      ww.openWerewolfPanel(g, window.__AICHAT__.ctx);
      await new Promise((r2) => setTimeout(r2, 700));
      const resume = [...document.querySelectorAll('.modal-foot button, .modal button')].find((b) => /继续这局/.test(b.textContent));
      if (resume) resume.click();
      await new Promise((r2) => setTimeout(r2, 600));
      document.querySelectorAll('.modal-mask').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });

      let bar = null;
      let text = '';
      for (let i = 0; i < 200; i++) {
        await new Promise((r2) => setTimeout(r2, 120));
        bar = document.querySelector('.chat-foot .ww-actionbar');
        text = bar && bar.offsetParent ? bar.innerText.replace(/\s+/g, ' ').trim() : '';
        if (/狼人刀人/.test(text)) break;
      }
      const allButtons = bar ? [...bar.querySelectorAll('button')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim()) : [];
      const labels = allButtons.filter((x) => /\\d+\\s*号/.test(x));
      const aliveSeats = dealt.filter((p) => p.alive).map((p) => p.seat).sort((a, b) => a - b);
      const mateSeat = mate.seat;
      const mySeat = me.seat;
      const labelSeats = labels.map((l) => Number((l.match(/^(\\d+)\\s*号/) || [])[1])).sort((a, b) => a - b);
      ww.stopWerewolf(g);
      await new Promise((r2) => setTimeout(r2, 600));
      return { text, labels, allButtons, barHtml: bar ? bar.innerHTML.slice(0, 300) : '', aliveSeats, labelSeats, mateSeat, mySeat, mateName: mate.name };
    })()`);
    assert(/狼人刀人/.test(r.text), `应当轮到"你"（狼人）选刀，实际：${JSON.stringify(r.text)}`);
    assert(/可以刀任何人|包括同伴/.test(r.text), `提示应当说明可以刀任何人：${JSON.stringify(r.text)}`);
    assert(
      r.labelSeats.length === r.aliveSeats.length,
      `候选应当覆盖全部存活玩家（${r.aliveSeats.length} 人），实际 ${r.labelSeats.length} 个；条上按钮=${JSON.stringify(r.allButtons)}`
    );
    assert(r.labelSeats.join() === r.aliveSeats.join(), `候选座位应当与存活座位一致：${JSON.stringify(r.labelSeats)} vs ${JSON.stringify(r.aliveSeats)}`);
    assert(r.labelSeats.includes(r.mateSeat), `同伴（${r.mateSeat} 号 ${r.mateName}）也应当在候选里`);
    assert(r.labelSeats.includes(r.mySeat), `你自己（${r.mySeat} 号，可自刀）也应当在候选里`);
    return `候选 ${r.labelSeats.length} 人 = 全部存活玩家，含同伴 ${r.mateSeat} 号与你自己 ${r.mySeat} 号（可自刀）`;
  });

  await check('G. 狼人认狼被拦下：提示词禁认狼 + 引擎兜底 + 群里不出现自曝', async () => {
    // 让假模型"故意认狼"：狼人每次发言/遗言都自曝，看引擎拦不拦得住
    await fetch(`http://127.0.0.1:${MOCK_PORT}/confess`).then((r) => r.json());
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      await store.clearGroupMessages(g.id);
      const game = new w.WerewolfGame({
        group: g, members, settings: store.getSettings(), userName: '我', fastMode: true,
        human: {
          wolf: async (req) => ({ seat: (req.options[0] || {}).seat }),
          seer: async (req) => ({ seat: (req.options[0] || {}).seat }),
          witch: async () => ({ none: true }),
          vote: async (req) => ({ seat: (req.options[0] || {}).seat }),
          speech: async () => ({ text: '我先听听大家怎么说。' }),
          lastWords: async () => ({ text: '' }),
          shoot: async () => null,
        },
        handlers: {},
      });
      // 只收集"本局"发布的发言（后台可能还有别的用例在跑对局，不能被它们干扰）
      const mineSpeeches = [];
      game.handlers.onSpeech = (pl, text) => mineSpeeches.push({ seat: pl.seat, text: String(text) });
      // 记下"模型原样返回了什么"（兜底之前的文本），便于核对兜底到底有没有跑
      const rawWolf = [];
      const origAsk = game.askLLM.bind(game);
      game.askLLM = async (player, prompt, kind) => {
        const t = await origAsk(player, prompt, kind);
        if (player && player.team === 'wolf') rawWolf.push({ seat: player.seat, kind, text: String(t || '').slice(0, 50) });
        return t;
      };
      await game.run();
      const msgs = await store.listGroupMessages(g.id);
      const speeches = mineSpeeches.map((x) => x.text);
      const confessions = speeches.filter((t) => w.looksLikeWolfConfession(t));
      const wolf = game.state.players.find((p) => p.team === 'wolf');
      const wolfLw = w.lastWordsPromptFor(game.state, wolf);
      const allText = msgs.map((m) => m.content).join('\\n');
      return {
        speeches: speeches.length,
        confessions: confessions.length,
        sample: confessions.slice(0, 2),
        // guardWolfSpeech 的措辞是「…的发言违规（你承认了自己是狼人），已要求重说」
        guardNotes: (game.state.debug || []).filter((t) => /违规/.test(t)).length,
        debugLen: (game.state.debug || []).length,
        hasDebugMethod: typeof game.debug === 'function',
        rawWolfConfess: rawWolf.filter((x) => w.looksLikeWolfConfession(x.text)).length,
        rawWolfSample: rawWolf.slice(0, 4),
        wolfSeats: game.state.players.filter((p) => p.team === 'wolf').map((p) => p.seat),
        lwBansConfess: /绝对不能承认自己是狼/.test(wolfLw),
        lwHasOldPermit: /可以公布身份/.test(wolfLw),
        leakToPrompt: /认了狼/.test(String((game.state.log || []).join('\\n'))),
        leakToGroup: /认了狼|自曝/.test(allText),
      };
    })()`);
    const calls = await fetch(`http://127.0.0.1:${MOCK_PORT}/calls`).then((x) => x.json());
    assert(calls.wolfConfessAttempts > 0, `假模型应当真的尝试过认狼（否则这条检查没测到东西）｜提问分类统计 ${JSON.stringify(calls.askTally)}`);
    assert(r.confessions === 0, `群里不该出现狼人自曝，实际 ${r.confessions} 条：${JSON.stringify(r.sample)}`);
    assert(
      r.guardNotes > 0,
      `引擎应当触发过"要求重说"的兜底，实际 ${r.guardNotes} 次｜debug=${r.debugLen} 条｜debug方法=${r.hasDebugMethod}｜狼人收到认狼回复 ${r.rawWolfConfess} 次｜样本 ${JSON.stringify(r.rawWolfSample)}｜提问分类统计 ${JSON.stringify(calls.askTally)}`
    );
    assert(r.lwBansConfess && !r.lwHasOldPermit, '狼人遗言提示必须明令禁止认狼、且不再写"可以公布身份"');
    assert(!r.leakToGroup && !r.leakToPrompt, '兜底记录不能泄露（进群或进公开信息都等于告诉全场谁是狼）');
    assert(r.speeches > 0 && r.wolfSeats.length > 0, '这一局应当有狼有发言');
    return `假模型故意认狼 ${calls.wolfConfessAttempts} 次（狼座位 ${r.wolfSeats.join('/')}），引擎纠正 ${r.guardNotes} 次，${r.speeches} 条公开发言里自曝 0 条、也没泄露到提示词｜提问分类统计 ${JSON.stringify(calls.askTally)}`;
  });

  await check('S. 身份不外泄：公开面不得出现"某座位 = 某身份"，狼队内仍互相可见', async () => {
    // 背景：开局那句"9 号就是你自己：你的身份是「猎人」"曾经走的是 say()（公开记录），
    // 而白天的提示词会把公开记录整段拼进去 —— 等于把玩家的身份告诉全场，狼人照着屠边目标去刀。
    // 这条守住两个方向：公开面 0 泄露；狼队内（含"你是狼"时）依然互相看得见。
    //
    // 注意：这里**一局一个 page.eval**（不要两局塞进同一个 evaluate）——整局跑完本来就要几十秒，
    // 合并成一个 evaluate 会在机器有负载时撞上 CDP 的 60s 超时（曾经因此误报过一次）。
    const runOnce = (humanIsWolf) => page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      const g = (await store.listGroups())[0];
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      await store.clearGroupMessages(g.id);
      const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human: {}, handlers: {} });
      const s = game.state;
      const user = s.players.find((p) => p.isUser);
      if (${humanIsWolf} && user.team !== 'wolf') {
        const wolf = s.players.find((p) => p.team === 'wolf');
        [user.role, wolf.role] = [wolf.role, user.role];
        [user.team, wolf.team] = [wolf.team, user.team];
        [user.god, wolf.god] = [wolf.god, user.god];
      }
      await game.run();
      const msgs = await store.listGroupMessages(g.id);
      const endIdx = msgs.findIndex((m) => /身份公开/.test(m.content));
      const beforeEnd = endIdx < 0 ? msgs : msgs.slice(0, endIdx);
      return {
        userSeat: user.seat,
        userRole: user.role,
        userTeam: user.team,
        mateSeats: s.players.filter((p) => p.team === 'wolf' && !p.isUser).map((p) => p.seat),
        endReveal: endIdx >= 0,
        publicLeaks: beforeEnd.filter((m) => /就是你自己|身份是「/.test(m.content)).map((m) => m.content),
        logLeaks: (s.log || []).filter((t) => /就是你自己|身份是「/.test(t)),
        privIdentity: (s.privLog || []).find((t) => t.includes('你的身份是「') && t.startsWith(user.seat + ' 号')) || '',
      };
    })()`);
    const good = await runOnce(false);
    const asWolf = await runOnce(true);
    // 狼同伴可见性：直接看 privateFacts（就是提示词里那一段），不必再跑一局
    const seeMates = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      const g = (await store.listGroups())[0];
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human: {}, handlers: {} });
      const s = game.state;
      const wolf = s.players.find((p) => p.team === 'wolf' && !p.isUser);
      const villager = s.players.find((p) => p.team === 'good' && !p.god && !p.isUser);
      return { wolfView: w.privateFacts(s, wolf), villagerView: w.privateFacts(s, villager), wolfSeat: wolf.seat, goodSeat: villager.seat };
    })()`);
    const r = { good, asWolf, seeMates };
    const leakText = [...r.good.publicLeaks, ...r.good.logLeaks, ...r.asWolf.publicLeaks, ...r.asWolf.logLeaks];
    assert(leakText.length === 0, `公开面出现身份泄露：${leakText.slice(0, 2).join(' / ')}`);
    assert(r.good.endReveal && r.asWolf.endReveal, '局末的"身份公开"必须照常（那是设计）');
    assert(/你的身份是「/.test(r.good.privIdentity), `玩家应当通过私密通道知道自己身份，实际：${r.good.privIdentity || '(空)'}`);
    assert(/你的身份是「/.test(r.asWolf.privIdentity), `"你是狼"时也应当私密告知身份，实际：${r.asWolf.privIdentity || '(空)'}`);
    assert(
      r.asWolf.userTeam !== 'wolf' || (r.asWolf.mateSeats.every((s) => r.asWolf.privIdentity.includes(s + ' 号')) && /狼同伴/.test(r.asWolf.privIdentity)),
      `"你是狼"时私密提示里要列出狼同伴：${r.asWolf.privIdentity}`
    );
    assert(/你的狼同伴/.test(r.seeMates.wolfView), `AI 狼必须看得到狼同伴，实际：${r.seeMates.wolfView}`);
    assert(!/你的狼同伴/.test(r.seeMates.villagerView), `好人绝不能看到狼同伴，实际：${r.seeMates.villagerView}`);
    return `公开面 0 泄露（局末揭底保留）｜玩家身份走私密通道（"你是狼"时带同伴 ${r.asWolf.mateSeats.join('/')}）｜AI 狼看得到同伴、好人看不到`;
  });

  await check('T. 女巫用药措辞：没人被刀 / 被刀的是自己 / 解药已用完，三种说法必须分开', async () => {
    // 这三种情形线上很少碰到，但一碰到就会给出自相矛盾的信息：
    // 原来统一拼成"今晚被刀的是：（今晚没有人被刀）（解药已用完或不能自救）"——
    // 没人被刀时说"今晚被刀的是"、药还在时说"解药已用完"，都会误导女巫。
    const beforeAll = seen.length;
    await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      const g = (await store.listGroups())[0];
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      window.__witchRuns = {};
      const run = async (kill, antidoteGone) => {
        let witchSeat = 0;
        let autoSeat = 0;
        const human = {
          // 座位随机，所以刀口不能用字面量 1 号（那可能正好是女巫自己）：
          // 'auto' 由 run() 在拿到牌局后填一个"非女巫、非真人"的座位
          wolf: async () => (kill === 'none' ? null : { seat: kill === 'self-witch' ? witchSeat : Number(kill === 'auto' ? autoSeat : kill) }),
          seer: async (req) => ({ seat: (req.options[0] || {}).seat }),
          witch: async () => ({ none: true }),
          vote: async (req) => ({ seat: (req.options[0] || {}).seat }),
          speech: async () => ({ text: '嗯。' }),
          lastWords: async () => ({ text: '' }),
          shoot: async () => null,
        };
        const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human, handlers: {} });
        const s = game.state;
        // 让"你"变成狼人：今晚刀谁由上面的 human.wolf 决定，局面因此完全确定
        const user = s.players.find((p) => p.isUser);
        if (user.team !== 'wolf') {
          const mate = s.players.find((p) => p.team === 'wolf');
          [user.role, mate.role] = [mate.role, user.role];
          [user.team, mate.team] = [mate.team, user.team];
          [user.god, mate.god] = [mate.god, user.god];
        }
        witchSeat = s.players.find((p) => p.role === 'witch').seat;
        autoSeat = (s.players.find((p) => p.role !== 'witch' && !p.isUser && p.alive) || {}).seat || 0;
        if (antidoteGone) s.witch.antidote = false;
        await game.phaseNight();
      };
      for (const [key, kill, gone] of [['normal', 'auto', false], ['noTarget', 'none', false], ['selfWitch', 'self-witch', false], ['noAntidote', 'auto', true]]) {
        window.__witchRuns[key] = { mark: -1 };
        await run(kill, gone);
        window.__witchRuns[key].mark = 1;
      }
      return Object.keys(window.__witchRuns).length;
    })()`);
    // 从假模型记录里取"今晚…"开头的那一行（= 女巫提问的 extra 段；privateFacts 里那句"你不能自救"不算）
    const segs = seen.slice(beforeAll).map((x) => {
      const i = x.prompt.indexOf('今晚');
      return i < 0 ? '' : x.prompt.slice(i).split('\n')[0];
    }).filter(Boolean);
    const findSeg = (re) => segs.find((s) => re.test(s)) || '';
    const normal = findSeg(/今晚被刀的是：\d+ 号[^（]*你可以用解药救 TA/);
    const noTarget = findSeg(/今晚没有人被刀/);
    const selfWitch = findSeg(/（被刀的是你自己，你不能自救）/);
    const noAntidote = findSeg(/（解药已用完）/);
    assert(normal, `有人被刀+有解药 应当说"你可以用解药救 TA"，实际抓到：${JSON.stringify(segs.slice(0, 4))}`);
    assert(noTarget, `没人被刀 应当直接说"今晚没有人被刀。"，实际抓到：${JSON.stringify(segs)}`);
    assert(!segs.some((s) => /今晚被刀的是：（今晚没有人被刀）/.test(s)), `不能串成"今晚被刀的是：（今晚没有人被刀）"`);
    assert(!/解药已用完/.test(noTarget), `没人被刀时不能说"解药已用完"（药还在）：${noTarget}`);
    assert(selfWitch, `被刀的是女巫自己 应当说"（被刀的是你自己，你不能自救）"，实际抓到：${JSON.stringify(segs)}`);
    assert(!/解药已用完/.test(selfWitch), `"不能自救" ≠ "解药已用完"：${selfWitch}`);
    assert(noAntidote, `解药真的用完了 才说"（解药已用完）"，实际抓到：${JSON.stringify(segs)}`);
    assert(!/解药：救/.test(noAntidote), `解药没了就不该把"解药：救"放进选项：${noAntidote}`);
    return `没被刀→"今晚没有人被刀。"｜刀的是自己→"（被刀的是你自己，你不能自救）"｜药没了→"（解药已用完）"｜正常→"你可以用解药救 TA"`;
  });

  await check('U. 座位每局重洗：你不固定是最后一号，座位表合法且按座位升序', async () => {
    // 以前是"群成员按入群顺序 + 你固定最后一号"，于是你永远是 9 号（9 人局）、发言也从固定的人开始。
    // 这条只建局不真打（不花 LLM 调用），连开 30 局看座位分布。
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      const g = (await store.listGroups())[0];
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const seats = [], valid = [], ascending = [], lastIsUser = [];
      for (let i = 0; i < 30; i++) {
        const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human: {}, handlers: {} });
        const s = game.state;
        seats.push(s.players.find((p) => p.isUser).seat);
        const list = s.players.map((p) => p.seat);
        valid.push(list.slice().sort((a, b) => a - b).join() === Array.from({ length: list.length }, (_, k) => k + 1).join());
        ascending.push(s.players.every((p, idx) => p.seat === idx + 1));
        lastIsUser.push(s.players[s.players.length - 1].isUser === true);
      }
      return {
        playerCount: members.length + 1,
        dist: seats.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}),
        distinct: new Set(seats).size,
        alwaysLast: seats.every((x) => x === 9) || seats.every((x) => x === members.length + 1),
        validAll: valid.every(Boolean),
        ascendingAll: ascending.every(Boolean),
        lastIsUserCount: lastIsUser.filter(Boolean).length,
      };
    })()`);
    assert(r.validAll, '座位表必须是 1..N 各一个');
    assert(r.ascendingAll, 'players 必须按座位升序（白天"按座位顺序依次发言"依赖它）');
    assert(!r.alwaysLast, `你的座位不能固定不变：${JSON.stringify(r.dist)}`);
    assert(r.distinct >= 4, `30 局里你的座位应当足够分散，实际 ${r.distinct} 种：${JSON.stringify(r.dist)}`);
    assert(r.lastIsUserCount <= 30 * 0.4, `你不能总是坐在末位（30 局里末位 ${r.lastIsUserCount} 次，随机期望约 ${(30 / r.playerCount).toFixed(1)} 次）`);
    return `30 局你的座位分布 ${JSON.stringify(r.dist)}（${r.distinct} 种）｜座位表合法且升序｜末位是你 ${r.lastIsUserCount} 次`;
  });

  await check('H. 狼人出卖同伴被拦下：悍跳查杀自己队友 → 纠正重说，群里不出现咬同伴', async () => {
    // 这条不依赖假模型的全局开关（那种做法会被别的用例干扰）：
    // 直接在页面里把 askLLM 换掉，让狼人的每次发言都"查杀自己的队友"，看引擎拦不拦得住。
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      await store.clearGroupMessages(g.id);
      const game = new w.WerewolfGame({
        group: g, members, settings: store.getSettings(), userName: '我', fastMode: true,
        human: {
          wolf: async (req) => ({ seat: (req.options[0] || {}).seat }),
          seer: async (req) => ({ seat: (req.options[0] || {}).seat }),
          witch: async () => ({ none: true }),
          vote: async (req) => ({ seat: (req.options[0] || {}).seat }),
          speech: async () => ({ text: '我先听听大家怎么说。' }),
          lastWords: async () => ({ text: '' }),
          shoot: async () => null,
        },
        handlers: {},
      });
      const s = game.state;
      const mateSeatOf = (player) => {
        const mate = s.players.find((p) => p.team === 'wolf' && String(p.id) !== String(player.id));
        return mate ? mate.seat : 0;
      };
      let betrayReturns = 0;
      // 只收集"本局"发布的发言：后台可能还有别的用例在跑对局，它们的消息也在同一个群里，
      // 用群里所有消息去套本局的狼同伴关系会误报。
      const mineSpeeches = [];
      game.handlers.onSpeech = (pl, text) => mineSpeeches.push({ seat: pl.seat, text: String(text) });
      const origAsk = game.askLLM.bind(game);
      game.askLLM = async (player, prompt, kind) => {
        // 狼人的每一次公开发言/遗言都返回"我是预言家 + 查杀队友"
        if (player && player.team === 'wolf' && /白天发言|遗言/.test(prompt)) {
          betrayReturns++;
          const mateSeat = mateSeatOf(player);
          const goodSeat = (s.players.find((p) => p.team !== 'wolf' && p.alive) || {}).seat || 1;
          return ['行啊，票送我走，那我就把话留这儿——我是预言家，昨晚验的 ' + mateSeat + ' 号，是狼。', '投票：' + goodSeat + '号'].join(String.fromCharCode(10));
        }
        return origAsk(player, prompt, kind);
      };
      await game.run();
      const msgs = await store.listGroupMessages(g.id);
      const betrayals = [];
      for (const sp of mineSpeeches) {
        const p = s.players.find((x) => x.seat === sp.seat);
        if (!p || p.team !== 'wolf') continue;
        if (w.looksLikeSellingTeammate(sp.text, s, p)) betrayals.push({ seat: sp.seat, text: sp.text.slice(0, 40) });
      }
      return {
        betrayReturns,
        speeches: mineSpeeches.length,
        betrayals: betrayals.length,
        sample: betrayals.slice(0, 2),
        guardNotes: (s.debug || []).filter((t) => /违规/.test(t)).length,
        wolfSeats: s.players.filter((p) => p.team === 'wolf').map((p) => p.seat),
        // 兜底记录不能进公开信息（s.log 会被拼进所有角色的提示词）
        leak: (s.log || []).some((t) => /出卖|咬了同伴|违规/.test(t)) || msgs.some((m) => /违规/.test(m.content)),
      };
    })()`);
    assert(r.betrayReturns > 0, '这一局应当至少有一次狼人发言（否则这条检查没测到东西）');
    assert(r.betrayals === 0, `群里不该出现狼人咬同伴，实际 ${r.betrayals} 条：${JSON.stringify(r.sample)}`);
    assert(r.guardNotes > 0, `引擎应当触发过纠正，实际 ${r.guardNotes} 次`);
    assert(!r.leak, '兜底记录不能进群、也不能进公开信息');
    assert(r.speeches > 0, '这一局应当有人发言');
    return `狼人被强制"查杀队友" ${r.betrayReturns} 次（狼座位 ${r.wolfSeats.join('/')}），引擎纠正 ${r.guardNotes} 次，${r.speeches} 条角色发言里咬同伴 0 条`;
  });

  await check('W. 普通消息也复用气泡；人工移除对照证明重绘检测有效', async () => {
    // 保险：万一 V 半路被别的异常打断，别让慢速流拖着后面所有用例（默认是关的）
    await fetch(`http://127.0.0.1:${MOCK_PORT}/slowstream?off=1`);
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      await window.__AICHAT__.openGroup(g.id);
      await new Promise((r2) => setTimeout(r2, 1000));
      document.querySelectorAll('.modal-mask, .onboard').forEach((n) => { try { n.__close && n.__close(); } catch {} n.remove(); });
      const body = document.querySelector('.gchat-body');
      if (!body) return { error: '聊天页列表不在' };
      const seeded = (await store.listGroupMessages(g.id)).length;
      const isMsg = (n) => n.nodeType === 1 && n.classList && n.classList.contains('msg');
      // 与 V 用例同款的判据：同一批里清掉≥2 条老气泡 = 整块重绘
      let rebuilds = 0;
      let batches = 0;
      let maxRemoved = 0;
      const obs = new MutationObserver((muts) => {
        batches += 1;
        let removed = 0;
        for (const m of muts) removed += [...m.removedNodes].filter(isMsg).length;
        if (removed > maxRemoved) maxRemoved = removed;
        if (removed >= 2) rebuilds += 1;
      });
      obs.observe(body, { childList: true, subtree: true, characterData: true });
      // 人工移除两条隐藏气泡，确认观察器确实看得见批量移除，再测正常消息。
      const controls = [document.createElement('div'), document.createElement('div')];
      controls.forEach(n => { n.className='msg'; n.hidden=true; body.appendChild(n); });
      controls.forEach(n => n.remove());
      await new Promise(r2 => setTimeout(r2, 0));
      const controlRebuilds = rebuilds;
      rebuilds = 0; batches = 0; maxRemoved = 0;
      const kept = body.querySelector('[data-mid]');
      const keptId = kept?.dataset.mid;
      // 一条普通群消息也必须通过键协调复用旧节点。
      const probe = await store.appendGroupMessage({
        groupId: g.id, role: 'assistant', speakerId: g.members[0], speakerName: '探针',
        content: '对照组探针：这条不是狼人杀消息', status: 'done',
      });
      await new Promise((r2) => setTimeout(r2, 1000));
      const seen = !!document.querySelector('[data-mid="' + probe.id + '"]');
      const counted = rebuilds;
      obs.disconnect();
      // 立刻清掉探针（连带它的重绘），别污染后面的用例
      await store.deleteGroupMessage(probe.id);
      await new Promise((r2) => setTimeout(r2, 600));
      return {
        rebuilds: counted, seen, seeded, batches, maxRemoved, controlRebuilds,
        kept: !kept || !body.querySelector('[data-mid="'+keptId+'"]') || body.querySelector('[data-mid="'+keptId+'"]') === kept,
        bodyAlive: body.isConnected,
        removed: !document.querySelector('[data-mid="' + probe.id + '"]'),
      };
    })()`);
    assert(!r.error, r.error || '对照组准备失败');
    assert(r.seen, '对照组消息应当出现在列表里');
    assert(r.controlRebuilds >= 1, '人工移除对照应当被检测到');
    assert(r.rebuilds === 0, `普通消息不应整块重绘，实际 ${r.rebuilds} 次`);
    assert(r.kept, '仍在当前页的旧气泡应复用原节点');
    assert(r.removed, '对照组探针消息应当已被删除（别污染后面的用例）');
    return `人工移除对照 ${r.controlRebuilds} 次，普通消息整块重绘 0 次，旧节点保留`;
  });

  /* ---------------- W. 被 max_tokens 截断的发言不能当成完整发言 ---------------- */
  await check('W. 发言被 max_tokens 截断（finish_reason=length）：放宽额度重问，仍被切则补"……"', async () => {
    // 一次发言调用：直接问引擎（不走整局），确定性最好
    const askOne = `(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: true, human: {}, handlers: {} });
      const s = game.state;
      const me = s.players.find((p) => !p.isUser && p.alive);
      const text = await game.askLLM(me, w.dayPromptFor(s, me), 'day', { live: true });
      return { seat: me.seat, name: me.name, text, debug: (s.debug || []).filter((x) => /没说完/.test(x)), warnings: s.warnings || [] };
    })()`;

    // ---- 第一次：soft（只切没放宽额度的那个请求）→ 引擎应当重问并拿到完整版 ----
    await fetch(`http://127.0.0.1:${MOCK_PORT}/truncate`);
    const before = (await fetch(`http://127.0.0.1:${MOCK_PORT}/seen`).then((r) => r.json())).seen.length;
    const soft = await page.eval(askOne);
    assert(soft.text, '重问之后应当拿到发言正文');
    assert(
      !/枪口$/.test(soft.text.trim()),
      `第二次请求额度已放宽，引擎应当采用完整版而不是半句，实际 = ${JSON.stringify(soft.text)}`
    );
    assert(/投票\s*[:：]/.test(soft.text), `完整版应当带着投票行，实际 = ${JSON.stringify(soft.text)}`);

    // 这两次请求必须是"同一条提问的两次尝试"：第一次 600、第二次放宽
    const requests = (await fetch(`http://127.0.0.1:${MOCK_PORT}/seen`).then((r) => r.json())).seen.slice(before);
    const speechReqs = requests.filter((x) => /【狼人杀 · 第 \d+ 天 · 白天发言】/.test(x.prompt));
    assert(speechReqs.length === 2, `截断后应当重问一次（共 2 次发言请求），实际 ${speechReqs.length} 次`);
    assert(speechReqs[0].maxTokens === 600, `第一次应当用引擎的默认额度 600，实际 ${speechReqs[0].maxTokens}`);
    assert(
      speechReqs[1].maxTokens > speechReqs[0].maxTokens,
      `重问应当放宽额度，实际 ${speechReqs[0].maxTokens} → ${speechReqs[1].maxTokens}`
    );
    // 关思考：所有狼人杀的请求都必须带 thinking=disabled（思考会和正文抢 max_tokens 预算）
    const withThinking = requests.filter((x) => x.thinking && x.thinking.type !== 'disabled');
    assert(
      withThinking.length === 0,
      `狼人杀的每一次调用都必须关掉思考，实际有 ${withThinking.length} 次没关（thinking=${JSON.stringify((withThinking[0] || {}).thinking)}）`
    );

    // ---- 第二次：hard（连重问也切）→ 引擎应当保留半句并补"……" ----
    await fetch(`http://127.0.0.1:${MOCK_PORT}/truncate?hard=1`);
    const hard = await page.eval(askOne);
    assert(hard.text, 'hard 模式下仍应保留半句（不能整条丢掉）');
    assert(/枪口/.test(hard.text), `hard 模式应当保留被截断的半句，实际 = ${JSON.stringify(hard.text)}`);
    assert(
      hard.text.trim().endsWith('……'),
      `重问仍被截断时应当在结尾补"……"，实际 = ${JSON.stringify(hard.text)}`
    );
    assert(hard.debug.length > 0, '被截断应当留下 debug 记录（排查用，且不进公开记录）');
    await fetch(`http://127.0.0.1:${MOCK_PORT}/truncate?off=1`);
    return `soft：600 → ${speechReqs[1].maxTokens} 重问拿到完整发言；hard：保留半句并补"……"`;
  });

  /* ---------------- X. 死因不外泄：叙述与引擎判定分离（见 core/werewolf.js 的 lastWordsPromptFor） ---------------- */
  await check('X. 死因不外泄：首夜双死时遗言提问里没有死因，引擎内部仍记得，真人 🔒 提示照旧', async () => {
    // 背景（线上实测，截图那局）：首夜"狼刀 + 女巫毒"造成双死时，两个死者的遗言里分别出现了
    // "狼第一刀砍了本座""被毒了啊"—— 因为遗言提示词第一行写着"你刚因为「女巫毒杀」出局了"，
    // 而遗言是**公开发言**，等于替女巫宣布毒药已经用掉、解药已经出手。
    // 现在的约定（docs/ARCHITECTURE.md 5.9）：
    //   · 进模型的提示词里 0 个死因 —— 死因只留在 state（player.deadReason），供"猎人能不能
    //     开枪（E 用例）/ 局末复盘"这类**引擎判定**用；
    //   · 真人的 🔒 私密提示仍然告诉他死因（README「你自己的死因同样只私下告诉你」）。
    // 局面按剧本搭，和截图那局同构：狼刀"你"（真人，村民），女巫毒一个 AI 好人。
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      await store.clearGroupMessages(g.id);
      const game = new w.WerewolfGame({ group: g, members, settings: store.getSettings(), userName: '我', fastMode: false, human: {}, handlers: {} });
${PAGE_ASSIGN}
      const s = game.state;
      assignToAI(w, game, { witch: 1, wolf: 2, seer: 1, hunter: 1 }); // 剧本角色全给 AI，真人固定当村民
      const me = s.players.find((p) => p.isUser);
      const poisonTarget = s.players.find((p) => !p.isUser && p.team === 'good' && p.role !== 'witch');
      const wolfSeat = s.players.find((p) => p.team === 'wolf').seat;
      const prompts = [];
      const humanAsks = [];
      game.askLLM = async (p, prompt) => {
        prompts.push({ seat: p.seat, prompt: String(prompt) });
        if (/刀杀：/.test(prompt)) return '刀杀：' + me.seat + '号';               // 狼刀真人
        if (/从下面这些里选一种/.test(prompt)) return '毒药：' + poisonTarget.seat + '号'; // 女巫毒 AI
        if (/查验：/.test(prompt)) return '查验：' + wolfSeat + '号';
        if (/开枪：/.test(prompt)) return '开枪：放弃';
        if (/【狼人杀 · 遗言】/.test(prompt)) return '我是 ' + p.seat + ' 号，我没什么好说的。';
        return '';
      };
      // 真人的两个决策口（遗言 / 开枪）：只记下 hint，选"跳过"
      game.askHuman = async (kind, req) => { humanAsks.push({ kind: String(kind), hint: String((req && req.hint) || '') }); return null; };
      s.phase = 'night';
      await game.phaseNight();
      await game.phaseDawn();
      const msgs = await store.listGroupMessages(g.id);
      const out = {
        dead: s.players.filter((p) => !p.alive).map((p) => ({ seat: p.seat, isUser: !!p.isUser, role: p.role, reason: p.deadReason })),
        askCount: prompts.length,
        lwCount: prompts.filter((x) => /【狼人杀 · 遗言】/.test(x.prompt)).length,
        lwHasNoCauseRule: prompts.some((x) => /【狼人杀 · 遗言】/.test(x.prompt) && /没有人知道你是怎么死的/.test(x.prompt)),
        leaks: prompts
          .filter((x) => /(女巫毒杀|狼人刀杀|因为「|刚刚出局（)/.test(x.prompt))
          .map((x) => ({ seat: x.seat, hit: (x.prompt.match(/(女巫毒杀|狼人刀杀|因为「|刚刚出局（)/) || [])[0] })),
        publicText: msgs.map((m) => String(m.content || '')).join(' ｜ '),
        privLog: s.privLog || [],
        humanHints: humanAsks.map((x) => x.kind + ' → ' + x.hint),
      };
      w.clearGame(s.groupId); // 别把这一局的存档留给后面的用例
      return out;
    })()`);
    const knifeRow = r.dead.find((p) => p.isUser);
    const poisonRow = r.dead.find((p) => !p.isUser);
    // ① 局面真的跑到了（否则后面两条断言是空的）
    assert(r.dead.length === 2, `首夜应当一刀一毒死两人，实际 ${JSON.stringify(r.dead)}`);
    assert(knifeRow && knifeRow.reason === '狼人刀杀', `引擎侧要记得"真人被刀"：${JSON.stringify(r.dead)}`);
    assert(poisonRow && poisonRow.reason === '女巫毒杀', `引擎侧要记得"AI 被毒"：${JSON.stringify(r.dead)}`);
    assert(r.lwCount >= 1, `首夜死者必须真的被问过遗言（否则这条没测到东西）｜提问 ${r.askCount} 次`);
    // ② 进模型的提示词里一个死因都没有（遗言提示 / 猎人开枪提示都算）
    assert(r.leaks.length === 0, `进模型的提示词里出现了死因：${JSON.stringify(r.leaks)}`);
    assert(r.lwHasNoCauseRule, '遗言提示词必须写明"没有人知道你是怎么死的"（免得模型自己编一个死因说出去）');
    // ③ 公开面（法官公告 + 遗言）同样 0 死因
    assert(!/(女巫毒杀|狼人刀杀)/.test(r.publicText), `公开群聊里出现了死因：${r.publicText.slice(0, 200)}`);
    // ④ 真人这一侧的设计不变：🔒 私密提示 + 遗言 hint 仍然告诉他死因（要改这条得连着 README 一起改）
    assert(
      r.privLog.some((t) => /你出局了（狼人刀杀）/.test(t)),
      `真人的 🔒 私密提示应当带死因，实际 ${JSON.stringify(r.privLog)}`
    );
    assert(
      r.humanHints.some((t) => /^lastWords/.test(t) && /狼人刀杀/.test(t)),
      `真人自己的遗言提示应当带死因，实际 ${JSON.stringify(r.humanHints)}`
    );
    return `首夜双死（真人被刀 / AI 被毒）：引擎 deadReason 完整；${r.askCount} 条提问与公开消息里 0 个死因；真人 🔒 提示照旧带死因`;
  });

  /* ---------------- Z. 顺序发言：前置位不能质问"后面的人怎么不说话" ---------------- */
  await check('Z. 顺序发言：发言提示词讲清顺序，"催还没轮到的人"被引擎拦下', async () => {
    // 背景（2026-09-21 修的那条）：白天按座位顺序依次发言，后置位那一刻**还没轮到**，
    // 可前几位会去质问"9 号被人捞了一整轮还不出声"——把"还没轮到"读成"故意躲着"，
    // 这个假疑点会一路污染后面的推理。修法：提示词里加【发言顺序】+ 引擎兜底。
    // 这里让假模型**故意**照提示词里的"还没轮到的"去踩那一位，看拦不拦得住。
    await fetch(`http://127.0.0.1:${MOCK_PORT}/urge`).then((r) => r.json());
    const r = await page.eval(`(async () => {
      const w = await import('./core/werewolf.js');
      const store = await import('./core/store.js');
      const g = (await store.listGroups())[0];
      const chars = await store.listCharacters();
      const members = g.members.map((id) => chars.find((c) => c.id === id)).filter(Boolean);
      await store.clearGroupMessages(g.id);
      const game = new w.WerewolfGame({
        group: g, members, settings: store.getSettings(), userName: '我', fastMode: true,
        human: {
          wolf: async (req) => ({ seat: (req.options[0] || {}).seat }),
          seer: async (req) => ({ seat: (req.options[0] || {}).seat }),
          witch: async () => ({ none: true }),
          vote: async (req) => ({ seat: (req.options[0] || {}).seat }),
          speech: async () => ({ text: '我先听听大家怎么说。' }),
          lastWords: async () => ({ text: '' }),
          shoot: async () => null,
        },
        handlers: {},
      });
      // 只收集"本局"落库的发言（后台没有别的对局，但保持与 G 用例一致的写法）
      const mineSpeeches = [];
      game.handlers.onSpeech = (pl, text) => mineSpeeches.push({ seat: pl.seat, text: String(text) });
      /** 每一次发言提问都要带顺序说明，这里逐条记下来核对 */
      const asks = [];
      const origAsk = game.askLLM.bind(game);
      game.askLLM = async (player, prompt, kind) => {
        const p = String(prompt);
        if (/【狼人杀 · 第 \\d+ 天 · 白天发言】/.test(p)) asks.push({ seat: player.seat, prompt: p });
        return origAsk(player, prompt, kind);
      };
      await game.run();
      const urgeRe = /不吭声|没吭声|不出声|没出声|不说话|没说话|不表态|没表态|沉默|装死/;
      const speeches = mineSpeeches.map((x) => x.text);
      return {
        speeches: speeches.length,
        urges: speeches.filter((t) => urgeRe.test(t)).length,
        sample: speeches.filter((t) => urgeRe.test(t)).slice(0, 2),
        asks: asks.length,
        withOrderNote: asks.filter((x) => /【发言顺序（重要）】/.test(x.prompt)).length,
        withRank: asks.filter((x) => /你是第 \\d+ 位/.test(x.prompt)).length,
        // 每次发言都要交代"身后的人还没轮到"（最后一位发言的人则是"身后没人了"）
        withPendingWords: asks.filter((x) => /还没有机会开口|你身后没有还没发言的人/.test(x.prompt)).length,
        // guardSilenceUrge 的措辞是「…的发言在催还没轮到的人（X 号），已要求重说」
        guardNotes: (game.state.debug || []).filter((t) => /在催还没轮到的人/.test(t)).length,
        debugLen: (game.state.debug || []).length,
        // 兜底之后不许把"谁在催谁"写进公开记录（那是公开面，会进所有人的提示词）
        leakToLog: /在催还没轮到的人|还没轮到/.test(String((game.state.log || []).join('\\n'))),
      };
    })()`);
    const calls = await fetch(`http://127.0.0.1:${MOCK_PORT}/calls`).then((x) => x.json());
    await fetch(`http://127.0.0.1:${MOCK_PORT}/urge?off=1`); // 关掉，别影响后面的用例
    assert(calls.urgeAttempts > 0, `假模型应当真的催过后置位（否则这条检查没测到东西）｜提问分类统计 ${JSON.stringify(calls.askTally)}`);
    assert(r.asks > 0, '这一局应当有人发言过');
    assert(r.withOrderNote === r.asks, `每一次发言提问都要带【发言顺序（重要）】，实际 ${r.withOrderNote}/${r.asks}`);
    assert(r.withRank === r.asks, `每一次发言提问都要写明"你是第 N 位"，实际 ${r.withRank}/${r.asks}`);
    assert(r.withPendingWords === r.asks, `每一次发言提问都要交代"身后的人还没轮到"，实际 ${r.withPendingWords}/${r.asks}`);
    assert(r.guardNotes > 0, `引擎应当拦下过"催还没轮到的人"，实际 ${r.guardNotes} 次｜debug=${r.debugLen} 条`);
    assert(r.urges === 0, `群里不该出现"催还没轮到的人"的发言，实际 ${r.urges} 条：${JSON.stringify(r.sample)}`);
    assert(!r.leakToLog, '兜底记录不能进公开记录（那会拼进所有人的提示词）');
    return `假模型故意催后置位 ${calls.urgeAttempts} 次，引擎拦下 ${r.guardNotes} 次；${r.speeches} 条发言里"催沉默"0 条；${r.asks} 次发言提问都带【发言顺序】/第几位/还没轮到的人`;
  });

  await check('D. 全程无未捕获异常', async () => {
    const problems = page.problems || [];
    assert(problems.length === 0, `控制台报错：${problems.slice(0, 3).join(' | ')}`);
    return '0 个异常';
  });

  code = failed === 0 ? 0 : 1;
} finally {
  console.log(`\n================ 狼人杀端到端结果：${passed} 通过 / ${failed} 失败 ================`);
  if (failures.length) console.log(`\n失败详情：\n - ${failures.join('\n - ')}`);
  await page.close();
  child.kill('SIGKILL');
  await new Promise((r) => mock.close(r));
  try {
    fs.rmSync(TMP_DATA, { recursive: true, force: true });
  } catch {}
}
process.exit(code);
