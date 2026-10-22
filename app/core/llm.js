/**
 * core/llm.js
 * ---------------------------------------------------------------------------
 * 模型接入层：多供应商统一调用 + 流式解析 + 超时/重试/中止 + 用量与成本统计。
 *
 * 契约：docs/ARCHITECTURE.md § 3.9（导出签名逐字一致）、§ 3.10（上游数据来自 data/models.js）。
 * 技术基线：原生 ES Module、浏览器直连、零依赖、零构建、禁止 CDN。
 *
 * 设计要点：
 * 1. 统一使用 fetch + 手工 SSE 解析（response.body.getReader() + TextDecoder），
 *    不使用 EventSource（它无法发送 POST，也无法自定义请求头）。
 * 2. 三种协议适配：openai / ollama（OpenAI 兼容）、anthropic、gemini。
 * 3. useProxy=true 时改走本地后端 `POST /api/llm`，密钥由服务器注入。
 * 4. 默认 120 秒无生成内容即中止；心跳不重置计时器，整次请求最长 10 分钟。
 * 5. 网络错误 / 5xx / 429 自动重试最多 2 次（退避 800ms、2000ms）；
 *    401 / 403 不重试，直接抛出可读中文错误。
 * 6. 用量写入 IndexedDB（库 aichat / 表 usage），失败时降级为内存记录，
 *    绝不让统计问题影响对话本身。
 * ---------------------------------------------------------------------------
 */

import { PROVIDERS_META, CHAT_MODELS, MODEL_PRICING, getProvider } from '../data/models.js';
// 持久层复用 core/store.js 的 openDB（同一个 aichat 数据库，store.js 已建好 usage 表），
// 避免多模块用不同版本各自 indexedDB.open 造成 schema 竞争。
import { openDB } from './store.js';
import { estimateTokens, dayKey } from './util.js';

/**
 * 供应商元数据（契约 3.9 要求 llm.js 也导出 PROVIDERS，即 data/models.js 的同一对象）。
 * @type {Record<string, object>}
 */
export const PROVIDERS = PROVIDERS_META;

/* ===========================================================================
 * 常量
 * ======================================================================== */

/** 默认空闲超时：120 秒内没有收到生成内容即中止 */
const DEFAULT_TIMEOUT_MS = 120000;
/** 整次请求的默认总时限：持续生成也不能无限占用连接 */
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
/** 重试退避（毫秒）：最多重试 2 次 */
const RETRY_DELAYS = [800, 2000];
/** 代理模式下的后端接口 */
const PROXY_ENDPOINT = '/api/llm';
/** 默认最大生成 token（Anthropic 的 max_tokens 为必填） */
const DEFAULT_MAX_TOKENS = 1024;
/** 代理未启动时的统一提示 */
const PROXY_HINT = '后端代理未启动，请运行 node server.mjs，或在设置中关闭代理模式';

/* ===========================================================================
 * 小工具
 * ======================================================================== */

/**
 * 取有限数值，非法时回退默认值。
 * @param {*} v
 * @param {number} d
 * @returns {number}
 */
function num(v, d) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return d;
}

/**
 * 可被中止的延时。
 * @param {number} ms
 * @param {AbortSignal|null} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    function settle(ok) {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (ok) resolve();
      else reject(makeAbortError());
    }
    onAbort = () => settle(false);
    if (signal && signal.aborted) {
      settle(false);
      return;
    }
    timer = setTimeout(() => settle(true), ms);
    // Node 环境下不要因为定时器让进程挂住
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 本地日期键 YYYY-MM-DD（按用户本地时区）。
 * @param {number} ts
 * @returns {string}
 */
/* ===========================================================================
 * 错误体系
 * ======================================================================== */

/**
 * @typedef {Error & { code: string, status: number }} LLMError
 * code: 'auth' | 'network' | 'rate' | 'timeout' | 'server' | 'aborted' | 'unknown'
 */

/**
 * 构造带 code / status 的统一错误对象。
 * @param {string} message 内部（英文或原始）消息
 * @param {'auth'|'network'|'rate'|'timeout'|'server'|'aborted'|'unknown'} code
 * @param {number} [status]
 * @param {object} [extra] 附加字段（如 { proxy: true, retryable: true }）
 * @returns {LLMError}
 */
function makeError(message, code, status = 0, extra = undefined) {
  const err = /** @type {LLMError} */ (new Error(message || '未知错误'));
  err.code = code;
  err.status = Number.isFinite(status) ? status : 0;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 用户主动取消。
 * @returns {LLMError}
 */
function makeAbortError() {
  return makeError('请求已取消', 'aborted', 0, { aborted: true });
}

/**
 * HTTP 状态码 → 错误分类。
 * @param {number} status
 * @returns {'auth'|'rate'|'server'|'unknown'}
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * 该错误是否值得重试（网络错误 / 5xx / 限流）。
 * @param {LLMError} err
 * @returns {boolean}
 */
function isRetryable(err) {
  if (!err) return false;
  return err.code === 'network' || err.code === 'server' || err.code === 'rate';
}

/**
 * 把 fetch 抛出的异常（或中止状态）翻译成本模块统一的错误对象。
 * @param {*} e
 * @param {{ idle: object, total: object, timeoutMs: number, totalTimeoutMs: number, callerSignal: AbortSignal|null, useProxy: boolean }} ctx
 * @returns {LLMError}
 */
function transportError(e, ctx) {
  if (ctx.callerSignal && ctx.callerSignal.aborted) return makeAbortError();
  if (ctx.total.timedOut || ctx.idle.timedOut) return timeoutError(ctx, e);
  if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return makeAbortError();
  const detail = e && e.message ? e.message : String(e);
  return makeError(detail, 'network', 0, {
    cause: e,
    retryable: true,
    proxy: !!ctx.useProxy
  });
}

/** 区分没有生成内容与整次请求超过总时限。 */
function timeoutError(ctx, cause) {
  const total = ctx.total.timedOut;
  const seconds = Math.max(1, Math.ceil((total ? ctx.totalTimeoutMs : ctx.timeoutMs) / 1000));
  const message = total
    ? `请求超过总时限（${seconds} 秒）`
    : `请求超时（${seconds} 秒没有收到生成内容）`;
  return makeError(message, 'timeout', 0, { cause });
}

/**
 * 读取失败响应的错误详情（兼容 OpenAI / Anthropic / Gemini / 本地代理的 JSON 错误体）。
 * @param {Response} res
 * @returns {Promise<{ status: number, message: string, body: string }>}
 */
async function readErrorInfo(res) {
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  let message = '';
  if (body) {
    try {
      const obj = JSON.parse(body);
      message =
        (obj && obj.error && (obj.error.message || obj.error.code)) ||
        (obj && obj.message) ||
        (obj && obj.detail) ||
        '';
      if (typeof message !== 'string') message = JSON.stringify(message);
    } catch {
      message = body.slice(0, 300);
    }
  }
  return { status: res.status, message: String(message || res.statusText || ''), body };
}

/**
 * 中文错误文案与判定工具（契约 3.9）。
 */
export const llmErrors = {
  /**
   * 是否为鉴权类错误（401 / 403，或错误码为 auth）。
   * @param {*} err
   * @returns {boolean}
   */
  isAuth(err) {
    return !!err && (err.code === 'auth' || err.status === 401 || err.status === 403);
  },

  /**
   * 是否为网络类错误（含后端代理未启动）。
   * @param {*} err
   * @returns {boolean}
   */
  isNetwork(err) {
    return !!err && (err.code === 'network' || err.name === 'TypeError');
  },

  /**
   * 是否为限流 / 额度不足。
   * @param {*} err
   * @returns {boolean}
   */
  isRateLimit(err) {
    return !!err && (err.code === 'rate' || err.status === 429);
  },

  /**
   * 转成给用户看的中文文案。
   * @param {*} err
   * @returns {string}
   */
  humanize(err) {
    if (!err) return '请求失败，请稍后重试';
    // 代理模式特有的提示优先
    if (err.proxy) return PROXY_HINT;
    // 代理已连通、但服务器上没有可用的密钥（server.mjs 的 .env 未配置）
    if (err.viaProxy && (err.code === 'auth' || err.status === 401 || err.status === 403)) {
      return '服务器代理未配置或用错了 API Key：请在 app/.env 中填写对应供应商的 API_KEY 后重启 node server.mjs，或在设置中关闭代理模式';
    }
    const code = err.code || (err.status ? classifyStatus(err.status) : 'unknown');
    switch (code) {
      case 'auth':
        return 'API Key 无效或未配置，请到「设置 → 模型」检查';
      case 'network':
        return '网络连接失败，请检查网络或代理设置后重试';
      case 'rate':
        return '请求过于频繁或额度不足，请稍后再试';
      case 'timeout':
        return '请求超时，模型长时间没有响应，请重试或换用更快的模型';
      case 'server':
        return `模型服务端出错${err.status ? `（HTTP ${err.status}）` : ''}，请稍后重试`;
      case 'aborted':
        return '已停止生成';
      default: {
        const detail = err.message ? `：${err.message}` : '';
        return `请求失败${detail}`;
      }
    }
  }
};

/* ===========================================================================
 * AbortSignal 合并与空闲超时
 * ======================================================================== */

/**
 * 合并多个 AbortSignal：优先使用原生 AbortSignal.any，否则手动桥接。
 * @param {Array<AbortSignal|null|undefined>} signals
 * @returns {{ signal: AbortSignal|null, cleanup: () => void }}
 */
function mergeSignals(signals) {
  const list = (signals || []).filter((s) => s && typeof s.aborted === 'boolean');
  if (list.length === 0) return { signal: null, cleanup: () => {} };
  if (list.length === 1) return { signal: list[0], cleanup: () => {} };

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(list), cleanup: () => {} };
  }

  const ctl = new AbortController();
  const onAbort = (e) => {
    const src = e && e.target;
    try {
      ctl.abort(src && 'reason' in src ? src.reason : undefined);
    } catch {
      ctl.abort();
    }
  };
  for (const s of list) {
    if (s.aborted) {
      onAbort({ target: s });
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    cleanup: () => {
      for (const s of list) s.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * 超时看门狗：每次 arm() 重置计时；到期后中止其 signal。
 * @param {number} ms
 * @param {string} reason
 * @returns {{ signal: AbortSignal, arm: () => void, clear: () => void, timedOut: boolean }}
 */
function createTimeoutWatch(ms, reason) {
  const ctl = new AbortController();
  let timer = null;
  let timedOut = false;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm() {
    clear();
    timer = setTimeout(() => {
      timedOut = true;
      try {
        ctl.abort(new Error(reason));
      } catch {
        ctl.abort();
      }
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  arm();

  return {
    signal: ctl.signal,
    arm,
    clear,
    get timedOut() {
      return timedOut;
    }
  };
}

/**
 * 便捷构造 AbortController（契约 3.9）。
 * @returns {AbortController}
 */
export function abortController() {
  return new AbortController();
}

/* ===========================================================================
 * 消息与请求体构造
 * ======================================================================== */

/**
 * 归一化参数：兼容 settings.params 的驼峰命名与协议里的下划线命名。
 * @param {object} [params]
 * @returns {{ temperature: number, topP: number, maxTokens: number, presencePenalty: number, frequencyPenalty: number, thinking: boolean|null }}
 */
function normParams(params) {
  const p = params || {};
  return {
    temperature: num(p.temperature !== undefined ? p.temperature : p.temp, 0.85),
    topP: num(p.topP !== undefined ? p.topP : p.top_p, 1),
    maxTokens: Math.max(1, Math.round(num(p.maxTokens !== undefined ? p.maxTokens : p.max_tokens, DEFAULT_MAX_TOKENS))),
    presencePenalty: num(p.presencePenalty !== undefined ? p.presencePenalty : p.presence_penalty, 0),
    frequencyPenalty: num(p.frequencyPenalty !== undefined ? p.frequencyPenalty : p.frequency_penalty, 0),
    // DeepSeek 专用的请求级开关。null 表示不干预模型默认行为；仅在
    // provider=deepseek 时会被写入上游请求，避免其他 OpenAI 兼容站不认该字段。
    thinking: typeof p.thinking === 'boolean' ? p.thinking : null
  };
}

/**
 * 把消息内容规整为纯文本（部分供应商会返回分段数组）。
 * @param {*} content
 * @returns {string}
 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

/**
 * 归一化 messages：只保留 role/content，角色限定为 system|user|assistant。
 * @param {Array<object>} [messages]
 * @returns {Array<{ role: string, content: string }>}
 */
function normMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of list) {
    if (!m) continue;
    const role = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    const content = contentToText(m.content);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

/**
 * 抽出 system 消息（Anthropic 与 Gemini 要求 system 独立于对话之外）。
 * @param {Array<{role: string, content: string}>} msgs
 * @returns {{ system: string, rest: Array<{role: string, content: string}> }}
 */
function splitSystem(msgs) {
  const systems = [];
  const rest = [];
  for (const m of msgs) {
    if (m.role === 'system') systems.push(m.content);
    else rest.push(m);
  }
  return { system: systems.join('\n\n'), rest };
}

/**
 * 合并相邻同角色消息（Anthropic / Gemini 对连续同角色不友好）。
 * @param {Array<{role: string, content: string}>} msgs
 * @returns {Array<{role: string, content: string}>}
 */
function mergeAdjacent(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * 构造 OpenAI / Ollama 兼容请求体。
 * @param {object} cfg
 * @param {boolean} stream
 * @param {boolean} includeUsage 是否请求流式 usage（stream_options）
 * @returns {object}
 */
function buildOpenAIBody(cfg, stream, includeUsage) {
  const p = cfg.params;
  const body = {
    model: cfg.model,
    messages: cfg.messages,
    stream: !!stream,
    temperature: p.temperature,
    top_p: p.topP,
    max_tokens: p.maxTokens,
    presence_penalty: p.presencePenalty,
    frequency_penalty: p.frequencyPenalty
  };
  if (cfg.provider === 'deepseek' && typeof p.thinking === 'boolean') {
    body.thinking = { type: p.thinking ? 'enabled' : 'disabled' };
  }
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  return body;
}

/**
 * 构造 Anthropic 请求体（system 提升到顶层，max_tokens 必填）。
 * @param {object} cfg
 * @param {boolean} stream
 * @returns {object}
 */
function buildAnthropicBody(cfg, stream) {
  const { system, rest } = splitSystem(cfg.messages);
  let msgs = mergeAdjacent(rest);
  if (msgs.length === 0) msgs = [{ role: 'user', content: '你好' }];
  // Anthropic 要求首条消息为 user 角色
  if (msgs[0].role !== 'user') msgs = [{ role: 'user', content: '（对话开始）' }, ...msgs];

  const body = {
    model: cfg.model,
    max_tokens: cfg.params.maxTokens || DEFAULT_MAX_TOKENS,
    messages: msgs.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    })),
    stream: !!stream,
    temperature: cfg.params.temperature,
    top_p: cfg.params.topP
  };
  if (system) body.system = system;
  // 说明：Anthropic 不支持 presence_penalty / frequency_penalty，故不下发。
  return body;
}

/**
 * 构造 Gemini 请求体（contents + systemInstruction）。
 * @param {object} cfg
 * @param {boolean} stream 仅用于文档说明，body 本身不区分流式
 * @returns {object}
 */
function buildGeminiBody(cfg) {
  const { system, rest } = splitSystem(cfg.messages);
  const contents = [];
  for (const m of mergeAdjacent(rest)) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text: m.content });
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '你好' }] });
  if (contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '（对话开始）' }] });

  const body = {
    contents,
    generationConfig: {
      temperature: cfg.params.temperature,
      topP: cfg.params.topP,
      maxOutputTokens: cfg.params.maxTokens
    }
  };
  // 说明：Gemini 的 generationConfig 不接受 presence/frequency penalty，故忽略这两个参数。
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

/* ===========================================================================
 * 响应解析（三种协议）
 * ======================================================================== */

/**
 * 从任意一个事件对象里找出错误信息。
 * @param {*} obj
 * @returns {string}
 */
function extractStreamError(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.error && typeof obj.error === 'object') {
    const m = obj.error.message || obj.error.code || obj.error.status;
    if (m) return String(m);
  }
  if (obj.type === 'error' && obj.message) return String(obj.message);
  return '';
}

/** 推理模型可能先输出不可见的思考 token；它算生成进展，心跳和用量事件不算。 */
function hasReasoningDelta(obj) {
  const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
  const openaiDelta = choice && choice.delta;
  if (openaiDelta && typeof openaiDelta.reasoning_content === 'string' && openaiDelta.reasoning_content.length) return true;
  const anthropicDelta = obj && obj.type === 'content_block_delta' ? obj.delta : null;
  return !!(anthropicDelta && anthropicDelta.type === 'thinking_delta' && typeof anthropicDelta.thinking === 'string' && anthropicDelta.thinking.length);
}

/**
 * 归一化各种形态的 usage 对象。
 * @param {*} u
 * @returns {{ prompt: number, completion: number }|null}
 */
function normalizeRawUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = num(u.prompt !== undefined ? u.prompt : u.prompt_tokens !== undefined ? u.prompt_tokens : u.input_tokens, 0);
  const completion = num(
    u.completion !== undefined ? u.completion : u.completion_tokens !== undefined ? u.completion_tokens : u.output_tokens,
    0
  );
  if (!prompt && !completion) return null;
  return { prompt: Math.max(0, Math.round(prompt)), completion: Math.max(0, Math.round(completion)) };
}

/**
 * 上游的「结束原因」里，哪些代表**被 token 上限截断**（而不是自然说完）。
 * 各家写法不同：OpenAI 系是 `length`、Anthropic 是 `max_tokens`、
 * Gemini 是 `MAX_TOKENS`、Ollama 是 `length` / `max_tokens`。
 * @param {string} reason
 * @returns {boolean}
 */
export function isTruncatedFinish(reason) {
  const r = String(reason || '').trim();
  if (!r) return false;
  return /^(length|max_tokens|max_output_tokens|token_limit)$/i.test(r);
}

/**
 * 生成某种协议的事件解析器。
 * @param {'openai'|'anthropic'|'gemini'|'ollama'} kind
 * @returns {{ delta: (o:any)=>string, fullText: (o:any)=>string, usage: (o:any)=>object|null, model: (o:any)=>string, finish: (o:any)=>string }}
 */
function makeExtractor(kind) {
  if (kind === 'anthropic') {
    return {
      delta(obj) {
        if (!obj) return '';
        if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
        if (obj.type === 'content_block_start' && obj.content_block && obj.content_block.type === 'text') {
          return obj.content_block.text || '';
        }
        return '';
      },
      fullText(obj) {
        if (!obj) return '';
        if (Array.isArray(obj.content)) {
          return obj.content
            .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
            .map((b) => b.text || '')
            .join('');
        }
        return typeof obj.completion === 'string' ? obj.completion : '';
      },
      usage(obj) {
        if (!obj) return null;
        if (obj.type === 'message_start' && obj.message && obj.message.usage) return normalizeRawUsage(obj.message.usage);
        if (obj.type === 'message_delta' && obj.usage) {
          const u = normalizeRawUsage(obj.usage);
          // message_delta 只带 output_tokens，prompt 保持此前累计值
          return u ? { prompt: 0, completion: u.completion } : null;
        }
        return normalizeRawUsage(obj.usage);
      },
      model(obj) {
        if (!obj) return '';
        if (obj.message && typeof obj.message.model === 'string') return obj.message.model;
        return typeof obj.model === 'string' ? obj.model : '';
      },
      finish(obj) {
        if (!obj) return '';
        // 流式：message_delta.delta.stop_reason；非流式：顶层 stop_reason
        const d = obj.delta && typeof obj.delta.stop_reason === 'string' ? obj.delta.stop_reason : '';
        return d || (typeof obj.stop_reason === 'string' ? obj.stop_reason : '');
      }
    };
  }

  if (kind === 'gemini') {
    return {
      delta(obj) {
        const cand = obj && Array.isArray(obj.candidates) ? obj.candidates[0] : null;
        const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : null;
        if (!parts) return '';
        return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      },
      fullText(obj) {
        return this.delta(obj);
      },
      usage(obj) {
        const u = obj && obj.usageMetadata;
        if (!u) return null;
        return normalizeRawUsage({ prompt: u.promptTokenCount, completion: u.candidatesTokenCount });
      },
      model(obj) {
        return obj && typeof obj.modelVersion === 'string' ? obj.modelVersion : '';
      },
      finish(obj) {
        const cand = obj && Array.isArray(obj.candidates) ? obj.candidates[0] : null;
        return cand && typeof cand.finishReason === 'string' ? cand.finishReason : '';
      }
    };
  }

  // openai / ollama（OpenAI 兼容）
  return {
    delta(obj) {
      const c = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
      if (!c) return '';
      if (c.delta) return contentToText(c.delta.content);
      if (c.message) return contentToText(c.message.content);
      if (typeof c.text === 'string') return c.text;
      return '';
    },
    fullText(obj) {
      const c = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
      if (!c) return '';
      if (c.message) return contentToText(c.message.content);
      if (typeof c.text === 'string') return c.text;
      return '';
    },
    usage(obj) {
      return obj ? normalizeRawUsage(obj.usage) : null;
    },
    model(obj) {
      return obj && typeof obj.model === 'string' ? obj.model : '';
    },
    finish(obj) {
      const c = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
      const r = c && typeof c.finish_reason === 'string' ? c.finish_reason : '';
      // Ollama 的原生字段
      return r || (obj && typeof obj.done_reason === 'string' ? obj.done_reason : '');
    }
  };
}

/**
 * 代理模式专用解析器。
 * server.mjs 会把上游（含 Anthropic / Gemini）的响应**统一转换成 OpenAI 的增量格式**
 * 再透传给浏览器，而非流式请求则原样返回上游 JSON。
 * 因此这里做成混合解析：增量优先按 OpenAI 格式取，完整文本优先按各家原生格式取。
 * @param {'openai'|'anthropic'|'gemini'|'ollama'} kind
 * @returns {{ delta: (o:any)=>string, fullText: (o:any)=>string, usage: (o:any)=>object|null, model: (o:any)=>string, finish: (o:any)=>string }}
 */
function makeProxyExtractor(kind) {
  const native = makeExtractor(kind);
  const openai = makeExtractor('openai');
  return {
    delta(obj) {
      return openai.delta(obj) || native.delta(obj);
    },
    fullText(obj) {
      return native.fullText(obj) || openai.fullText(obj);
    },
    usage(obj) {
      return openai.usage(obj) || native.usage(obj);
    },
    model(obj) {
      return native.model(obj) || openai.model(obj);
    },
    finish(obj) {
      // 代理模式下流被归一化成 OpenAI 格式；非流式则是上游原始 JSON
      return openai.finish(obj) || native.finish(obj);
    }
  };
}

/**
 * 收到"收尾事件"后再多等一会儿的宽限期。
 *
 * 为什么需要：有些供应商（尤其走本地代理时）会把 `usage` 之类的事件放在 finish_reason
 * **之后**，立刻断开就拿不到 token 统计了。
 *
 * 为什么分两档：直连模式下客户端根本没请求 `stream_options.include_usage`，
 * finish_reason 之后不会再有任何有用的事件 —— 等 3 秒纯粹是让用户多等，
 * 所以只留 300ms 兜"同一批到达的尾包"；代理模式下服务端会转发 usage，
 * 才值得多等一会儿。
 */
const FINISH_GRACE_MS = 2500;
const FINISH_GRACE_DIRECT_MS = 300;

/**
 * 读取 SSE 流。
 * 兼容：`data: {...}` 逐行事件、多行 data 事件、心跳注释行、`[DONE]` 结束标记，
 * 以及少数实现直接输出裸 JSON 行的情况。
 *
 * 结束条件（三个，缺一不可）：
 *   1. 收到 `[DONE]`；
 *   2. onEvent 回调**返回 true**（调用方判定"这条流已经说完了"，见 runChat 的
 *      applyEvent：收到带 finish_reason 的收尾事件、且没有正文增量时就是这种情形）；
 *   3. 对端关闭连接（read() 返回 done）。
 *
 * 为什么必须有第 2 条：不少网关/中转站在最后一个 chunk（只带 finish_reason）之后
 * **既不发 [DONE]、也不关连接**，连接就挂在 keep-alive 池里。以前只能等空闲看门狗
 * 到期，于是"已经生成完整的一段回复"被当成超时错误整条丢弃 —— 用户看到的是
 * "AI 卡了一两分钟，然后报错，什么也没有"。收到收尾事件就收工才能真正救回这段话。
 * @param {Response} res
 * @param {(payload: string) => void|boolean} onEvent 每个事件的原始 payload；返回 true 表示"可以停止读取了"
 * @returns {Promise<void>}
 */
async function readSSE(res, onEvent, opts) {
  const o = opts || {};
  /** 判定"流已经说完"后调用：给尾包留一小段宽限期（内部会自己关掉 reader） */
  const doStop = typeof o.stop === 'function' ? o.stop : null;
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // 环境不支持流式读取（例如极旧的浏览器）：退化为整体读取
    const text = await res.text();
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith(':')) continue;
      if (onEvent(t.startsWith('data:') ? t.slice(5).trim() : t) === true) {
        if (doStop) doStop(null);
        return;
      }
    }
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines = [];
  let finished = false;
  /** 已经交给"宽限期"处理，主循环不要再把它当结束标记 */
  let handedOff = false;

  function flush() {
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    // 调用方在派发过程中抛错时必须原样冒泡（上游 error 事件靠这个机制上报）
    if (onEvent(payload) === true) {
      if (doStop) {
        handedOff = true;
        doStop(reader);
      } else {
        finished = true;
      }
    }
    if (payload.trim() === '[DONE]') finished = true;
  }

  function push(payload) {
    dataLines.push(payload);
    // 启发式：绝大多数供应商一行就是一个完整 JSON 事件，能解析就立即派发，
    // 这样即便对方漏发事件间的空行也不会丢内容。
    try {
      JSON.parse(dataLines.join('\n'));
    } catch {
      return; // 仅忽略尚不完整的 JSON，不吞掉 onEvent 抛出的上游错误
    }
    flush();
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf('\n');
      while (nl >= 0 && !finished) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') flush();
        else if (line.startsWith(':')) {
          /* SSE 注释 / 心跳，忽略 */
        } else if (line.startsWith('data:')) {
          push(line.slice(5).replace(/^ /, ''));
        } else if (line[0] === '{' || line[0] === '[') {
          push(line);
        }
        nl = buffer.indexOf('\n');
      }
      // 有些网关发完 [DONE] 仍保持 SSE 连接；到结束标记就主动结束读取。
      if (finished) break;
      // 交棒给宽限期后**继续读**（尾包 usage 之类要收），但看门狗已被 finishStream
      // 切成宽限期，所以不会真的等满空闲超时。
    }

    if (!finished) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const t = buffer.trim();
        if (t.startsWith('data:')) push(t.slice(5).replace(/^ /, ''));
        else if (t[0] === '{' || t[0] === '[') push(t);
      }
      flush();
    }
  } catch (e) {
    try {
      await reader.cancel();
    } catch {
      /* 忽略 */
    }
    throw e;
  } finally {
    // 注意：handedOff（收到收尾事件、交给宽限期）**不能**在这里 cancel ——
    // 宽限期的意义就是"再等一会儿尾包（usage 之类）"，提前 cancel 等于把宽限期废掉。
    // 真正的 [DONE] 才立刻收工。
    if (finished && !handedOff) {
      try {
        await reader.cancel();
      } catch {
        /* 忽略：结束标记已收到 */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* 忽略 */
    }
  }
}

/* ===========================================================================
 * 请求规划
 * ======================================================================== */

/**
 * 解析调用参数，得到一次请求所需的全部配置。
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function resolveConfig(opts) {
  const o = opts || {};
  const provider = typeof o.provider === 'string' && o.provider ? o.provider : 'deepseek';
  const meta = getProvider(provider);
  const kind = meta.kind || 'openai';

  const customBase = typeof o.baseUrl === 'string' && o.baseUrl.trim() ? o.baseUrl.trim() : '';
  const baseUrl = (customBase || meta.baseUrl || '').replace(/\/+$/, '');

  const requestedModel =
    typeof o.model === 'string' && o.model.trim()
      ? o.model.trim()
      : (meta.models && meta.models[0]) || '';
  const params = normParams(o.params);
  let model = requestedModel;
  // 2026-07 后 DeepSeek 的 deepseek-chat / deepseek-reasoner 旧名停用。为已保存的
  // 全局设置和角色独立模型做请求时兼容，并保留旧名原本的思考语义。
  if (provider === 'deepseek' && (model === 'deepseek-chat' || model === 'deepseek-reasoner')) {
    if (params.thinking === null) params.thinking = model === 'deepseek-reasoner';
    model = 'deepseek-flash';
  }

  const cfg = {
    provider,
    meta,
    kind,
    model,
    baseUrl,
    // 代理只应收到用户显式填写的覆盖地址；默认地址由服务端自行选择。
    customBaseUrl: customBase,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey.trim() : '',
    messages: normMessages(o.messages),
    params,
    useProxy: !!o.useProxy,
    // 代理模式：keySlot 用于指定服务器上读取哪一份密钥；proxyToken 对应 server.mjs 的 AICHAT_PROXY_TOKEN
    keySlot: typeof o.keySlot === 'string' && o.keySlot ? o.keySlot : provider,
    proxyToken: typeof o.proxyToken === 'string' ? o.proxyToken : ''
  };
  return fillProxyDefaults(cfg);
}

/* ---------------------------------------------------------------------------
 * 代理口令兜底：调用方不一定显式传 proxyToken，
 * 这里从全局设置里补一次，避免用户明明在设置里填了口令却不生效。
 * 用惰性 import，避免与 core/store.js 形成加载期强耦合。
 * ------------------------------------------------------------------------- */
let settingsFallbackPromise = null;
let settingsFallbackAt = 0;
/** 缓存有效期：口令/密钥槽可能被用户在设置里改掉，不能永久缓存（否则一直 401，只能刷新页面） */
const SETTINGS_FALLBACK_TTL = 5000;

/** @returns {Promise<object>} */
function loadSettingsForFallback() {
  const stale = Date.now() - settingsFallbackAt > SETTINGS_FALLBACK_TTL;
  if (!settingsFallbackPromise || stale) {
    settingsFallbackAt = Date.now();
    settingsFallbackPromise = import('./store.js')
      .then((m) => (typeof m.getSettings === 'function' ? m.getSettings() : {}))
      .catch(() => ({}));
  }
  return settingsFallbackPromise;
}

/**
 * 补齐配置里缺省的代理相关字段（仅代理模式且调用方没传口令时生效）
 * @param {object} cfg
 * @returns {Promise<object>}
 */
async function fillProxyDefaults(cfg) {
  if (!cfg.useProxy || (cfg.proxyToken && cfg.proxyToken !== '')) return cfg;
  try {
    const s = await loadSettingsForFallback();
    if (!cfg.proxyToken && typeof s.proxyToken === 'string') cfg.proxyToken = s.proxyToken;
    if (s.proxyKeySlot && cfg.keySlot === cfg.provider) cfg.keySlot = s.proxyKeySlot;
  } catch {
    /* 忽略：没有口令而服务器开启了校验时，会返回 401 与中文提示 */
  }
  return cfg;
}

/**
 * 构造请求计划（直接调用供应商 或 走本地代理）。
 * @param {object} cfg
 * @param {boolean} stream
 * @param {boolean} includeUsage
 * @returns {{ url: string, headers: Record<string,string>, body: object, stream: boolean }}
 */
function buildPlan(cfg, stream, includeUsage) {
  if (cfg.useProxy) {
    const body = {
      provider: cfg.provider,
      model: cfg.model,
      messages: cfg.messages,
      params: cfg.params,
      stream: !!stream,
      keySlot: cfg.keySlot
    };
    // 自定义反代地址一并交给后端（服务器可选择忽略）
    if (cfg.customBaseUrl) body.baseUrl = cfg.customBaseUrl;
    const headers = { 'Content-Type': 'application/json' };
    // 局域网首次访问通常靠 HttpOnly Cookie；手填的口令也可作为请求头使用。
    if (cfg.proxyToken) headers['X-Aichat-Token'] = cfg.proxyToken;
    return {
      url: PROXY_ENDPOINT,
      headers,
      body,
      stream: !!stream
    };
  }

  if (!cfg.baseUrl) {
    throw makeError('尚未配置接口地址，请到「设置 → 模型」填写 baseUrl', 'unknown', 0);
  }
  if (!cfg.model) {
    throw makeError('尚未选择模型，请到「设置 → 模型」选择或填写模型名', 'unknown', 0);
  }

  if (cfg.kind === 'anthropic') {
    if (!cfg.apiKey) throw makeError('缺少 Anthropic API Key', 'auth', 401);
    return {
      url: `${cfg.baseUrl}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        // 浏览器直连 Anthropic 必需，否则会被 CORS 策略拒绝
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: buildAnthropicBody(cfg, stream),
      stream: !!stream
    };
  }

  if (cfg.kind === 'gemini') {
    if (!cfg.apiKey) throw makeError('缺少 Gemini API Key', 'auth', 401);
    const action = stream ? 'streamGenerateContent?alt=sse&key=' : 'generateContent?key=';
    return {
      url: `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:${action}${encodeURIComponent(cfg.apiKey)}`,
      headers: { 'Content-Type': 'application/json' },
      body: buildGeminiBody(cfg),
      stream: !!stream
    };
  }

  // openai / ollama
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  else if (cfg.meta.needKey && cfg.provider !== 'custom') {
    throw makeError(`缺少 ${cfg.meta.label} 的 API Key`, 'auth', 401);
  }
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    headers,
    body: buildOpenAIBody(cfg, stream, includeUsage),
    stream: !!stream
  };
}

/* ===========================================================================
 * 网络执行（重试 / 超时 / 错误分类）
 * ======================================================================== */

/**
 * 发起一次 fetch 并校验响应状态。
 * @param {object} plan
 * @param {object} ctx
 * @returns {Promise<Response>}
 */
async function fetchOnce(plan, ctx) {
  let res;
  try {
    res = await fetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      signal: ctx.signal
    });
  } catch (e) {
    throw transportError(e, ctx);
  }

  if (!res.ok) {
    const info = await readErrorInfo(res);
    let code = classifyStatus(res.status);
    // server.mjs 在服务器上没有配置密钥时返回 400，这本质上是鉴权配置问题
    if (ctx.useProxy && res.status === 400 && /api\s*key|密钥/i.test(info.message)) code = 'auth';
    const suffix = ctx.useProxy ? '（后端代理返回）' : '';
    const detail = info.message ? `：${info.message}` : '';
    throw makeError(`${code.toUpperCase()} ${res.status}${suffix}${detail}`, code, res.status, {
      retryable: isRetryable({ code }),
      viaProxy: ctx.useProxy,
      raw: info.body
    });
  }

  return res;
}

/**
 * 带重试的请求执行。
 * @param {object} plan
 * @param {object} ctx
 * @returns {Promise<Response>}
 */
async function performRequest(plan, ctx) {
  const attempts = RETRY_DELAYS.length + 1;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await delay(RETRY_DELAYS[i - 1], ctx.callerSignal);
    }
    try {
      return await fetchOnce(plan, ctx);
    } catch (err) {
      lastErr = err;
      const canRetry =
        isRetryable(err) && !ctx.hasData() && !(ctx.callerSignal && ctx.callerSignal.aborted) && i < attempts - 1;
      if (!canRetry) throw err;
    }
  }
  throw lastErr;
}

/* ===========================================================================
 * 核心：一次对话请求
 * ======================================================================== */

/**
 * 执行一次对话（流式或非流式）。
 * @param {object} opts 见 chat / chatStream
 * @param {boolean} stream
 * @param {((delta: string, full: string) => void)|null} emitDelta
 * @returns {Promise<{ text: string, usage: object, raw: any, model: string, aborted: boolean }>}
 */
async function runChat(opts, stream, emitDelta) {
  const cfg = await resolveConfig(opts);
  // 代理模式下响应已被 server.mjs 归一化为 OpenAI 增量格式，故走混合解析器
  const extractor = cfg.useProxy && cfg.kind !== 'openai' ? makeProxyExtractor(cfg.kind) : makeExtractor(cfg.kind);
  const timeoutMs = num(opts && opts.timeoutMs, 0) > 0 ? num(opts.timeoutMs, 0) : DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = num(opts && opts.totalTimeoutMs, 0) > 0 ? num(opts.totalTimeoutMs, 0) : DEFAULT_TOTAL_TIMEOUT_MS;
  const callerSignal = (opts && opts.signal) || null;

  const idle = createTimeoutWatch(timeoutMs, 'idle-timeout');
  const total = createTimeoutWatch(totalTimeoutMs, 'total-timeout');
  const merged = mergeSignals([callerSignal, idle.signal, total.signal]);

  const ctx = {
    idle,
    total,
    timeoutMs,
    totalTimeoutMs,
    extractor,
    cfg,
    signal: merged.signal,
    callerSignal,
    useProxy: cfg.useProxy,
    text: '',
    usageAcc: { prompt: 0, completion: 0 },
    hasUsage: false,
    gotData: false,
    raw: null,
    model: cfg.model,
    /**
     * 上游给的结束原因（OpenAI 的 finish_reason / Anthropic 的 stop_reason / Gemini 的 finishReason）。
     * 关键用途：`length` 表示**被 max_tokens 截断**，正文是半句话——调用方必须能识别出来
     * （以前这个字段被整条链路丢掉了，于是"说一半"的发言被当成完整发言落库）。
     * @type {string}
     */
    finishReason: '',
    hasData() {
      return this.gotData;
    }
  };

  /** 应用一个流式事件 */
  function applyEvent(obj) {
    ctx.raw = obj;
    const errMsg = extractStreamError(obj);
    if (errMsg) throw makeError(errMsg, classifyStatus(0), 0, { raw: obj });

    // 结束原因要单独收：带 finish_reason 的那个事件通常**没有正文增量**
    // （OpenAI 系最后一个 chunk 往往只有 finish_reason），漏掉它就等于丢掉了
    // "这次被截断了"的唯一信号。
    const fr = extractor.finish(obj);
    if (fr) ctx.finishReason = fr;

    const u = extractor.usage(obj);
    if (u) {
      // 多数供应商返回的是累计值，取最大值合并更稳妥
      ctx.usageAcc.prompt = Math.max(ctx.usageAcc.prompt, u.prompt || 0);
      ctx.usageAcc.completion = Math.max(ctx.usageAcc.completion, u.completion || 0);
      ctx.hasUsage = true;
    }

    const m = extractor.model(obj);
    if (m) ctx.model = m;

    const delta = extractor.delta(obj);
    if (delta) {
      idle.arm();
      ctx.text += delta;
      ctx.gotData = true;
      if (emitDelta) emitDelta(delta, ctx.text);
      return false;
    } else if (hasReasoningDelta(obj)) {
      // 推理模型的思考文本暂不展示，但它证明模型仍在生成；心跳与 usage 不算进展。
      idle.arm();
      return false;
    }
    // 走到这里：这一条事件没有正文增量。若它带了结束原因，说明上游已经把话说完了
    // （OpenAI 系最后一个 chunk 通常只有 finish_reason、没有 content）。
    // 告诉 readSSE "可以停止读取了"：有些网关此后既不发 [DONE] 也不关连接，
    // 继续等下去只会等到看门狗超时，把一段完整回复当成错误丢掉。
    return !!fr;
  }

  /** 应用一个完整的（非流式）响应体 */
  function applyFull(obj) {
    ctx.raw = obj;
    const errMsg = extractStreamError(obj);
    if (errMsg) throw makeError(errMsg, 'server', 0, { raw: obj });

    const fr = extractor.finish(obj);
    if (fr) ctx.finishReason = fr;

    let text = extractor.fullText(obj);
    // 兼容本地代理可能直接返回 { text, usage, model }
    if (!text && obj && typeof obj.text === 'string') text = obj.text;

    const m = extractor.model(obj);
    if (m) ctx.model = m;
    else if (obj && typeof obj.model === 'string') ctx.model = obj.model;

    const u = extractor.usage(obj) || normalizeRawUsage(obj && obj.usage);
    if (u) {
      ctx.usageAcc.prompt = Math.max(ctx.usageAcc.prompt, u.prompt || 0);
      ctx.usageAcc.completion = Math.max(ctx.usageAcc.completion, u.completion || 0);
      ctx.hasUsage = true;
    }

    if (text) {
      ctx.text = text;
      ctx.gotData = true;
      if (emitDelta) {
        // 非流式一次性把全文作为 delta 抛出，保证上层渲染逻辑统一
        emitDelta(text, ctx.text);
      }
    }
  }

  let aborted = false;
  /** 收到收尾事件后是否已交棒给"宽限期"（见 finishStream） */
  let handedOff = false;
  /** 宽限期定时器 */
  let graceTimer = null;
  /** 本模式下的宽限期长度：代理模式要等服务端转发的 usage，直连模式不需要（见常量说明） */
  const finishGraceMs = cfg.useProxy ? FINISH_GRACE_MS : FINISH_GRACE_DIRECT_MS;
  /**
   * 收到收尾事件后：不再把等待算作"空闲超时"，而是切到宽限期。
   *
   * 为什么不是"立刻结束读取"：有些供应商（尤其走本地代理时）会把 `usage` 之类的事件
   * 放在 finish_reason **之后**，立刻断开就拿不到 token 统计了。所以做法是
   * "保留读循环、把看门狗的超时从 120 秒换成宽限期"，到点 cancel 读流 →
   * read() 立刻返回 done → 上层走**成功收尾**分支（而不是超时错误分支）。
   * @param {{ cancel: () => Promise<void> }|null} reader 当前读流
   */
  const finishStream = (reader) => {
    handedOff = true;
    // 客户端自己的空闲看门狗也要让位：否则它会按原值（默认 120 秒，测试里可能更短）
    // 先于宽限期开火，把一段已经完整的回复判成超时错误。
    idle.clear();
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    graceTimer = setTimeout(() => {
      graceTimer = null;
      try {
        reader?.cancel();
      } catch {
        /* 忽略 */
      }
    }, finishGraceMs);
  };

  try {
    let includeUsage = stream && cfg.kind === 'openai' && !cfg.useProxy && cfg.provider !== 'ollama';
    let plan = buildPlan(cfg, stream, includeUsage);

    let res;
    try {
      res = await performRequest(plan, ctx);
    } catch (e) {
      // 个别兼容实现不认 stream_options，去掉后重试一次
      if (e && e.status === 400 && includeUsage && /stream_options/i.test(e.message || '')) {
        includeUsage = false;
        plan = buildPlan(cfg, stream, includeUsage);
        res = await performRequest(plan, ctx);
      } else {
        throw e;
      }
    }

    if (stream) {
      const ctype = ((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
      if (ctype.includes('application/json') && !ctype.includes('event-stream')) {
        // 服务端忽略了 stream=true，直接返回完整 JSON
        const data = await res.json();
        applyFull(data);
      } else {
        await readSSE(
          res,
          (payload) => {
            const p = String(payload).trim();
            if (!p) return false;
            if (p === '[DONE]') return false;
            let obj;
            try {
              obj = JSON.parse(p);
            } catch {
              return false; // 无法解析的片段直接忽略，避免中断整条流
            }
            return applyEvent(obj) === true;
          },
          { stop: finishStream }
        );
      }
    } else {
      const ctype = ((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
      if (ctype.includes('event-stream')) {
        // 服务端强行流式返回：按流式事件处理，最后以累计文本为准
        await readSSE(
          res,
          (payload) => {
            const p = String(payload).trim();
            if (!p || p === '[DONE]') return false;
            let obj;
            try {
              obj = JSON.parse(p);
            } catch {
              return false; // 忽略无法解析的片段
            }
            return applyEvent(obj) === true;
          },
          { stop: finishStream }
        );
      } else {
        const data = await res.json();
        applyFull(data);
      }
    }
  } catch (e) {
    const raw = /** @type {any} */ (e);
    // 统一把各种中止形态（fetch 的 AbortError、DOMException code 20、内部错误码）翻译成本模块错误
    const abortLike = !!raw && (raw.name === 'AbortError' || raw.code === 'ABORT_ERR' || raw.code === 20);
    const callerAborted = !!(callerSignal && callerSignal.aborted);

    if (callerAborted) {
      // 用户主动停止：不抛错，返回已生成的内容
      aborted = true;
      // 被掐断（用户停止 / 看门狗超时）时同样要带上截断信息：
      // 上层据此判断"这句话没说完"，而不是把它当成完整发言。
      return {
        text: ctx.text,
        usage: finalizeUsage(ctx),
        raw: ctx.raw,
        model: ctx.model,
        aborted: true,
        finishReason: ctx.finishReason,
        truncated: isTruncatedFinish(ctx.finishReason)
      };
    }
    // 注意：使用 AbortSignal.any 时，读流失败抛出的可能是我们自定义的中止原因
    // （而非标准 AbortError），所以先判断看门狗是否到期。
    if (total.timedOut || idle.timedOut) throw timeoutError(ctx, raw);
    if (abortLike) {
      aborted = true;
      // 被掐断（用户停止 / 看门狗超时）时同样要带上截断信息：
      // 上层据此判断"这句话没说完"，而不是把它当成完整发言。
      return {
        text: ctx.text,
        usage: finalizeUsage(ctx),
        raw: ctx.raw,
        model: ctx.model,
        aborted: true,
        finishReason: ctx.finishReason,
        truncated: isTruncatedFinish(ctx.finishReason)
      };
    }
    if (raw && !raw.code) raw.code = 'unknown';
    throw raw;
  } finally {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    idle.clear();
    total.clear();
    merged.cleanup();
  }

  return {
    text: ctx.text,
    usage: finalizeUsage(ctx),
    raw: ctx.raw,
    model: ctx.model,
    aborted,
    finishReason: ctx.finishReason,
    truncated: isTruncatedFinish(ctx.finishReason)
  };
}

/**
 * 结算 usage：优先使用供应商返回的真实 token 数，缺失时按字符粗略估算，
 * 并统一补齐 cost（人民币，保留 6 位小数）。
 * @param {object} ctx
 * @returns {{ prompt: number, completion: number, total: number, cost: number }}
 */
function finalizeUsage(ctx) {
  const estPrompt = ctx.cfg.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  let prompt = ctx.usageAcc.prompt;
  let completion = ctx.usageAcc.completion;

  if (!ctx.hasUsage) {
    // 供应商没返回 usage（例如中止得早）：整体按字符估算
    prompt = estPrompt;
    completion = estimateTokens(ctx.text);
  } else {
    if (!prompt) prompt = estPrompt;
    if (!completion && ctx.text) completion = estimateTokens(ctx.text);
  }

  const total = prompt + completion;
  return {
    prompt,
    completion,
    total,
    cost: estimateCost(ctx.cfg.provider, ctx.model, { prompt, completion })
  };
}

/* ===========================================================================
 * 对外 API
 * ======================================================================== */

/**
 * 非流式对话（契约 3.9）。
 * @param {object} opts
 *   { provider, model, apiKey, baseUrl, messages, params, useProxy, stream: false, signal?, timeoutMs?, totalTimeoutMs? }
 * @returns {Promise<{ text: string, usage: {prompt:number,completion:number,total:number,cost:number}, raw: any, model: string, finishReason: string, truncated: boolean }>}
 */
export async function chat(opts) {
  const r = await runChat({ ...(opts || {}), stream: false }, false, null);
  return {
    text: r.text,
    usage: r.usage,
    raw: r.raw,
    model: r.model,
    finishReason: r.finishReason,
    truncated: r.truncated
  };
}

/**
 * 流式对话（契约 3.9）。
 * - 每收到一段增量文本调用 handlers.onDelta(deltaText, fullText)
 * - 正常结束（含用户主动中止）调用 handlers.onDone(fullText)
 * - 出错时先调用 handlers.onError(err)，**同时把异常抛出**，调用方 await 可以 catch
 * - 用户中止时返回 { text, usage, model, aborted: true }，不抛错
 * @param {object} opts
 *   { provider, model, apiKey, baseUrl, messages, params, useProxy, stream: true, signal, timeoutMs?, totalTimeoutMs? }
 * @param {{ onDelta?: (t: string, full: string) => void, onDone?: (full: string) => void, onError?: (e: Error) => void }} [handlers]
 * @returns {Promise<{ text: string, usage: object, model: string, aborted: boolean, finishReason: string, truncated: boolean }>}
 */
export async function chatStream(opts, handlers) {
  const h = handlers || {};
  const onDelta = typeof h.onDelta === 'function' ? h.onDelta : () => {};
  const onDone = typeof h.onDone === 'function' ? h.onDone : () => {};
  const onError = typeof h.onError === 'function' ? h.onError : () => {};

  let result;
  try {
    result = await runChat({ ...(opts || {}), stream: true }, true, (delta, full) => {
      onDelta(delta, full);
    });
  } catch (e) {
    const err = /** @type {Error} */ (e);
    if (!err.code) err.code = 'unknown';
    try {
      onError(err);
    } catch {
      /* onError 自身抛错不影响主流程 */
    }
    throw err;
  }

  onDone(result.text);
  return {
    text: result.text,
    usage: result.usage,
    model: result.model,
    aborted: !!result.aborted,
    finishReason: result.finishReason,
    truncated: result.truncated
  };
}

/**
 * 拉取供应商可用模型列表（契约 3.9）。
 * - OpenAI 兼容家：GET {baseUrl}/models
 * - Anthropic / Gemini：请求失败或无结果时回退内置 CHAT_MODELS
 * - 任何异常都不抛出，最差返回 []
 * @param {string} provider
 * @param {string} [apiKey]
 * @param {string} [baseUrl]
 * @returns {Promise<string[]>}
 */
export async function listModels(provider, apiKey, baseUrl, options = {}) {
  const meta = getProvider(provider);
  const builtin = Array.isArray(CHAT_MODELS[provider]) ? CHAT_MODELS[provider].slice() : [];
  const kind = meta.kind || 'openai';
  const base = String(baseUrl || meta.baseUrl || '').replace(/\/+$/, '');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';

  if (options.useProxy) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (options.proxyToken) headers['X-Aichat-Token'] = String(options.proxyToken);
      const res = await fetch('/api/models', {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider, baseUrl: String(baseUrl || '').trim(), keySlot: options.keySlot || 'default' }),
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(15000)
          : undefined,
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.models) ? data.models.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /** 按协议给出兜底列表 */
  const fallback = () => (kind === 'anthropic' || kind === 'gemini' ? builtin : []);

  if (!base) return fallback();

  let timer = null;
  let ctl = null;
  try {
    let url = `${base}/models`;
    const headers = {};
    if (kind === 'gemini') {
      if (!key) return builtin;
      url += `?key=${encodeURIComponent(key)}`;
    } else if (kind === 'anthropic') {
      if (!key) return builtin;
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (key) {
      headers.Authorization = `Bearer ${key}`;
    }

    ctl = new AbortController();
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(15000)
      : ctl.signal;
    if (signal === ctl.signal) {
      timer = setTimeout(() => ctl.abort(), 15000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    const res = await fetch(url, { method: 'GET', headers, signal });
    if (!res.ok) return fallback();

    const data = await res.json();
    const arr = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : [];
    const list = arr
      .map((it) => {
        if (typeof it === 'string') return it;
        if (!it || typeof it !== 'object') return '';
        const id = it.id || it.name || it.model || '';
        return String(id).replace(/^models\//, '');
      })
      .filter(Boolean);
    return list.length ? Array.from(new Set(list)) : fallback();
  } catch {
    return fallback();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ===========================================================================
 * 成本估算
 * ======================================================================== */

/** 价格表键按长度倒序，供前缀模糊匹配使用 */
const PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

/**
 * 在价格表里查找某个模型名对应的价格（支持模糊匹配）。
 * 例：gpt-4o-mini-2024-07-18 → gpt-4o-mini；claude-sonnet-4-5-20250929 → claude-sonnet-4-5。
 * @param {string} model
 * @returns {{ in: number, out: number }|null}
 */
function findPricing(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return null;

  const candidates = new Set();
  const add = (s) => {
    if (s) candidates.add(s);
  };

  add(raw);
  // 去掉日期/版本后缀
  const stripped = raw
    .replace(/(-\d{8})$/, '')
    .replace(/(-\d{4}-\d{2}-\d{2})$/, '')
    .replace(/-(latest|preview|beta|stable)$/, '');
  add(stripped);
  // 去掉 :free / :beta 之类的后缀
  add(raw.replace(/:[a-z0-9-]+$/, ''));
  // 处理带组织前缀的模型名（openrouter / siliconflow）
  const slash = raw.lastIndexOf('/');
  if (slash >= 0) {
    add(raw.slice(slash + 1));
    candidates.add(raw.slice(0, slash + 1) + stripped.slice(slash + 1));
  }

  // 1) 精确命中
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, c)) return MODEL_PRICING[c];
  }
  // 2) 前缀命中（长的键优先，避免 gpt-4o 抢走 gpt-4o-mini）
  for (const c of candidates) {
    for (const k of PRICING_KEYS) {
      if (c.startsWith(`${k}-`) || c.startsWith(`${k}:`)) return MODEL_PRICING[k];
    }
  }
  return null;
}

/**
 * 估算一次调用的人民币成本（契约 3.9）。未知模型返回 0。
 * @param {string} provider 供应商 id（保留参数，便于将来按供应商区分同名模型）
 * @param {string} model 模型名
 * @param {{prompt?: number, completion?: number, prompt_tokens?: number, completion_tokens?: number}} usage
 * @returns {number} 元，保留 6 位小数
 */
export function estimateCost(provider, model, usage) {
  const price = findPricing(model);
  if (!price) return 0;
  const u = usage || {};
  const p = num(u.prompt !== undefined ? u.prompt : u.prompt_tokens, 0);
  const c = num(u.completion !== undefined ? u.completion : u.completion_tokens, 0);
  const cost = (p / 1e6) * num(price.in, 0) + (c / 1e6) * num(price.out, 0);
  return Math.round(cost * 1e6) / 1e6;
}

/* ===========================================================================
 * 用量统计（IndexedDB：库 aichat / 表 usage）
 *
 * 说明：直接复用 core/store.js 导出的 openDB()。
 *      它打开的正是 aichat 数据库，并在升级时创建 usage 表
 *      （keyPath: 'id' + autoIncrement，与本次统计所需完全一致），
 *      因此这里不再自己 indexedDB.open，避免同库多版本 schema 竞争。
 *      在无 IndexedDB 的环境（如 Node 自测、隐私模式）自动降级为内存记录，
 *      统计失败绝不影响对话本身。
 * ======================================================================== */

const STORE_USAGE = 'usage';

/** @type {Promise<IDBDatabase|null>|null} */
let usageDBPromise = null;
/** 无 IndexedDB 环境下的内存降级存储 */
let memoryRecords = null;

/**
 * 取得统计用的数据库连接；不可用时返回 null。
 * @returns {Promise<IDBDatabase|null>}
 */
function openUsageDB() {
  if (usageDBPromise) return usageDBPromise;
  usageDBPromise = Promise.resolve()
    .then(() => openDB())
    .then((db) => {
      if (!db) usageDBPromise = null; // 允许后续重试
      return db || null;
    })
    .catch(() => {
      usageDBPromise = null; // 打不开就降级到内存，并允许下次重试
      return null;
    });
  return usageDBPromise;
}

/**
 * 降级存储：内存数组。
 * @param {object} rec
 */
function memoryPush(rec) {
  if (!memoryRecords) memoryRecords = [];
  memoryRecords.push(rec);
}

/**
 * 读取全部统计记录。
 * @returns {Promise<Array<object>>}
 */
async function readAllUsage() {
  const db = await openUsageDB();
  if (!db) return memoryRecords ? memoryRecords.slice() : [];
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_USAGE, 'readonly');
      const req = tx.objectStore(STORE_USAGE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    // 句柄可能已被别的标签页的版本升级关掉（onversionchange）→ 丢弃它，下次重开
    if (isStaleHandleError(err)) usageDBPromise = null;
    return memoryRecords ? memoryRecords.slice() : [];
  }
}

/** 判断是否"数据库句柄已失效"类错误（需要丢弃缓存连接） */
function isStaleHandleError(err) {
  const name = (err && err.name) || '';
  const msg = (err && err.message) || '';
  return name === 'InvalidStateError' || name === 'NotFoundError' || /closing|closed|version/i.test(msg);
}

/**
 * 记录一次调用的用量（契约 3.9）。
 * @param {{ at?: number, charId?: string, provider?: string, model?: string,
 *           prompt?: number, completion?: number, total?: number, cost?: number }} record
 * @returns {Promise<void>}
 */
export async function addUsage(record) {
  const r = record || {};
  // 注意：本函数只负责"记账"，任何失败都降级为内存记录，绝不影响对话
  const prompt = Math.max(0, Math.round(num(r.prompt, 0)));
  const completion = Math.max(0, Math.round(num(r.completion, 0)));
  const rec = {
    at: num(r.at, Date.now()) || Date.now(),
    charId: typeof r.charId === 'string' && r.charId ? r.charId : 'unknown',
    provider: typeof r.provider === 'string' ? r.provider : '',
    model: typeof r.model === 'string' ? r.model : '',
    prompt,
    completion,
    total: Math.max(0, Math.round(num(r.total, prompt + completion))),
    cost: num(r.cost, estimateCost(r.provider, r.model, { prompt, completion }))
  };

  const db = await openUsageDB();
  if (!db) {
    memoryPush(rec);
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_USAGE, 'readwrite');
      tx.objectStore(STORE_USAGE).add(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    // 句柄失效（别的标签页升级过库）→ 丢弃缓存连接，下次自动重开
    if (isStaleHandleError(err)) usageDBPromise = null;
    // 统计失败绝不能影响对话
    memoryPush(rec);
  }
}

/**
 * 聚合用量（契约 3.9）。
 * @returns {Promise<{ total: { prompt: number, completion: number, total: number, cost: number },
 *                      daily: Record<string, { tokens: number, cost: number, calls: number }>,
 *                      byChar: Record<string, { tokens: number, cost: number, calls: number }> }>}
 */
export async function getUsage() {
  const records = await readAllUsage();
  const total = { prompt: 0, completion: 0, total: 0, cost: 0 };
  const daily = {};
  const byChar = {};

  const bump = (bucket, key, tokens, cost) => {
    if (!bucket[key]) bucket[key] = { tokens: 0, cost: 0, calls: 0 };
    bucket[key].tokens += tokens;
    bucket[key].cost += cost;
    bucket[key].calls += 1;
  };

  for (const r of records) {
    if (!r) continue;
    const prompt = num(r.prompt, 0);
    const completion = num(r.completion, 0);
    const tokens = num(r.total, prompt + completion);
    const cost = num(r.cost, 0);

    total.prompt += prompt;
    total.completion += completion;
    total.total += tokens;
    total.cost += cost;

    bump(daily, dayKey(num(r.at, Date.now())), tokens, cost);
    bump(byChar, r.charId || 'unknown', tokens, cost);
  }

  total.cost = Math.round(total.cost * 1e6) / 1e6;
  for (const k of Object.keys(daily)) daily[k].cost = Math.round(daily[k].cost * 1e6) / 1e6;
  for (const k of Object.keys(byChar)) byChar[k].cost = Math.round(byChar[k].cost * 1e6) / 1e6;

  return { total, daily, byChar };
}

/**
 * 清空用量统计（契约 3.9）。
 * @returns {Promise<void>}
 */
export async function clearUsage() {
  memoryRecords = [];
  const db = await openUsageDB();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_USAGE, 'readwrite');
      tx.objectStore(STORE_USAGE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* 忽略：清空失败不影响使用 */
  }
}
