#!/usr/bin/env node
/** 近期经历：纯函数 + 独立浏览器/临时数据目录 + 真实请求捕获，绝不使用真实模型或用户数据库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { launch, freePort, sleep } from './cdp.mjs';
import { buildMessages } from '../core/prompt.js';
import { buildGroupMessages } from '../core/group.js';
import { estimateTokens } from '../core/util.js';
import { formatRecentExperiences, heardGroupMessage } from '../core/recent.js';

let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.error(`✗ ${name}: ${err.stack}`); }
}
const now = Date.now();
const role = { id: 'c_a', name: '甲', persona: {} };
const recent = [{ ownerId: 'c_a', source: 'group:g_ab', sourceName: '测试群', speakerName: '乙', at: now, content: 'RECENT_MARKER' }];
await check('只装配当前角色的经历，忽略损坏日期', () => {
  const text = formatRecentExperiences([...recent, { ...recent[0], ownerId: 'c_b', content: 'FOREIGN_SECRET' }, { ...recent[0], at: 'bad', content: 'BAD_DATE' }], { charId: 'c_a' });
  assert.ok(text.includes('RECENT_MARKER')); assert.ok(!text.includes('FOREIGN_SECRET')); assert.ok(!text.includes('BAD_DATE'));
});
await check('私聊预算包含近期经历，分项之和一致，小预算不溢出', () => {
  for (const budget of [400, 1000, 3000, 8000]) {
    const r = buildMessages(role, [{ role: 'user', content: '现在继续聊' }], { runtime: {}, settings: {}, budgetTokens: budget, recentExperiences: recent });
    assert.ok(r.messages.reduce((n, m) => n + estimateTokens(m.content), 0) <= budget);
    assert.equal(r.meta.breakdown.reduce((n, b) => n + b.tokens, 0), r.meta.total);
    if (budget >= 3000) assert.ok(JSON.stringify(r.messages).includes('RECENT_MARKER'));
  }
});
await check('群聊附加经历受预算限制，未听到的历史不会触发世界书', () => {
  const r = buildGroupMessages({ speaker: { ...role, lorebook: [{ keys: ['UNHEARD_KEY'], content: 'LORE_LEAK' }] }, group: { members: ['c_a'] }, members: [role],
    history: [{ role: 'user', content: 'UNHEARD_KEY', audienceIds: ['c_b'], at: now }], recentExperiences: recent, budgetTokens: 8000 });
  assert.ok(JSON.stringify(r.messages).includes('RECENT_MARKER'));
  assert.ok(!JSON.stringify(r.messages).includes('UNHEARD_KEY')); assert.ok(!JSON.stringify(r.messages).includes('LORE_LEAK'));
  assert.ok(r.meta.total <= 8000);
});
await check('听众快照优先，旧消息不推测跨场景听众', () => {
  assert.equal(heardGroupMessage({ audienceIds: ['c_a'] }, 'c_b', { memberSince: { c_b: 0 } }), false);
  assert.equal(heardGroupMessage({ at: 1, role: 'user' }, 'c_a'), false);
  assert.equal(heardGroupMessage({ at: 1 }, 'c_a', { memberSince: { c_a: 2 } }), false);
});

const root = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-recentcheck-'));
assert.ok(!dataDir.startsWith(path.join(root, 'data')));
const calls = [];
const mock = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body); calls.push(payload);
  if (payload.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '收到，我们继续聊。' } }] }) + '\n\ndata: [DONE]\n\n');
  } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"摘要","facts":[]}' } }] })); }
});
const port = await freePort(), mockPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
let server, page;
async function wait(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const r = await fn(); if (r) return r; await sleep(100); }
  throw new Error('等待条件超时');
}
const evaluate = (body) => page.eval(`(async()=>{const s=await import('./core/store.js');${body}})()`);
async function sendPrivate(charId) {
  await page.goto(`${origin}/#/chat/${charId}`);
  await wait(() => page.eval(`window.__AICHAT__?.state.currentCharId===${JSON.stringify(charId)} && !!document.querySelector('#composerInput')`));
  await sleep(200);
  const before = calls.length;
  await page.eval(`(()=>{const i=document.querySelector('#composerInput');i.value='继续聊刚才的事';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sendBtn').click()})()`);
  await wait(() => calls.length > before);
  await wait(() => page.eval(`!document.querySelector('#sendBtn.stop')`));
  return JSON.stringify(calls[before].messages);
}
try {
  await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/API_KEY|AICHAT|^PORT$|^HOST$/.test(key)) delete env[key];
  server = spawn(process.execPath, ['server.mjs', '--host', '127.0.0.1', '--port', String(port), '--no-open', '--data-dir', dataDir], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (c) => log += c); server.stderr.on('data', (c) => log += c);
  await wait(async () => { try { return (await fetch(origin + '/api/health')).ok; } catch { if (server.exitCode != null) throw new Error(log); return false; } });
  page = await launch({ port: await freePort() }); await page.goto(origin);
  await wait(() => page.eval('!!window.__AICHAT__'));
  await evaluate(`s.setSettings({onboarded:true,provider:'ollama',model:'mock',baseUrls:{ollama:'http://127.0.0.1:${mockPort}/v1'},typedEffect:false,voice:{enabled:false},proactive:{enabled:false},context:{summary:false}});
    document.querySelector('.onboard')?.remove();
    for(const [id,name] of [['c_a','甲'],['c_b','乙'],['c_c','丙'],['c_d','丁']])await s.saveCharacter({id,name,greeting:[],persona:{}});
    await s.saveGroup({id:'g_ab',name:'甲乙群',members:['c_a','c_b'],autoDelayMs:0,everyoneSpeaks:false});
    await s.saveGroup({id:'g_cd',name:'丙丁群',members:['c_c','c_d'],autoDelayMs:0});
    await s.appendMessage({id:'m_private',charId:'c_a',role:'user',content:'PRIVATE_A_ONLY_考试在周五'});
    await s.appendGroupMessage({id:'m_public',groupId:'g_ab',role:'user',speakerId:'user',content:'GROUP_AB_PUBLIC_周末看电影'});
    await s.appendGroupMessage({groupId:'g_cd',role:'user',speakerId:'user',content:'GROUP_CD_SECRET'});`);
  await check('私聊几句即可进入同一角色群聊请求，另一角色看不到私聊和其他群', async () => {
    const before = calls.length;
    await evaluate(`const {runGroupRound}=await import('./core/group.js');const group=await s.getGroup('g_ab');const members=await Promise.all(group.members.map(id=>s.getCharacter(id)));await runGroupRound({group,members,history:await s.listGroupMessages(group.id),userText:'@乙 @甲 继续聊',settings:s.getSettings()});`);
    const bodies = calls.slice(before).map((c) => JSON.stringify(c.messages));
    assert.equal(bodies.length, 2); // 没有额外摘要/记忆模型调用。
    assert.ok(!bodies[0].includes('PRIVATE_A_ONLY')); assert.ok(bodies[1].includes('PRIVATE_A_ONLY'));
    assert.ok(bodies.every((b) => !b.includes('GROUP_CD_SECRET')));
  });
  await check('群聊经历即时进入真实私聊发送流程', async () => {
    assert.ok((await sendPrivate('c_a')).includes('GROUP_AB_PUBLIC'));
    const b = await sendPrivate('c_b'); assert.ok(b.includes('GROUP_AB_PUBLIC')); assert.ok(!b.includes('PRIVATE_A_ONLY'));
  });
  await check('在场但从未发言/被禁言的角色也能记住', async () => {
    const rows = await evaluate(`await s.saveGroup({id:'g_ad',name:'旁听群',members:['c_a','c_d'],mutedMembers:['c_d']});await s.appendGroupMessage({groupId:'g_ad',role:'user',content:'SILENT_D_HEARD'});return s.getRecentExperiences('c_d');`);
    assert.ok(rows.some((e) => e.content === 'SILENT_D_HEARD'));
  });
  await check('后来入群的角色不会获得此前群消息或成员的私聊', async () => {
    const result = await evaluate(`await s.setGroupMembers('g_ab',['c_c']);const group=await s.getGroup('g_ab');const {buildGroupMessages}=await import('./core/group.js');return {recent:await s.getRecentExperiences('c_c'),prompt:buildGroupMessages({speaker:await s.getCharacter('c_c'),members:await Promise.all(group.members.map(id=>s.getCharacter(id))),group,history:await s.listGroupMessages(group.id),recentExperiences:await s.getRecentExperiences('c_c',{source:'group:g_ab'})}).messages};`);
    assert.ok(!JSON.stringify(result).includes('GROUP_AB_PUBLIC')); assert.ok(!JSON.stringify(result).includes('PRIVATE_A_ONLY'));
  });
  await check('离群期间的消息不补入，重新入群后仍记得原来听过的消息', async () => {
    const rows = await evaluate(`await s.appendGroupMessage({groupId:'g_ab',role:'user',content:'C_PRESENT'});await s.setGroupMembers('g_ab',[],['c_c']);await s.appendGroupMessage({groupId:'g_ab',role:'user',content:'C_ABSENT'});await s.setGroupMembers('g_ab',['c_c']);return s.getRecentExperiences('c_c');`);
    assert.ok(rows.some((e) => e.content === 'C_PRESENT')); assert.ok(!rows.some((e) => e.content === 'C_ABSENT'));
  });
  await check('甲在群里公开后乙才会得到该信息', async () => {
    await evaluate(`await s.appendGroupMessage({groupId:'g_ab',role:'assistant',speakerId:'c_a',speakerName:'甲',content:'现在我公开说：PRIVATE_A_ONLY_考试在周五'});`);
    assert.ok((await sendPrivate('c_b')).includes('PRIVATE_A_ONLY'));
  });
  await check('群到群互通只跟随同一角色，保留原有长期记忆', async () => {
    const before = calls.length;
    await evaluate(`await s.saveMemory('c_a',{summary:'EXISTING_LONG_MEMORY',facts:['原有用户偏好']});const {runGroupRound}=await import('./core/group.js');const group=await s.getGroup('g_ad');await s.saveGroup({...group,mutedMembers:[]});const current=await s.getGroup('g_ad');await runGroupRound({group:current,members:await Promise.all(current.members.map(id=>s.getCharacter(id))),history:await s.listGroupMessages(current.id),userText:'@丁 @甲 继续聊',settings:s.getSettings()});`);
    const bodies = calls.slice(before).map((c) => JSON.stringify(c.messages));
    assert.equal(bodies.length, 2);
    assert.ok(!bodies[0].includes('PRIVATE_A_ONLY')); assert.ok(!bodies[0].includes('EXISTING_LONG_MEMORY'));
    assert.ok(bodies[1].includes('PRIVATE_A_ONLY')); assert.ok(bodies[1].includes('EXISTING_LONG_MEMORY'));
  });
  await check('旧消息缺听众时不猜测；新成员的当前群提示词也排除旧消息', async () => {
    const result = await evaluate(`await s.putGroupMessagesLocal([{id:'m_legacy',groupId:'g_ab',role:'user',at:1,content:'LEGACY_UNPROVEN'}]);const group=await s.getGroup('g_ab');const {buildGroupMessages}=await import('./core/group.js');return {recent:await s.getRecentExperiences('c_c'),prompt:buildGroupMessages({speaker:await s.getCharacter('c_c'),members:[],group,history:await s.listGroupMessages(group.id)}).messages};`);
    assert.ok(!JSON.stringify(result).includes('LEGACY_UNPROVEN'));
  });
  await check('游戏、系统、失败和未完成消息不成为近期经历', async () => {
    const rows = await evaluate(`for(const m of [{role:'user',game:'werewolf',content:'HIDDEN_GAME_ROLE'},{role:'system',content:'SYSTEM_ONLY'},{role:'assistant',status:'error',content:'FAILED_REPLY'},{role:'assistant',status:'streaming',content:'UNFINISHED_REPLY'}])await s.appendGroupMessage({groupId:'g_ab',...m});return s.getRecentExperiences('c_a');`);
    for (const token of ['HIDDEN_GAME_ROLE', 'SYSTEM_ONLY', 'FAILED_REPLY', 'UNFINISHED_REPLY']) assert.ok(!JSON.stringify(rows).includes(token));
  });
  await check('修改、删除源消息即时生效，编辑不能扩张原听众', async () => {
    const r = await evaluate(`await s.appendGroupMessage({id:'m_edit',groupId:'g_ad',role:'user',content:'BEFORE_EDIT'});await s.updateGroupMessage('m_edit',{content:'AFTER_EDIT',audienceIds:['c_c']});const edited=await s.getGroupMessage('m_edit');const before=await s.getRecentExperiences('c_d');await s.deleteGroupMessage('m_edit');return {edited,before,after:await s.getRecentExperiences('c_d')};`);
    assert.deepEqual(r.edited.audienceIds, ['c_a', 'c_d']);
    assert.ok(r.before.some((e) => e.content === 'AFTER_EDIT')); assert.ok(!JSON.stringify(r.after).includes('AFTER_EDIT'));
  });
  await check('刷新并清空浏览器缓存后从磁盘恢复听众和近期经历', async () => {
    await wait(async () => { const r = await (await fetch(origin + '/api/db/groupmsgs/g_ad')).json(); return r.messages?.some((m) => m.content === 'SILENT_D_HEARD' && m.audienceIds?.includes('c_d')); });
    await evaluate(`await s.wipeLocalOnly();`);
    await page.goto('about:blank'); await wait(() => page.eval('location.href==="about:blank"'));
    await page.goto(origin); await wait(() => page.eval('!!window.__AICHAT__'));
    const r = await evaluate(`return {d:await s.getRecentExperiences('c_d'),c:await s.getRecentExperiences('c_c')};`);
    assert.ok(r.d.some((e) => e.content === 'SILENT_D_HEARD')); assert.ok(!r.c.some((e) => e.content === 'C_ABSENT'));
  });
  await check('合并导入重新映射听众与入群时间，原角色不会读取导入副本经历', async () => {
    const r = await evaluate(`const pack=await s.exportAll();await s.importAll(pack,{merge:true});const chars=await s.listCharacters();const a=chars.find(c=>c.name==='甲（导入）');const g=(await s.listGroups()).find(g=>g.name==='甲乙群（导入）');const msgs=await s.listGroupMessages(g.id);return {a:a.id,g,heard:msgs.find(m=>m.content.startsWith('GROUP_AB_PUBLIC')).audienceIds,recent:await s.getRecentExperiences(a.id),original:await s.getRecentExperiences('c_a')};`);
    assert.ok(r.heard.includes(r.a)); assert.ok(!r.heard.includes('c_a')); assert.ok(Object.hasOwn(r.g.memberSince, r.a));
    assert.ok(r.recent.some((e) => e.content.includes('PRIVATE_A_ONLY')));
    assert.ok(!r.original.some((e) => e.source === `group:${r.g.id}`));
  });
  await check('近期条数与时间窗口有界，选中回复版本生效', async () => {
    const r = await evaluate(`await s.saveGroup({id:'g_limit',name:'限量群',members:['c_a','c_d']});const base=Date.now()-5000;
      await s.appendGroupMessage({groupId:'g_limit',role:'user',content:'TOO_OLD',at:Date.now()-8*86400000});
      for(let i=0;i<20;i++)await s.appendGroupMessage({groupId:'g_limit',role:'user',content:'LIMIT_'+i,at:base+i});
      await s.appendGroupMessage({groupId:'g_limit',role:'assistant',speakerId:'c_a',content:'UNSELECTED',variants:{list:['UNSELECTED','SELECTED_VERSION'],index:1}});
      return {rows:await s.getRecentExperiences('c_d'),past:await s.getRecentExperiences('c_d',{beforeAt:base+3})};`);
    assert.equal(r.rows.length, 12); assert.ok(!JSON.stringify(r.rows).includes('TOO_OLD')); assert.ok(r.rows.some((e) => e.content === 'SELECTED_VERSION'));
    assert.ok(r.past.every((e) => !/^LIMIT_([4-9]|1[0-9])$/.test(e.content))); assert.ok(!r.past.some((e) => e.content === 'SELECTED_VERSION'));
  });
  await check('页面无未捕获异常', () => assert.deepEqual(page.problems, []));
} catch (err) { failed++; console.error(err.stack); }
finally {
  if (page) await page.close();
  if (server) { server.kill('SIGKILL'); await new Promise((r) => server.exitCode != null ? r() : server.once('exit', r)); }
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`近期经历：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
