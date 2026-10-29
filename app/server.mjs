#!/usr/bin/env node
/**
 * AI 聊天网站 · 零依赖服务器
 *
 * 两个职责：
 *   1. 托管 app/ 目录下的静态文件（原生 ES Module 需要 http:// 才能加载；
 *      同时也满足麦克风等 API 对 secure context 的要求，127.0.0.1/localhost 视为安全来源）。
 *   2. /api/llm 固定调用项目内的 Qwen3；/api/tts 云语音已停用。
 *
 * 推荐：node local-start.mjs（同时准备模型并启动网站）。
 * node server.mjs 只启动网站；仅在项目模型服务已启动时单独使用。
 * 支持 --port 8080、--host 0.0.0.0、--no-open。
 * 局域网访问需在 app/.env 设置 AICHAT_PROXY_TOKEN；无需模型 API Key。
 */

import { LOCAL_MODEL, LOCAL_BASE_URL, localOutputTokens, localContextError } from './core/local-model.js';
import { applyChanges, validateBackup } from './core/sync.js';
import { mergeEntity } from './core/entity-sync.js';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname));

/* ------------------------------------------------------------------ *
 * 参数与配置
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return fallback;
}
const hasFlag = (name) => argv.includes(`--${name}`);

loadEnvFile();

const PORT = Number(argValue('port', process.env.PORT || 5180));
const HOST = argValue('host', process.env.HOST || '127.0.0.1');
const AUTO_OPEN = !hasFlag('no-open');

/* ------------------------------------------------------------------ *
 * 代理上游的超时（只作用于 /api/llm）
 *
 * 为什么必须有：这是全项目唯一"服务端自己没有任何兜底"的链路。
 * 上游连上却不响应时，Node 内置 fetch（undici）默认要等 300 秒才会放弃，
 * 期间浏览器端只能干等自己的看门狗（默认 120 秒空闲 / 10 分钟总时限）。
 * 之前的实测：假上游收下请求后不响应，客户端 200 秒没拿到任何字节。
 * 更糟的是"每 ~59 秒滴一个字节"的上游 —— undici 的 bodyTimeout 会被每次数据重置，
 * 于是服务端永不超时，只能靠浏览器兜底。
 *
 * 两个口子都要堵：
 *   · FIRST_BYTE：连接 + 首字节（含响应头）上限；
 *   · IDLE：流已经建立后，"多久没有新数据"上限（每收到一块就重置）。
 * 超时时写一帧中文 error 再结束，客户端能显示"上游超时"而不是"模型没有返回任何内容"。
 * ------------------------------------------------------------------ */
const UPSTREAM_FIRST_BYTE_MS = 30_000;
const UPSTREAM_IDLE_MS = 90_000;

/** 读取 .env（零依赖手写解析，简单的 KEY=VALUE） */
function loadEnvFile() {
  const candidates = [
    path.join(ROOT, '.env'),
    path.join(path.dirname(ROOT), '.env'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const idx = t.indexOf('=');
        if (idx < 1) continue;
        const key = t.slice(0, idx).trim();
        let val = t.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
      }
      console.log(`[env] 已加载 ${path.relative(process.cwd(), file) || file}`);
    } catch (err) {
      console.warn('[env] 读取失败：', err.message);
    }
  }
}

const PROXY_TOKEN = process.env.AICHAT_PROXY_TOKEN || '';

/** 接口地址由项目固定，浏览器不能把模型请求转到其他地址。 */
function checkUpstreamOverride(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (base && base !== LOCAL_BASE_URL) return { ok: false, error: '仅允许项目内的本地模型接口' };
  return { ok: true, base: LOCAL_BASE_URL };
}

const UPSTREAM = { ollama: { kind: 'openai', baseUrl: LOCAL_BASE_URL } };

/* ------------------------------------------------------------------ *
 * 静态文件服务
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * 归一化请求路径：解码 → 统一分隔符 → 折叠 `.` / `..` / 重复斜杠。
 *
 * 为什么必须"先归一化再判断敏感路径"：敏感路径检查原来是拿**原始**路径做的正则，
 * 于是 `/x/../.env.example` 既不以 `/.env` 开头、也不匹配 `/^\/data\/db/`，
 * 顺利通过检查后被 `path.normalize` 折叠成 `.env.example` 读了出去（已复现）。
 * 同一招也能读到 `data/db/settings.json`（里面有 API Key）。
 *
 * @param {string} urlPath 原始 `req.url`（可带查询串）
 * @returns {string|null} 以 `/` 开头的归一化路径；`null` 表示非法（非法编码 / 含 NUL）
 */
function normalizeUrlPath(urlPath) {
  const raw = String(urlPath || '').split('?')[0].split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // %zz 这类非法编码：直接拒绝，别让它带着原样字符串往下走
  }
  if (decoded.includes('\0')) return null;
  // Windows 上 `\` 也是分隔符，统一成正斜杠，避免 `/x/..\.env` 绕过
  decoded = decoded.replace(/\\/g, '/');
  return path.posix.normalize(decoded.startsWith('/') ? decoded : '/' + decoded);
}

/**
 * 从"相对 app 根目录的路径"判断是否属于禁止通过 HTTP 暴露的内容。
 * @param {string} rel 形如 `data/db/settings.json`、`.env.example`、`tools/e2e.mjs`
 * @returns {boolean}
 */
function isProtectedPath(rel) {
  if (!rel || rel === '.') return false;
  const segs = rel.toLowerCase().split('/').filter(Boolean);
  if (!segs.length) return false;
  // 本地数据库目录（settings.json 里有 API Key）—— 但 data/models.js 是应用模块，只能精确挡 data/db
  if (segs[0] === 'data' && segs[1] === 'db') return true;
  // 测试脚本目录
  if (segs[0] === 'tools') return true;
  // 点文件与点目录：.env、.env.example、.gitignore、.DS_Store、.git/…
  if (segs.some((s) => s.startsWith('.'))) return true;
  return false;
}

async function serveStatic(req, res, urlPath) {
  const norm = normalizeUrlPath(urlPath);
  if (norm === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
    return;
  }
  const rel = norm === '/' ? '/index.html' : norm;
  // 落成绝对路径（`. + rel` 保证是"根目录下的相对路径"，不会被当成绝对路径整段丢掉）
  const target = path.resolve(ROOT, '.' + rel);
  // 防目录穿越：必须仍在 app 根目录内（比较时带上分隔符，避免 /app-other 这种同前缀目录）
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('403 Forbidden');
    return;
  }
  // 敏感路径：在**归一化之后**判断（见 normalizeUrlPath 的注释）
  if (isProtectedPath(path.relative(ROOT, target).split(path.sep).join('/'))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
    return;
  }
  // 自定义 --data-dir 时同样保护真实数据库目录
  if (target.toLowerCase() === DATA_DIR.toLowerCase() || target.toLowerCase().startsWith(DATA_DIR.toLowerCase() + path.sep)) {
    res.writeHead(403).end('403 Forbidden');
    return;
  }
  let filePath = target;
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // SPA 回退：未知路径交给 index.html（哈希路由不需要，但更稳妥）
    if (!path.extname(filePath)) filePath = path.join(ROOT, 'index.html');
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
  }
  try {
    const real = await fsp.realpath(filePath);
    const realRoot = await fsp.realpath(ROOT);
    const realData = await fsp.realpath(DATA_DIR).catch(() => DATA_DIR);
    if (!real.startsWith(realRoot + path.sep) || isProtectedPath(path.relative(realRoot, real).split(path.sep).join('/')) ||
        real.toLowerCase() === realData.toLowerCase() || real.toLowerCase().startsWith(realData.toLowerCase() + path.sep)) {
      res.writeHead(403).end('403 Forbidden'); return;
    }
    const data = await fsp.readFile(real);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // HTML 与模块都要求每次校验，避免拿到旧代码
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

/* ------------------------------------------------------------------ *
 * 代理：/api/llm
 * ------------------------------------------------------------------ */

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    // 先看 Content-Length：能提前拒绝，不用把 5MB 读进来
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limit) {
      const err = new Error('请求体过大');
      err.tooLarge = true;
      reject(err);
      return;
    }
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        // 不要在 reject 前 destroy：那会让服务端来不及回响应，
        // 客户端只看到 ECONNRESET（浏览器表现为 Failed to fetch）
        aborted = true;
        const err = new Error('请求体过大');
        err.tooLarge = true;
        req.pause();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 把前端的 messages/params 转成各家协议的上游请求 */
function buildUpstream(_provider, _model, messages, params, _key, _base, stream) {
  return {
    url: `${LOCAL_BASE_URL}/chat/completions`,
    headers: { 'Content-Type': 'application/json' },
    body: { model: LOCAL_MODEL, messages, stream,
      temperature: params.temperature, top_p: params.topP, max_tokens: localOutputTokens(params.maxTokens),
      presence_penalty: params.presencePenalty, frequency_penalty: params.frequencyPenalty }
  };
}

/** 把各家 SSE 统一成 OpenAI 风格的 data: {"choices":[{"delta":{"content":"..."}}]} */
function makeTransformer(kind, provider) {
  const enc = new TextEncoder();
  let buf = '';
  return {
    /** @returns {Uint8Array|null} 需要转发给客户端的数据；null 表示无需转发 */
    feed(chunkText) {
      buf += chunkText;
      const events = buf.split('\n');
      buf = events.pop() || '';
      const out = [];
      for (const raw of events) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') out.push('data: [DONE]\n\n');
          continue;
        }
        if (kind === 'openai') {
          out.push(`data: ${data}\n\n`);
          continue;
        }
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (kind === 'anthropic') {
          if (obj.type === 'content_block_delta' && obj.delta?.text) {
            out.push(`data: ${JSON.stringify({ choices: [{ delta: { content: obj.delta.text } }] })}\n\n`);
          } else if (obj.type === 'message_delta') {
            // stop_reason 必须转发：`max_tokens` 意味着这段话被截断了（半句话），
            // 客户端要靠 finish_reason 才能识别出来，否则会把半句当成完整发言。
            const ev = { choices: [{ delta: {}, finish_reason: obj.delta?.stop_reason || null }] };
            if (obj.usage) ev.usage = { completion_tokens: obj.usage.output_tokens };
            out.push(`data: ${JSON.stringify(ev)}\n\n`);
          } else if (obj.type === 'message_start' && obj.message?.usage) {
            out.push(
              `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: obj.message.usage.input_tokens } })}\n\n`
            );
          } else if (obj.type === 'message_stop') {
            out.push('data: [DONE]\n\n');
          }
        } else if (kind === 'gemini') {
          const cand = obj.candidates?.[0] || null;
          const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
          if (text) out.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          // 同 Anthropic：MAX_TOKENS 也要带过去（Gemini 把结束原因放在每个候选上）
          if (cand?.finishReason) {
            out.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: cand.finishReason }] })}\n\n`);
          }
          if (obj.usageMetadata) {
            out.push(
              `data: ${JSON.stringify({
                choices: [{ delta: {} }],
                usage: { prompt_tokens: obj.usageMetadata.promptTokenCount, completion_tokens: obj.usageMetadata.candidatesTokenCount },
              })}\n\n`
            );
          }
        }
      }
      return out.length ? enc.encode(out.join('')) : null;
    },
    flush() {
      const rest = buf;
      buf = '';
      return rest;
    },
    /**
     * 上游对 stream:true 仍然回了**非 SSE** 的完整 JSON（部分兼容实现/中转站会这样，
     * 高负载时也可能回落成非流式）。
     *
     * 以前这种情况会被 `feed()` 整份丢掉（`if (!line.startsWith('data:')) continue;`）：
     * 一个字节都没转发，客户端只收到 `data: [DONE]`，界面报"模型没有返回任何内容" ——
     * 而模型其实回答得好好的。直连路径（core/llm.js 兼容裸 JSON 行）没这个问题，
     * 只有代理会丢，所以必须在代理这一层翻译成增量格式。
     * @param {string} text 上游响应全文
     * @returns {string} 需要转发给客户端的 SSE 数据
     */
    fromJson(text) {
      const raw = String(text || '').trim();
      if (!raw) return 'data: [DONE]\n\n';
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        /* 下面按纯文本兜底 */
      }
      // 上游用 200 包了一个错误体：必须原样变成 error 帧，不能让客户端当"空回复"
      const errMsg =
        obj && obj.error
          ? String(obj.error.message || obj.error.code || JSON.stringify(obj.error))
          : obj && obj.type === 'error' && obj.message
            ? String(obj.message)
            : '';
      if (errMsg) return `data: ${JSON.stringify({ error: { message: errMsg } })}\n\ndata: [DONE]\n\n`;
      const body = obj ? makeExtractorText(obj) : raw;
      if (body) {
        return `data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\ndata: [DONE]\n\n`;
      }
      return 'data: [DONE]\n\n';
    },
  };
}

/**
 * 从"上游原样返回的完整 JSON"里取正文（兼容 OpenAI / Anthropic / Gemini / 代理自造格式）。
 * @param {any} obj
 * @returns {string}
 */
function makeExtractorText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  // 本地代理自造的 { text } 形态
  if (typeof obj.text === 'string' && obj.text) return obj.text;
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const c = obj.choices[0];
    if (c.message) return contentText(c.message.content);
    if (c.delta) return contentText(c.delta.content);
    if (typeof c.text === 'string') return c.text;
  }
  if (typeof obj.completion === 'string') return obj.completion;
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text || '')
      .join('');
  }
  const cand = Array.isArray(obj.candidates) ? obj.candidates[0] : null;
  const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : null;
  if (parts) return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

/** 把分段内容（字符串 / 数组）拼成纯文本 */
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * 给用户看的"上游地址"标签：只保留协议 + 主机 + 路径，**去掉查询串与 fragment**。
 * 注意 Gemini 的地址形如 `…/models/x:streamGenerateContent?alt=sse&key=<API Key>`，
 * 直接把 up.url 拼进错误消息会把密钥写进界面和日志。
 * @param {string} url
 * @returns {string}
 */
function safeUpstreamLabel(url) {
  const raw = String(url || '');
  if (!raw) return '默认地址';
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split('?')[0] || '默认地址';
  }
}

async function handleLLM(req, res) {
  // 先接上"客户端断开"的信号，**再**读请求体。
  // 为什么顺序重要：Node 16+ 在请求体读完（autoDestroy）时就会发 `req 'close'`，
  // 而 readBody 正等着读完整个 body —— 以前监听注册在 readBody 之后，
  // 那两个监听器永远等不到事件（实测 req.on('close') 的监听数始终为 0）。
  // 当前取消功能靠 res 'close' 仍然有效，但那是"碰巧"；这里把顺序摆正。
  const upstreamAbort = new AbortController();
  const onClientGone = () => {
    try {
      upstreamAbort.abort();
    } catch {
      /* 忽略 */
    }
  };
  req.on('aborted', onClientGone);
  // 注意**不要**监听 req.socket 的 close：HTTP keep-alive 下同一个 socket 会被后续请求复用，
  // 一旦复用就误判成"客户端走了"，把新请求的上游掐断。
  // `req 'close'` 本身在 Node 16+ 会于请求体读完时触发（早于上游 fetch），
  // 但那时 upstreamAbort 还没有被使用，abort 一个尚未使用的控制器是无害的。
  // `res.on('close')` 用 writableEnded 区分"我们把响应写完了"与"对端提前走了"。
  res.on('close', () => {
    if (!res.writableEnded) onClientGone();
  });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    if (upstreamAbort.signal.aborted) return; // 客户端已走：不用再回应
    json(res, err && err.tooLarge ? 413 : 400, { error: { message: `请求体解析失败：${err.message}` } });
    return;
  }
  const { provider = 'ollama', model = LOCAL_MODEL, messages = [], params = {}, stream = false, keySlot = 'default', baseUrl = '' } = payload;
  if (provider !== 'ollama' || model !== LOCAL_MODEL) {
    return json(res, 400, { error: { message: '此版本只支持项目内的本地 Qwen3 模型', code: 'local-model-only' } });
  }
  const key = '';
  const meta = UPSTREAM.ollama;
  // 客户端指定的上游地址必须先过校验：否则等于"让服务器带着自己的 Key 去请求任意地址"
  const override = checkUpstreamOverride(baseUrl);
  if (!override.ok) {
    json(res, 403, { error: { message: override.error, code: 'upstream-not-allowed' } });
    return;
  }

  const contextError = localContextError(messages, params?.maxTokens);
  if (contextError) return json(res, 400, { error: { message: contextError, code: 'context-budget' } });

  let up;
  try {
    up = buildUpstream(provider, model, messages, params, key, override.base, Boolean(stream));
  } catch (err) {
    json(res, 400, { error: { message: err.message } });
    return;
  }

  // 客户端断开（点"停止"、关页、切会话）时必须**掐断上游连接**。
  // 以前这里没把取消信号接进上游 fetch：客户端走了，服务器还在原地读上游的流，
  // 上游（尤其是按 token 计费、或长心跳的中转）会继续算下去 —— 白花钱，还占着连接与额度。
  // 信号与监听在函数开头就建好了（见那里的说明：必须在 readBody 之前注册）。
  let upstream;
  // 首字节看门狗：上游"连上了但不回"时不能无限等（见文件顶部 UPSTREAM_FIRST_BYTE_MS 的说明）。
  // 拿到响应头之后立刻清掉，后续由流式的空闲看门狗接手。
  const firstByte = new AbortController();
  const firstByteMs = provider === 'ollama' ? 120_000 : UPSTREAM_FIRST_BYTE_MS;
  const firstByteTimer = setTimeout(() => {
    try {
      firstByte.abort(new Error('first-byte-timeout'));
    } catch {
      firstByte.abort();
    }
  }, firstByteMs);
  try {
    upstream = await fetch(up.url, {
      redirect: 'error',
      method: 'POST',
      headers: up.headers,
      body: JSON.stringify(up.body),
      signal: AbortSignal.any([upstreamAbort.signal, firstByte.signal]),
    });
  } catch (err) {
    // 客户端自己断开的：不算错误，也不再往一个已经关掉的响应上写
    if (upstreamAbort.signal.aborted) return;
    if (firstByte.signal.aborted) {
      json(res, 504, {
        error: {
          message: `上游接口 ${Math.round(firstByteMs / 1000)} 秒内没有响应（地址：${safeUpstreamLabel(up.url)}）。${provider === 'ollama' ? '请确认本地模型已准备完成，或缩短上下文后重试。' : '请检查该中转/接口是否可用，或换一个供应商。'}`,
        },
      });
      return;
    }
    json(res, 502, { error: { message: `无法连接项目本地模型：${err.message}。请运行项目启动脚本，并检查启动窗口中的报错` } });
    return;
  } finally {
    clearTimeout(firstByteTimer);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    json(res, upstream.status, {
      error: { message: `上游返回 ${upstream.status}：${text.slice(0, 600) || upstream.statusText}` },
    });
    return;
  }

  if (!stream) {
    try {
      const data = await upstream.json();
      if (upstreamAbort.signal.aborted) return; // 客户端已断开，别再往关掉的响应上写
      json(res, 200, data);
    } catch (err) {
      if (upstreamAbort.signal.aborted) return;
      json(res, 502, { error: { message: `上游响应解析失败：${err.message}` } });
    }
    return;
  }

  // 流式转发
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // 客户端已经走了：别再往下读上游（此时 res 已关闭，写了也没人收）
  if (upstreamAbort.signal.aborted) {
    res.end();
    return;
  }
  const decoder = new TextDecoder();
  const transform = makeTransformer(meta.kind, provider);

  /**
   * 非 SSE 的 200 响应：上游忽略了 stream:true，直接回了完整 JSON（或 200 包了个 error 体）。
   * 以前这里会把整份内容丢掉、只发 `data: [DONE]`，客户端于是报"模型没有返回任何内容"。
   * 现在整体读出来翻译成增量帧；读不动就报错，不要伪装成"空回复"。
   */
  const upstreamType = String(upstream.headers.get('content-type') || '').toLowerCase();
  if (upstreamType && !upstreamType.includes('text/event-stream')) {
    try {
      const raw = await upstream.text();
      if (upstreamAbort.signal.aborted) return;
      res.write(transform.fromJson(raw));
    } catch (err) {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: `读取上游响应失败：${err.message}` } })}\n\ndata: [DONE]\n\n`);
      } catch {}
    } finally {
      res.end();
    }
    return;
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  // 复用上面那个由"客户端断开"驱动的控制器：同一个信号既掐上游，也用来跳出发送循环
  const abort = upstreamAbort;
  let idleTimer = null;
  let idleTimedOut = false;
  /** 上游"还活着但不吐字"时掐断（每收到一块数据就重置） */
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      // 只取消这个 reader，**不要** abort 整个 upstreamAbort —— 那个控制器连着
      // `res.on('close')` 的处理：一旦 abort，客户端的响应会被连带关掉，
      // 我们随后想写的"上游超时"错误帧就送不出去了（实测踩到过）。
      try {
        reader.cancel();
      } catch {
        /* 忽略 */
      }
    }, UPSTREAM_IDLE_MS);
  };
  try {
    armIdle();
    let sentDone = false;
    let sentBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (abort.signal.aborted) break;
      armIdle();
      const out = transform.feed(decoder.decode(value, { stream: true }));
      if (out) {
        if (out.includes('[DONE]')) sentDone = true;
        sentBytes += out.length;
        res.write(out);
      }
    }
    // 上游最后一个事件常常没有尾换行（不少网关这样收尾）——必须 flush，
    // 否则回复的结尾会少一截（客户端明明能容错处理尾包，却被代理先吃掉了）
    const rest = transform.flush();
    if (rest && rest.trim()) {
      const out = transform.feed(rest + '\n');
      if (out) {
        if (out.includes('[DONE]')) sentDone = true;
        sentBytes += out.length;
        res.write(out);
      }
    }
    if (idleTimedOut) {
      // 必须让客户端看到"为什么断了"，而不是把空回复当成正常结束
      res.write(
        `data: ${JSON.stringify({
          error: { message: `上游超过 ${Math.round(UPSTREAM_IDLE_MS / 1000)} 秒没有返回新内容，已中断` },
        })}\n\n`
      );
    } else if (!sentDone && sentBytes === 0) {
      // 一个字节都没翻译出来：多半是上游协议不认识（既不是 SSE 也不是可解析的 JSON）。
      // 以前这里只发 `[DONE]`，界面上就是"模型没有返回任何内容"。
      res.write(
        `data: ${JSON.stringify({
          error: { message: '上游没有返回可识别的内容（既不是 SSE 流，也不是标准的完整响应体）' },
        })}\n\n`
      );
    }
    if (!sentDone) res.write('data: [DONE]\n\n');
  } catch (err) {
    if (!abort.signal.aborted) {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: `转发中断：${err.message}` } })}\n\n`);
      } catch {}
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    res.end();
  }
}

/** 代理模式下由服务器持有密钥并拉取模型列表，避免浏览器无密钥直连上游。 */
async function handleModels(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, 64 * 1024));
  } catch (err) {
    return json(res, err && err.tooLarge ? 413 : 400, { error: { message: `请求体解析失败：${err.message}` } });
  }
  const provider = String(payload.provider || 'ollama');
  if (!Object.hasOwn(UPSTREAM, provider)) {
    return json(res, 400, { error: { message: '此版本只支持项目内的本地模型' } });
  }
  const override = checkUpstreamOverride(payload.baseUrl);
  if (!override.ok) return json(res, 403, { error: { message: override.error } });
  const meta = UPSTREAM[provider];
  const base = String(override.base || meta.baseUrl || '').replace(/\/+$/, '');
  if (!base) return json(res, 400, { error: { message: '未配置模型接口地址' } });
  const headers = {};
  const url = `${base}/models`;
  try {
    const upstream = await fetch(url, {
      redirect: 'error',
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      return json(res, upstream.status, { error: { message: `模型列表上游返回 ${upstream.status}` } });
    }
    const data = await upstream.json();
    const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = Array.from(new Set(rows.map((item) =>
      typeof item === 'string' ? item : String(item?.id || item?.name || item?.model || '').replace(/^models\//, '')
    ).filter(Boolean)));
    return json(res, 200, { ok: true, models: models.filter((name) => name === LOCAL_MODEL) });
  } catch (err) {
    return json(res, 502, { error: { message: `获取模型列表失败：${err.message}` } });
  }
}

/* ------------------------------------------------------------------ *
 * 代理：/api/tts（可选，OpenAI 兼容语音合成）
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 本地文件存储层：把角色 / 聊天记录 / 记忆落到电脑本地的 JSON 文件
 *
 * 目录结构（默认 app/data/db/，可用 --data-dir 或 AICHAT_DATA_DIR 改）：
 *   data/db/characters/<角色id>.json    角色卡
 *   data/db/messages/<角色id>.ndjson    聊天记录（一行一条消息，追加写）
 *   data/db/memory/<角色id>.json        长期记忆
 *   data/db/groups/<群id>.json          群聊资料（群名、成员、接话设置）
 *   data/db/groupmsgs/<群id>.ndjson     群聊记录（一行一条，带 speakerId）
 *   data/db/deleted/<角色id>.json       删除墓碑（防止旧标签页把它复活）
 *   data/db/settings.json               设置（含密钥，谨慎分享）
 *   data/db/runtime.json                好感度 / 未读等运行时状态
 *   data/db/backup-<日期>.json          整库快照（每次启动自动留一份，滚动保留 10 份）
 * ------------------------------------------------------------------ */

const DATA_DIR = path.resolve(argValue('data-dir', process.env.AICHAT_DATA_DIR || path.join(ROOT, 'data', 'db')));
const DB_DIRS = {
  characters: path.join(DATA_DIR, 'characters'),
  messages: path.join(DATA_DIR, 'messages'),
  memory: path.join(DATA_DIR, 'memory'),
  groups: path.join(DATA_DIR, 'groups'),
  groupmsgs: path.join(DATA_DIR, 'groupmsgs'),
  deleted: path.join(DATA_DIR, 'deleted'),
};

async function ensureDataDirsUnlocked() {
  for (const dir of [DATA_DIR, ...Object.values(DB_DIRS)]) await ensureDir(dir);
}

function ensureDataDirs() {
  return withFsLock(ensureDataDirsUnlocked);
}

/** 只允许安全的 id，杜绝 ../ 之类的路径穿越 */
function safeId(id) {
  const s = String(id == null ? '' : id);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) throw new Error(`非法 id：${s.slice(0, 40)}`);
  return s;
}

/** 原子写：先写临时文件再 rename，避免写一半断电留下坏文件 */
/**
 * 确保目录存在（带重试）。
 * 为什么要重试：wipe/replace 会 rm -rf 整个数据目录，而此刻可能还有在途写请求，
 * 并发下 mkdir 会偶发 ENOENT（父目录刚被删掉）。重试即可自愈。
 * @param {string} dir
 */
/**
 * 全局写锁：所有落盘操作（写入 / 追加 / 目录重建 / 清空 / 覆盖恢复）都在它里面串行执行。
 *
 * 为什么需要：wipe / replace / --restore 会 rm -rf 整个数据目录，
 * 若此时还有并发写请求，会出现"刚建好的目录又被删"、"临时文件消失导致 rename 失败"这类
 * 竞态（表现为偶发 500 ENOENT，客户端只能降级并提示写盘失败）。
 * 串行化之后，"清空"与"写入"不会再交错。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
let fsLock = Promise.resolve();
function withFsLock(fn) {
  const run = fsLock.then(fn, fn);
  fsLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Kept outside the tables cleared by /wipe. Legacy databases start at generation 0.
async function dbMetadata() {
  const meta = await readJsonFile(path.join(DATA_DIR, 'db-generation.json'), null);
  if (meta === null) return { generation: '0', retiredGenerations: [] };
  const retiredGenerations = meta.retiredGenerations || [];
  if (typeof meta.generation !== 'string' || !meta.generation || !Array.isArray(retiredGenerations) ||
      retiredGenerations.some(value => typeof value !== 'string' || !value || value === meta.generation)) {
    throw new Error('数据库清空标记损坏，已停止写入');
  }
  return { generation: meta.generation, retiredGenerations };
}

function withDbWrite(req, fn) {
  return withFsLock(async () => {
    const { generation } = await dbMetadata();
    if (String(req.headers['x-aichat-db-generation'] || '0') !== generation) {
      const err = new Error('数据已在其他页面清空，请刷新页面后继续；清空前的修改不会重新写入');
      err.status = 409;
      err.code = 'db-generation-changed';
      throw err;
    }
    return fn();
  });
}

async function ensureDir(dir) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('无法创建目录');
}

function writeAtomic(file, text) {
  return withFsLock(() => writeAtomicUnlocked(file, text));
}

async function writeAtomicUnlocked(file, text) {
  // 原子写：先写临时文件再 rename。
  // 注意这里必须容错重试 —— 清空/覆盖类接口（wipe / replace --restore）会 rm -rf 目录，
  // 而此刻可能还有在途的写请求：临时文件会连同目录一起消失，rename 抛 ENOENT。
  // 这类竞态在"边聊天边清空"或测试收尾阶段真的会偶发，所以失败就重建目录重试几次。
  const dir = path.dirname(file);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ensureDir(dir);
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${attempt}`;
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      // 临时文件可能已被删（目录被清），清一下残留再重试
      await fsp.rm(file.replace(/([^/]+)$/, `$1.tmp-${process.pid}-${Date.now()}-${attempt}`), { force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('写入失败');
}

/** 串行化同一文件的写入，避免并发追加互相覆盖 */
const writeChains = new Map();
function withLock(key, fn) {
  const prev = writeChains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(
    key,
    next.catch(() => {})
  );
  return next;
}

async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function listIdsIn(kind) {
  const dir = DB_DIRS[kind];
  const files = await fsp.readdir(dir).catch((err) => { if (err.code === 'ENOENT') return []; throw err; });
  return files
    .filter((f) => f.endsWith('.json') || f.endsWith('.ndjson'))
    .map((f) => f.replace(/\.ndjson$|\.json$/, ''))
    .filter((id, i, arr) => arr.indexOf(id) === i);
}

/** 读取某个会话（角色单聊 / 群聊）的聊天记录（NDJSON 按 id 去重，后写覆盖先写） */
async function readMessages(ownerId, kind = 'messages') {
  const id = safeId(ownerId);
  const file = path.join(DB_DIRS[kind] || DB_DIRS.messages, `${id}.ndjson`);
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const map = new Map();
  const order = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (!m || !m.id) continue;
      if (!map.has(m.id)) order.push(m.id);
      map.set(m.id, m);
    } catch (err) {
      throw new Error(`聊天记录损坏：${path.basename(file)}（${err.message}）`);
    }
  }
  return order.map((k) => map.get(k)).filter((m) => m && m.deleted !== true);
}

/** 追加消息（NDJSON 一行一条，天然支持并发与增量） */
const compactionThresholds = new Map();
async function appendMessages(ownerId, messages, kind, req) {
  const id = safeId(ownerId);
  const file = path.join(DB_DIRS[kind] || DB_DIRS.messages, `${id}.ndjson`);
  const lines = messages.map((m) => JSON.stringify(m)).join('\n');
  if (!lines) return 0;
  await withDbWrite(req, () =>
    withLock(file, async () => {
      await ensureDir(path.dirname(file));
      await fsp.appendFile(file, lines + '\n', 'utf8');
      // 压实后按新增量再触发；有效正文自身超过 2MB 时不能每追加一条都重写。
      const stat = await fsp.stat(file).catch(() => null);
      const step = 2 * 1024 * 1024;
      let threshold = compactionThresholds.get(file);
      if (threshold && stat && stat.size < threshold.compactedBytes) threshold = null;
      if (stat && stat.size > (threshold?.nextAt || step)) {
        const list = await readMessages(id, kind);
        // 已经在全局锁里，直接用未加锁版本，避免自我等待
        const text = list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : '');
        await writeAtomicUnlocked(file, text);
        const compactedBytes = Buffer.byteLength(text);
        compactionThresholds.set(file, { compactedBytes, nextAt: compactedBytes + Math.max(step, compactedBytes / 2) });
      }
    })
  );
  return messages.length;
}

/** 记录删除（写墓碑，保证别的标签页/浏览器也同步删掉） */
async function writeTombstone(charId, req, also = []) {
  return withDbWrite(req, async () => {
    await ensureDataDirsUnlocked();
    const id = safeId(charId);
    await writeAtomicUnlocked(
      path.join(DB_DIRS.deleted, `${id}.json`),
      JSON.stringify({ id, at: Date.now(), also: also.map(safeId) })
    );
    await fsp.rm(path.join(DB_DIRS.characters, `${id}.json`), { force: true });
    await fsp.rm(path.join(DB_DIRS.messages, `${id}.ndjson`), { force: true });
    await fsp.rm(path.join(DB_DIRS.memory, `${id}.json`), { force: true });
  });
}

/** 群聊删除：同样留墓碑（防止旧标签页把群聊复活），并清掉它的两份文件 */
async function writeGroupTombstone(groupId, req) {
  return withDbWrite(req, async () => {
    await ensureDataDirsUnlocked();
    const id = safeId(groupId);
    await writeAtomicUnlocked(
      path.join(DB_DIRS.deleted, `g-${id}.json`),
      JSON.stringify({ id, kind: 'group', at: Date.now() })
    );
    await fsp.rm(path.join(DB_DIRS.groups, `${id}.json`), { force: true });
    await fsp.rm(path.join(DB_DIRS.groupmsgs, `${id}.ndjson`), { force: true });
  });
}

/** 整库快照：导出全部数据为单个文件 */
async function snapshot() {
  const chars = [];
  for (const id of await listIdsIn('characters')) {
    const c = await readJsonFile(path.join(DB_DIRS.characters, `${id}.json`));
    if (c) chars.push(c);
  }
  const messages = [];
  for (const id of await listIdsIn('messages')) {
    for (const m of await readMessages(id)) messages.push(m);
  }
  const groups = [];
  for (const id of await listIdsIn('groups')) {
    const g = await readJsonFile(path.join(DB_DIRS.groups, `${id}.json`));
    if (g) groups.push(g);
  }
  const groupMessages = [];
  for (const id of await listIdsIn('groupmsgs')) {
    for (const m of await readMessages(id, 'groupmsgs')) groupMessages.push(m);
  }
  const memory = [];
  for (const id of await listIdsIn('memory')) {
    const mem = await readJsonFile(path.join(DB_DIRS.memory, `${id}.json`));
    if (mem) memory.push(mem);
  }
  const deleted = [];
  for (const id of await listIdsIn('deleted')) {
    const t = await readJsonFile(path.join(DB_DIRS.deleted, `${id}.json`));
    if (t) deleted.push(t);
  }
  return {
    app: 'AI 聊天网站',
    format: 'aichat-filedb',
    version: 1,
    exportedAt: new Date().toISOString(),
    characters: chars,
    messages,
    groups,
    groupMessages,
    memory,
    deleted,
    settings: await readJsonFile(path.join(DATA_DIR, 'settings.json'), null),
    runtime: await readJsonFile(path.join(DATA_DIR, 'runtime.json'), null),
  };
}

/**
 * 破坏性操作（整库覆盖 / 清空）**执行前**自动存一份快照。
 *
 * 为什么必须有：数据被清掉就再也找不回来，"事后备份"没有意义。
 * 每次清空前留一份带时间戳的快照，任何误操作都还能从 data/db/safety-*.json 捞回来。
 * 这类文件不参与自动清理，需要手动删。
 *
 * @param {string} reason 简短原因（如 before-replace / before-wipe），写进文件名便于辨认
 * @returns {Promise<string>} 快照路径（空库返回空串，失败抛错并阻止破坏性操作）
 */
async function safetySnapshot(reason, alreadyLocked = false) {
  try {
    const pack = await snapshot();
    const empty = !pack.characters.length && !pack.messages.length && !pack.groups.length && !pack.memory.length && !pack.groupMessages.length && !pack.settings && !pack.runtime;
    if (empty) return '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(DATA_DIR, `safety-${reason}-${stamp}.json`);
    if (alreadyLocked) await writeAtomicUnlocked(file, JSON.stringify(pack, null, 1));
    else await writeAtomic(file, JSON.stringify(pack, null, 1));
    console.log(
      `[db] 清空前已自动存快照：${path.basename(file)}（${pack.characters.length} 角色 / ${pack.messages.length} 消息 / ${pack.groups.length} 群）`
    );
    return file;
  } catch (err) {
    throw new Error(`安全快照失败，已停止操作：${err.message}`);
  }
}

/** 启动时留一份快照，最多保留 10 份（纯 File System 操作，出错不影响启动） */
async function autoBackupOnBoot() {
  try {
    const pack = await snapshot();
    if (!pack.characters.length && !pack.messages.length && !pack.groups.length && !pack.settings) return;
    const name = `backup-${new Date().toISOString().slice(0, 10)}.json`;
    const already = await readJsonFile(path.join(DATA_DIR, name), null);
    const wouldLoseData =
      !pack.characters.length && already && Array.isArray(already.characters) && already.characters.length > 0;
    if (wouldLoseData) {
      // 当天已有一份"带角色"的快照，别用空的覆盖它，改为另存一份带时间戳的
      const alt = `backup-${new Date().toISOString().slice(0, 10)}-empty-${Date.now()}.json`;
      await writeAtomic(path.join(DATA_DIR, alt), JSON.stringify(pack, null, 1));
      return;
    }
    await writeAtomic(path.join(DATA_DIR, name), JSON.stringify(pack, null, 1));
    const files = (await fsp.readdir(DATA_DIR)).filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 10) {
      const old = files.shift();
      await fsp.rm(path.join(DATA_DIR, old), { force: true });
    }
  } catch (err) {
    console.warn('[db] 启动快照失败（忽略）：', err.message);
  }
}

/** 读取一份运行时状态（好感度等） */
async function handleDbState(res) {
  await ensureDataDirsUnlocked();
  const characters = [];
  for (const id of await listIdsIn('characters')) {
    const c = await readJsonFile(path.join(DB_DIRS.characters, `${id}.json`));
    if (c) characters.push({ id, updatedAt: c.updatedAt || 0, data: c });
  }
  const groups = [];
  for (const id of await listIdsIn('groups')) {
    const g = await readJsonFile(path.join(DB_DIRS.groups, `${id}.json`));
    if (g) groups.push({ id, updatedAt: g.updatedAt || 0, data: g });
  }
  const deleted = [];
  for (const id of await listIdsIn('deleted')) {
    const t = await readJsonFile(path.join(DB_DIRS.deleted, `${id}.json`));
    if (t) deleted.push(t);
  }
  return json(res, 200, {
    ok: true,
    dir: DATA_DIR,
    ...await dbMetadata(),
    characters,
    groups,
    deleted,
    counts: {
      characters: characters.length,
      messageFiles: (await listIdsIn('messages')).length,
      memoryFiles: (await listIdsIn('memory')).length,
      groups: groups.length,
      groupMessageFiles: (await listIdsIn('groupmsgs')).length,
    },
    settings: await readJsonFile(path.join(DATA_DIR, 'settings.json'), null),
    runtime: await readJsonFile(path.join(DATA_DIR, 'runtime.json'), null),
  });
}

/** 把浏览器内存里的状态整体写盘（用于新装/恢复/多设备覆盖） */
async function handleDbReplace(req, res) {
  const body = JSON.parse(await readBody(req, 64 * 1024 * 1024));
  return withDbWrite(req, () => replaceDbBody(body, res));
}

/** 调用方已持有全局文件锁；整个快照、清目录、重建过程不得穿插普通镜像写入。 */
async function replaceDbBody(body, res) {
  try {
    validateBackup(body);
    for (const key of ['characters', 'groups', 'messages', 'groupMessages', 'memory']) {
      for (const row of body[key] || []) {
        for (const field of ['id', 'charId', 'groupId']) if (row[field]) safeId(row[field]);
      }
    }
  } catch (err) { return json(res, 400, { error: { message: err.message } }); }
  await ensureDataDirsUnlocked();
  const chars = Array.isArray(body.characters) ? body.characters : [];

  // 防误删闸门：客户端带着"空角色列表"来整体覆盖，而磁盘上明明还有角色时直接拒绝。
  // 常见于：浏览器数据被清空、换了新浏览器、测试脚本跑到了真实 data/db。
  // 用户自己在设置里"清空全部数据"会带 force:true（见 core/filestore.js）。
  const onDisk = (await fsp.readdir(DB_DIRS.characters).catch(() => [])).filter((f) => f.endsWith('.json'));
  if (!body.force && chars.length === 0 && onDisk.length > 0) {
    return json(res, 409, {
      error: {
        message: `电脑上已有 ${onDisk.length} 个角色，拒绝用空数据覆盖以免误删。若确实要清空，请到「设置 → 数据 → 清空全部数据」。`,
        code: 'replace-would-delete',
        onDisk: onDisk.length,
      },
    });
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const mems = Array.isArray(body.memory) ? body.memory : [];
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const gmsgs = Array.isArray(body.groupMessages) ? body.groupMessages : [];

  // 覆盖前先留退路：任何被覆盖掉的数据都还能从 safety-*.json 里捞回来
  await safetySnapshot('before-replace', true);

  const staging = await fsp.mkdtemp(path.join(DATA_DIR, '.replace-'));
  const kinds = ['characters', 'messages', 'memory', 'groups', 'groupmsgs', ...(body.deleted ? ['deleted'] : [])];
  const stagedDirs = Object.fromEntries(kinds.map((kind) => [kind, path.join(staging, kind)]));
  try {
    for (const dir of Object.values(stagedDirs)) await ensureDir(dir);
    for (const c of chars) {
      await writeAtomicUnlocked(path.join(stagedDirs.characters, `${safeId(c.id)}.json`), JSON.stringify(c, null, 1));
    }
    const byChar = new Map();
    for (const m of msgs) {
      const id = String(m.charId || '');
      if (!id) continue;
      if (!byChar.has(id)) byChar.set(id, []);
      byChar.get(id).push(m);
    }
    for (const [charId, list] of byChar) {
      await writeAtomicUnlocked(
        path.join(stagedDirs.messages, `${safeId(charId)}.ndjson`),
        list.map((m) => JSON.stringify(m)).join('\n') + '\n'
      );
    }
    for (const g of groups) {
      if (!g || !g.id) continue;
      await writeAtomicUnlocked(path.join(stagedDirs.groups, `${safeId(g.id)}.json`), JSON.stringify(g, null, 1));
    }
    const byGroup = new Map();
    for (const m of gmsgs) {
      const id = String(m.groupId || m.charId || '');
      if (!id) continue;
      if (!byGroup.has(id)) byGroup.set(id, []);
      byGroup.get(id).push(m);
    }
    for (const [groupId, list] of byGroup) {
      await writeAtomicUnlocked(
        path.join(stagedDirs.groupmsgs, `${safeId(groupId)}.ndjson`),
        list.map((m) => JSON.stringify(m)).join('\n') + '\n'
      );
    }
    for (const mem of mems) {
      if (!mem || !mem.charId) continue;
      await writeAtomicUnlocked(path.join(stagedDirs.memory, `${safeId(mem.charId)}.json`), JSON.stringify(mem, null, 1));
    }
    for (const kind of ['deleted']) for (const row of body[kind] || []) {
      await writeAtomicUnlocked(path.join(stagedDirs[kind], `${row.kind === 'group' ? 'g-' : ''}${safeId(row.id)}.json`), JSON.stringify(row));
    }
    if (body.settings) await writeAtomicUnlocked(path.join(staging, 'settings.json'), JSON.stringify(body.settings, null, 1));
    if (body.runtime) await writeAtomicUnlocked(path.join(staging, 'runtime.json'), JSON.stringify(body.runtime, null, 1));

    const names = [...kinds, ...(body.settings ? ['settings.json'] : []), ...(body.runtime ? ['runtime.json'] : [])];
    const moved = [];
    try {
      for (const name of names) {
        const live = path.join(DATA_DIR, name);
        const old = path.join(staging, `old-${name}`);
        let existed = true;
        try { await fsp.rename(live, old); } catch (err) { if (err.code === 'ENOENT') existed = false; else throw err; }
        moved.push({ live, old, existed });
        await fsp.rename(path.join(staging, name), live);
      }
    } catch (err) {
      for (const row of moved.reverse()) {
        await fsp.rm(row.live, { recursive: true, force: true });
        if (row.existed) await fsp.rename(row.old, row.live);
      }
      throw err;
    }
    await fsp.rm(staging, { recursive: true, force: true });
  } catch (err) {
    // Preserve staging and the pre-replacement snapshot for recovery on I/O failure.
    throw new Error(`整库替换失败，恢复副本位于 ${staging}：${err.message}`);
  }

  return json(res, 200, {
    ok: true,
    written: {
      characters: chars.length,
      messages: msgs.length,
      memory: mems.length,
      groups: groups.length,
      groupMessages: gmsgs.length,
    },
  });
}

/**
 * /api/db/characters|groups|memory（JSON 单体）与 /api/db/messages|groupmsgs（NDJSON 追加）的读写与删除
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {'characters'|'messages'|'memory'|'groups'|'groupmsgs'} kind
 * @param {string} id
 * @param {string[]} rest
 */
async function handleDbEntity(req, res, kind, id, rest) {
  await ensureDataDirs();
  const isMessageKind = kind === 'messages' || kind === 'groupmsgs';
  const file = path.join(DB_DIRS[kind], `${safeId(id)}.${isMessageKind ? 'ndjson' : 'json'}`);
  if (req.method === 'GET') {
    if (isMessageKind) return json(res, 200, { ok: true, messages: await readMessages(id, kind) });
    const data = await readJsonFile(file, null);
    // 注意："暂时还没有这份数据"（新角色还没记忆、新群还没资料）必须返回 200 + data:null，
    // 不能返回 404 —— 启动回填会对每个角色都查一次记忆，404 会让浏览器控制台刷出假错误。
    if (!data) return json(res, 200, { ok: true, data: null, missing: true });
    return json(res, 200, { ok: true, data });
  }
  if (req.method === 'DELETE') {
    if (kind === 'characters') await writeTombstone(id, req);
    else if (kind === 'groups') await writeGroupTombstone(id, req);
    else await withDbWrite(req, () => fsp.rm(file, { force: true }));
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'POST' && req.method !== 'PUT') return json(res, 405, { error: { message: '不支持的方法' } });

  const body = JSON.parse(await readBody(req, 32 * 1024 * 1024));
  if (isMessageKind) {
    const list = Array.isArray(body) ? body : body.messages || [];
    const n = await appendMessages(id, list, kind, req);
    return json(res, 200, { ok: true, appended: n });
  }
  if (kind === 'characters' || kind === 'groups') {
    try {
      await withDbWrite(req, async () => {
        const current = await readJsonFile(file, null);
        const next = mergeEntity(current, body);
        await writeAtomicUnlocked(file, JSON.stringify(next, null, 1));
      });
    } catch (err) {
      if (err.status === 409) return json(res, 409, { error: { message: err.message, code: err.code } });
      throw err;
    }
  } else await withDbWrite(req, () => writeAtomicUnlocked(file, JSON.stringify(body.data || body, null, 1)));
  return json(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */

/**
 * 判断请求来源是否可信（防 CSRF）。
 *
 * 为什么必须有：/api/db/* 是**破坏性接口**（有 wipe/replace），而浏览器允许跨站发起
 * "简单请求"（Content-Type: text/plain 时不触发预检）。如果不校验来源，
 * 用户只要在开着本服务时访问任意恶意网页，对方就能 POST /api/db/wipe {force:true}
 * 把整个数据库清空（或用服务器上的 Key 白嫖 /api/llm）。
 *
 * 规则：浏览器请求一定带 Origin —— 同源请求与命令行工具放行，跨站来源一律拒绝。
 * "不带 Origin"只代表跨站 CSRF 风险不存在，**不代表请求可信**；
 * 非本机来源的授权另有 guardRemote()（口令）负责。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isTrustedHost(req) {
  try {
    const host = new URL(`http://${req.headers.host || ''}`);
    const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
    for (const rows of Object.values(os.networkInterfaces())) for (const row of rows || []) {
      allowed.add(row.address.includes(':') ? `[${row.address}]` : row.address);
    }
    if (!['0.0.0.0', '::'].includes(HOST)) allowed.add(HOST);
    return !host.username && !host.password && host.pathname === '/' &&
      allowed.has(host.hostname.toLowerCase()) && Number(host.port || 80) === Number(req.socket.localPort);
  } catch { return false; }
}
function isTrustedOrigin(req) {
  if (!isTrustedHost(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host && url.origin === origin;
  } catch { return false; }
}

/** 请求是否来自本机（回环地址） */
function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1';
}

/**
 * 取请求携带的访问口令：优先自定义头，其次 Bearer，其次查询串，最后 Cookie。
 * Cookie 是给"局域网里的浏览器"兜底的：手机打开一次
 * `http://<本机IP>:端口/?token=口令` 就会种下它（见 maybeSetTokenCookie），
 * 之后页面里的同源接口请求会自动带上，不需要用户手动配置。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} url
 * @returns {string}
 */
function tokenFromRequest(req, url) {
  const header = String(req.headers['x-aichat-token'] || '').trim();
  if (header) return header;
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  try {
    const q = new URL(url, 'http://localhost').searchParams.get('token');
    if (q) return String(q).trim();
  } catch {
    /* 忽略 */
  }
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/(?:^|;\s*)aichat_token=([^;]*)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]).trim();
    } catch {
      return m[1].trim();
    }
  }
  return '';
}

/**
 * 非本机来源的接口访问控制（P0 修复）。
 *
 * 背景：`guardApi()` 只判断 Origin —— "不带 Origin"的命令行客户端一律放行，
 * 于是 `--host 0.0.0.0` 时局域网上任何一个能连上来的设备都能 `GET /api/db/state`
 * （里面含设置与密钥）或 `POST /api/db/wipe {force:true}` 清空整库，
 * 而 `AICHAT_PROXY_TOKEN` 当时只管 /api/llm，完全保护不了数据库接口。
 *
 * 规则：本机（回环）请求照常放行；**非本机来源必须带对 `AICHAT_PROXY_TOKEN`**；
 * 服务器没配这个口令时，局域网访问一律拒绝，并明确告诉用户怎么开。
 * `GET /api/health` 例外，但对非本机只回一个 `{ok:true}`（不泄露路径与配置）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} url
 * @returns {boolean} 是否允许继续处理
 */
function guardRemote(req, res, url) {
  if (isLoopback(req)) return true;
  if (!String(url).startsWith('/api/')) return true;
  if (String(url).split('?')[0] === '/api/health') return true;
  if (!PROXY_TOKEN) {
    json(res, 403, {
      error: {
        message:
          '本服务默认只允许本机访问。如需在局域网/手机上使用，请在 app/.env 里设置 AICHAT_PROXY_TOKEN=自定义口令 后重启，' +
          '并用 http://<本机IP>:端口/?token=口令 打开一次页面。',
        code: 'remote-needs-token',
      },
    });
    return false;
  }
  if (tokenFromRequest(req, url) === PROXY_TOKEN) return true;
  json(res, 401, { error: { message: '访问口令不正确（AICHAT_PROXY_TOKEN）', code: 'bad-token' } });
  return false;
}

/**
 * 局域网浏览器首次带 `?token=` 打开页面时把口令种成 Cookie（HttpOnly + SameSite=Strict）。
 *
 * 目的：手机用户只需打开一次 `http://<本机IP>:端口/?token=口令`，
 * 之后页面里所有同源接口请求会自动带上它，不必在浏览器里手填口令。
 * SameSite=Strict 保证别的站点发起的跨站请求不会带上它，因此不会引入新的 CSRF 风险。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} url
 */
function maybeSetTokenCookie(req, res, url) {
  if (!PROXY_TOKEN || req.method !== 'GET' || String(url).startsWith('/api/')) return;
  let given = '';
  try {
    given = String(new URL(url, 'http://localhost').searchParams.get('token') || '').trim();
  } catch {
    return;
  }
  // 只有"口令正确"才种 Cookie：拿错误口令来试也不会得到任何东西
  if (!given || given !== PROXY_TOKEN) return;
  res.setHeader(
    'Set-Cookie',
    `aichat_token=${encodeURIComponent(PROXY_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`
  );
}

/** API 路由的统一前置校验：来源 + 远程口令 + JSON Content-Type */
function guardApi(req, res, url) {
  if (!url.startsWith('/api/')) return true;
  if (!isTrustedOrigin(req)) {
    json(res, 403, { error: { message: '拒绝跨站请求（只允许本机页面访问本地接口）' } });
    return false;
  }
  if (!guardRemote(req, res, url)) return false;
  // 写操作必须声明 JSON：挡住"简单请求"这种免预检的跨站提交
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    const ct = String(req.headers['content-type'] || '');
    if (ct && !/application\/json/i.test(ct)) {
      json(res, 415, { error: { message: '请使用 Content-Type: application/json' } });
      return false;
    }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    if (!isTrustedHost(req)) return json(res, 403, { error: { message: '请求 Host 不属于本地服务地址' } });
    // 局域网浏览器带着正确口令打开页面 → 种 Cookie（非本机接口请求的授权凭据）
    maybeSetTokenCookie(req, res, url);
    if (req.method === 'OPTIONS') {
      // 预检也只对本机来源放行，且不再回 Access-Control-Allow-Origin: *
      if (!isTrustedOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin || 'null',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Aichat-Token,X-Aichat-Db-Generation',
      });
      res.end();
      return;
    }
    if (!guardApi(req, res, url)) return;
    if (url.startsWith('/api/llm')) {
      if (req.method !== 'POST') return json(res, 405, { error: { message: '请用 POST' } });
      return await handleLLM(req, res);
    }
    if (url.startsWith('/api/models')) {
      if (req.method !== 'POST') return json(res, 405, { error: { message: '请用 POST' } });
      return await handleModels(req, res);
    }
    if (url.startsWith('/api/tts')) {
      if (req.method !== 'POST') return json(res, 405, { error: { message: '请用 POST' } });
      return json(res, 400, { error: { message: '本地版本不提供云端语音，请使用系统语音。' } });
    }
    if (url.startsWith('/api/db')) {
      const pathname = url.split('?')[0];
      const seg = pathname.split('/').filter(Boolean); // ['api','db', ...]
      // /api/db/state | /api/db/replace
      if (seg[2] === 'state' && req.method === 'GET') return await withFsLock(() => handleDbState(res));
      if (seg[2] === 'replace' && req.method === 'POST') return await handleDbReplace(req, res);
      if (seg[2] === 'snapshot' && req.method === 'POST') {
        const pack = await snapshot();
        const name = `backup-manual-${Date.now()}.json`;
        await ensureDataDirs();
        await writeAtomic(path.join(DATA_DIR, name), JSON.stringify(pack, null, 1));
        return json(res, 200, { ok: true, file: path.join(DATA_DIR, name), counts: { characters: pack.characters.length, messages: pack.messages.length } });
      }
      // /api/db/settings —— 设置与运行时状态
      if (seg[2] === 'settings') {
        if (req.method === 'GET') {
          return json(res, 200, {
            ok: true,
            settings: await readJsonFile(path.join(DATA_DIR, 'settings.json'), null),
            runtime: await readJsonFile(path.join(DATA_DIR, 'runtime.json'), null),
          });
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = JSON.parse(await readBody(req, 8 * 1024 * 1024));
          const data = body.data || body;
          // 只覆盖"请求里确实带了"的那一份。
          // 踩过的坑：客户端在只有设置待写时曾发出 `runtime:{}`（已是 truthy），
          // 于是好感度 / 未读所在的 runtime.json 被整份覆盖成空对象。
          // 这里按"字段是否存在 + 是不是对象"判断：显式传 `{}` 仍然表示"清空运行时状态"（清库时用得到）。
          const has = (k) => data[k] !== undefined && data[k] !== null && typeof data[k] === 'object';
          await withDbWrite(req, async () => {
            for (const key of ['settings', 'runtime']) {
              const file = path.join(DATA_DIR, `${key}.json`);
              const changes = data[`${key}Changes`];
              if (changes !== undefined) {
                const current = await readJsonFile(file, {});
                await writeAtomicUnlocked(file, JSON.stringify(applyChanges(current, changes), null, 1));
              } else if (has(key)) {
                let next = data[key];
                // Compatibility with older clients: reject stale runtime records per entity.
                if (key === 'runtime' && Object.keys(next).length) {
                  const current = await readJsonFile(file, {});
                  next = { ...current };
                  for (const [id, value] of Object.entries(data[key])) {
                    if (!current[id] || Number(value?.updatedAt || 0) >= Number(current[id]?.updatedAt || 0)) next[id] = value;
                  }
                }
                await writeAtomicUnlocked(file, JSON.stringify(next, null, 1));
              }
            }
          });
          return json(res, 200, {
            ok: true,
            wrote: ['settings', 'runtime'].filter((key) => has(key) || data[`${key}Changes`] !== undefined),
          });
        }
        return json(res, 405, { error: { message: '不支持的方法' } });
      }
      // /api/db/wipe —— 整库清空
      if (seg[2] === 'wipe' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
        const ids = Array.isArray(body.charIds) ? body.charIds : [];
        // 整库清空（既没给角色也没给群 id）必须显式 force，防止误调接口把数据清光
        const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
        if (!body.force && !ids.length && !groupIds.length) {
          return json(res, 409, {
            error: { message: '整库清空需要显式 force:true（请在「设置 → 数据」里操作）', code: 'wipe-needs-force' },
          });
        }
        // 整库清空前先存快照（指定 id 的删除属于日常操作，不存）
        const metadata = await withDbWrite(req, async () => {
          if (!ids.length && !groupIds.length) {
            await safetySnapshot('before-wipe', true);
            // Persist the fence before deleting: a crash must not allow old clients to refill the database.
            const previous = await dbMetadata();
            await writeAtomicUnlocked(path.join(DATA_DIR, 'db-generation.json'), JSON.stringify({
              generation: randomUUID(), retiredGenerations: [...new Set([...previous.retiredGenerations, previous.generation])],
            }));
          }
          for (const kind of ['characters', 'messages', 'memory', 'groups', 'groupmsgs', 'deleted']) {
            const targets = kind === 'groups' || kind === 'groupmsgs' ? groupIds : ids;
            if (targets.length && kind !== 'deleted') {
              for (const id of targets) {
                const ext = kind === 'messages' || kind === 'groupmsgs' ? '.ndjson' : '.json';
                await fsp.rm(path.join(DB_DIRS[kind], `${safeId(id)}${ext}`), { force: true });
              }
            } else if (!ids.length && !groupIds.length) {
              await fsp.rm(DB_DIRS[kind], { recursive: true, force: true });
            }
          }
          if (!ids.length && !groupIds.length) {
            await fsp.rm(path.join(DATA_DIR, 'settings.json'), { force: true });
            await fsp.rm(path.join(DATA_DIR, 'runtime.json'), { force: true });
          }
          await ensureDataDirsUnlocked();
          return dbMetadata();
        });
        return json(res, 200, { ok: true, ...metadata });
      }
      // /api/db/messages/:id/replace 与 /api/db/groupmsgs/:id/replace —— 整段聊天记录重写
      if ((seg[2] === 'messages' || seg[2] === 'groupmsgs') && seg[3] && seg[4] === 'replace' && (req.method === 'POST' || req.method === 'PUT')) {
        const kind = seg[2];
        const id = safeId(decodeURIComponent(seg[3]));
        const body = JSON.parse(await readBody(req, 64 * 1024 * 1024));
        const list = Array.isArray(body.messages) ? body.messages : [];
        await ensureDataDirs();
        const file = path.join(DB_DIRS[kind], `${id}.ndjson`);
        await withDbWrite(req, () => withLock(file, () =>
          writeAtomicUnlocked(file, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''))
        ));
        return json(res, 200, { ok: true, written: list.length });
      }
      // /api/db/characters/:id | /api/db/messages/:id | /api/db/memory/:id
      // /api/db/groups/:id    | /api/db/groupmsgs/:id
      const kind = seg[2];
      const id = seg[3] ? decodeURIComponent(seg[3]) : '';
      if (['characters', 'messages', 'memory', 'groups', 'groupmsgs'].includes(kind) && id) {
        return await handleDbEntity(req, res, kind, id, seg.slice(4));
      }
      return json(res, 404, { error: { message: '未知的数据接口' } });
    }
    if (url.startsWith('/api/health')) {
      // 非本机来源只回一个"活着"的最小响应：路径与已配置的供应商列表都属于本机信息
      if (!isLoopback(req)) return json(res, 200, { ok: true });
      return json(res, 200, {
        ok: true,
        root: ROOT,
        dataDir: DATA_DIR,
        providers: ['ollama'], localOnly: true,
        tokenRequired: Boolean(PROXY_TOKEN),
      });
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    if (err.status === 409) return json(res, 409, { error: { message: err.message, code: err.code } });
    console.error('[server] 未捕获错误', err);
    try {
      json(res, 500, { error: { message: String(err?.message || err) } });
    } catch {}
  }
});

await ensureDataDirs();

// --restore <文件>：把某份快照（safety-*.json / backup-*.json）恢复回 data/db。
// 用法：node server.mjs --restore data/db/safety-before-wipe-xxx.json
// 这样"清空前自动快照"才真正可用（否则快照只是躺在那里的文件）。
const restoreArg = argValue('restore', '');
if (restoreArg) {
  const file = path.isAbsolute(restoreArg) ? restoreArg : path.join(process.cwd(), restoreArg);
  try {
    const pack = JSON.parse(await fsp.readFile(file, 'utf8'));
    validateBackup(pack);
    // Reuse the fully staged, rollback-capable replacement used by HTTP import.
    const response = { writeHead(code) { this.code = code; return this; }, end(body) {
      if (this.code >= 400) throw new Error(JSON.parse(body).error.message);
    } };
    await withFsLock(() => replaceDbBody({ ...pack, force: true, deleted: pack.deleted || [] }, response));
    console.log(
      `  ♻️  已从快照恢复：${path.basename(file)}（${pack.characters.length} 角色 / ${(pack.messages || []).length} 消息 / ` +
        `${(pack.groups || []).length} 群 / ${(pack.groupMessages || []).length} 群消息` +
        `${pack.settings ? ' / 含设置' : ''}${pack.runtime ? ' / 含好感度' : ''}）`
    );
  } catch (err) {
    console.error(`  ✗ 恢复失败：${err.message}`);
    process.exit(1);
  }
}

void autoBackupOnBoot();

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const url = `http://${shown}:${PORT}`;
  console.log('');
  console.log('  🤖  AI 聊天网站已启动');
  console.log(`  ➜  本地地址：${url}`);
  const lanBind = !(HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1');
  if (lanBind && PROXY_TOKEN) {
    console.log(`  ➜  局域网访问已开启（需要口令）：http://<本机IP>:${PORT}/?token=<AICHAT_PROXY_TOKEN>`);
    console.log('  🔒  非本机的接口请求必须携带该口令（用上面这个地址打开一次页面即可自动记住）');
  } else if (lanBind) {
    console.log('  ➜  已绑定 ' + HOST + '，但**没有设置 AICHAT_PROXY_TOKEN**：');
    console.log('  🔒  为保护数据与密钥，非本机的接口请求会被拒绝；如需手机/局域网访问，');
    console.log('      请在 app/.env 里设置 AICHAT_PROXY_TOKEN=自定义口令 后重启。');
  }
  console.log('  🖥️  仅本地 Qwen3 模型 · 无需 API Key');
  console.log(`  💾  角色与聊天记录保存目录：${DATA_DIR}`);
  console.log('  ⏹   Ctrl+C 停止');
  console.log('');
  if (AUTO_OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {}
  }
});

process.on('SIGINT', () => {
  console.log('\n再见 👋');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
