#!/usr/bin/env node
/** 零 npm 依赖：启动 Ollama、准备固定 Qwen3 模型，再运行网站。 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { LOCAL_MODEL, LOCAL_BASE_MODEL, LOCAL_BASE_URL } from './core/local-model.js';

const root = import.meta.dirname;
const args = process.argv.slice(2);
const project = path.resolve(root, '..');
const modelDirectory = path.join(project, 'models', 'ollama');
const localOrigin = LOCAL_BASE_URL.replace(/\/v1$/, '');
const env = { ...process.env, OLLAMA_HOST: new URL(localOrigin).host, OLLAMA_MODELS: modelDirectory, OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1' };
let daemon, website, activeCommand, daemonFailure;
let stopping = false;
function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Ollama 会启动独立的推理进程；只终止本次启动的 PID 树，避免留下占用端口/显存的子进程。
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 4000,
    });
  } else child.kill('SIGTERM');
}
function cleanup() {
  stopping = true;
  stopChild(website);
  stopChild(activeCommand);
  stopChild(daemon);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143); });

async function ready() {
  try {
    const response = await fetch(`${localOrigin}/api/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok && typeof (await response.json()).version === 'string';
  } catch { return false; }
}

function run(binary, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, commandArgs, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    activeCommand = child;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (activeCommand === child) activeCommand = null;
      daemonFailure ? reject(daemonFailure) : code === 0 ? resolve() : reject(new Error(`${path.basename(binary)} 执行失败（${signal || code}）`));
    });
  });
}

try {
  const candidates = [path.join(project, 'runtime', 'ollama', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ollama.exe' : 'ollama'),
    process.env.AICHAT_OLLAMA_BIN, 'ollama',
    '/Applications/Ollama.app/Contents/Resources/ollama',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Ollama/ollama.exe')].filter(Boolean);
  const binary = candidates.find((candidate) => {
    if (candidate !== 'ollama' && !existsSync(candidate)) return false;
    return spawnSync(candidate, ['--version'], { env, timeout: 5000, stdio: 'ignore', windowsHide: true }).status === 0;
  });
  if (!binary) throw new Error('尚未安装 Ollama。请从 https://ollama.com/download 安装后重试；也可用 AICHAT_OLLAMA_BIN 指定可执行文件。');

  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`项目模型端口 ${new URL(localOrigin).port} 无法使用或已被占用，请先停止已有的项目启动进程。`)));
    probe.listen(Number(new URL(localOrigin).port), '127.0.0.1', () => probe.close(resolve));
  });
  {
    console.log('启动本机 Ollama（仅监听 127.0.0.1，关闭云模型）…');
    daemon = spawn(binary, ['serve'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    daemon.once('exit', (code, signal) => {
      if (stopping) return;
      daemonFailure = new Error(`本地模型进程意外退出（${signal || code}），请检查上方日志后重新运行启动脚本。`);
      stopChild(activeCommand);
      stopChild(website);
    });
    let spawnError;
    daemon.once('error', (error) => { spawnError = error; });
    let started = false;
    for (let i = 0; i < 40; i++) {
      if (spawnError) throw spawnError;
      if (daemonFailure) throw daemonFailure;
      if (await ready() && daemon.exitCode === null && daemon.signalCode === null) { started = true; break; }
      if (daemon.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!started) throw new Error('Ollama 未能启动，请检查 11435 端口与上方日志。');
  }

  const response = await fetch(`${localOrigin}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`读取已安装模型失败：HTTP ${response.status}`);
  const installed = (await response.json()).models || [];
  if (!installed.some((model) => model.name === LOCAL_BASE_MODEL)) {
    console.log(`首次下载 ${LOCAL_BASE_MODEL}（约 2.5GB，保存到项目 models/ollama）…`);
    await run(binary, ['pull', LOCAL_BASE_MODEL]);
  }
  console.log(`准备 ${LOCAL_MODEL}：16K 上下文，角色提示词由应用提供…`);
  await run(binary, ['create', LOCAL_MODEL, '-f', path.join(root, 'models/Modelfile')]);
  if (daemonFailure) throw daemonFailure;
  if (!args.includes('--setup-only')) {
    console.log(`模型目录：${modelDirectory}`);
    console.log('本地模型已准备完成，所有角色自动使用项目模型。');
    await new Promise((resolve, reject) => {
      website = spawn(process.execPath, [path.join(root, 'server.mjs'), ...args], { cwd: root, env: process.env, stdio: 'inherit' });
      website.once('error', reject);
      website.once('exit', (code) => daemonFailure ? reject(daemonFailure) : code === 0 ? resolve() : reject(new Error(`网站服务退出：${code}`)));
    });
  }
} catch (error) {
  console.error(`本地模型启动失败：${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
