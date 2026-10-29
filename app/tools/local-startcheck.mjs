#!/usr/bin/env node
/** 在中文/空格路径下验证启动目录与进程清理；用假 Ollama，不占用真实模型端口。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
if (process.platform === 'win32') throw new Error('此夹具使用 POSIX 可执行脚本；Windows 需实际运行便携包验收。');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '趣聊 path with spaces-')));
const app = path.join(temp, 'app'); fs.mkdirSync(path.join(app, 'core'), { recursive: true });
fs.mkdirSync(path.join(app, 'models')); fs.writeFileSync(path.join(app, 'models/Modelfile'), 'FROM test\n');
const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const source = path.resolve(import.meta.dirname, '..');
fs.copyFileSync(path.join(source, 'core/util.js'), path.join(app, 'core/util.js'));
fs.copyFileSync(path.join(source, 'local-start.mjs'), path.join(app, 'local-start.mjs'));
fs.writeFileSync(path.join(app, 'core/local-model.js'), fs.readFileSync(path.join(source, 'core/local-model.js'), 'utf8').replace('11435', String(port)));
const bin = path.join(temp, 'fake ollama');
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
if(process.argv[2]==='--version'){console.log('test');process.exit(0)}
const root=path.resolve(process.cwd(),'..');
if(process.argv[2]==='create'){fs.writeFileSync(path.join(root,'created.json'),JSON.stringify({args:process.argv.slice(2),models:process.env.OLLAMA_MODELS,noCloud:process.env.OLLAMA_NO_CLOUD}));process.exit(0)}
if(process.argv[2]!=='serve')throw Error('Unexpected download or command');
fs.writeFileSync(path.join(root,'daemon.pid'),String(process.pid));
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/version'?{version:'test'}:{models:[{name:'qwen3:4b-instruct-2507-q4_K_M'}]}))}).listen(${port},'127.0.0.1');
`, { mode: 0o755 });
fs.writeFileSync(path.join(app, 'server.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(temp,'website.pid'))},String(process.pid));setInterval(()=>{},1000);`);
let child;
const stopped = async pid => {
  for (let i=0;i<100;i++) { try {process.kill(pid,0);} catch {return true;} await new Promise(r=>setTimeout(r,20)); }
  return false;
};
try {
  child = spawn(process.execPath, [path.join(app,'local-start.mjs'),'--setup-only'], { cwd: temp, env: {...process.env,AICHAT_OLLAMA_BIN:bin}, stdio:'ignore' });
  let [code] = await once(child,'exit'); assert.equal(code,0);
  const created = JSON.parse(fs.readFileSync(path.join(temp,'created.json')));
  assert.equal(created.models,path.join(temp,'models','ollama')); assert.equal(created.noCloud,'1');
  assert.equal(created.args[0],'create'); assert.equal(created.args[3],path.join(app,'models','Modelfile'));
  assert.ok(await stopped(Number(fs.readFileSync(path.join(temp,'daemon.pid')))));
  console.log('✓ 中文/空格路径下模型目录正确、禁用云端、只用已安装权重，setup-only 清理模型进程');
  child = spawn(process.execPath,[path.join(app,'local-start.mjs'),'--no-open'],{cwd:temp,env:{...process.env,AICHAT_OLLAMA_BIN:bin},stdio:'ignore'});
  for(let i=0;i<200&&!fs.existsSync(path.join(temp,'website.pid'));i++)await new Promise(r=>setTimeout(r,25));
  assert.ok(fs.existsSync(path.join(temp,'website.pid')),'website did not start');
  const daemonPid=Number(fs.readFileSync(path.join(temp,'daemon.pid'))),webPid=Number(fs.readFileSync(path.join(temp,'website.pid')));
  const done=once(child,'exit');child.kill('SIGTERM');await done;
  assert.ok(await stopped(daemonPid));assert.ok(await stopped(webPid));
  console.log('✓ 正常启动后关闭时清理本次网站和模型进程（macOS 夹具）');
  const occupied = http.createServer((_req,res) => res.writeHead(404).end());
  occupied.listen(port,'127.0.0.1'); await once(occupied,'listening');
  try {
    let log='';
    child=spawn(process.execPath,[path.join(app,'local-start.mjs'),'--setup-only'],{cwd:temp,env:{...process.env,AICHAT_OLLAMA_BIN:bin},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
    const [exit]=await once(child,'exit'); assert.equal(exit,1);assert.match(log,/端口.*占用/);
    console.log('✓ 非 Ollama 程序占用端口时立即拒绝，不复用外部服务');
  } finally { await new Promise(resolve=>occupied.close(resolve)); }
  fs.unlinkSync(path.join(temp,'website.pid'));
  let crashLog='';
  child=spawn(process.execPath,[path.join(app,'local-start.mjs'),'--no-open'],{cwd:temp,env:{...process.env,AICHAT_OLLAMA_BIN:bin},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>crashLog+=d);child.stderr.on('data',d=>crashLog+=d);
  const crashDone=once(child,'exit');
  for(let i=0;i<200&&!fs.existsSync(path.join(temp,'website.pid'));i++)await new Promise(r=>setTimeout(r,25));
  assert.ok(fs.existsSync(path.join(temp,'website.pid')));
  const crashWeb=Number(fs.readFileSync(path.join(temp,'website.pid')));
  process.kill(Number(fs.readFileSync(path.join(temp,'daemon.pid'))),'SIGTERM');
  const [crashCode]=await crashDone;assert.equal(crashCode,1);assert.match(crashLog,/本地模型进程意外退出/);
  assert.ok(await stopped(crashWeb));
  console.log('✓ 模型意外退出时关闭本次网站，明确报错，不留下假在线页面');
} finally {
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
  fs.rmSync(temp,{recursive:true,force:true});
}
