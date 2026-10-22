import fs from 'node:fs';import os from 'node:os';import assert from 'node:assert/strict';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';
import {launch,freePort,sleep} from './cdp.mjs';
const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aichat-multiclient-')),port=await freePort(),origin=`http://127.0.0.1:${port}`;const results=[];
const env={...process.env};for(const k of Object.keys(env))if(/API_KEY|AICHAT|^HOST$|^PORT$/.test(k))delete env[k];
const server=spawn(process.execPath,['server.mjs','--no-open','--host','127.0.0.1','--port',String(port),'--data-dir',dir],{cwd:root,env,stdio:['ignore','pipe','pipe']});server.stdout.resume();server.stderr.resume();let p,q;
async function wait(fn){let t=Date.now();while(Date.now()-t<10000){try{const v=await fn();if(v)return v;}catch{}await sleep(100)}throw Error('timeout')}
async function check(name,fn){if(!name.startsWith("多浏览器"))return;try{const r=await fn();if(r.afterB)assert.deepEqual(r.afterB,{c_test1:80,c_test2:70});if(r.actualName)assert.equal(r.actualName,r.expectedName);results.push({name,result:r});console.log(JSON.stringify({name,result:r}))}catch(e){results.push({name,error:e.message});console.log(JSON.stringify({name,error:e.message}))}}
async function post(url,body){const r=await fetch(origin+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}}
try{
await wait(async()=> (await fetch(origin+'/api/health')).ok);
await post('/api/db/characters/c_test1',{data:{id:'c_test1',name:'甲',greeting:[]}});await post('/api/db/characters/c_test2',{data:{id:'c_test2',name:'乙',greeting:[]}});
await post('/api/db/settings',{data:{settings:{onboarded:true,voice:{enabled:false},proactive:{enabled:false}},runtime:{c_test1:{affinity:20,updatedAt:1},c_test2:{affinity:20,updatedAt:1}}}});
p=await launch({port:await freePort(),width:1440,height:900});q=await launch({port:await freePort(),width:1440,height:900});for(const page of[p,q]){await page.goto(origin);await wait(()=>page.eval('!!window.__AICHAT__'))}await sleep(1000);
await check('多浏览器运行时更新不互相覆盖',async()=>{
 await p.eval(`(async()=>{const r=await import('./core/runtime.js');r.setRuntime('c_test1',{affinity:80})})()`);await sleep(900);
 const first=(await(await fetch(origin+'/api/db/settings')).json()).runtime;
 await q.eval(`(async()=>{const r=await import('./core/runtime.js');r.setRuntime('c_test2',{affinity:70})})()`);await sleep(900);
 const second=(await(await fetch(origin+'/api/db/settings')).json()).runtime;return{afterA:{c_test1:first.c_test1.affinity,c_test2:first.c_test2.affinity},afterB:{c_test1:second.c_test1.affinity,c_test2:second.c_test2.affinity}};
});
await check('多浏览器设置更新不互相覆盖',async()=>{
 await p.eval(`(async()=>{const s=await import('./core/store.js');s.setSettings({user:{name:'设备A的新昵称'}})})()`);await sleep(900);
 await q.eval(`(async()=>{const s=await import('./core/store.js');s.setSettings({theme:'light'})})()`);await sleep(900);
 const settings=(await(await fetch(origin+'/api/db/settings')).json()).settings;return{expectedName:'设备A的新昵称',actualName:settings.user?.name,theme:settings.theme};
});
await check('多浏览器同一角色不同字段不互相覆盖',async()=>{
 await q.eval(`(async()=>{const r=await import('./core/runtime.js');r.setRuntime('c_test1',{unread:7})})()`);await sleep(900);
 const rt=(await(await fetch(origin+'/api/db/settings')).json()).runtime.c_test1;
 assert.equal(rt.affinity,80);assert.equal(rt.unread,7);return rt;
});
}finally{if(p)await p.close();if(q)await q.close();server.kill('SIGTERM');if(results.some(r=>r.error))process.exitCode=1}
