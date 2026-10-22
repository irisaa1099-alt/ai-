import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {launch,freePort,sleep} from './cdp.mjs';
const root=path.resolve(import.meta.dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aichat-regression-'));
const port=await freePort(),modelPort=await freePort(),origin=`http://127.0.0.1:${port}`;
let calls=[],ttsFinished=0,ttsCancelled=0;
const mock=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  let text='';for await(const c of req)text+=c;
  let payload={};try{payload=JSON.parse(text)}catch{}
  calls.push({url:req.url,body:payload});
  if(req.url.includes('/audio/speech')){
    res.on('close',()=>{if(!res.writableEnded)ttsCancelled++});
    await sleep(1300);ttsFinished++;res.writeHead(200,{'Content-Type':'audio/mpeg'});res.end(Buffer.alloc(64));return;
  }
  if(payload.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'测试回复完成。'}}]})+'\n\n');if(req.url.startsWith('/error'))res.write('data: '+JSON.stringify({error:{message:'simulated upstream failure'}})+'\n\n');res.end('data: [DONE]\n\n');}
  else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'{"summary":"摘要","facts":[]}'}}]}));}
});
await new Promise(r=>mock.listen(modelPort,'127.0.0.1',r));
const env={...process.env};for(const key of Object.keys(env))if(/API_KEY|AICHAT|^PORT$|^HOST$/.test(key))delete env[key];
const server=spawn(process.execPath,['server.mjs','--port',String(port),'--host','127.0.0.1','--no-open','--data-dir',dataDir],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let serverLog='';server.stdout.on('data',c=>serverLog+=c);server.stderr.on('data',c=>serverLog+=c);
let page;const results=[];
async function wait(fn,ms=12000){const start=Date.now();while(Date.now()-start<ms){try{const r=await fn();if(r)return r;}catch{}await sleep(100);}throw Error('wait timeout');}
async function check(name,fn){try{const result=await fn();verify(name,result);results.push({name,result});console.log(JSON.stringify({name,result}));}catch(e){results.push({name,error:e.message});console.log(JSON.stringify({name,error:e.message}));}}
async function reload(url){await page.goto('about:blank');await wait(()=>page.eval('location.href==="about:blank"'));await page.goto(url);await wait(()=>page.eval('!!window.__AICHAT__'));}
async function post(route,body){const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
function verify(name,r){
 if(name.includes('IndexedDB')){assert.equal(r.rejected,true);assert.equal(r.exists,false)}
 else if(name.includes('未同步')){assert.equal(r.after.length,2);assert.equal(r.after.find(c=>c.id==='c_base').name,'浏览器新版')}
 else if(name.includes('自动摘要')){assert.ok(r.summaryCalls>0);assert.ok(r.memory.summary)}
 else if(name.includes('SSE'))assert.equal(r.threw,true);
 else if(name.includes('旧失败'))assert.deepEqual(r,['u_old','a_error','u_new','a_new']);
 else if(name.includes('TTS'))assert.ok(r.upstreamCancelled>0);
 else if(name.includes('磁盘读取'))assert.equal(r.status,500);
 else if(name.includes('PWA'))assert.ok(r.shell&&r.chat&&r.controller);
 else if(name.includes('移动端'))assert.ok(r.width===r.scrollWidth&&r.restore);
 else if(name.includes('畸形'))assert.equal(r.bootError,'');
}
try{
  await wait(async()=>{try{return(await fetch(origin+'/api/health')).ok}catch{return false}});
  page=await launch({port:await freePort(),width:1440,height:900});await page.goto(origin);
  await wait(()=>page.eval('!!window.__AICHAT__'));
  await page.eval(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('直接跳过'))?.click()})()`);
  await page.eval(`(async()=>{const s=await import('./core/store.js');s.setSettings({onboarded:true,provider:'ollama',model:'mock',baseUrls:{ollama:'http://127.0.0.1:${modelPort}/v1'},voice:{enabled:false},typedEffect:false,proactive:{enabled:false},context:{summary:true,maxMessages:4,summaryKeep:2}});await s.saveCharacter({id:'c_base',name:'磁盘旧版',greeting:[]});})()`);await sleep(1100);
  await check('IndexedDB事务回滚必须拒绝',()=>page.eval(`(async()=>{const s=await import('./core/store.js');let rejected=false;try{await s.idb('characters','readwrite',os=>{const req=os.put({id:'c_abort',name:'不会提交'});req.addEventListener('success',()=>os.transaction.abort());return req;});}catch{rejected=true;}await new Promise(r=>setTimeout(r,50));return {rejected,exists:!!await s.getCharacter('c_abort')};})()`));
  await check('批量事务没有返回request时也等待回滚',async()=>{
    const r=await page.eval(`(async()=>{const s=await import('./core/store.js');let rejected=false;try{await s.idb('characters','readwrite',os=>{const req=os.put({id:'c_bulkabort',name:'批量失败'});req.onsuccess=()=>os.transaction.abort();})}catch{rejected=true}return{rejected,exists:!!await s.getCharacter('c_bulkabort')}})()`);
    assert.equal(r.rejected,true);assert.equal(r.exists,false);return r;
  });
  await check('未同步角色重启后保留',async()=>{
    const before=await page.eval(`(async()=>{const s=await import('./core/store.js');window.savedFetch=window.fetch;window.fetch=(u,o)=>String(u).startsWith('/api/db/')&&o?.method!=='GET'?Promise.reject(new Error('模拟断网')):window.savedFetch(u,o);await s.saveCharacter({id:'c_base',name:'浏览器新版',greeting:[]});await s.saveCharacter({id:'c_unsynced',name:'未同步新角色',greeting:[]});const list=await s.listCharacters();window.fetch=window.savedFetch;return list.map(c=>({id:c.id,name:c.name}));})()`);
    await sleep(400);await reload(origin+'/#/chat/c_base');await wait(()=>page.eval('!!document.querySelector("#composerInput")'));await sleep(500);
    const after=await page.eval(`(async()=>{const s=await import('./core/store.js');return(await s.listCharacters()).map(c=>({id:c.id,name:c.name}));})()`);return{before,after};
  });
  await check('自动摘要真实聊天触发检查',async()=>{
    await page.eval(`(async()=>{const s=await import('./core/store.js');for(let i=0;i<14;i++)await s.appendMessage({charId:'c_base',role:i%2?'assistant':'user',content:'这是第'+i+'条历史消息，包含需要长期记忆的重要事件。',at:Date.now()-20000+i});await import('./ui/chat.js').then(m=>m.refreshMessages());})()`);
    calls=[];await page.eval(`(()=>{const i=document.querySelector('#composerInput');i.value='请继续聊天';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sendBtn').click();})()`);
    await wait(()=>calls.length>0);await wait(()=>page.eval(`!document.querySelector('#sendBtn.stop')`));await sleep(1000);
    const mem=await page.eval(`(async()=>{const s=await import('./core/store.js');return await s.getMemory('c_base')})()`);return {modelCalls:calls.length,summaryCalls:calls.filter(c=>JSON.stringify(c.body).includes('记忆整理助手')).length,memory:mem};
  });
  await check('真实浏览器SSE错误正常上报',()=>page.eval(`(async()=>{const llm=await import('./core/llm.js');try{const r=await llm.chatStream({provider:'ollama',model:'mock',baseUrl:'http://127.0.0.1:${modelPort}/error',useProxy:false,messages:[{role:'user',content:'测试'}]});return {threw:false,text:r.text};}catch(e){return{threw:true,error:e.message}}})()`));
  await check('旧失败消息重试后排序',async()=>{
    await page.eval(`(async()=>{const s=await import('./core/store.js');await s.clearMessages('c_base');for(const m of [{id:'u_old',role:'user',content:'旧问题',at:1},{id:'a_error',role:'assistant',content:'',status:'error',error:'失败',at:2},{id:'u_new',role:'user',content:'新问题',at:3},{id:'a_new',role:'assistant',content:'新问题的回复',at:4}])await s.appendMessage({...m,charId:'c_base'});await import('./ui/chat.js').then(m=>m.refreshMessages());})()`);
    await page.eval(`document.querySelector('[data-mid="a_error"] .retry-btn').click()`);await wait(()=>page.eval(`(async()=>{const s=await import('./core/store.js');return(await s.getMessage('a_error')).status==='done'})()`));
    return page.eval(`(async()=>{const s=await import('./core/store.js');return(await s.listMessages('c_base')).map(m=>m.id)})()`);
  });
  await check('TTS取消向上游传播',async()=>{
    const ctl=new AbortController();const p=fetch(origin+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'ollama',text:'测试取消',baseUrl:`http://127.0.0.1:${modelPort}/v1`}),signal:ctl.signal}).catch(()=>null);
    await wait(()=>calls.some(c=>c.url.includes('/audio/speech')));ctl.abort();await p;await sleep(1550);return{upstreamCompleted:ttsFinished,upstreamCancelled:ttsCancelled};
  });
  await check('磁盘读取异常返回错误',async()=>{
    const f=path.join(dataDir,'messages','c_broken.ndjson');fs.mkdirSync(f);try{const r=await fetch(origin+'/api/db/messages/c_broken');return{status:r.status,body:await r.json()};}finally{fs.rmdirSync(f);}
  });
  await check('启动探测离线后清空仍然保留数据',async()=>{
    const r=await page.eval(`(async()=>{const s=await import('./core/store.js'),f=await import('./core/filestore.js');const before=(await s.listCharacters()).length;const original=window.fetch;try{window.fetch=()=>Promise.reject(new Error('模拟离线'));await f.available(true);const result=await s.wipeAll();return{before,after:(await s.listCharacters()).length,result}}finally{window.fetch=original;await f.available(true)}})()`);
    assert.equal(r.result.ok,false);assert.equal(r.before,r.after);return r;
  });
  await check('无效备份必须在清空前拒绝',async()=>{
    const r=await post('/api/db/replace',{characters:[null]});assert.equal(r.status,400);
    const count=await page.eval(`(async()=>{const s=await import('./core/store.js');const before=(await s.listCharacters()).length;let rejected=false;try{await s.importAll({}, {merge:false})}catch{rejected=true}return{before,after:(await s.listCharacters()).length,rejected}})()`);
    assert.equal(count.rejected,true);assert.equal(count.before,count.after);return count;
  });
  await check('安全快照失败时两份数据库都保留',async()=>{
    const blocked=[];
    for(let i=0;i<10;i++){const stamp=new Date(Date.now()+i*1000).toISOString().replace(/[:.]/g,'-').slice(0,19);const f=path.join(dataDir,`safety-before-wipe-${stamp}.json`);fs.mkdirSync(f,{recursive:true});blocked.push(f)}
    try{
      const local=await page.eval(`(async()=>{const s=await import('./core/store.js');const before=(await s.listCharacters()).length;const result=await s.wipeAll();return{before,after:(await s.listCharacters()).length,result}})()`);
      assert.equal(local.result.ok,false);assert.equal(local.after,local.before);
      const remote=await(await fetch(origin+'/api/db/state')).json();assert.equal(remote.characters.length,local.before);return local;
    }finally{for(const f of blocked)fs.rmdirSync(f)}
  });
  await check('摘要只推进实际处理的记录',async()=>{
    const r=await page.eval(`(async()=>{const s=await import('./core/store.js'),p=await import('./core/prompt.js');await s.saveMemory('c_base',{summary:'',facts:[]});const character=await s.getCharacter('c_base');const history=Array.from({length:100},(_,i)=>({id:'m_batch_'+i,charId:'c_base',at:1000+i,role:'user',content:'重要事件'.repeat(150)}));await s.putMessagesLocal(history);await p.summarizeIfNeeded(character,history,{settings:s.getSettings(),force:true});return s.getMemory('c_base')})()`);
    assert.ok(r.summarizedUpTo<1097);assert.ok(r.summarizedUpTo>=1000);assert.ok(r.summaryCursors.private.id);return r;
  });
  await check('日期、提示词预算、世界书和语音缓存',async()=>{
    const r=await page.eval(`(async()=>{const u=await import('./core/util.js'),p=await import('./core/prompt.js'),g=await import('./core/group.js'),v=await import('./voice/tts.js');const character={id:'c_base',name:'测试',examples:[{user:'你'.repeat(2000),ai:'我'.repeat(2000)}],lorebook:[{keys:['暗号'],content:'隐藏事实',enabled:true}]};const built=p.buildMessages(character,[{role:'user',content:'测试',quoted:{content:'引用'.repeat(60)}}],{budgetTokens:1000,settings:{},runtime:{}});const group=g.buildGroupMessages({speaker:character,members:[character],group:{},history:[{role:'user',speakerId:'user',content:'暗号'}],settings:{},runtime:{}});return{old:u.fmtDay(new Date(2020,0,1).getTime()),yesterday:u.fmtDay(Date.now()-86400000),tokens:built.messages.reduce((n,m)=>n+u.estimateTokens(m.content),0),lore:JSON.stringify(group.messages).includes('隐藏事实'),keys:[v.cacheKey('你好',{provider:'x',model:'a'}),v.cacheKey('你好',{provider:'x',model:'b'})]}})()`);
    assert.notEqual(r.old,'今天');assert.equal(r.yesterday,'昨天');assert.ok(r.tokens<=1000);assert.equal(r.lore,true);assert.notEqual(...r.keys);return r;
  });
  await check('摘要进度跨调用持久化且不同会话互不跳过',async()=>{
    const r=await page.eval(`(async()=>{const s=await import('./core/store.js'),p=await import('./core/prompt.js');const character=await s.getCharacter('c_base');const history=Array.from({length:100},(_,i)=>({id:'m_batch_'+i,charId:'c_base',at:1000+i,role:'user',content:'重要事件'.repeat(150)}));await s.putMessagesLocal(history);const before=await s.getMemory('c_base');await p.summarizeIfNeeded(character,history,{settings:s.getSettings(),force:true});const second=await s.getMemory('c_base');const groupHistory=history.map(m=>({...m,id:'gm_'+m.id,groupId:'g_test',charId:'g_test',speakerId:'user',audienceIds:['c_base']}));await s.putGroupLocal({id:'g_test',name:'摘要来源测试',members:['c_base']});await s.putGroupMessagesLocal(groupHistory);await p.summarizeIfNeeded(character,groupHistory,{settings:s.getSettings(),source:'group:g_test',force:true});const third=await s.getMemory('c_base');return{before,second,third}})()`);
    assert.ok(r.second.summarizedUpTo>r.before.summarizedUpTo);
    assert.equal(r.third.summarizedUpTo,r.second.summarizedUpTo);
    assert.equal(r.third.summaryCursors['group:g_test'].at,r.before.summarizedUpTo);return{private:r.second.summarizedUpTo,group:r.third.summaryCursors['group:g_test'].at};
  });
  await check('合并导入群组状态跟随新ID',async()=>{
    const r=await page.eval(`(async()=>{const s=await import('./core/store.js'),r=await import('./core/runtime.js');await s.saveGroup({id:'g_original',name:'原群',members:[]});r.setRuntime('g_original',{unread:3});await s.importAll({characters:[],groups:[{id:'g_original',name:'导入群',members:[]}],runtime:{g_original:{unread:9}}},{merge:true});const fresh=(await s.listGroups()).find(g=>g.name.startsWith('导入群'));return{old:r.getRuntime('g_original').unread,new:r.getRuntime(fresh.id).unread}})()`);
    assert.deepEqual(r,{old:3,new:9});return r;
  });
  await check('狼人杀实际请求使用角色独立模型',async()=>{
    calls=[];
    const state=await page.eval(`(async()=>{const w=await import('./core/werewolf.js');const members=Array.from({length:5},(_,i)=>({id:'c_player'+i,name:'玩家'+i,model:{provider:'ollama',model:'role-model'}}));const game=new w.WerewolfGame({members,group:{id:'g_game'},settings:{provider:'ollama',model:'global-model',baseUrls:{ollama:'http://127.0.0.1:${modelPort}/v1'}}});const player=game.state.players.find(p=>!p.isUser);await game.askLLM(player,'请选择一个目标','night');return player.model})()`);
    assert.equal(state.model,'role-model');assert.equal(calls[0].body.model,'role-model');return state;
  });
  await check('桌面标题保持单行',async()=>{
    const r=await page.eval(`(()=>{const h=document.querySelector('.side-title h1 span'),range=document.createRange();range.selectNodeContents(h);return{lines:range.getClientRects().length,viewport:innerWidth}})()`);
    assert.equal(r.lines,1);return r;
  });
  await check('环境文件端口生效且只有设置也能恢复',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aichat-env-')),envPort=await freePort();
    fs.mkdirSync(path.join(dir,'core'));fs.copyFileSync(path.join(root,'server.mjs'),path.join(dir,'server.mjs'));
    for(const file of ['sync.js','entity-sync.js'])fs.copyFileSync(path.join(root,'core',file),path.join(dir,'core',file));
    fs.writeFileSync(path.join(dir,'.env'),`PORT=${envPort}\nHOST=127.0.0.1\n`);
    const child=spawn(process.execPath,['server.mjs','--no-open','--data-dir',path.join(dir,'db')],{cwd:dir,env,stdio:'ignore'});
    try{await wait(async()=> (await fetch(`http://127.0.0.1:${envPort}/api/health`)).ok)}finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}}
    // Use a fresh browser origin for the settings-only recovery case.
    const data=path.join(dir,'only-settings');fs.mkdirSync(data);fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({onboarded:true,user:{name:'磁盘昵称'},proactive:{enabled:false}}));
    const child2=spawn(process.execPath,['server.mjs','--no-open','--host','127.0.0.1','--port',String(envPort),'--data-dir',data],{cwd:root,env,stdio:'ignore'});let other;
    try{await wait(async()=> (await fetch(`http://127.0.0.1:${envPort}/api/health`)).ok);other=await launch({port:await freePort()});await other.goto(`http://127.0.0.1:${envPort}`);await wait(()=>other.eval('!!window.__AICHAT__'));const name=await other.eval(`(async()=> (await import('./core/store.js')).getSettings().user.name)()`);assert.equal(name,'磁盘昵称');return{port:envPort,name};}
    finally{if(other)await other.close();child2.kill('SIGTERM')}
  });
  await check('PWA离线刷新',async()=>{
    await page.eval(`navigator.serviceWorker.ready`);await sleep(1000);
    await page.client.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0},page.sessionId);
    await reload(origin+'/#/chat/c_base');await wait(()=>page.eval('!!document.querySelector("#composerInput")'));
    const state=await page.eval(`({shell:!!document.querySelector('.shell'),chat:!!document.querySelector('#composerInput'),controller:!!navigator.serviceWorker.controller})`);
    await page.client.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1},page.sessionId);return state;
  });
  await check('移动端收起面板恢复入口',async()=>{
    await page.client.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},page.sessionId);
    await reload(origin+'/#/chat/c_base');await wait(()=>page.eval('!!document.querySelector("#composerInput")'));await sleep(400);
    const out=await page.eval(`(()=>{const ctx=window.__AICHAT__.ctx;if(ctx?.toggleChatHead)ctx.toggleChatHead();const shell=document.querySelector('.shell');const rect=shell.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,shellWidth:rect.width,restore:!!document.querySelector('.head-restore')};})()`);return out;
  });
  await page.client.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false},page.sessionId);await sleep(250);
  await check('畸形路由恢复能力',async()=>{page.problems.length=0;await page.goto('about:blank');await sleep(150);await page.goto(origin+'/#/chat/%');await sleep(1000);return{errors:page.problems,bootError:await page.eval(`document.querySelector('#boot-error')?.innerText||''`)}});
}finally{
  console.log(`回归：${results.filter(r=>!r.error).length} 通过 / ${results.filter(r=>r.error).length} 失败`);
  if(results.some(r=>r.error))process.exitCode=1;
  if(page)await page.close();server.kill('SIGTERM');mock.closeAllConnections();await new Promise(r=>mock.close(r));
}
