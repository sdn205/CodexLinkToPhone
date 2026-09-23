import { proxyExe, fixtureEnvironment } from '../fixtures/native-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { WebSocket } from 'ws';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../proxy');
const root = path.resolve(project, '..');
const out = path.join(root, 'tests/build/verification', String(Date.now()));
await fs.mkdir(out, { recursive: true });
const native = proxyExe;
const fake = path.join(root, 'tests/build/bin/FakeCodex/release/fake-codex.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(20); }
  throw new Error('Verification timed out');
}
async function start(name, real) {
  const dir = path.join(out, `${name}-${Date.now()}`);
  await fs.mkdir(dir);
  const registry = path.join(dir, 'proxy.json.instances');
  const originalCodex = path.join(process.env.USERPROFILE, '.trae-cn/extensions/openai.chatgpt-26.901.22334/bin/windows-x86_64/codex.exe');
  const env = { ...process.env, ...fixtureEnvironment, CODEX_PHONE_REPO_ROOT: root, CODEX_PROXY_REPO_ROOT: root,
    CODEX_PHONE_REAL_CODEX_EXE: real ? originalCodex : fake, REAL_CODEX_BIN: fake,
    FAKE_NODE: process.execPath, FAKE_SCRIPT: path.join(root, 'tests/fixtures/wire-fixture.mjs'),
    CODEX_PHONE_AUTO_START: '0', CODEX_PROXY_STATE: path.join(dir, 'proxy.json'),
    CODEX_PROXY_LOG: path.join(dir, 'proxy.log') };
  // The real upstream gets a separate home and cannot open the live conversation.
  if (real) { env.CODEX_HOME = path.join(dir, 'codex-home'); await fs.mkdir(env.CODEX_HOME); }
  const isNode = name === 'node';
  const proc = spawn(isNode ? process.execPath : native,
    isNode ? [process.env.CODEX_PHONE_LEGACY_PROXY, 'app-server'] : ['app-server'],
    { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '', notifications = 0, nextId = 0;
  const responses = new Map();
  proc.stderr.on('data', data => { errors += data; });
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    const value = JSON.parse(line);
    if (Object.hasOwn(value, 'id')) responses.set(value.id, value); else notifications++;
  });
  const state = await waitFor(async () => {
    if (proc.exitCode !== null) throw new Error(`Startup failed ${proc.exitCode}: ${errors}`);
    try {
      for (const file of await fs.readdir(registry)) {
        if (!file.endsWith('.json')) continue;
        const state = JSON.parse(await fs.readFile(path.join(registry, file), 'utf8'));
        if (state.upstreamConnected) return state;
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  });
  async function request(method, params) {
    const id = ++nextId;
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    const result = await waitFor(() => responses.get(id), 30000); responses.delete(id); return result;
  }
  await request('initialize', { clientInfo: { name: 'codex-phone-native-verification', version: '1.0' }, capabilities: { experimentalApi: true } });
  proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  return { proc, state, request, notifications: () => notifications, async stop() {
    proc.stdin.end(); await waitFor(() => proc.exitCode !== null); assert.equal(proc.exitCode, 0);
    if (!isNode) assert.deepEqual(await fs.readdir(registry), []);
  } };
}
async function memory(pid) {
  const command = `$p=Get-Process -Id ${Number(pid)}; [pscustomobject]@{WorkingSetMiB=[math]::Round($p.WorkingSet64/1MB,2);PrivateCommitMiB=[math]::Round($p.PrivateMemorySize64/1MB,2);CpuSeconds=[math]::Round($p.CPU,3)} | ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  return JSON.parse(stdout);
}
const report = { date: new Date().toISOString(), workload: '5000 notifications, 4096 ASCII chars plus Chinese/emoji per notification; default replay budget; no control client during load', samples: {} };
for (const name of process.env.CODEX_PHONE_LEGACY_PROXY ? ['native', 'node'] : ['native']) {
  const proxy = await start(name, false);
  try {
    await delay(1000);
    const idle = await memory(proxy.proc.pid);
    const begin = performance.now();
    const before = proxy.notifications();
    assert.equal((await proxy.request('test/burst', { count: 5000, size: 4096 })).result.count, 5000);
    assert.equal(proxy.notifications() - before, 5000);
    const elapsedMs = Math.round(performance.now() - begin);
    await delay(1000);
    const loaded = await memory(proxy.proc.pid);
    report.samples[name] = { idle, loaded, elapsedMs };
  } finally { await proxy.stop(); }
}
const real = await start('real', true);
try {
  const listed = await real.request('thread/list', { limit: 1 });
  assert(!listed.error, JSON.stringify(listed.error)); assert(Array.isArray(listed.result.data));
  const ws = new WebSocket(`${real.state.controlUrl}?token=${encodeURIComponent(real.state.token)}`);
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ id: 'real-phone-list', method: 'thread/list', params: { limit: 1 } }));
  const response = await waitFor(() => messages.find(message => message.id === 'real-phone-list'));
  assert(!response.error, JSON.stringify(response.error)); assert(Array.isArray(response.result.data));
  ws.terminate();
  report.realUpstream = { version: '0.153.4', desktopThreadList: true, controlThreadList: true, isolatedCodexHome: true };
} finally { await real.stop(); }
await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
