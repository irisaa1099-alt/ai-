#!/usr/bin/env node
/** 隔离执行 Service Worker：验证升级时取新代码、离线回退、API 不缓存。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const handlers = new Map();
let mode = 'online', fetches = 0, cached = 'old-code';
const response = text => ({ ok: true, status: 200, type: 'basic', text: async () => text, clone() { return response(text); } });
const context = vm.createContext({ URL, Response,
  self: { location: { origin: 'http://127.0.0.1:5180' }, addEventListener: (name, fn) => handlers.set(name, fn) },
  caches: { open: async () => ({ match: async () => response(cached), put: async (_request, value) => { cached = await value.text(); } }) },
  fetch: async () => { fetches++; if (mode === 'offline') throw new Error('offline'); return response('current-local-code'); },
});
vm.runInContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), context);
const request = { method: 'GET', url: 'http://127.0.0.1:5180/core/llm.js', mode: 'cors' };
async function dispatch(req) {
  let result;
  handlers.get('fetch')({ request: req, respondWith: promise => { result = promise; } });
  return result;
}
assert.equal(await (await dispatch(request)).text(), 'current-local-code');
console.log('✓ 已缓存旧商业接入代码时仍优先取当前版本');
mode = 'offline';
assert.equal(await (await dispatch(request)).text(), 'current-local-code');
console.log('✓ 离线时回退到已更新的缓存');
const before = fetches;
for (const req of [{ ...request, url: 'http://127.0.0.1:5180/api/models' },
  { ...request, method: 'POST', url: 'http://127.0.0.1:5180/api/llm' },
  { ...request, url: 'https://example.invalid/code.js' }]) assert.equal(await dispatch(req), undefined);
assert.equal(fetches, before);
console.log('✓ 模型 API、POST、跨域请求不进入离线缓存');
