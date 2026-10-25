#!/usr/bin/env node
/** 2026-10-20 修复回归：全部数据和浏览器档案均使用临时目录。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { launch, freePort, sleep } from './cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-optimization-'));
assert.ok(!dir.startsWith(path.join(root, 'data')));
const port = await freePort(), modelPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
let page, server, passed = 0, failed = 0;
const calls = [];
const mock = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); calls.push(body);
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '收到，继续聊。' } }] }) + '\n\ndata: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"摘要","facts":[]}' } }] }));
  }
});
async function wait(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await sleep(80); }
  throw new Error('等待条件超时');
}
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const evaluate = (code) => page.eval(`(async()=>{const s=await import('./core/store.js');${code}})()`);
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.error(`✗ ${name}: ${err.stack}`); }
}
try {
  await new Promise((resolve) => mock.listen(modelPort, '127.0.0.1', resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/API_KEY|AICHAT|^PORT$|^HOST$/.test(key)) delete env[key];
  server = spawn(process.execPath, ['server.mjs', '--host', '127.0.0.1', '--port', String(port), '--no-open', '--data-dir', dir],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (c) => log += c); server.stderr.on('data', (c) => log += c);
  await wait(async () => { try { return (await fetch(origin + '/api/health')).ok; } catch { if (server.exitCode != null) throw Error(log); return false; } });
  await request('/api/db/settings', { data: { settings: { onboarded: true, voice: { enabled: false }, proactive: { enabled: false } } } });
  for (const id of ['c_base', 'c_restore1', 'c_restore2']) await request('/api/db/characters/' + id,
    { data: { id, name: id, tagline: '原简介', version: 1, greeting: [] } });

  for (const kind of ['characters', 'groups']) {
    const id = kind === 'characters' ? 'c_merge' : 'g_merge';
    await check(`${kind} 多端修改不同字段合并，重复重放不加版本`, async () => {
      const base = { id, name: '原名称', tagline: '原简介', version: 1, members: ['c_base'] };
      await request(`/api/db/${kind}/${id}`, { data: base, base: null });
      assert.equal((await request(`/api/db/${kind}/${id}`, { base, data: { ...base, name: 'A的新名称', version: 2 } })).status, 200);
      const second = { base, data: { ...base, tagline: 'B的新简介', version: 2 } };
      assert.equal((await request(`/api/db/${kind}/${id}`, second)).status, 200);
      const before = (await request(`/api/db/${kind}/${id}`)).data;
      assert.equal(before.name, 'A的新名称'); assert.equal(before.tagline, 'B的新简介');
      assert.equal((await request(`/api/db/${kind}/${id}`, second)).status, 200);
      const after = (await request(`/api/db/${kind}/${id}`)).data;
      assert.equal(after.version, before.version);
    });
    await check(`${kind} 同字段冲突与旧版整卡覆盖返回409`, async () => {
      const base = { id, name: '原名称', tagline: '原简介', version: 1, members: ['c_base'] };
      assert.equal((await request(`/api/db/${kind}/${id}`, { base, data: { ...base, name: '旧端想覆盖' } })).status, 409);
      assert.equal((await request(`/api/db/${kind}/${id}`, { data: { ...base, name: '旧版整卡' } })).status, 409);
      assert.equal((await request(`/api/db/${kind}/${id}`)).data.name, 'A的新名称');
    });
  }
  await check('大于2MB的有效记录不再每追加一条都整文件重写，增长后仍压实去重', async () => {
    const file = path.join(dir, 'messages', 'c_big.ndjson');
    const rows = Array.from({ length: 800 }, (_, i) => ({ id: 'm_big_' + i, charId: 'c_big', role: 'user', content: 'x'.repeat(3000), at: i }));
    fs.writeFileSync(file, rows.map((m) => JSON.stringify(m)).join('\n') + '\n');
    await request('/api/db/messages/c_big', { messages: [{ id: 'm_added_0', charId: 'c_big', content: '新增', at: 1000 }] });
    const inode = fs.statSync(file).ino;
    for (let i = 1; i <= 3; i++) {
      await request('/api/db/messages/c_big', { messages: [{ id: 'm_added_' + i, charId: 'c_big', content: '新增', at: 1000 + i }] });
      assert.equal(fs.statSync(file).ino, inode);
    }
    await request('/api/db/messages/c_big', { messages: rows.map((m) => ({ ...m, content: 'y'.repeat(3000) })) });
    assert.notEqual(fs.statSync(file).ino, inode);
    const result = await request('/api/db/messages/c_big');
    assert.equal(result.messages.length, 804); assert.equal(result.messages[0].content, 'y'.repeat(3000));
  });

  page = await launch({ port: await freePort() }); await page.goto(origin);
  await wait(() => page.eval('!!window.__AICHAT__')); await sleep(500);
  await check('私聊、群聊并发修改保留两个字段，群消息听众不可扩大', async () => {
    const result = await evaluate(`
      await s.putMessagesLocal([{id:'m_race',charId:'c_base',role:'assistant',content:'原正文',at:1}]);
      await s.putGroupLocal({id:'g_race',name:'并发群',members:['c_base']});
      await s.putGroupMessagesLocal([{id:'gm_race',groupId:'g_race',role:'assistant',speakerId:'c_base',content:'原正文',at:1,audienceIds:['c_base']}]);
      await Promise.all([s.updateMessage('m_race',{content:'新正文'}),s.updateMessage('m_race',{bookmarked:true}),
        s.updateGroupMessage('gm_race',{content:'新正文'}),s.updateGroupMessage('gm_race',{bookmarked:true,audienceIds:['foreign']})]);
      return {a:await s.getMessage('m_race'),b:await s.getGroupMessage('gm_race')};`);
    for (const row of [result.a, result.b]) { assert.equal(row.content, '新正文'); assert.equal(row.bookmarked, true); }
    assert.deepEqual(result.b.audienceIds, ['c_base']);
  });
  await sleep(800);
  await check('启动回填中途写入失败，五张表一起回滚，磁盘不受影响', async () => {
    const result = await evaluate(`
      await s.putCharacterLocal({id:'c_local_marker',name:'恢复前标记'});
      const stores=['characters','messages','memory','groups','groupMessages'];
      const snapshot=()=>Promise.all(stores.map(name=>s.idb(name,'readonly',o=>o.getAll())));
      const before=await snapshot(); const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(row,...args){if(this.name==='characters'&&row.id==='c_restore2')throw Error('模拟写入失败');return put.call(this,row,...args)};
      let outcome;try{outcome=await(await import('./core/filestore.js')).syncOnBoot()}finally{IDBObjectStore.prototype.put=put}
      return {before,after:await snapshot(),outcome};`);
    assert.equal(result.outcome.action, 'error'); assert.deepEqual(result.after, result.before);
    assert.ok((await request('/api/db/characters/c_restore2')).data);
  });
  await check('正常启动回填成功，完成后清理旧的本地标记', async () => {
    const result = await evaluate(`const f=await import('./core/filestore.js');const result=await f.syncOnBoot();return{result,marker:await s.getCharacter('c_local_marker')};`);
    assert.equal(result.result.ok, true); assert.equal(result.marker, null);
  });
  await evaluate(`
    s.setSettings({onboarded:true,provider:'ollama',model:'mock',baseUrls:{ollama:'http://127.0.0.1:${modelPort}/v1'},
      typedEffect:false,voice:{enabled:false},proactive:{enabled:false},context:{summary:false,maxMessages:300,budgetTokens:50000}});
    const now=Date.now()-1000000;
    await s.putMessagesLocal(Array.from({length:235},(_,i)=>({id:'mp_'+String(i).padStart(3,'0'),charId:'c_base',at:now+i,
      role:i%2?'assistant':'user',content:i===0?'PRIVATE_OLDEST_MARKER':'私聊历史'+i})));
    await s.putGroupLocal({id:'g_pages',name:'分页测试群',members:['c_base'],everyoneSpeaks:false,maxAutoTurns:1});
    await s.putGroupMessagesLocal(Array.from({length:235},(_,i)=>({id:'gp_'+String(i).padStart(3,'0'),groupId:'g_pages',at:now+i,
      role:i%2?'assistant':'user',speakerId:i%2?'c_base':'user',speakerName:i%2?'c_base':'我',content:'群聊历史'+i,audienceIds:['c_base']})));
    const f=await import('./core/filestore.js');
    await f.mirrorMessages('c_base',await s.listMessages('c_base'));
    await f.mirrorGroup(await s.getGroup('g_pages'));
    await f.mirrorGroupMessages('g_pages',await s.listGroupMessages('g_pages'));
    const synced=await f.syncNow();if(!synced.ok)throw Error('测试记录未能持久化');`);
  await check('侧栏摘要无全表正文读取，末条、数量和兼容接口一致', async () => {
    const result = await evaluate(`const original=IDBObjectStore.prototype.getAll;let scans=0;
      IDBObjectStore.prototype.getAll=function(...args){if(['messages','groupMessages'].includes(this.name))scans++;return original.apply(this,args)};
      try{const stats=await s.listConversationStats();const recent=await s.listGroupRecent();return{scans,stats,recent}}finally{IDBObjectStore.prototype.getAll=original}`);
    assert.equal(result.scans, 0); assert.equal(result.stats.counts.c_base, 236);
    assert.equal(result.stats.groupCounts.g_pages, 235);
    assert.equal(result.stats.recent.find((m) => m.charId === 'c_base').id, 'mp_234');
    assert.equal(result.recent.find((m) => m.groupId === 'g_pages').id, 'gp_234');
  });
  await check('私聊和群聊索引分页有序、无漏页，旧消息可直接定位', async () => {
    const result = await evaluate(`const a=await s.listMessagesPage('c_base');const b=await s.listGroupMessagesPage('g_pages');
      const more=await s.listGroupMessagesPage('g_pages',{limit:200});const old=await s.listMessagesPage('c_base',{includeId:'mp_000'});
      return{a,b,more,old};`);
    for (const page of [result.a, result.b]) { assert.equal(page.messages.length, 100); assert.equal(page.hasMore, true); }
    assert.equal(result.a.messages[0].id, 'mp_135'); assert.equal(result.more.messages.length, 200);
    assert.ok(result.old.messages.some((m) => m.id === 'mp_000'));
  });
  await page.goto(origin + '/#/chat/c_base');
  await wait(() => page.eval(`!!document.querySelector('[data-mid="mp_234"]')`));
  await check('私聊首屏100条，加载旧页和收藏时保留原气泡节点', async () => {
    assert.equal(await page.eval(`document.querySelectorAll('.chat-body [data-mid]').length`), 100);
    await page.eval(`window.__kept=document.querySelector('[data-mid="mp_220"]');document.querySelector('.history-more').click()`);
    await wait(() => page.eval(`!!document.querySelector('[data-mid="mp_035"]')`));
    assert.equal(await page.eval(`window.__kept===document.querySelector('[data-mid="mp_220"]')`), true);
    await evaluate(`await s.updateMessage('mp_230',{bookmarked:true});`);
    await wait(() => page.eval(`!!document.querySelector('[data-mid="mp_230"].bookmarked')`));
    assert.equal(await page.eval(`window.__kept===document.querySelector('[data-mid="mp_220"]')`), true);
  });
  await check('私聊搜索/收藏跳转可加载尚未显示的旧消息', async () => {
    await page.eval(`(async()=>{await(await import('./ui/chat.js')).focusMessage('mp_000')})()`);
    assert.equal(await page.eval(`!!document.querySelector('[data-mid="mp_000"].flash-highlight')`), true);
  });
  await page.goto('about:blank'); await page.goto(origin + '/#/chat/c_base');
  await wait(() => page.eval(`!!document.querySelector('[data-mid="mp_234"]')`));
  await check('界面仅加载100条时，真实发送请求仍包含完整允许上下文', async () => {
    const before = calls.length;
    await page.eval(`(()=>{const i=document.querySelector('#composerInput');i.value='请接着聊';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sendBtn').click()})()`);
    await wait(() => calls.length > before);
    await wait(() => page.eval(`!document.querySelector('#sendBtn.stop')`));
    assert.ok(JSON.stringify(calls[before].messages).includes('PRIVATE_OLDEST_MARKER'));
  });
  await page.goto(origin + '/#/group/g_pages');
  await wait(() => page.eval(`!!document.querySelector('.gchat-body [data-mid="gp_234"]')`));
  await check('群聊首屏100条、旧页加载及普通消息更新均保留其他气泡', async () => {
    assert.equal(await page.eval(`document.querySelectorAll('.gchat-body [data-mid]').length`), 100);
    await page.eval(`window.__kept=document.querySelector('[data-mid="gp_220"]');document.querySelector('.history-more').click()`);
    await wait(() => page.eval(`!!document.querySelector('[data-mid="gp_035"]')`));
    await evaluate(`await s.updateGroupMessage('gp_230',{bookmarked:true});`);
    await wait(() => page.eval(`!!document.querySelector('[data-mid="gp_230"].bookmarked')`));
    assert.equal(await page.eval(`window.__kept===document.querySelector('[data-mid="gp_220"]')`), true);
  });
  await check('同浏览器旧角色卡保存被拒绝，保留较新修改', async () => {
    const result = await evaluate(`const old=await s.getCharacter('c_base');await s.saveCharacter({...old,tagline:'新版简介'});
      let rejected=false;try{await s.saveCharacter({...old,name:'过期名称'})}catch{rejected=true}return{rejected,after:await s.getCharacter('c_base')};`);
    assert.equal(result.rejected, true); assert.equal(result.after.tagline, '新版简介'); assert.notEqual(result.after.name, '过期名称');
  });
  await evaluate(`await s.saveCharacter({id:'c_resolution',name:'原名称',tagline:'原简介',greeting:[]});`);
  await wait(async () => !!(await request('/api/db/characters/c_resolution')).data);
  for (const choice of ['local', 'remote']) {
    await check(`真实资料冲突可在界面选择${choice === 'local' ? '本次修改且保留远端其他字段' : '电脑版本并恢复后续同步'}`, async () => {
      const base = (await request('/api/db/characters/c_resolution')).data;
      const diskTagline = '电脑简介_' + choice, localTagline = '本次简介_' + choice;
      assert.equal((await request('/api/db/characters/c_resolution', { base, data: { ...base, name: '电脑改名', tagline: diskTagline } })).status, 200);
      await evaluate(`const c=await s.getCharacter('c_resolution');await s.saveCharacter({...c,tagline:${JSON.stringify(localTagline)}});`);
      await wait(() => page.eval(`(async()=> (await import('./core/filestore.js')).fileStatus().conflict)()`));
      assert.equal(await evaluate(`return(await s.getCharacter('c_resolution')).tagline;`), localTagline);
      await page.eval(`document.querySelector('.store-line').click()`);
      await wait(() => page.eval(`!![...document.querySelectorAll('.modal-title')].find(n=>n.textContent==='处理资料同步冲突')`));
      assert.equal(await page.eval(`document.querySelector('.modal-body').textContent.includes(${JSON.stringify(diskTagline)})`), true);
      await page.eval(`(()=>{window.__conflictPageToken='before-reload';[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent===${JSON.stringify(choice === 'local' ? '保留本次修改' : '保留电脑版本')}).click()})()`);
      await wait(async () => {
        try { return await evaluate(`return !window.__conflictPageToken && !!window.__AICHAT__ && (await s.getCharacter('c_resolution'))?.tagline===${JSON.stringify(choice === 'local' ? localTagline : diskTagline)} && !(await import('./core/filestore.js')).fileStatus().conflict;`); }
        catch { return false; }
      });
      const after = (await request('/api/db/characters/c_resolution')).data;
      assert.equal(after.name, '电脑改名'); assert.equal(after.tagline, choice === 'local' ? localTagline : diskTagline);
      // 409 是本用例故意触发的 HTTP 结果，仍保留其他错误供最终断言检查。
      page.problems.splice(0, page.problems.length, ...page.problems.filter((p) => !(p.includes('409') && p.includes('/api/db/characters/c_resolution'))));
    });
  }
  await check('冲突处理后普通消息写盘继续工作', async () => {
    await evaluate(`await s.updateMessage('mp_001',{bookmarked:true});`);
    await wait(async () => (await request('/api/db/messages/c_base')).messages.some((m) => m.id === 'mp_001' && m.bookmarked));
  });
  await check('同时间戳消息的分页和完整读取使用相同顺序', async () => {
    const result = await evaluate(`await s.putMessagesLocal(['m_a','m_A','m_0','m_Z'].map(id=>({id,charId:'c_ties',role:'user',content:id,at:1})));
      return{all:(await s.listMessages('c_ties')).map(m=>m.id),page:(await s.listMessagesPage('c_ties',{limit:2})).messages.map(m=>m.id)};`);
    assert.deepEqual(result.page, result.all.slice(-2));
  });
  await check('切换会话后旧分页请求的成功与失败都不能覆盖新会话', async () => {
    const result = await page.eval(`(async()=>{const{createHistoryPager}=await import('./ui/message-list.js');
      const pending=[];const pager=createHistoryPager(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
      const old=pager.read('old');pager.reset();const latest=pager.read('new');
      pending[1].resolve({messages:[{id:'new'}],hasMore:false,limit:100});const fresh=await latest;
      pending[0].reject(Error('旧会话失败'));return{fresh,old:await old};})()`);
    assert.deepEqual(result.fresh, [{ id: 'new' }]); assert.equal(result.old, null);
  });
  await check('新共享模块已预缓存，浏览器无未捕获异常', async () => {
    const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    for (const file of ['core/entity-sync.js', 'ui/message-list.js']) assert.ok(sw.includes(`'./${file}'`));
    assert.deepEqual(page.problems, []);
  });
} finally {
  if (page) await page.close();
  if (server) server.kill('SIGTERM');
  await new Promise((resolve) => mock.close(resolve));
  console.log(`优化回归：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}
