import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from '../fixtures/phone-websocket.mjs';
import { root, build, executable as bridgeExe } from '../scripts/paths.mjs';
import { proxyExe, fakeEnv } from '../fixtures/native-fixture.mjs';
import { managerExe, managerFixture } from '../fixtures/native-manager.mjs';

const exec = promisify(execFile);
const run = path.join(build, 'registration-faults', String(Date.now()));
await fs.mkdir(run, { recursive: true });
const children = new Set(), faults = new Set(), sockets = new Set(), results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;
async function until(read, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(40); }
  throw new Error('Timed out: ' + label);
}
function start(exe, args, env) {
  const child = spawn(exe, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); child.errors = '';
  child.stderr.on('data', data => { child.errors += data; });
  child.lines = [];
  readline.createInterface({ input: child.stdout }).on('line', line => child.lines.push(line));
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  await until(() => child.exitCode !== null || child.signalCode !== null, 'process exit');
}
async function hold(target, mode) {
  const child = start('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'tests/fixtures/hold-registration.ps1'), '-Target', target, '-Mode', mode]);
  faults.add(child);
  await until(() => {
    if (child.exitCode !== null) throw new Error(child.errors);
    return child.lines.includes('READY');
  }, mode + ' fault ready');
  return async () => { await stop(child); faults.delete(child); assert.equal(child.exitCode, 0, child.errors); };
}
async function proxy(folder, extra = {}) {
  const stateDir = path.join(folder, 'state');
  const registry = path.join(stateDir, 'proxy/instances');
  await fs.mkdir(registry, { recursive: true });
  const log = path.join(folder, 'proxy.log');
  const child = start(proxyExe, ['app-server'], { ...fakeEnv(path.join(root, 'tests/fixtures/wire-fixture.mjs')),
    CODEX_PROXY_REGISTRY: registry, CODEX_PROXY_LOG: log, CODEX_PHONE_AUTO_START: '0', ...extra });
  async function request(method, params = {}) {
    const id = 'parent-' + ++sequence;
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    return until(() => {
      if (child.exitCode !== null) throw new Error(`Proxy exited: ${child.errors}`);
      return child.lines.map(line => JSON.parse(line)).find(line => line.id === id);
    }, method);
  }
  async function registration() {
    for (const name of await fs.readdir(registry)) {
      if (!name.endsWith('.json')) continue;
      const value = JSON.parse(await fs.readFile(path.join(registry, name), 'utf8'));
      if (value.pid === child.pid && value.initialized) return { ...value, file: path.join(registry, name) };
    }
  }
  assert((await request('initialize')).result);
  return { child, request, registration, registry, stateDir, folder, log };
}
async function connect(url) {
  const ws = new WebSocket(url); sockets.add(ws); const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, messages };
}
async function bridge(p) {
  const isolatedBridge = path.join(p.folder, 'bridge-test.exe');
  await fs.copyFile(bridgeExe, isolatedBridge);
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const token = 'registration-test'; const config = path.join(p.folder, 'phone.ini');
  await fs.writeFile(config, `[phone]\nmode=relay\nlocal_host=127.0.0.1\nlocal_port=${port}\ntoken=${token}\n[relay]\nserver=127.0.0.1\nagent_port=1\npublic_port=2\nsecret=${'x'.repeat(32)}\nreconnect_delay_ms=2000\n`);
  const settings = path.join(p.folder, 'settings.json');
  await fs.writeFile(settings, JSON.stringify({ 'chatgpt.cliExecutable': proxyExe }));
  const child = start(isolatedBridge, [], { HOST: '127.0.0.1', PORT: String(port), CODEX_PHONE_MODE_CONFIG: config,
    CODEX_PHONE_STATE_DIR: path.join(p.stateDir, 'bridge'), CODEX_PROXY_REGISTRY: p.registry,
    CODEX_PHONE_RELAY_DISABLED: '1', CODEX_PHONE_AUTO_LIFECYCLE: '1', CODEX_PHONE_PROXY_GRACE_MS: '5000' });
  const url = `http://127.0.0.1:${port}`;
  async function health() {
    if (child.exitCode !== null) throw new Error('Bridge exited: ' + child.errors);
    return fetch(`${url}/api/health?token=${token}`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
  }
  await until(async () => (await health())?.codex?.status === 'connected', 'bridge connected');
  const phone = await connect(`${url.replace('http', 'ws')}/ws?token=${token}&streamProtocol=1`);
  await until(() => phone.messages.some(m => m.type === 'state'), 'phone initial state');
  async function manager() {
    const { stdout } = await exec(managerExe, ['--action', 'Status', '--root', root, '--settings', settings,
      '--state-dir', p.stateDir, '--config', config, '--proxy', proxyExe, '--bridge', isolatedBridge, '--port', String(port)],
    { windowsHide: true, timeout: 15000 });
    return JSON.parse(stdout);
  }
  return { child, health, phone, manager };
}
async function check(name, action) { await action(); results.push(name); console.log('PASS ' + name); }

try {
  await check('startup denied: desktop works and phone auto-start follows recovered registration', async () => {
    const folder = path.join(run, 'startup'); const registry = path.join(folder, 'state/proxy/instances');
    await fs.mkdir(registry, { recursive: true });
    const release = await hold(registry, 'DenyWrite');
    const marker = path.join(folder, 'auto-start.json'); let p;
    try {
      p = await proxy(folder, { CODEX_PHONE_AUTO_START: '1', CODEX_PHONE_MANAGER_EXE: managerFixture, CODEX_PHONE_AUTO_START_MARKER: marker });
      assert.deepEqual((await p.request('test/echo', { text: 'works without disk registration' })).result, { text: 'works without disk registration' });
      assert.equal((await fs.readdir(registry)).length, 0);
      await assert.rejects(fs.access(marker));
      assert.match(await fs.readFile(p.log, 'utf8'), /state_write_error.*UnauthorizedAccessException/);
    } finally { await release(); }
    const state = await until(p.registration, 'registration recovery');
    await until(async () => { try { return JSON.parse(await fs.readFile(marker, 'utf8')); } catch { return null; } }, 'deferred automatic start');
    assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).proxyPid, p.child.pid);
    assert.match(await fs.readFile(p.log, 'utf8'), /state_write_recovered/);
    await stop(p.child); assert.equal(p.child.exitCode, 0);
    await until(() => { try { process.kill(state.upstreamPid, 0); return false; } catch { return true; } }, 'owned upstream shutdown');
  });

  const p = await proxy(path.join(run, 'connected'));
  const state = await until(p.registration, 'registration');
  const b = await bridge(p);
  const peer = await connect(`${state.controlUrl}?token=${encodeURIComponent(state.token)}`);
  async function communication() {
    const text = 'desktop-' + ++sequence;
    assert.equal((await p.request('test/echo', { text })).result.text, text);
    const id = 'control-' + ++sequence;
    peer.ws.send(JSON.stringify({ id, method: 'test/echo', params: { text } }));
    assert.equal((await until(() => peer.messages.find(m => m.id === id), 'control echo')).result.text, text);
    const count = b.phone.messages.filter(m => m.type === 'state').length;
    b.phone.ws.send(JSON.stringify({ type: 'state:request' }));
    await until(() => b.phone.messages.filter(m => m.type === 'state').length > count, 'phone state');
    assert.equal((await b.health()).codex.status, 'connected');
  }
  await check('46 seconds of blocked replacement preserve desktop, phone and manager status', async () => {
    const release = await hold(state.file, 'Read');
    try {
      const before = (await p.registration()).updatedAt;
      const end = Date.now() + 46000;
      while (Date.now() < end) { await communication(); await delay(1000); }
      assert.equal((await p.registration()).updatedAt, before, 'test must block actual publication');
      const status = (await b.manager()).status;
      assert.equal(status.proxyConnected, true); assert.equal(status.bridgeConnected, true);
      assert.match(await fs.readFile(p.log, 'utf8'), /state_write_error/);
    } finally { await release(); }
    await until(async () => Date.now() - Date.parse((await p.registration()).updatedAt) < 2000, 'publication resumes');
    await communication();
  });
  await check('exclusive read failure is not interpreted as a dead connection', async () => {
    const release = await hold(state.file, 'Exclusive');
    try {
      await delay(1500); await communication();
      assert.equal((await b.manager()).status.bridgeConnected, true);
    } finally { await release(); }
  });
  await check('access-denied publication recovers and cleanup failure cannot change normal exit', async () => {
    let release = await hold(state.file, 'ReadOnly');
    try {
      await until(async () => /state_write_error.*UnauthorizedAccessException/.test(await fs.readFile(p.log, 'utf8')), 'access-denied evidence');
      await communication();
    } finally { await release(); }
    await until(async () => Date.now() - Date.parse((await p.registration()).updatedAt) < 2000, 'access-denied recovery');
    release = await hold(state.file, 'ReadOnly');
    try {
      await stop(p.child); assert.equal(p.child.exitCode, 0);
      assert.match(await fs.readFile(p.log, 'utf8'), /registry_cleanup/);
      await until(() => { try { process.kill(state.upstreamPid, 0); return false; } catch { return true; } }, 'upstream exited');
      await until(() => b.child.exitCode !== null, 'bridge real-exit lifecycle'); assert.equal(b.child.exitCode, 0);
    } finally { await release(); }
  });
  assert(!/proxy_fatal/.test(await fs.readFile(p.log, 'utf8')));
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify({ passed: results.length, results }, null, 2));
  console.log('Evidence: ' + run);
} finally {
  // Release file handles and restore ACLs before terminating any fixture.
  for (const child of faults) await stop(child);
  for (const ws of sockets) ws.terminate();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'fixture cleanup');
  }
}
