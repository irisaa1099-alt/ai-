#!/usr/bin/env node
/** 清空代际回归：临时源码/数据库、独立 Chrome、真实文件接口；不访问模型或用户数据库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { launch, freePort, sleep } from './cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'quliao-db-reset-'));
const app = path.join(sandbox, 'app'), data = path.join(sandbox, 'db');
assert.ok(!sandbox.startsWith(root + path.sep));
fs.mkdirSync(app);
fs.copyFileSync(path.join(root, 'server.mjs'), path.join(app, 'server.mjs'));
fs.cpSync(path.join(root, 'core'), path.join(app, 'core'), { recursive: true });
fs.writeFileSync(path.join(app, 'reset-probe.html'), '<!doctype html><meta charset="utf-8"><title>隔离同步回归</title>');
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET|^AICHAT_|^HOST$|^PORT$/.test(key)));
let server, serverLog = '', a, b, fresh, sibling, passed = 0;
const results = [];

async function waitFor(fn, label = '条件') {
  for (let i = 0; i < 120; i++) {
    try { const value = await fn(); if (value) return value; } catch {}
    await sleep(50);
  }
  throw new Error(`等待${label}超时\n${serverLog.slice(-600)}`);
}
async function startServer() {
  server = spawn(process.execPath, ['server.mjs', '--no-open', '--host', '127.0.0.1', '--port', String(port), '--data-dir', data],
    { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => serverLog += chunk);
  server.stderr.on('data', chunk => serverLog += chunk);
  await waitFor(async () => (await fetch(origin + '/api/health')).ok, '服务器');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited;
}
async function request(route, body, generation, method = body === undefined ? 'GET' : 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  if (generation !== undefined) headers['X-Aichat-Db-Generation'] = generation;
  const response = await fetch(origin + '/api/db' + route, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, ...await response.json() };
}
const disk = () => request('/state');
const evaluate = (page, code) => page.eval(`(async()=>{const s=await import('./core/store.js');const f=await import('./core/filestore.js');const o=await import('./core/outbox.js');${code}})()`);
async function openPage(page, sync = true) {
  await page.goto('about:blank');
  await waitFor(() => page.eval('location.href === \"about:blank\"'), '空白页面');
  await page.goto(origin + '/reset-probe.html');
  await waitFor(() => page.eval('document.title === "隔离同步回归"'), '测试页面');
  if (sync) assert.equal((await evaluate(page, 'return f.syncOnBoot();')).ok, true);
}
async function writeCharacter(page, id) {
  return evaluate(page, `await s.saveCharacter({id:${JSON.stringify(id)},name:${JSON.stringify(id)},greeting:[]});
    await s.appendMessage({id:${JSON.stringify('m_' + id)},charId:${JSON.stringify(id)},role:'user',content:'合成测试消息'});
    return f.syncNow();`);
}
async function offline(page) {
  await evaluate(page, `window.resetNativeFetch=window.fetch;window.fetch=(url,options)=>
    String(url).startsWith('/api/db') && (options?.method||'GET')!=='GET'
      ? Promise.reject(new TypeError('合成离线')) : resetNativeFetch(url,options);`);
}
async function online(page) { await page.eval('window.fetch=window.resetNativeFetch'); }
async function check(name, fn) {
  const detail = await fn(); passed++; results.push({ name, ...(detail ? { detail } : {}) }); console.log('✓ ' + name);
}
function assertRejected(response) {
  assert.equal(response.status, 409);
  assert.equal(response.error?.code, 'db-generation-changed');
}

try {
  await startServer();
  a = await launch({ port: await freePort() });
  b = await launch({ port: await freePort() });
  await openPage(a, false);
  let firstGeneration, secondGeneration;

  await check('没有清空标记的初次空库仍支持旧浏览器数据迁移', async () => {
    assert.equal((await disk()).generation, '0');
    await evaluate(a, `await s.putCharacterLocal({id:'c_legacy',name:'原本仅在浏览器的角色',greeting:[]});
      await s.putMessagesLocal([{id:'m_legacy',charId:'c_legacy',role:'user',content:'原浏览器记录'}]);`);
    const result = await evaluate(a, 'return f.syncOnBoot();');
    assert.equal(result.ok, true); assert.equal(result.action, 'push');
    assert.deepEqual((await disk()).characters.map(row => row.id), ['c_legacy']);
    assert.equal((await request('/messages/c_legacy')).messages.length, 1);
    await openPage(b);
  });

  await check('离线角色、消息和设置队列在另一浏览器清空后不会先重放', async () => {
    await offline(a);
    const queued = await evaluate(a, `await s.saveCharacter({id:'c_offline',name:'旧代离线角色',greeting:[]});
      await s.appendMessage({id:'m_offline',charId:'c_offline',role:'user',content:'不应复活的离线消息'});
      s.setSettings({theme:'dark'});s.writeRuntimeAll({c_offline:{affinity:99,updatedAt:9999999999999}});
      await f.syncNow();return o.firstQueuedOperation();`);
    assert.equal(queued.generation, '0');
    const wipe = await evaluate(b, 'return s.wipeAll();'); assert.equal(wipe.ok, true);
    firstGeneration = (await disk()).generation; assert.notEqual(firstGeneration, '0');
    assert.equal((await disk()).characters.length, 0);
    await online(a);
    await openPage(a, false); // Reload modules and replay only the durable outbox, not in-memory promises.
    const restored = await evaluate(a, `const writes=[];const native=window.fetch;
      window.fetch=(url,options)=>{if(String(url).startsWith('/api/db')&&(options?.method||'GET')!=='GET')writes.push(String(url));return native(url,options)};
      try {const result=await f.syncOnBoot();return {result,writes,characters:await s.listCharacters(),
        messages:await s.listMessages('c_offline'),queued:await o.firstQueuedOperation(),runtime:s.readRuntimeAll()};}
      finally {window.fetch=native;}`);
    assert.equal(restored.result.ok, true); assert.equal(restored.result.action, 'pull');
    assert.deepEqual(restored.characters, []); assert.deepEqual(restored.messages, []);
    assert.deepEqual(restored.runtime, {}); assert.equal(restored.queued, null);
    assert.deepEqual(restored.writes, []); assert.equal((await disk()).characters.length, 0);
    return { oldQueueGeneration: queued.generation, newGeneration: firstGeneration };
  });

  await check('清空发起端无需刷新即可创建并保存新角色', async () => {
    assert.equal((await writeCharacter(b, 'c_after_first_wipe')).ok, true);
    assert.deepEqual((await disk()).characters.map(row => row.id), ['c_after_first_wipe']);
    assert.equal((await request('/messages/c_after_first_wipe')).messages.length, 1);
    await evaluate(a, 'return f.syncOnBoot();');
  });

  await check('再次清空后旧浏览器只拉取新库，不覆盖清空后新建的数据', async () => {
    await offline(a);
    await evaluate(a, `await s.saveCharacter({id:'c_old_again',name:'另一份旧代草稿',greeting:[]});await f.syncNow();`);
    assert.equal((await evaluate(b, 'return s.wipeAll();')).ok, true);
    secondGeneration = (await disk()).generation; assert.notEqual(secondGeneration, firstGeneration);
    assert.equal((await writeCharacter(b, 'c_new_database')).ok, true);
    await online(a);
    const result = await evaluate(a, `const result=await f.syncOnBoot();return {result,ids:(await s.listCharacters()).map(c=>c.id),queued:await o.firstQueuedOperation()};`);
    assert.equal(result.result.ok, true); assert.deepEqual(result.ids, ['c_new_database']); assert.equal(result.queued, null);
    assert.deepEqual((await disk()).characters.map(row => row.id), ['c_new_database']);
  });

  await check('所有数据变更入口拒绝旧代际与未带代际的旧请求', async () => {
    const staleRoutes = [
      ['/characters/c_stale', { data: { id: 'c_stale', name: '旧请求' } }],
      ['/groups/g_stale', { data: { id: 'g_stale', name: '旧群', members: [] } }],
      ['/messages/c_new_database', { messages: [{ id: 'm_stale', charId: 'c_new_database', content: '旧写入' }] }],
      ['/messages/c_new_database/replace', { messages: [] }, 'PUT'],
      ['/groupmsgs/g_stale', { messages: [{ id: 'gm_stale', groupId: 'g_stale', content: '旧群消息' }] }],
      ['/groupmsgs/g_stale/replace', { messages: [] }],
      ['/memory/c_new_database', { data: { charId: 'c_new_database', facts: ['旧记忆'] } }, 'PUT'],
      ['/settings', { data: { settings: { theme: 'dark' }, runtime: {} } }],
      ['/characters/c_new_database', undefined, 'DELETE'],
      ['/groups/g_stale', undefined, 'DELETE'],
      ['/messages/c_new_database', undefined, 'DELETE'],
      ['/memory/c_new_database', undefined, 'DELETE'],
      ['/replace', { characters: [{ id: 'c_stale', name: '旧全库' }], messages: [], force: true }],
      ['/wipe', { force: true }],
    ];
    for (const generation of [firstGeneration, undefined]) for (const [route, body, method] of staleRoutes) {
      const response = await request(route, body, generation, method || 'POST');
      assertRejected(response);
    }
    assert.deepEqual((await disk()).characters.map(row => row.id), ['c_new_database']);
    assert.equal((await request('/messages/c_new_database')).messages.length, 1);
    return { rejectedRequests: staleRoutes.length * 2 };
  });

  await check('服务重启后清空代际仍持久有效', async () => {
    await stopServer(); await startServer();
    assert.equal((await disk()).generation, secondGeneration);
    assertRejected(await request('/characters/c_after_restart_stale', { data: { id: 'c_after_restart_stale' } }, firstGeneration));
    const valid = await request('/characters/c_restart', { data: { id: 'c_restart', name: '重启后正常写入' } }, secondGeneration);
    assert.equal(valid.status, 200);
  });

  await check('全新浏览器能够接入清空后的库并继续写入', async () => {
    fresh = await launch({ port: await freePort() }); await openPage(fresh);
    assert.equal((await writeCharacter(fresh, 'c_fresh_browser')).ok, true);
    assert.ok((await disk()).characters.some(row => row.id === 'c_fresh_browser'));
    assert.equal(await fresh.eval('localStorage.getItem("aichat.filestore.generation")'), secondGeneration);
  });

  await check('本地回填事务失败时不会提前采用新代际，重试后不混入旧墓碑与运行时', async () => {
    const wipe = await request('/wipe', { force: true }, secondGeneration); assert.equal(wipe.status, 200);
    const generation = wipe.generation;
    assert.equal((await request('/characters/c_reused', { data: { id: 'c_reused', name: '新库复用ID', greeting: [] } }, generation)).status, 200);
    await request('/settings', { data: { runtime: { c_reused: { affinity: 12, updatedAt: 2 } } } }, generation);
    const result = await evaluate(a, `s.writeRuntimeAll({c_reused:{affinity:99,updatedAt:9999999999999}});
      f.noteDeleted('c_reused');f.noteGroupDeleted('g_reused');
      const native=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(names,mode,...args){const tx=native.call(this,names,mode,...args);
        if(Array.isArray(names)&&names.includes('characters')&&names.includes('groupMessages')&&mode==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
      try {const result=await f.syncOnBoot();return {result,generation:localStorage.getItem('aichat.filestore.generation')};}
      finally {IDBDatabase.prototype.transaction=native;}`);
    assert.equal(result.result.ok, false); assert.equal(result.generation, secondGeneration);
    const staleWrite = await evaluate(a, `const headers=[];const native=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/characters/'))headers.push(new Headers(options?.headers).get('X-Aichat-Db-Generation'));return native(url,options)};
      try {await s.saveCharacter({id:'c_failed_restore',name:'仍应旧代',greeting:[]});await new Promise(r=>setTimeout(r,120));return headers;}finally{window.fetch=native;}`);
    assert.ok(staleWrite.length); assert.ok(staleWrite.every(value => value === secondGeneration));
    assert.ok(!(await disk()).characters.some(row => row.id === 'c_failed_restore'));
    const recovered = await evaluate(a, `const result=await f.syncOnBoot();return {result,ids:(await s.listCharacters()).map(c=>c.id),runtime:s.readRuntimeAll(),
      tombstones:localStorage.getItem('aichat.deleted.v1'),generation:localStorage.getItem('aichat.filestore.generation')};`);
    assert.equal(recovered.result.ok, true); assert.deepEqual(recovered.ids, ['c_reused']);
    assert.equal(recovered.runtime.c_reused.affinity, 12); assert.equal(recovered.generation, generation);
    assert.deepEqual(JSON.parse(recovered.tombstones), {});
  });

  await check('同源旧标签页不会拿共享localStorage的新代际重标旧内存写入', async () => {
    const { targetId } = await a.client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await a.client.send('Target.attachToTarget', { targetId, flatten: true });
    await a.client.send('Page.enable', {}, sessionId); await a.client.send('Runtime.enable', {}, sessionId);
    sibling = { targetId, async goto(url) { await a.client.send('Page.navigate', { url }, sessionId); }, async eval(expression) {
      const r = await a.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } };
    await openPage(sibling);
    const oldGeneration = (await disk()).generation;
    assert.equal((await evaluate(a, 'return s.wipeAll();')).ok, true);
    const newGeneration = (await disk()).generation; assert.notEqual(newGeneration, oldGeneration);
    assert.equal(await sibling.eval('localStorage.getItem("aichat.filestore.generation")'), newGeneration);
    const stale = await evaluate(sibling, `await s.saveCharacter({id:'c_old_tab',name:'旧标签页内存',greeting:[]});
      await new Promise(r=>setTimeout(r,120));return {sync:await f.syncNow(),queue:await o.firstQueuedOperation()};`);
    assert.equal(stale.sync.ok, false); assert.equal(stale.queue.generation, oldGeneration);
    assert.equal((await disk()).characters.length, 0);
    assert.equal((await evaluate(a, 'return f.syncNow();')).ok, true);
    assert.equal((await evaluate(a, 'return f.syncOnBoot();')).ok, true);
    assert.deepEqual(await evaluate(a, 'return s.listCharacters();'), []);
    await a.client.send('Target.closeTarget', { targetId }); sibling = null;
  });

  await check('清空前已发出但尚未读完请求体的写入不能越过清空边界', async () => {
    const generation = (await disk()).generation;
    const body = JSON.stringify({ data: { id: 'c_in_flight', name: '在途旧写入' } });
    const pending = new Promise((resolve, reject) => {
      const req = http.request(origin + '/api/db/characters/c_in_flight', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Aichat-Db-Generation': generation,
      } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(text) })); });
      req.on('error', reject); req.write(body.slice(0, -1));
      void request('/wipe', { force: true }, generation).then(result => { assert.equal(result.status, 200); req.end(body.slice(-1)); }).catch(reject);
    });
    assertRejected(await pending); assert.equal((await disk()).characters.length, 0);
    assert.equal((await evaluate(a, 'return f.syncOnBoot();')).ok, true);
  });

  await check('覆盖导入在清空完成后使用新代际，导入内容可持久化', async () => {
    const result = await evaluate(a, `const imported=await s.importAll({characters:[{id:'c_imported',name:'覆盖导入',greeting:[]}],
      messages:[{id:'m_imported',charId:'c_imported',role:'user',content:'覆盖导入消息'}],groups:[],groupMessages:[],memory:[]},{merge:false});
      return {imported,sync:await f.syncNow()};`);
    assert.equal(result.imported.chars, 1); assert.equal(result.sync.ok, true);
    assert.deepEqual((await disk()).characters.map(row => row.id), ['c_imported']);
    assert.equal((await request('/messages/c_imported')).messages[0].content, '覆盖导入消息');
  });

  await check('清空前同步队列事务失败，不会阻止清空后新代际恢复', async () => {
    const generation = (await disk()).generation;
    const unsafe = await evaluate(a, `const native=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(names,mode,...args){
        if(this.name==='aichat-file-outbox'&&mode==='readwrite')throw new Error('合成同步队列写失败');
        return native.call(this,names,mode,...args);};
      try {await s.saveCharacter({id:'c_unjournaled',name:'未入队旧资料',greeting:[]});
        for(let i=0;i<30&&!localStorage.getItem('aichat.sync.unjournaled');i++)await new Promise(r=>setTimeout(r,10));
        return localStorage.getItem('aichat.sync.unjournaled');}
      finally {IDBDatabase.prototype.transaction=native;}`);
    assert.ok(unsafe, '必须真实触发同步队列写失败');
    assert.equal((await request('/wipe', { force: true }, generation)).status, 200);
    const recovered = await evaluate(a, `const result=await f.syncOnBoot();return {result,ids:(await s.listCharacters()).map(c=>c.id),unsafe:localStorage.getItem('aichat.sync.unjournaled')};`);
    assert.equal(recovered.result.ok, true); assert.deepEqual(recovered.ids, []); assert.equal(recovered.unsafe, null);
    assert.equal((await disk()).characters.length, 0);
  });

  await check('尚未识别的未来代际队列保留，不被当前客户端清理误删', async () => {
    const result = await evaluate(a, `await o.enqueue({path:'/characters/c_future',method:'POST',generation:'future-audit-generation',
      body:{data:{id:'c_future',name:'另一更新代际的队列'}}});
      return {sync:await f.syncNow(),queued:await o.firstQueuedOperation()};`);
    assert.equal(result.sync.ok, false); assert.equal(result.queued.generation, 'future-audit-generation');
    assert.ok(!(await disk()).characters.some(row => row.id === 'c_future'));
    await evaluate(a, 'await o.clearOutbox();'); // Remove only this test's intentionally unsupported operation.
  });

  await check('过时的清理快照不会删除下一次清空后产生的新代际队列', async () => {
    const before = await disk();
    const wiped = await request('/wipe', { force: true }, before.generation); assert.equal(wiped.status, 200);
    const result = await evaluate(a, `await o.enqueue({path:'/characters/c_new_generation_queue',method:'POST',generation:${JSON.stringify(wiped.generation)},
      body:{data:{id:'c_new_generation_queue',name:'下一代合法队列'}}});
      await o.discardStaleOperations(${JSON.stringify(before.retiredGenerations)});
      const preserved=await o.firstQueuedOperation();const sync=await f.syncOnBoot();
      return {preserved,sync,ids:(await s.listCharacters()).map(c=>c.id),queued:await o.firstQueuedOperation()};`);
    assert.equal(result.preserved.generation, wiped.generation); assert.equal(result.sync.ok, true);
    assert.deepEqual(result.ids, ['c_new_generation_queue']); assert.equal(result.queued, null);
    assert.deepEqual((await disk()).characters.map(row => row.id), ['c_new_generation_queue']);
  });

  console.log(JSON.stringify({ passed, failed: 0, cases: results }, null, 2));
} catch (error) {
  console.error(error.stack || error); process.exitCode = 1;
} finally {
  if (sibling) await a?.client.send('Target.closeTarget', { targetId: sibling.targetId }).catch(() => {});
  for (const page of [a, b, fresh]) await page?.close();
  await stopServer(); fs.rmSync(sandbox, { recursive: true, force: true });
}
