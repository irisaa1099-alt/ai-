#!/usr/bin/env node
/** 群发送跨会话回归：真实 Chrome + 临时数据库；模型仅使用页内假 SSE。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, freePort, sleep } from './cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quliao-group-send-switch-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs', '--host', '127.0.0.1', '--port', String(port), '--no-open', '--data-dir', dir],
  { cwd: root, stdio: 'ignore' });
let page, passed = 0;
async function waitFor(fn) {
  for (let i = 0; i < 150; i++) {
    try { if (await fn()) return; } catch {}
    await sleep(40);
  }
  throw new Error('等待检查条件超时');
}
const evaluate = code => page.eval(`(async()=>{const s=await import('./core/store.js');${code}})()`);
async function setup(name) {
  await evaluate(`
    const a=await s.saveGroup({name:${JSON.stringify(name + ' A')},members:checkCharacters,maxAutoTurns:1,autoDelayMs:0});
    const b=await s.saveGroup({name:${JSON.stringify(name + ' B')},members:checkCharacters,maxAutoTurns:1,autoDelayMs:0});
    await __AICHAT__.ctx.reloadGroups();
    window.checkA=a;window.checkB=b;window.checkRequests=[];
    localStorage.setItem('aichat.groupDraft.'+b.id,'B草稿');
    await __AICHAT__.openGroup(a.id);
  `);
  await sleep(250); // 等本次初始历史加载完成，随后只阻塞指定发送步骤。
}
async function send(text) {
  await evaluate(`const input=document.querySelector('#groupComposerInput');input.value=${JSON.stringify(text)};
    input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#groupSendBtn').click();`);
}
async function gate(mode, abort = false) {
  await evaluate(`window.holdGroupTransaction(${JSON.stringify(mode)},${abort});`);
}
async function held() { await waitFor(() => page.eval('!!window.groupTransactionRelease')); }
async function release() { await page.eval('window.groupTransactionRelease()'); await sleep(500); }
async function snapshot() {
  return evaluate(`return {a:await s.listGroupMessages(checkA.id),b:await s.listGroupMessages(checkB.id),
    input:document.querySelector('#groupComposerInput, #composerInput')?.value,
    requests:checkRequests.length,aDraft:localStorage.getItem('aichat.groupDraft.'+checkA.id),
    bDraft:localStorage.getItem('aichat.groupDraft.'+checkB.id)};`);
}
async function check(name, fn) { await setup(name); await fn(); passed++; console.log('✓ '+name); }

try {
  await waitFor(async () => (await fetch(origin + '/api/health')).ok);
  page = await launch({ port: await freePort() }); await page.goto(origin);
  await waitFor(() => page.eval('!!window.__AICHAT__'));
  await evaluate(`
    s.setSettings({onboarded:true,typedEffect:false,voice:{enabled:false},proactive:{enabled:false},context:{summary:false}});
    document.querySelector('.onboard')?.remove();
    window.checkCharacters=[];
    for(const name of ['群回归甲','群回归乙'])checkCharacters.push((await s.saveCharacter({name,greeting:[]})).id);
    await __AICHAT__.ctx.reloadCharacters();
    const nativeFetch=window.fetch;
    window.fetch=async(url,options)=>{
      if(String(url).includes('/api/llm')){
        checkRequests.push(JSON.parse(options.body));
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:'本群测试回复。'}}]})+'\\n\\ndata: [DONE]\\n\\n',
          {headers:{'Content-Type':'text/event-stream'}});
      }
      return nativeFetch(url,options);
    };
    // 只延迟一个真实 IDB 事务的完成通知；数据仍由实际 store API 写入。
    // 可选择让实际事务 abort，用于验证失败恢复没有覆盖新会话。
    window.holdGroupTransaction=(mode,abort=false)=>{
      window.groupTransactionRelease=null;
      const native=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(names,kind,...rest){
        const tx=native.call(this,names,kind,...rest);
        if(String(names)!=='groupMessages'||kind!==mode)return tx;
        IDBDatabase.prototype.transaction=native;
        const event=abort?'abort':'complete';let callback;
        Object.defineProperty(tx,'on'+event,{configurable:true,get:()=>callback,set:fn=>callback=fn});
        tx.addEventListener(event,e=>{window.groupTransactionRelease=()=>{
          window.groupTransactionRelease=null;callback?.call(tx,e);
        };});
        if(abort){
          const objectStore=tx.objectStore.bind(tx);
          tx.objectStore=(...args)=>{
            const store=objectStore(...args),put=store.put.bind(store);
            store.put=(...values)=>{const req=put(...values);req.addEventListener('success',()=>tx.abort());return req;};
            return store;
          };
        }
        return tx;
      };
    };
  `);

  await check('发送后立即切群：原消息落原群，新群草稿与记录不变', async () => {
    await evaluate(`const input=document.querySelector('#groupComposerInput');input.value='即时切群';
      input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#groupSendBtn').click();
      await __AICHAT__.openGroup(checkB.id);`);
    await sleep(500);
    const r=await snapshot();assert.equal(r.a.length,1);assert.equal(r.a[0].content,'即时切群');
    assert.equal(r.b.length,0);assert.equal(r.input,'B草稿');assert.equal(r.requests,0);
    assert.equal(r.aDraft,null,'成功消息不能在切回原群后再次作为草稿出现');
    await evaluate('await __AICHAT__.openGroup(checkA.id);');
    assert.equal((await snapshot()).input,'');
  });
  await check('成功后清原群草稿，不取消新群正在延迟保存的草稿', async () => {
    await gate('readwrite');await send('成功后清除A草稿');await held();
    await evaluate(`await __AICHAT__.openGroup(checkB.id);const input=document.querySelector('#groupComposerInput');
      input.value='B新输入仍须写草稿';input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await release();const r=await snapshot();assert.equal(r.a.length,1);assert.equal(r.b.length,0);
    assert.equal(r.aDraft,null);assert.equal(r.input,'B新输入仍须写草稿');assert.equal(r.bDraft,r.input);
    assert.equal(r.requests,0);
  });
  await check('写入等待期间 A→B→A：旧发送不清新草稿、不启动回复', async () => {
    await gate('readwrite');await send('写入后返回原群');await held();
    await evaluate(`await __AICHAT__.openGroup(checkB.id);await __AICHAT__.openGroup(checkA.id);
      const input=document.querySelector('#groupComposerInput');input.value='返回A后新写草稿';input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await release();const r=await snapshot();assert.equal(r.a.length,1);assert.equal(r.b.length,0);
    assert.equal(r.input,'返回A后新写草稿');assert.equal(r.aDraft,r.input);assert.equal(r.requests,0);
  });
  await check('消息刷新等待期间切群：不在新群启动回复', async () => {
    await gate('readonly');await send('刷新时切换');await held();
    await evaluate('await __AICHAT__.openGroup(checkB.id);');await release();
    const r=await snapshot();assert.equal(r.a.length,1);assert.equal(r.b.length,0);
    assert.equal(r.input,'B草稿');assert.equal(r.requests,0);
  });
  await check('写入失败后切群：原文留原群草稿，新群输入不被覆盖', async () => {
    await evaluate(`localStorage.setItem('aichat.groupDraft.'+checkA.id,'较早的旧草稿');`);
    await gate('readwrite',true);await send('未保存的原群消息');await held();
    await evaluate(`await __AICHAT__.openGroup(checkB.id);const input=document.querySelector('#groupComposerInput');
      input.value='B正在输入的新草稿';input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await release();const r=await snapshot();assert.equal(r.a.length,0);assert.equal(r.b.length,0);
    assert.equal(r.input,'B正在输入的新草稿');assert.equal(r.bDraft,r.input);
    assert.equal(r.aDraft,'未保存的原群消息');assert.equal(r.requests,0);
  });
  await check('群发送切到私聊：不清私聊草稿、不生成跨会话回复', async () => {
    await gate('readwrite');await send('切换到私聊');await held();
    await evaluate(`localStorage.setItem('aichat.draft.'+checkCharacters[0],'私聊草稿');await __AICHAT__.openChat(checkCharacters[0]);`);
    await release();const r=await snapshot();assert.equal(r.a.length,1);assert.equal(r.input,'私聊草稿');assert.equal(r.requests,0);
  });
  await check('/ooc 保存期间切群：系统消息留原群，新群草稿不清空', async () => {
    await gate('readwrite');await send('/ooc 只属于原群的指令');await held();
    await evaluate('await __AICHAT__.openGroup(checkB.id);');await release();
    const r=await snapshot();assert.equal(r.a.length,1);assert.equal(r.a[0].role,'system');
    assert.equal(r.b.length,0);assert.equal(r.input,'B草稿');assert.equal(r.requests,0);
  });
  await check('/again 读取期间切群：不触发新群发言', async () => {
    await evaluate(`await s.appendGroupMessage({groupId:checkA.id,role:'assistant',speakerId:checkCharacters[0],content:'原群旧回复'});`);
    await sleep(300);await gate('readonly');await send('/again');await held();
    await evaluate('await __AICHAT__.openGroup(checkB.id);');await release();
    const r=await snapshot();assert.equal(r.a.length,1);assert.equal(r.b.length,0);assert.equal(r.input,'B草稿');assert.equal(r.requests,0);
  });
  await check('不切群的正常发送仍生成回复、清空已发送草稿', async () => {
    await send('同群正常消息');
    await waitFor(async () => (await snapshot()).a.some(m=>m.role==='assistant'));
    const r=await snapshot();assert.equal(r.a[0].content,'同群正常消息');assert.equal(r.a.length,2);
    assert.equal(r.requests,1);assert.equal(r.input,'');assert.equal(r.aDraft,null);
  });
  await check('不切群的写入失败仍保留输入与草稿', async () => {
    await gate('readwrite',true);await send('当前群保存失败');await held();await release();
    const r=await snapshot();assert.equal(r.a.length,0);assert.equal(r.input,'当前群保存失败');
    assert.equal(r.aDraft,r.input);assert.equal(r.requests,0);
  });
  await check('/clear 的确认与输入清理仍正常', async () => {
    await evaluate(`await s.appendGroupMessage({groupId:checkA.id,role:'user',content:'待清空的测试消息'});`);
    await send('/clear');
    await waitFor(()=>page.eval(`Array.from(document.querySelectorAll('.modal-foot button')).some(b=>b.textContent.trim()==='清空')`));
    await page.eval(`Array.from(document.querySelectorAll('.modal-foot button')).find(b=>b.textContent.trim()==='清空').click()`);
    await waitFor(async()=>{const r=await snapshot();return r.a.length===0&&r.input==='';});
    const r=await snapshot();assert.equal(r.requests,0);assert.equal(r.aDraft,null);
  });
  assert.deepEqual(page.problems,[]);
  console.log(`群发送切换回归：${passed} 通过 / 0 失败`);
} finally {
  await page?.close();child.kill();fs.rmSync(dir,{recursive:true,force:true});
}
