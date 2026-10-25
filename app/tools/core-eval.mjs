#!/usr/bin/env node
/** Isolated, zero-dependency memory evaluation; live mode is always explicit. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { launch, freePort, sleep } from './cdp.mjs';
import { PROVIDERS_META } from '../data/models.js';
import { SCENARIOS, VERSION, VARIANTS, PILOT_IDS, scoreAnswer } from './core-eval/scenarios.mjs';
import { writeReport } from './core-eval/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]).sort();
}
function databaseFingerprint() {
  const dir = path.join(root, 'data/db');
  const rows = files(dir).map((p) => [path.relative(dir, p), sha(fs.readFileSync(p))]);
  return { fileCount: rows.length, sha256: sha(JSON.stringify(rows)) };
}
function atomicJson(filename, data) {
  const tmp = `${filename}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, filename);
}
function configuration(live) {
  if (!live) return { provider: 'openai', model: 'PIPELINE-MOCK-NOT-REAL', baseUrl: null, apiKey: '', params: { temperature: 0, topP: 1, maxTokens: 256, thinking: false } };
  let supplied;
  if (args.includes('--from-site')) {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'data/db/settings.json'), 'utf8'));
    // Only these connection fields are used. User profile and chat content never enter fixtures.
    const provider = s.provider, meta = PROVIDERS_META[provider];
    supplied = { provider, model: s.model, baseUrl: s.baseUrls?.[provider] || meta?.baseUrl,
      apiKey: s.apiKeys?.[provider] || process.env.MEMORY_EVAL_API_KEY || '', params: s.params };
    if (s.useProxy && !supplied.apiKey && meta?.needKey !== false) throw Error('网站使用服务端密钥。请通过 MEMORY_EVAL_API_KEY 提供同一密钥，或使用 --config；不会扫描 .env。');
  } else {
    const filename = option('--config', '');
    if (!filename) throw Error('真实调用需要 --from-site 或 --config 文件。');
    supplied = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
    supplied.apiKey = process.env[supplied.apiKeyEnv || 'MEMORY_EVAL_API_KEY'] || '';
  }
  const meta = PROVIDERS_META[supplied.provider];
  if (!meta || !['openai', 'ollama'].includes(meta.kind)) throw Error('当前评测桥仅支持项目已有的 OpenAI 兼容接口；不支持此配置的协议。');
  if (!supplied.model || !supplied.baseUrl) throw Error('缺少模型名或接口地址。');
  const url = new URL(supplied.baseUrl);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw Error('接口地址不能含凭据、查询参数或片段。');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('外部模型接口必须使用 HTTPS。');
  if (meta.needKey !== false && !supplied.apiKey) throw Error('本地配置没有可用密钥；请设置评测专用环境变量。');
  return { ...supplied, baseUrl: supplied.baseUrl.replace(/\/+$/, ''), params: {
    temperature: 0, topP: 1, maxTokens: 256, thinking: false, ...supplied.params,
    // Fixed across every answer variant; production extractor keeps its own 0.3/1100 parameters.
    temperature: Number(option('--temperature', '0')), maxTokens: 256,
  } };
}

if (args.includes('--help') || !args.some((x) => ['--live', '--dry-run', '--list'].includes(x))) {
  console.log('记忆效果评测（Node.js 22+，本地 Chrome/Edge）\n'
    + '  node tools/core-eval.mjs --list\n'
    + '  node tools/core-eval.mjs --dry-run --full\n'
    + '  node tools/core-eval.mjs --live --pilot --from-site\n'
    + '  node tools/core-eval.mjs --live --full --config tools/core-eval/config.local.json --max-calls 400\n'
    + '选项：--variants current,no_memory,...  --ids 场景ID,...  --out 目录  --max-calls N\n'
    + '默认选2个场景、no_memory/current两组。--full为18场景、3组，默认每场景重复2次。无自动重试整轮或断点续跑。');
  process.exit(0);
}
if (args.includes('--list')) { console.log(JSON.stringify({ version: VERSION, variants: VARIANTS, scenarios: SCENARIOS }, null, 2)); process.exit(0); }
if (args.includes('--live') && args.includes('--dry-run')) throw Error('--live 和 --dry-run 不能同时使用');
const live = args.includes('--live'), full = args.includes('--full');
let selected = full ? SCENARIOS : SCENARIOS.slice(0,2);
if (option('--ids', '')) {
  const ids = option('--ids', '').split(',');
  if (ids.some((id) => !SCENARIOS.some((s) => s.id === id))) throw Error('存在未知场景ID');
  selected = SCENARIOS.filter((s) => ids.includes(s.id));
}
const variants = option('--variants', full ? Object.keys(VARIANTS).join(',') : 'no_memory,current').split(',');
if (!variants.length || new Set(variants).size !== variants.length || variants.some((v) => !VARIANTS[v])) throw Error('对照组名称无效或重复');
const maxCalls = Number(option('--max-calls', full ? '400' : '24'));
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw Error('--max-calls 必须为正整数');
const config = configuration(live);
if (!Number.isFinite(config.params.temperature) || config.params.temperature < 0 || config.params.temperature > 2) throw Error('temperature 必须为0至2');
if (config.pricing) {
  for (const key of ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion']) {
    if (config.pricing[key] != null && (!Number.isFinite(config.pricing[key]) || config.pricing[key] < 0)) throw Error('价格必须是非负数值');
  }
  if (!config.pricing.source || !config.pricing.currency || !config.pricing.checkedAt) throw Error('计费估算需附币种、价格来源和核价日期');
}
const repeats = Number(option('--repeats','2'));
if(!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('repeats 1..5');
selected=Array.from({length:repeats},(_,rep)=>selected.map(s=>({...s,baseId:s.id,id:s.id+'-r'+(rep+1),repeat:rep+1}))).flat();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(option('--out', path.join(workspace, 'artifacts/memory-eval', `${stamp}-${live ? 'live' : 'pipeline'}`)));
if (out === root || out.startsWith(path.join(root, 'data') + path.sep) || fs.existsSync(out)) throw Error('输出目录必须是未存在的新目录，且不能位于真实数据目录中');
fs.mkdirSync(out, { recursive: true });
const beforeDb = databaseFingerprint();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-memory-eval-'));
let page, server, active = {}, apiCalls = 0, stopReason = null;
const calls = [], rows = [], preparations = [];
const interruptController = new AbortController();
const onInterrupt = () => { stopReason = 'interrupted'; interruptController.abort(); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
const started = new Date().toISOString();
const publicConfig = { provider: config.provider, model: config.model, baseUrl: config.baseUrl, answerParams: config.params,
  extractionParams: { temperature: 0.3, topP: 1, maxTokens: 1100, thinking: false }, pricing: config.pricing || null };
const sourceManifest = [];
for (const dir of ['core', 'data', 'tools/core-eval']) for (const filename of files(path.join(root, dir))) {
  const rel = path.relative(root, filename);
  if (dir === 'data' && !['models.js','contest-templates.js'].includes(path.basename(rel))) continue;
  if (!/\.(?:js|mjs)$/.test(rel) || rel.startsWith(`data${path.sep}db${path.sep}`)) continue;
  const bytes = fs.readFileSync(filename), dest = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes);
  sourceManifest.push({ path: rel, sha256: sha(bytes) });
}
for (const rel of ['tools/core-eval.mjs', 'tools/cdp.mjs']) sourceManifest.push({ path: rel, sha256: sha(fs.readFileSync(path.join(root, rel))) });
fs.cpSync(path.join(sandbox, 'core'), path.join(out, 'source/core'), { recursive: true });
fs.cpSync(path.join(sandbox, 'data'), path.join(out, 'source/data'), { recursive: true });
fs.cpSync(path.join(sandbox, 'tools'), path.join(out, 'source/tools'), { recursive: true });
for (const rel of ['tools/core-eval.mjs', 'tools/cdp.mjs']) fs.copyFileSync(path.join(root, rel), path.join(out, 'source', rel));
atomicJson(path.join(out, 'scenarios.json'), selected);
atomicJson(path.join(out, 'source-manifest.json'), sourceManifest);
const protocol = { version: VERSION, mode: live ? 'live' : 'pipeline-only', started, configuration: publicConfig,
  scenarioSha256: sha(JSON.stringify(selected)), sourceSha256: sha(JSON.stringify(sourceManifest)),
  variants, scenarioIds: selected.map((s) => s.id), repeats, maxCalls, node: process.version,
  design: 'Frozen new chat/group cases; independent extraction and independent summary per case/repeat; same audience evidence and management actions, same model/answer params/4000 budget; cyclic order; all runs retained',
  expectedCells: selected.length * variants.length, prepSharedAcrossVariants: true };
atomicJson(path.join(out, 'protocol.json'), protocol);

function persist() {
  atomicJson(path.join(out, 'results.json'), { protocol, preparations, rows, stopReason });
}
function mockResponse(body) {
  const isExtract = body.messages[0]?.content.includes('记忆整理助手');
  let content = '不知道';
  if (isExtract) {
    const raw = body.messages.at(-1).content.split('新增聊天记录（JSON，id用于sourceIds）：\n').at(-1);
    const sources = JSON.parse(raw);
    const source = sources.find((r) => !r.content.includes('普通闲聊'));
    content = JSON.stringify({ summary: source?.content || '', facts: source ? [{ text: source.content, sourceIds: [source.id] }] : [] });
  }
  return { model: config.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    // Intentionally no usage: dry-run must not look like measured tokens or cost.
  };
}

async function bridge(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (apiCalls >= maxCalls) { stopReason = 'max_calls'; res.writeHead(402).end('{"error":{"message":"评测调用上限已达到"}}'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body.model !== config.model || body.stream) { res.writeHead(400).end('{"error":{"message":"模型或流式参数不符合冻结协议"}}'); return; }
  const call = { index: ++apiCalls, ...active, started: new Date().toISOString(), request: body };
  const start = performance.now();
  try {
    let payload, status = 200;
    if (live) {
      const upstream = await fetch(`${config.baseUrl}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(100000), interruptController.signal]) });
      status = upstream.status;
      if (!upstream.ok) {
        // Never persist upstream error bodies: some relays echo authentication headers.
        call.httpStatus = status;
        throw Error(`上游接口HTTP ${status}`);
      }
      payload = await upstream.json();
    } else payload = mockResponse(body);
    // Whitelist only standard response fields, never relay headers or unknown debug fields.
    call.response = { id: payload.id, model: payload.model, choices: payload.choices, usage: payload.usage,
      system_fingerprint: payload.system_fingerprint };
    call.httpStatus = status;
    res.writeHead(status).end(JSON.stringify(call.response));
  } catch (error) {
    call.error = /^上游接口HTTP \d+$/.test(error.message) ? error.message : '模型请求失败或超时（外部错误正文未保存）';
    // Do not silently retry paid calls. 400 bypasses the app adapter's retry loop.
    res.writeHead(400).end(JSON.stringify({ error: { message: call.error } }));
  } finally {
    call.elapsedMs = Math.round(performance.now() - start); calls.push(call);
    fs.appendFileSync(path.join(out, 'calls.jsonl'), JSON.stringify(call) + '\n', { mode: 0o600 });
  }
}

try {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/model/v1/chat/completions') return await bridge(req, res);
      if (req.method === 'GET' && req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<!doctype html><meta charset="utf-8"><title>隔离记忆评测</title><script type="module" src="/tools/core-eval/browser.mjs"></script>');
      }
      const rel = new URL(req.url, origin).pathname.slice(1);
      // Allowlist only copied JS modules. No API/db, settings, real app HTML, env or arbitrary file access.
      if (req.method === 'GET' && /^(core|data|tools\/core-eval)\/[a-zA-Z0-9_./-]+\.(js|mjs)$/.test(rel) && !rel.includes('..')) {
        const filename = path.join(sandbox, rel);
        if (fs.existsSync(filename)) { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fs.readFileSync(filename)); }
      }
      res.writeHead(404).end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  page = await launch({ port: await freePort() });
  page.client.timeoutMs = 240000;
  await page.goto(origin);
  for (let i = 0; i < 150; i++) { if (await page.eval('!!window.coreEvaluation')) break; if (i === 149) throw Error('评测页面模块加载失败'); await sleep(100); }
  await page.eval(`window.coreEvaluation.configure(${JSON.stringify({ provider: config.provider, model: config.model, params: config.params })})`);
  for (const [i, scenario] of selected.entries()) {
    if (stopReason) break;
    if (apiCalls >= maxCalls) { stopReason = 'max_calls'; break; }
    active = { scenarioId: scenario.id, phase: 'prepare', variant: 'shared_preparation' };
    console.log(`[${i + 1}/${selected.length}] ${scenario.id}：提取记忆`);
    const prepCallStart = calls.length, prepStart = performance.now();
    const prepared = await page.eval(`window.coreEvaluation.prepare(${JSON.stringify(scenario)},${JSON.stringify(String(i))})`);
    preparations.push({ scenarioId: scenario.id, ...prepared, elapsedMs: Math.round(performance.now() - prepStart),
      callIndexes: calls.slice(prepCallStart).map((c) => c.index), error: calls.slice(prepCallStart).some((c) => c.error) });
    persist();
    if (calls.slice(prepCallStart).some((c) => c.error)) { stopReason ||= 'upstream_error'; break; }
    // Rotate order deterministically; no choosing the best answer or retrying a failed cell.
    const order = [...variants.slice(i % variants.length), ...variants.slice(0, i % variants.length)];
    for (const variant of order) {
      if (stopReason) break;
      if (apiCalls >= maxCalls) { stopReason = 'max_calls'; break; }
      active = { scenarioId: scenario.id, phase: 'answer', variant };
      const assembled = await page.eval(`window.coreEvaluation.assemble(${JSON.stringify(variant)})`);
      const row = { scenarioId: scenario.id, category: scenario.category, variant, expected: scenario.reference,
        messages: assembled.messages, meta: assembled.meta, injectedMemory: assembled.memory, recentExperiences: assembled.recentExperiences,
        preparationCallIndexes: ['no_memory'].includes(variant) ? [] : preparations.at(-1).callIndexes };
      const callStart = calls.length, start = performance.now();
      try {
        Object.assign(row, await page.eval(`window.coreEvaluation.answer(${JSON.stringify(assembled.messages)})`));
        row.score = scoreAnswer(scenario, row.text, { truncated: row.truncated });
      } catch {
        row.error = calls.slice(callStart).find((c) => c.error)?.error || '模型调用或浏览器执行失败';
        row.score = scoreAnswer(scenario, '', { error: true });
      }
      row.elapsedMs = Math.round(performance.now() - start);
      row.callIndexes = calls.slice(callStart).map((c) => c.index);
      rows.push(row); persist();
      console.log(`  ${variant}: ${row.score.status}`);
      if (calls.at(-1)?.error) { stopReason ||= 'upstream_error'; break; }
    }
    if (stopReason) break;
  }
} catch (error) {
  stopReason = 'runner_error';
  // Internal diagnostics have no key or upstream response body.
  fs.writeFileSync(path.join(out, 'runner-error.txt'), String(error.stack));
  console.error('评测执行中断，已保留完成部分及本地诊断。');
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  if (page) await page.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(sandbox, { recursive: true, force: true });
  const afterDb = databaseFingerprint();
  const unchanged = JSON.stringify(beforeDb) === JSON.stringify(afterDb);
  const isolation = { before: beforeDb, after: afterDb, unchanged,
    method: 'sorted relative paths + SHA-256 contents; one isolated browser origin/profile; only copied JS served; no real DB API' };
  atomicJson(path.join(out, 'isolation.json'), isolation);
  protocol.finished = new Date().toISOString();
  protocol.completedCells = rows.length; protocol.apiCalls = apiCalls;
  protocol.complete = !stopReason && rows.length === protocol.expectedCells;
  atomicJson(path.join(out, 'protocol.json'), protocol); persist();
  const report = writeReport({ out, protocol, rows, preparations, calls, scenarios: selected, isolation, stopReason });
  console.log(`报告：${path.join(out, 'report.md')}\n完成 ${rows.length}/${protocol.expectedCells}，接口调用 ${apiCalls} 次，原数据库校验${unchanged ? '一致' : '发生变化，请检查同期其他程序写入'}。`);
  if (stopReason || !unchanged || report.errors) process.exitCode = 1;
}
