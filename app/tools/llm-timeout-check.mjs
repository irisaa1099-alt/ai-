#!/usr/bin/env node
/**
 * 流式请求超时回归检查：假 SSE 响应，不使用真实密钥、网络或用户数据。
 * 用法：node tools/llm-timeout-check.mjs
 */
import assert from 'node:assert/strict';
import { chatStream } from '../core/llm.js';

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const liveTimers = new Set();
const base = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  apiKey: 'test-only',
  messages: [{ role: 'user', content: '测试' }],
  params: {},
  useProxy: false,
  stream: true,
};

/** 按间隔发 SSE 片段；数组结束时关闭连接，函数则持续发到被中止。 */
function fakeResponse(signal, everyMs, chunks) {
  let index = 0;
  let timer = null;
  let finished = false;
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      liveTimers.delete(timer);
      timer = null;
    }
  };
  const stream = new ReadableStream({
    start(controller) {
      const abort = () => {
        if (finished) return;
        finished = true;
        stop();
        controller.error(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      timer = setInterval(() => {
        if (finished) return;
        const chunk = typeof chunks === 'function' ? chunks(index++) : chunks[index++];
        if (chunk) controller.enqueue(encoder.encode(chunk));
        if (Array.isArray(chunks) && index >= chunks.length) {
          finished = true;
          stop();
          signal.removeEventListener('abort', abort);
          controller.close();
        }
      }, everyMs);
      liveTimers.add(timer);
    },
    cancel() {
      finished = true;
      stop();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const thinking = (content) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: content } }] })}\n\n`;

async function check(name, fetcher, opts, verify) {
  globalThis.fetch = (_url, init) => Promise.resolve(fetcher(init.signal));
  try {
    const result = await chatStream({ ...base, ...opts });
    verify(null, result);
  } catch (err) {
    verify(err, null);
  }
  console.log(`✓ ${name}`);
}

try {
  await check(
    '只有心跳时按无生成内容超时',
    (signal) => fakeResponse(signal, 25, () => ': ping\n\n'),
    { timeoutMs: 120, totalTimeoutMs: 700 },
    (err) => {
      assert.equal(err?.code, 'timeout');
      assert.match(err.message, /没有收到生成内容/);
    }
  );

  await check(
    '慢速但持续生成的回复完整结束',
    (signal) => fakeResponse(signal, 70, [delta('一'), delta('二'), delta('三'), 'data: [DONE]\n\n']),
    { timeoutMs: 120, totalTimeoutMs: 700 },
    (err, result) => {
      assert.equal(err, null);
      assert.equal(result.text, '一二三');
    }
  );

  await check(
    '推理内容算生成进展',
    (signal) => fakeResponse(signal, 70, [thinking('思'), thinking('考'), thinking('中'), delta('好了'), 'data: [DONE]\n\n']),
    { timeoutMs: 120, totalTimeoutMs: 700 },
    (err, result) => {
      assert.equal(err, null);
      assert.equal(result.text, '好了');
    }
  );

  await check(
    '收到结束标记后不等待仍开放的连接',
    (signal) => fakeResponse(signal, 30, (index) => index === 0 ? delta('好') : index === 1 ? 'data: [DONE]\n\n' : ': ping\n\n'),
    { timeoutMs: 120, totalTimeoutMs: 700 },
    (err, result) => {
      assert.equal(err, null);
      assert.equal(result.text, '好');
    }
  );

  await check(
    '持续生成也受总时限限制',
    (signal) => fakeResponse(signal, 30, () => delta('字')),
    { timeoutMs: 120, totalTimeoutMs: 230 },
    (err) => {
      assert.equal(err?.code, 'timeout');
      assert.match(err.message, /总时限/);
    }
  );

  const caller = new AbortController();
  const abortTimer = setTimeout(() => caller.abort(), 90);
  try {
    await check(
      '用户停止仍返回主动中止',
      (signal) => fakeResponse(signal, 25, () => ': ping\n\n'),
      { timeoutMs: 300, totalTimeoutMs: 700, signal: caller.signal },
      (err, result) => {
        assert.equal(err, null);
        assert.equal(result.aborted, true);
      }
    );
  } finally {
    clearTimeout(abortTimer);
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const timer of liveTimers) clearInterval(timer);
}
