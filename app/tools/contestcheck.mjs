/** Contest regressions. Only synthetic data in temporary directories. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {launch,freePort,sleep} from './cdp.mjs';
import {buildMessages} from '../core/prompt.js';
import {estimateTokens} from '../core/util.js';
const root=path.resolve(import.meta.dirname,'..');
let passed=0;
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`)}
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'quliao-contest-'));
const env={...process.env};for(const k of Object.keys(env))if(/API_KEY|AICHAT|^HOST$|^PORT$/.test(k))delete env[k];
async function wait(fn){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await sleep(50)}throw Error('timeout')}
await check('long persona preserves relevant facts, custom rules and exact sent-budget accounting',()=>{
 for(const budget of [400,1000,4000,8000]){
  const char={id:'c_test',name:'测试',persona:{personality:'喜欢星空。'.repeat(5000)},systemPrompt:'CUSTOM_RULE',examples:[{user:'示例'.repeat(500),ai:'回答'.repeat(500)}]};
  const out=buildMessages(char,[{role:'user',content:'集合地点？'}],{runtime:{},settings:{context:{affinity:false,timeAware:false}},budgetTokens:budget,memory:{summary:'以前讨论过阅读',facts:['集合地点是蓝鲸书屋。']}});
  const actual=out.messages.reduce((n,m)=>n+estimateTokens(m.content),0);
  assert.equal(actual,out.meta.total);assert.ok(actual<=budget);
  assert.equal(out.meta.breakdown.reduce((n,b)=>n+b.tokens,0),actual);
  if(budget>=1000){assert.ok(out.messages[0].content.includes('蓝鲸书屋'));assert.ok(out.messages[0].content.includes('CUSTOM_RULE'));assert.ok(out.messages[0].content.includes('行为准则'));}
 }
});
await check('old generateReply completion cannot clear a newer request busy state',async()=>{
 const code=fs.readFileSync(path.join(root,'ui/chat.js'),'utf8');
 const start=code.indexOf('async function generateReply('),end=code.indexOf('\n/**',start);
 assert.ok(start>=0);
 const fn=code.slice(start,end);
 let release;const stalled=new Promise(r=>release=r);
 const state={};const context=vm.createContext({console,Promise,AbortController,
   busy:false,activeGeneration:null,stream:null,listEl:{appendChild(){}},
   curChar:()=>({id:'c_test',name:'测试'}),curSettings:()=>({provider:'ollama',model:'test'}),curId:()=> 'c_test',
   ctxRef:{settings:{provider:'ollama',model:'test'}},getSettings:()=>({provider:'ollama',model:'test'}),
   PROVIDERS:{ollama:{needKey:false}},updateSendBtn(){},createStreamState:()=>({node:{}}),isNearBottom:()=>false,
   startSpeech(){},getMemory:()=>stalled,getRecentExperiences:async()=>[],listMessages:async()=>[],
   cancelTyping(){},removeStreamNode(){},num:(v,d)=>Number.isFinite(v)?v:d,
   toast(){},appendLocalNotice(){},state,
 });
 vm.runInContext(fn+'\nglobalThis.invoke=generateReply;',context);
 // Derive signature from implementation; only the asynchronous ownership path is exercised.
 const pending=vm.runInContext("invoke({mode:'new',charId:'c_test',userText:'hi'})",context);
 await sleep(10);
 const newer={};context.activeGeneration=newer;context.stream=newer;context.busy=true;
 release({});await pending;
 assert.equal(context.busy,true);assert.equal(context.activeGeneration,newer);
});
await check('disabling proactive cancels in-flight reply before persistence and notifications',async()=>{
 let code=fs.readFileSync(path.join(root,'core/proactive.js'),'utf8').replace(/^import[\s\S]*?;\n/gm,'').replace(/export /g,'').replace(/\{ pick \};/,'');
 let finish;const pending=new Promise(r=>finish=r);let writes=0,events=0;
 const ctx={settings:{proactive:{enabled:true},context:{},params:{}}};
 const c=vm.createContext({console,AbortController,Set,Date,Math,setTimeout,clearTimeout,setInterval,clearInterval,
  bus:{emit(){events++}},getRuntime:()=>({}),inQuietHours:()=>false,canProactiveToday:()=>true,
  listMessages:async()=>[],getMemory:async()=>({}),getRecentExperiences:async()=>[],timeContext:()=>({}),
  buildMessages:()=>({messages:[]}),num:(v,d)=>v??d,chatStream:()=>pending,appendMessage:async()=>writes++,
  addUnread(){},noteProactive(){},summarizeIfNeeded(){},pick(){},ctx});
 vm.runInContext(code,c);const job=vm.runInContext("maybeTrigger({id:'c_test'},ctx)",c);
 await sleep(10);ctx.settings.proactive.enabled=false;vm.runInContext('stopProactive()',c);finish({text:'should not be saved'});assert.equal(await job,false);assert.equal(writes,0);assert.equal(events,0);
});
const app=path.join(scratch,'app');fs.mkdirSync(app);
for(const name of ['server.mjs','core','ui','voice','styles','data/models.js','data/templates.js','index.html','icon.svg','sw.js','manifest.webmanifest']){const dest=path.join(app,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(path.join(root,name),dest,{recursive:true});}
const data=path.join(app,'data/db');fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({onboarded:true,marker:'SYNTHETIC'}));
const port=await freePort(),origin=`http://127.0.0.1:${port}`;
let server,page;
function start(extra=[]){const p=spawn(process.execPath,['server.mjs','--no-open','--host','127.0.0.1','--port',String(port),...extra],{cwd:app,env,stdio:['ignore','pipe','pipe']});p.stdout.resume();p.stderr.resume();return p;}
try{
 server=start();await wait(async()=> (await fetch(origin+'/api/health')).ok);
 await check('mixed-case, encoded, symlink and rebinding paths are denied',async()=>{
  fs.symlinkSync(data,path.join(app,'shortcut'));
  for(const url of ['/DATA/DB/settings.json','/DaTa/%64b/settings.json','/shortcut/settings.json','/TOOLS/cdp.mjs'])assert.equal((await fetch(origin+url)).status,403,url);
  for(const headers of [{Host:'review.invalid',Origin:'http://review.invalid'},{Host:`review.invalid:${port}`},{Origin:'http://localhost:1234'},{'Sec-Fetch-Site':'cross-site'}]){const status=await new Promise((resolve,reject)=>{const r=http.get(origin+'/api/db/state',{headers},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject)});assert.equal(status,403,JSON.stringify(headers));}
  assert.equal((await fetch(origin+'/data/models.js')).status,200);
 });
 page=await launch({port:await freePort()});await page.goto(origin);await wait(()=>page.eval('!!window.__AICHAT__'));
 await check('syncNow keeps concurrent new messages and newer remote fields',async()=>{
  const result=await page.eval(`(async()=>{const s=await import('./core/store.js'),f=await import('./core/filestore.js');await s.saveCharacter({id:'c_test',name:'甲',greeting:[]});await f.syncNow();
   await fetch('/api/db/characters/c_test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base:await s.getCharacter('c_test'),data:{...(await s.getCharacter('c_test')),name:'远端新名'}})});
   const jobs=[f.syncNow()];for(let i=0;i<20;i++)jobs.push(s.appendMessage({id:'m_'+i,charId:'c_test',role:'user',content:'并发'+i}));await Promise.all(jobs);await f.syncNow();
   return {msgs:(await(await fetch('/api/db/messages/c_test')).json()).messages.length,name:(await(await fetch('/api/db/characters/c_test')).json()).data.name};})()`);
  assert.equal(result.msgs,20);assert.equal(result.name,'远端新名');
 });
 await page.close();page=null;server.kill();await once(server,'exit');server=null;
 const original=fs.readFileSync(path.join(data,'characters/c_test.json'),'utf8');
 await check('invalid CLI backup fails before changing existing records',async()=>{
  const bad=path.join(scratch,'bad.json');fs.writeFileSync(bad,JSON.stringify({characters:[{id:'replacement'}],messages:[{id:'m',charId:'../bad'}]}));
  const proc=start(['--restore',bad]);const [exit]=await once(proc,'exit');assert.equal(exit,1);assert.equal(fs.readFileSync(path.join(data,'characters/c_test.json'),'utf8'),original);
 });
 await check('valid CLI backup restores messages, groups and tombstones together',async()=>{
  const good=path.join(scratch,'good.json');fs.writeFileSync(good,JSON.stringify({characters:[{id:'c_new',name:'新'}],messages:[{id:'m_new',charId:'c_new',content:'恢复'}],groups:[{id:'g_new'}],groupMessages:[{id:'gm_new',groupId:'g_new',content:'群记录'}],deleted:[{id:'c_old',kind:'character'},{id:'g_old',kind:'group'}]}));
  server=start(['--restore',good]);await wait(async()=> (await fetch(origin+'/api/health')).ok);
  assert.ok(fs.readFileSync(path.join(data,'groupmsgs/g_new.ndjson'),'utf8').includes('群记录'));
  assert.ok(fs.existsSync(path.join(data,'deleted/g-g_old.json')));assert.ok(!fs.existsSync(path.join(data,'characters/c_test.json')));
 });
}finally{await page?.close();if(server){server.kill();await once(server,'exit');}fs.rmSync(scratch,{recursive:true,force:true});}
console.log(JSON.stringify({passed,failed:0}));
