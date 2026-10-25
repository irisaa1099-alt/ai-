#!/usr/bin/env node
/**
 * 长期记忆与来源纠错专项：合成消息、本地假模型、临时源码/数据库、独立无头浏览器。
 * 不读取真实聊天或 .env，不调用外部模型；用例结束后删除自建临时目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { launch, freePort, sleep } from './cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-memorycheck-'));
const appDir = path.join(sandbox, 'app');
const dataDir = path.join(sandbox, 'db');
assert.ok(!sandbox.startsWith(root + path.sep));
fs.cpSync(root, appDir, {
  recursive: true,
  filter(file) {
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    return !parts.some((part) => /^\.env(?:\.|$)/.test(part) || ['.git', 'node_modules', '.DS_Store'].includes(part))
      && !(parts[0] === 'data' && parts[1] === 'db');
  },
});
const port = await freePort(), modelPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
const evidenceIndex = process.argv.indexOf('--ui-evidence');
const evidenceDir = evidenceIndex >= 0 ? path.resolve(process.argv[evidenceIndex + 1] || path.join(sandbox, 'screenshots')) : '';
const auditOnly = process.argv.includes('--audit-extra');
let page, server, passed = 0, failed = 0;
const calls = [], plans = [], mockErrors = [];
const pendingResponses = new Set();

/** 从实际摘要请求末尾的 JSON 数组取来源编号，不能在假模型中捏造有效来源。 */
function sourceRows(body) {
  const rows = [];
  for (const message of body.messages || []) {
    if (message.role !== 'user') continue;
    for (const line of String(message.content || '').split('\n')) {
      const start = line.indexOf('[');
      if (start < 0) continue;
      try {
        const parsed = JSON.parse(line.slice(start));
        if (Array.isArray(parsed)) rows.push(...parsed.filter((row) => row && typeof row.id === 'string'));
      } catch { /* 非对话 JSON 行不作来源。 */ }
    }
  }
  return rows;
}
function citation(body, marker) {
  const row = sourceRows(body).find((r) => JSON.stringify(r).includes(marker));
  assert.ok(row?.id, `摘要请求中未找到测试来源：${marker}`);
  return row.id;
}
function answer(summary, facts) { return JSON.stringify({ summary, facts }); }
function planFact(marker, fact, summary = `摘要_${fact}`) {
  plans.push((body) => answer(summary, [{ text: fact, sourceIds: [citation(body, marker)] }]));
}
const mock = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  pendingResponses.add(res);
  res.once('close', () => pendingResponses.delete(res));
  try {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push(body);
    assert.equal(body.stream, false, '专项只允许非流式摘要请求');
    const plan = plans.shift(); assert.ok(plan, '出现未计划的模型请求');
    const content = await plan(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  } catch (error) {
    mockErrors.push(error.stack || String(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'memorycheck mock assertion failed' } }));
  }
});
async function wait(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await sleep(60); }
  throw new Error('等待条件超时');
}
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}: ${error.stack || error}`); }
}
const evaluate = (code) => page.eval(`(async()=>{const s=await import('./core/store.js');const p=await import('./core/prompt.js');const h=window.__memoryCheck;${code}})()`);
const active = (mem) => (mem.factRecords || []).filter((r) => r.status === 'active');
const facts = (mem) => active(mem).map((r) => r.text);
const detailRows = (detail) => Array.isArray(detail) ? detail : detail?.sources || [];
async function seed(key, options = {}) {
  return evaluate(`return h.seed(${JSON.stringify(key)},${JSON.stringify(options)});`);
}
async function summarize(id, extra = {}) {
  return evaluate(`return h.summarize(${JSON.stringify(id)},${JSON.stringify(extra)});`);
}
async function memory(id) { return evaluate(`return s.getMemory(${JSON.stringify(id)});`); }
async function prompt(id) { return evaluate(`return h.prompt(${JSON.stringify(id)});`); }
async function source(id, recordId) { return evaluate(`return s.getMemorySource(${JSON.stringify(id)},${JSON.stringify(recordId)});`); }
async function installHelpers() {
  await evaluate(`
    s.setSettings({onboarded:true,provider:'ollama',model:'memorycheck-mock',useProxy:false,
      apiKeys:{},baseUrls:{ollama:'http://127.0.0.1:${modelPort}/v1'},typedEffect:false,
      voice:{enabled:false},proactive:{enabled:false},
      context:{summary:true,summaryKeep:2,maxMessages:2,budgetTokens:12000,timeAware:false,affinity:false}});
    document.querySelector('.onboard')?.remove();
    window.__memoryCheck={
      async seed(key,options={}) {
        const id='c_mc_'+key, other='c_other_'+key, groupId='g_mc_'+key;
        await s.saveCharacter({id,name:'测试角色_'+key,greeting:[],persona:{}});
        await s.saveCharacter({id:other,name:'其他角色_'+key,greeting:[],persona:{}});
        const at=Date.now()-60000;
        const messages=Array.from({length:18},(_,i)=>({id:'m_'+key+'_'+i,charId:id,role:i%2?'assistant':'user',
          at:at+i,content:i===0?(options.marker||'SOURCE_'+key)+'：这是一条用于核验记忆来源的合成消息。':'测试对话_'+key+'_'+i+'，讨论今日计划与公开事项。'}));
        await s.putMessagesLocal(messages);
        if(options.group){
          await s.saveGroup({id:groupId,name:'测试群_'+key,members:[id,other]});
          await s.putGroupMessagesLocal(messages.map((m,i)=>({...m,id:'gm_'+key+'_'+i,charId:groupId,groupId,
            speakerId:i%2?other:'user',speakerName:i%2?'其他角色':'我',audienceIds:[id,other]})));
        }
        return {id,other,groupId,marker:options.marker||'SOURCE_'+key,messageId:messages[0].id,groupMessageId:'gm_'+key+'_0'};
      },
      async summarize(id,extra={}) {
        const char=await s.getCharacter(id),groupId=extra.groupId;
        const history=groupId?await s.listGroupMessages(groupId):await s.listMessages(id);
        const options={settings:s.getSettings(),force:true,...extra};
        if(groupId)options.source='group:'+groupId;
        return p.summarizeIfNeeded(char,history,options);
      },
      async prompt(id){return p.buildSystemPrompt(await s.getCharacter(id),{settings:s.getSettings(),memory:await s.getMemory(id),runtime:{}})}
    };`);
}

try {
  await new Promise((resolve) => mock.listen(modelPort, '127.0.0.1', resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|AICHAT|^PORT$|^HOST$/.test(key)) delete env[key];
  server = spawn(process.execPath, ['server.mjs', '--host', '127.0.0.1', '--port', String(port), '--no-open', '--data-dir', dataDir],
    { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (chunk) => serverLog += chunk);
  server.stderr.on('data', (chunk) => serverLog += chunk);
  await wait(async () => { try { return (await fetch(origin + '/api/health')).ok; } catch { if (server.exitCode != null) throw Error(serverLog); return false; } });
  await fetch(origin + '/api/db/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { settings: { onboarded: true, voice: { enabled: false }, proactive: { enabled: false } } } }) });
  page = await launch({ port: await freePort(), ...(evidenceDir ? { height: 1400 } : {}) });
  await page.goto(origin);
  await wait(() => page.eval('!!window.__AICHAT__'));
  await installHelpers();

  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const f = await seed('ui_evidence', { marker: '用户说明：我平日喜欢晚饭后散步，周末会去图书馆。' });
    plans.push((body) => answer('这位用户喜欢散步，也会讨论一天的计划。', [
      { text: '用户喜欢在晚饭后散步。', sourceIds: [citation(body, f.marker)] },
      { text: '用户会讨论今日计划与公开事项。', sourceIds: [citation(body, '测试对话_ui_evidence_1，')] },
    ]));
    await summarize(f.id);
    await page.goto(origin + '/#/chat/' + f.id);
    await wait(() => page.eval(`window.__AICHAT__?.state.currentCharId===${JSON.stringify(f.id)}`));
    await evaluate(`(await import('./ui/settings.js')).openSettings('context');`);
    await wait(() => page.eval(`!!document.querySelector('article[data-memory-status="active"] button[aria-label^="查看记忆来源"]')`));
    await check('截图：有效事实可以查看当前原始来源', async () => {
      await page.eval(`document.querySelector('article[data-memory-status="active"] button[aria-label^="查看记忆来源"]').click()`);
      await wait(() => page.eval(`[...document.querySelectorAll('.memory-source-content')].some(n=>n.textContent.includes('晚饭后散步'))`));
      await sleep(150); await page.shot(path.join(evidenceDir, '01-valid-source.png'));
      await page.eval(`[...document.querySelectorAll('.modal-foot button')].findLast(b=>b.textContent==='关闭').click()`);
    });
    await check('截图：人工纠正后新事实有效，旧事实保留在历史', async () => {
      plans.push(()=>JSON.stringify({factIds:[],messageIds:[],retainedFacts:[]}));
    await page.eval(`document.querySelector('[data-memory-write="correct"]').click()`);
      await wait(() => page.eval(`!!document.querySelector('.modal-body textarea')`));
      await page.eval(`(()=>{const input=document.querySelector('.modal-body textarea');input.value='用户现在更喜欢清晨散步。';input.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.modal-foot button')].findLast(b=>b.textContent==='确定').click()})()`);
      await wait(async () => facts(await memory(f.id)).includes('用户现在更喜欢清晨散步。'));
      await wait(() => page.eval(`!!document.querySelector('details.memory-history')`));
      await wait(() => page.eval(`![...document.querySelectorAll('.modal-title')].some(n=>n.textContent==='纠正这条记忆')`));
      await page.eval(`document.querySelector('details.memory-history').open=true;document.querySelector('.memory-summary').scrollIntoView({block:'start'})`);
      await sleep(150); await page.shot(path.join(evidenceDir, '02-corrected-and-history.png'));
    });
    await check('截图：原文变更后显示来源变化与暂停使用提醒', async () => {
      await evaluate(`await s.updateMessage('m_ui_evidence_1',{content:'用户已更新今天的安排，请以新消息为准。'});`);
      await page.eval(`document.querySelector('[data-memory-write="refresh"]').click()`);
      await wait(() => page.eval(`!!document.querySelector('article[data-memory-status="stale"]')`));
      await page.eval(`document.querySelector('details.memory-history').open=true;document.querySelector('.memory-summary').scrollIntoView({block:'start'})`);
      await sleep(150); await page.shot(path.join(evidenceDir, '03-source-changed.png'));
      assert.ok(!(await prompt(f.id)).includes('用户会讨论今日计划与公开事项。'));
    });
  } else if (auditOnly) {
    await check('游戏记忆原子追加保留旧记录与人工纠正，重建后仍有效', async () => {
      const f = await seed('game_append');
      await evaluate(`await s.saveMemory(${JSON.stringify(f.id)},{summary:'GAME_PREVIOUS_SUMMARY',facts:['GAME_LEGACY_FACT','GAME_OLD_WRONG']});`);
      const before = await memory(f.id), old = active(before).find((r) => r.text === 'GAME_OLD_WRONG');
      await evaluate(`await Promise.all([
        s.appendGameMemoryFact(${JSON.stringify(f.id)},'GAME_RESULT_FACT'),
        s.correctMemoryFact(${JSON.stringify(f.id)},${JSON.stringify(old.id)},'GAME_MANUAL_CORRECTION')]);
        await s.appendGameMemoryFact(${JSON.stringify(f.id)},'GAME_RESULT_FACT');`);
      const appended = await memory(f.id);
      assert.ok(facts(appended).includes('GAME_LEGACY_FACT'));
      assert.ok(facts(appended).includes('GAME_MANUAL_CORRECTION'));
      assert.equal(appended.factRecords.filter((r) => r.text === 'GAME_RESULT_FACT').length, 1);
      assert.equal(active(appended).find((r) => r.text === 'GAME_RESULT_FACT')?.origin, 'game');
      assert.equal(appended.factRecords.find((r) => r.id === old.id)?.status, 'superseded');
      planFact(f.marker, 'GAME_REBUILT_MODEL_FACT');
      assert.equal((await evaluate(`return p.rebuildMemory(await s.getCharacter(${JSON.stringify(f.id)}),[],s.getSettings());`)).summarized, true);
      const rebuilt = await memory(f.id);
      for (const text of ['GAME_RESULT_FACT', 'GAME_MANUAL_CORRECTION', 'GAME_REBUILT_MODEL_FACT']) assert.ok(facts(rebuilt).includes(text));
      assert.ok(!facts(rebuilt).includes('GAME_OLD_WRONG'));
      const gameRecord = active(rebuilt).find((r) => r.text === 'GAME_RESULT_FACT');
      await evaluate(`await s.retractMemoryFact(${JSON.stringify(f.id)},${JSON.stringify(gameRecord.id)});
        await s.appendGameMemoryFact(${JSON.stringify(f.id)},'GAME_RESULT_FACT');`);
      assert.ok(!facts(await memory(f.id)).includes('GAME_RESULT_FACT'));
    });
    await check('多批重建第二批解析失败，第一批结果不提交且原记录不变', async () => {
      const f = await seed('batch_failure');
      await evaluate(`await s.putMessagesLocal(Array.from({length:35},(_,i)=>({id:'long_'+i,charId:${JSON.stringify(f.id)},role:'user',at:Date.now()+i,content:'长记录_'+i+'：'+'合成资料'.repeat(110)})));
        await s.saveMemory(${JSON.stringify(f.id)},{summary:'ORIGINAL_BATCH_SUMMARY',facts:['ORIGINAL_BATCH_FACT']});`);
      const before = await evaluate(`return s.idb('memory','readonly',o=>o.get(${JSON.stringify(f.id)}));`);
      plans.push((body) => answer('PARTIAL_BATCH_SUMMARY', [{ text: 'PARTIAL_BATCH_FACT', sourceIds: [sourceRows(body)[0].id] }]));
      plans.push(() => 'invalid second batch JSON');
      const callsBefore = calls.length;
      const result = await evaluate(`return p.rebuildMemory(await s.getCharacter(${JSON.stringify(f.id)}),[],s.getSettings());`);
      assert.equal(calls.length - callsBefore, 2); assert.equal(result.summarized, false);
      const after = await evaluate(`return s.idb('memory','readonly',o=>o.get(${JSON.stringify(f.id)}));`);
      assert.deepEqual(after, before);
      assert.ok(!(await prompt(f.id)).includes('PARTIAL_BATCH_FACT'));
    });
    await check('错误来源事实不能借同一响应的摘要进入提示词', async () => {
      const f = await seed('bad_source_summary');
      plans.push(() => answer('UNKNOWN_SOURCE_FACT_用户住在未提及的地方', [
        { text: 'UNKNOWN_SOURCE_FACT_用户住在未提及的地方', sourceIds: ['private:unknown:unknown'] },
      ]));
      await summarize(f.id);
      const mem = await memory(f.id);
      assert.ok(!facts(mem).some((text) => text.includes('UNKNOWN_SOURCE_FACT')));
      assert.ok(!(await prompt(f.id)).includes('UNKNOWN_SOURCE_FACT'), '未知来源事实被丢弃，但仍通过summary进入提示词');
    });
  } else {
  await check('旧摘要/事实只读兼容，稳定标识且不写回原记录', async () => {
    const f = await seed('legacy');
    const result = await evaluate(`
      const raw={charId:${JSON.stringify(f.id)},summary:'LEGACY_SUMMARY',facts:['LEGACY_FACT_1','LEGACY_FACT_2'],updatedAt:123,summarizedUpTo:456};
      await s.idb('memory','readwrite',o=>o.put(raw));
      const before=await s.idb('memory','readonly',o=>o.get(raw.charId));
      const first=await s.getMemory(raw.charId),second=await s.getMemory(raw.charId);
      return{before,after:await s.idb('memory','readonly',o=>o.get(raw.charId)),first,second,prompt:await h.prompt(raw.charId)};`);
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.first.factRecords, result.second.factRecords);
    assert.equal(result.first.summary, 'LEGACY_SUMMARY');
    assert.deepEqual(result.first.facts, ['LEGACY_FACT_1', 'LEGACY_FACT_2']);
    assert.ok(active(result.first).every((r) => r.id && r.origin === 'legacy' && r.sourceStatus === 'unverified'));
    for (const marker of ['LEGACY_SUMMARY', 'LEGACY_FACT_1', 'LEGACY_FACT_2']) assert.ok(result.prompt.includes(marker));
  });
  await check('四十条事实中的最新十条进入提示词', async () => {
    const f = await seed('forty');
    await evaluate(`await s.saveMemory(${JSON.stringify(f.id)},{summary:'',facts:Array.from({length:40},(_,i)=>'FACT_'+String(i+1).padStart(2,'0'))});`);
    const text = await prompt(f.id);
    for (let i = 31; i <= 40; i++) assert.ok(text.includes(`FACT_${i}`));
  });
  await check('重新整理依据新来源替换旧模型事实，不无条件拼回旧事实', async () => {
    const f = await seed('rebuild');
    await evaluate(`await s.saveMemory(${JSON.stringify(f.id)},{summary:'OLD_SUMMARY',facts:['OLD_INCORRECT_FACT']});`);
    planFact(f.marker, 'NEW_CORRECT_FACT');
    const result = await evaluate(`return p.rebuildMemory(await s.getCharacter(${JSON.stringify(f.id)}),await s.listMessages(${JSON.stringify(f.id)}),s.getSettings());`);
    assert.equal(result.summarized, true);
    const text = await prompt(f.id);
    assert.ok(text.includes('NEW_CORRECT_FACT')); assert.ok(!text.includes('OLD_INCORRECT_FACT'));
  });

  await check('模型事实仅归因当前角色真实私聊来源，未知ID不会成为可核验引用', async () => {
    const f = await seed('private_source');
    plans.push((body) => answer('PRIVATE_SOURCE_SUMMARY', [
      { text: 'PRIVATE_VERIFIED_FACT', sourceIds: [citation(body, f.marker)] },
      { text: 'INVALID_SOURCE_FACT', sourceIds: ['private:nonexistent:m_nonexistent'] },
    ]));
    assert.equal((await summarize(f.id)).summarized, true);
    const mem = await memory(f.id), record = active(mem).find((r) => r.text === 'PRIVATE_VERIFIED_FACT');
    assert.equal(record?.sourceStatus, 'verified');
    assert.ok(record.sources.every((r) => r.kind === 'private' && r.conversationId === f.id));
    const detail = detailRows(await source(f.id, record.id));
    assert.ok(detail.some((r) => r.available && !r.changed && r.content.includes(f.marker)));
    const invalid = active(mem).find((r) => r.text === 'INVALID_SOURCE_FACT');
    assert.ok(!invalid || (invalid.sourceStatus !== 'verified' && !invalid.sources.length));
  });
  await check('他人私聊即使混进调用参数也不进入摘要输入或来源归因', async () => {
    const f = await seed('foreign_private');
    const foreignId = 'foreign_private_id';
    await evaluate(`await s.putMessagesLocal([{id:${JSON.stringify(foreignId)},charId:${JSON.stringify(f.other)},role:'user',at:(await s.listMessages(${JSON.stringify(f.id)}))[0].at+0.5,content:'FOREIGN_PRIVATE_SECRET'}]);`);
    plans.push((body) => {
      assert.ok(!JSON.stringify(body.messages).includes('FOREIGN_PRIVATE_SECRET'));
      return answer('SAFE_PRIVATE_SUMMARY', [
        { text: 'OWN_PRIVATE_FACT', sourceIds: [citation(body, f.marker)] },
        { text: 'FOREIGN_ATTRIBUTION', sourceIds: ['private:' + f.other + ':' + foreignId] },
      ]);
    });
    await evaluate(`const list=[...await s.listMessages(${JSON.stringify(f.id)}),...await s.listMessages(${JSON.stringify(f.other)})].sort((a,b)=>a.at-b.at);return p.summarizeIfNeeded(await s.getCharacter(${JSON.stringify(f.id)}),list,{settings:s.getSettings(),force:true});`);
    const mem = await memory(f.id);
    assert.ok(active(mem).some((r) => r.text === 'OWN_PRIVATE_FACT'));
    assert.ok(mem.factRecords.every((r) => !r.sources.some((ref) => ref.conversationId === f.other)));
  });
  await check('群聊只归因角色当时听到的消息，未听消息不进入摘要输入', async () => {
    const f = await seed('group_source', { group: true });
    await evaluate(`await s.putGroupMessagesLocal([{id:'gm_unheard',groupId:${JSON.stringify(f.groupId)},role:'user',speakerId:'user',at:(await s.listGroupMessages(${JSON.stringify(f.groupId)}))[0].at+0.5,audienceIds:[${JSON.stringify(f.other)}],content:'UNHEARD_GROUP_SECRET'}]);`);
    plans.push((body) => {
      assert.ok(!JSON.stringify(body.messages).includes('UNHEARD_GROUP_SECRET'));
      return answer('GROUP_SOURCE_SUMMARY', [
        { text: 'GROUP_VERIFIED_FACT', sourceIds: [citation(body, f.marker)] },
        { text: 'UNHEARD_ATTRIBUTION', sourceIds: ['group:' + f.groupId + ':gm_unheard'] },
      ]);
    });
    assert.equal((await summarize(f.id, { groupId: f.groupId })).summarized, true);
    const mem = await memory(f.id), record = active(mem).find((r) => r.text === 'GROUP_VERIFIED_FACT');
    assert.equal(record?.sourceStatus, 'verified');
    assert.ok(record.sources.every((r) => r.kind === 'group' && r.conversationId === f.groupId));
    assert.ok(mem.factRecords.every((r) => !r.sources.some((ref) => ref.messageId === 'gm_unheard')));
    assert.ok(detailRows(await source(f.id, record.id)).some((r) => r.available && r.content.includes(f.marker)));
  });
  for (const operation of ['edit', 'delete']) {
    await check(`${operation === 'edit' ? '修改' : '删除'}原私聊后，对应长期事实与摘要不再注入提示词`, async () => {
      const f = await seed('source_' + operation), fact = 'STALE_FACT_' + operation, summary = 'STALE_SUMMARY_' + operation;
      planFact(f.marker, fact, summary); await summarize(f.id);
      const record = active(await memory(f.id)).find((r) => r.text === fact);
      assert.ok((await prompt(f.id)).includes(fact));
      await evaluate(operation === 'edit'
        ? `await s.updateMessage(${JSON.stringify(f.messageId)},{content:'CHANGED_SOURCE_TEXT'});`
        : `await s.deleteMessage(${JSON.stringify(f.messageId)});`);
      const text = await prompt(f.id), mem = await memory(f.id);
      assert.ok(!text.includes(fact)); assert.ok(!text.includes(summary));
      assert.equal(mem.factRecords.find((r) => r.id === record.id)?.status, 'stale');
      const detail = detailRows(await source(f.id, record.id));
      assert.ok(detail.every((r) => operation === 'edit' ? r.changed : !r.available));
    });
  }
  await check('修改群聊原消息同样使事实与摘要失效', async () => {
    const f = await seed('group_edit', { group: true });
    planFact(f.marker, 'GROUP_EDIT_FACT', 'GROUP_EDIT_SUMMARY'); await summarize(f.id, { groupId: f.groupId });
    await evaluate(`await s.updateGroupMessage(${JSON.stringify(f.groupMessageId)},{content:'GROUP_SOURCE_CHANGED'});`);
    const text = await prompt(f.id);
    assert.ok(!text.includes('GROUP_EDIT_FACT')); assert.ok(!text.includes('GROUP_EDIT_SUMMARY'));
  });
  await check('人工纠正替换旧事实，后续摘要不能原样复活旧文本和原来源', async () => {
    const f = await seed('correct');
    planFact(f.marker, 'CORRECT_OLD_FACT'); await summarize(f.id);
    const old = active(await memory(f.id)).find((r) => r.text === 'CORRECT_OLD_FACT');
    await evaluate(`await s.correctMemoryFact(${JSON.stringify(f.id)},${JSON.stringify(old.id)},'CORRECT_NEW_FACT');`);
    const corrected = await memory(f.id), replacement = active(corrected).find((r) => r.text === 'CORRECT_NEW_FACT');
    assert.equal(corrected.factRecords.find((r) => r.id === old.id)?.status, 'superseded');
    assert.equal(replacement?.origin, 'manual'); assert.equal(replacement.replaces, old.id);
    plans.push((body) => {
      assert.ok(!sourceRows(body).some((r) => JSON.stringify(r).includes(f.marker)));
      return answer('POST_CORRECTION_SUMMARY', ['CORRECT_OLD_FACT']);
    });
    await evaluate(`return p.rebuildMemory(await s.getCharacter(${JSON.stringify(f.id)}),[],s.getSettings());`);
    const text = await prompt(f.id);
    assert.ok(text.includes('CORRECT_NEW_FACT')); assert.ok(!text.includes('CORRECT_OLD_FACT'));
  });
  await check('撤回保留阻止复活的记录，后续摘要不重新注入旧事实', async () => {
    const f = await seed('retract');
    planFact(f.marker, 'RETRACT_OLD_FACT'); await summarize(f.id);
    const record = active(await memory(f.id)).find((r) => r.text === 'RETRACT_OLD_FACT');
    await evaluate(`await s.retractMemoryFact(${JSON.stringify(f.id)},${JSON.stringify(record.id)});`);
    assert.equal((await memory(f.id)).factRecords.find((r) => r.id === record.id)?.status, 'retracted');
    plans.push((body) => {
      assert.ok(!sourceRows(body).some((r) => JSON.stringify(r).includes(f.marker)));
      return answer('POST_RETRACTION_SUMMARY', ['RETRACT_OLD_FACT']);
    });
    await evaluate(`return p.rebuildMemory(await s.getCharacter(${JSON.stringify(f.id)}),[],s.getSettings());`);
    assert.ok(!(await prompt(f.id)).includes('RETRACT_OLD_FACT'));
  });
  await check('旧revision保存明确冲突，不覆盖人工纠正', async () => {
    const f = await seed('revision');
    await evaluate(`await s.saveMemory(${JSON.stringify(f.id)},{summary:'',facts:['REVISION_OLD']});`);
    const before = await memory(f.id), record = active(before)[0];
    const result = await evaluate(`
      const id=${JSON.stringify(f.id)};await s.correctMemoryFact(id,${JSON.stringify(record.id)},'REVISION_MANUAL');
      let code='';try{await s.saveMemory(id,${JSON.stringify(before)},{expectedRevision:${before.revision}})}catch(error){code=error.code}
      return{code,memory:await s.getMemory(id)};`);
    assert.equal(result.code, 'memory_conflict'); assert.ok(facts(result.memory).includes('REVISION_MANUAL'));
  });
  for (const outcome of ['success', 'invalid']) {
    await check(`${outcome === 'success' ? '摘要迟到成功' : '重新整理解析失败'}不覆盖等待期间的人工纠正`, async () => {
      const f = await seed('race_' + outcome);
      await evaluate(`await s.saveMemory(${JSON.stringify(f.id)},{summary:'RACE_BEFORE',facts:['RACE_OLD']});`);
      const record = active(await memory(f.id))[0], beforeCalls = calls.length;
      let release;
      plans.push((body) => new Promise((resolve) => { release = () => resolve(outcome === 'success'
        ? answer('RACE_MODEL_SUMMARY', [{ text: 'RACE_MODEL_FACT', sourceIds: [citation(body, f.marker)] }])
        : 'not valid JSON'); }));
      await evaluate(`window.__memoryPending=p.${outcome === 'success' ? 'summarizeIfNeeded' : 'rebuildMemory'}(
        await s.getCharacter(${JSON.stringify(f.id)}),await s.listMessages(${JSON.stringify(f.id)}),
        ${outcome === 'success' ? '{settings:s.getSettings(),force:true}' : 's.getSettings()'});`);
      await wait(() => calls.length > beforeCalls && release);
      try { await evaluate(`await s.correctMemoryFact(${JSON.stringify(f.id)},${JSON.stringify(record.id)},'RACE_MANUAL');`); }
      finally { release(); }
      await evaluate('await window.__memoryPending;');
      const text = await prompt(f.id);
      assert.ok(text.includes('RACE_MANUAL')); assert.ok(!text.includes('RACE_OLD')); assert.ok(!text.includes('RACE_MODEL_FACT'));
    });
  }

  // 持久化/导入在独立夹具上执行；合并副本用内容定位，不能依赖旧消息 ID。
  const transfer = await seed('transfer', { group: true });
  await check('JSON导出保留私聊、群聊事实来源及摘要来源', async () => {
    planFact(transfer.marker, 'TRANSFER_PRIVATE'); await summarize(transfer.id);
    planFact(transfer.marker, 'TRANSFER_GROUP'); await summarize(transfer.id, { groupId: transfer.groupId });
    await evaluate(`window.__memoryPack=JSON.parse(await(await s.exportAll([${JSON.stringify(transfer.id)},${JSON.stringify(transfer.other)}])).text());`);
    const row = await evaluate(`return window.__memoryPack.memory.find(m=>m.charId===${JSON.stringify(transfer.id)});`);
    assert.ok(row.factRecords.some((r) => r.sources.some((ref) => ref.kind === 'private')));
    assert.ok(row.factRecords.some((r) => r.sources.some((ref) => ref.kind === 'group')));
    assert.ok(row.summarySources?.length);
  });
  await check('合并导入重映射角色、群和消息ID，来源仍指向副本有效消息', async () => {
    const result = await evaluate(`
      await s.importAll(JSON.parse(JSON.stringify(window.__memoryPack)),{merge:true});
      const char=(await s.listCharacters()).find(c=>c.name==='测试角色_transfer（导入）');
      const mem=await s.getMemory(char.id);
      return{char,memory:mem,details:await Promise.all(mem.factRecords.filter(r=>r.status==='active').map(r=>s.getMemorySource(char.id,r.id)))};`);
    assert.notEqual(result.char.id, transfer.id);
    const refs = active(result.memory).flatMap((r) => r.sources);
    assert.ok(refs.some((ref) => ref.kind === 'private' && ref.conversationId === result.char.id));
    assert.ok(refs.some((ref) => ref.kind === 'group' && ref.conversationId !== transfer.groupId));
    assert.ok(refs.every((ref) => ![transfer.messageId, transfer.groupMessageId].includes(ref.messageId)));
    assert.ok(result.details.flatMap(detailRows).every((ref) => ref.available && !ref.changed));
    assert.ok(facts(result.memory).includes('TRANSFER_PRIVATE')); assert.ok(facts(result.memory).includes('TRANSFER_GROUP'));
  });
  await check('覆盖JSON恢复保留来源，消息恢复后所有引用可核验', async () => {
    const result = await evaluate(`
      await s.importAll(JSON.parse(JSON.stringify(window.__memoryPack)),{merge:false});
      const mem=await s.getMemory(${JSON.stringify(transfer.id)});
      return{memory:mem,details:await Promise.all(mem.factRecords.filter(r=>r.status==='active').map(r=>s.getMemorySource(${JSON.stringify(transfer.id)},r.id)))};`);
    assert.ok(facts(result.memory).includes('TRANSFER_PRIVATE')); assert.ok(facts(result.memory).includes('TRANSFER_GROUP'));
    assert.ok(result.details.flatMap(detailRows).every((ref) => ref.available && !ref.changed));
  });
  await check('浏览器清空后从临时磁盘恢复来源与只含撤回的记忆', async () => {
    const tomb = await seed('tombstone');
    await evaluate(`await s.saveMemory(${JSON.stringify(tomb.id)},{summary:'',facts:['TOMBSTONE_FACT']});
      const mem=await s.getMemory(${JSON.stringify(tomb.id)});await s.retractMemoryFact(${JSON.stringify(tomb.id)},mem.factRecords[0].id);
      const sync=await(await import('./core/filestore.js')).syncNow();if(!sync.ok)throw Error('临时磁盘同步失败');
      await s.wipeLocalOnly();`);
    await page.goto('about:blank'); await wait(() => page.eval('location.href==="about:blank"'));
    await page.goto(origin); await wait(() => page.eval('!!window.__AICHAT__'));
    await installHelpers();
    const mem = await memory(transfer.id);
    assert.ok(facts(mem).includes('TRANSFER_PRIVATE')); assert.ok(facts(mem).includes('TRANSFER_GROUP'));
    for (const record of active(mem)) assert.ok(detailRows(await source(transfer.id, record.id)).every((r) => r.available && !r.changed));
    assert.ok((await memory(tomb.id)).factRecords.some((r) => r.text === 'TOMBSTONE_FACT' && r.status === 'retracted'));
  });

  await check('界面能查看原始来源、纠正和撤回事实', async () => {
    // 操作真实按钮并核对持久层结果。
    await page.goto(origin + '/#/chat/' + transfer.id);
    await wait(() => page.eval(`window.__AICHAT__?.state.currentCharId===${JSON.stringify(transfer.id)}`));
    await evaluate(`(await import('./ui/settings.js')).openSettings('context');`);
    await wait(() => page.eval(`!!document.querySelector('article[data-memory-status="active"] button[aria-label^="查看记忆来源"]')`));
    await page.eval(`document.querySelector('article[data-memory-status="active"] button[aria-label^="查看记忆来源"]').click()`);
    await wait(() => page.eval(`[...document.querySelectorAll('.memory-source-content')].some(n=>n.textContent.includes(${JSON.stringify(transfer.marker)}))`));
    await page.eval(`[...document.querySelectorAll('.modal-foot button')].findLast(b=>b.textContent==='关闭').click()`);
    for(let i=0;i<2;i++)plans.push(()=>JSON.stringify({factIds:[],messageIds:[],retainedFacts:[]}));
    await page.eval(`document.querySelector('[data-memory-write="correct"]').click()`);
    await wait(() => page.eval(`!!document.querySelector('.modal-body textarea')`));
    await page.eval(`(()=>{const input=document.querySelector('.modal-body textarea');input.value='UI_CORRECTED_FACT';input.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.modal-foot button')].findLast(b=>b.textContent==='确定').click()})()`);
    await wait(async () => facts(await memory(transfer.id)).includes('UI_CORRECTED_FACT'));
    const record = active(await memory(transfer.id)).find((r) => r.text === 'UI_CORRECTED_FACT');
    await wait(() => page.eval(`!!document.querySelector('[data-memory-id="${record.id}"] [data-memory-write="retract"]')`));
    await page.eval(`document.querySelector('[data-memory-id="${record.id}"] [data-memory-write="retract"]').click()`);
    await wait(() => page.eval(`!![...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent==='撤回记忆')`));
    await page.eval(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent==='撤回记忆').click()`);
    await wait(async () => (await memory(transfer.id)).factRecords.some((r) => r.id === record.id && r.status === 'retracted'));
    assert.ok(!(await prompt(transfer.id)).includes('UI_CORRECTED_FACT'));
  });
  await check('同义分析延迟返回不覆盖期间的手工修改',async()=>{
    const f=await seed('semantic_race');await evaluate(`await s.saveMemory('${f.id}',{facts:['旧安排']})`);
    const before=await memory(f.id),rid=active(before)[0].id;let release;
    plans.push(()=>new Promise(resolve=>{release=()=>resolve(JSON.stringify({factIds:[],messageIds:[],retainedFacts:[]}))}));
    await evaluate(`window.__correction=(await import('./core/memory-correction.js')).correctRelatedMemoryFacts('${f.id}','${rid}','迟到的新安排').catch(e=>({error:e.code||e.message}));`);
    await wait(()=>release);await evaluate(`await s.correctMemoryFact('${f.id}','${rid}','期间人工修改')`);release();
    const result=await evaluate('return await window.__correction');assert.equal(result.error,'memory_conflict');assert.deepEqual(facts(await memory(f.id)),['期间人工修改']);
  });
  await check('同义分析返回伪造ID时不产生任何修改',async()=>{
    const f=await seed('semantic_bad');await evaluate(`await s.saveMemory('${f.id}',{facts:['应保留的安排']})`);const before=await memory(f.id),rid=active(before)[0].id;
    plans.push(()=>JSON.stringify({factIds:['foreign_fact'],messageIds:[],retainedFacts:[]}));
    const result=await evaluate(`try{await(await import('./core/memory-correction.js')).correctRelatedMemoryFacts('${f.id}','${rid}','错误覆盖');return false}catch{return true}`);
    assert(result);assert.deepEqual(await memory(f.id),before);
  });
  await check('明确清空记录不会遗留事实或撤回记录', async () => {
    await evaluate(`await s.saveMemory(${JSON.stringify(transfer.id)},{summary:'',facts:[],factRecords:[],summarySources:[],summarizedUpTo:0});`);
    const mem = await memory(transfer.id);
    assert.deepEqual(mem.factRecords, []); assert.deepEqual(mem.facts, []); assert.equal(mem.summary, '');
  });
  await check('专项没有额外模型请求或浏览器未捕获异常', () => {
    assert.equal(plans.length, 0); assert.deepEqual(mockErrors, []); assert.deepEqual(page.problems, []);
  });
  }
} catch (error) { failed++; console.error(error.stack || error); }
finally {
  for (const response of pendingResponses) response.destroy();
  if (page) await page.close();
  if (server) { server.kill('SIGKILL'); await new Promise((resolve) => server.exitCode != null ? resolve() : server.once('exit', resolve)); }
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
console.log(`记忆专项：${passed} 通过 / ${failed} 失败（本地假模型 ${calls.length} 次；无真实模型调用）`);
process.exitCode = failed ? 1 : 0;
