import { managerExe } from "../fixtures/native-manager.mjs";
import { proxyExe, fixtureEnvironment } from '../fixtures/native-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { WebSocket } from 'ws';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../proxy');
const root = path.resolve(project, '..');
const exe = proxyExe;
const fake = path.join(root, 'tests/build/bin/FakeCodex/release/fake-codex.exe');
const scratch = path.join(root, 'tests/build/contracts', String(Date.now()));
await fs.mkdir(scratch, { recursive: true });
let sequence = 0;
const results = [];
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await test(); if (result) return result; await delay(20); }
  throw new Error('Condition timed out');
}
function baseEnv(extra = {}) {
  return { ...process.env, ...fixtureEnvironment, CODEX_PHONE_REPO_ROOT: root, CODEX_PHONE_REAL_CODEX_EXE: fake,
    FAKE_NODE: process.execPath, FAKE_SCRIPT: path.join(root, 'tests/fixtures/wire-fixture.mjs'),
    CODEX_PHONE_AUTO_START: '0', CODEX_PROXY_CONTROL_REQUEST_TIMEOUT_MS: '5000',
    CODEX_PROXY_CONTROL_HISTORY_LIMIT: '100', CODEX_PROXY_CONTROL_HEARTBEAT_MS: '5000', ...extra };
}
async function start(extra = {}) {
  const folder = path.join(scratch, `run-${Date.now()}-${sequence++}`);
  await fs.mkdir(folder);
  const statePath = extra.CODEX_PROXY_STATE || path.join(folder, 'proxy.json');
  const child = spawn(exe, ['app-server'], {
    env: baseEnv({ CODEX_PROXY_STATE: statePath, CODEX_PROXY_LOG: path.join(folder, 'proxy.log'), REAL_CODEX_BIN: fake, ...extra }),
    cwd: folder, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  const lines = [];
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try { lines.push(JSON.parse(line)); } catch { lines.push(line); }
  });
  const state = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Proxy exited ${child.exitCode}: ${errors}`);
    try {
      for (const file of await fs.readdir(statePath + '.instances')) {
        if (!file.endsWith('.json')) continue;
        const state = JSON.parse(await fs.readFile(path.join(statePath + '.instances', file), 'utf8'));
        if (state.upstreamConnected && state.pid === child.pid) return state;
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  });
  const peers = [];
  return {
    child, lines, state, statePath,
    async parent(method, params = {}) {
      const id = `desktop-${sequence++}`;
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      return waitFor(() => lines.find(line => line.id === id));
    },
    async connect(token = state.token, options = {}) {
      const ws = new WebSocket(`${state.controlUrl}?token=${encodeURIComponent(token)}`, options);
      const messages = [];
      peers.push(ws);
      ws.on('message', data => messages.push(JSON.parse(data)));
      ws.on('error', () => {});
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return { ws, messages, async request(method, params = {}, id = `phone-${sequence++}`) {
        ws.send(JSON.stringify({ id, method, params }));
        return waitFor(() => messages.find(message => message.id === id));
      } };
    },
    async close(force = false) {
      for (const peer of peers) peer.terminate();
      if (child.exitCode === null) {
        if (force) child.kill('SIGKILL'); else child.stdin.end();
        await waitFor(() => child.exitCode !== null || child.signalCode !== null);
      }
      if (!force) assert.deepEqual(await fs.readdir(statePath + '.instances'), [], 'graceful exit removes own registry');
    }
  };
}
async function check(name, run) { await run(); results.push(name); console.log('PASS ' + name); }

await check('arguments, tool subcommands and version validation', async () => {
  const args = ['-c', '中文路径="E:\\有 空格\\"', 'app-server', 'generate-json-schema', '--out', 'a "quoted" path\\'];
  const child = spawn(exe, args, { env: baseEnv({ FAKE_ECHO_ARGS: '1' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; });
  await new Promise(resolve => child.on('exit', resolve));
  assert.equal(child.exitCode, 0); assert.deepEqual(JSON.parse(output), args);
  const bad = spawn(exe, ['app-server'], { env: baseEnv({ FAKE_VERSION: '0.0.0' }), windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => bad.on('exit', resolve)); assert.equal(bad.exitCode, 1);
});

await check('initialization gate, authentication, fragmented Unicode and raw stdio', async () => {
  const proxy = await start();
  try {
    const peer = await proxy.connect();
    assert.equal((await peer.request('test/echo')).error.code, -32002);
    const bad = await proxy.connect('incorrect');
    const code = await new Promise(resolve => bad.ws.on('close', resolve)); assert.equal(code, 1008);
    await proxy.parent('initialize');
    const payload = { id: 'unicode', method: 'test/echo', params: { text: '中文🙂é\n"\\', unknown: { nested: [null, true, 1] } } };
    const data = Buffer.from(JSON.stringify(payload));
    for (let i = 0; i < data.length; i += 7) peer.ws.send(data.subarray(i, i + 7), { binary: false, fin: i + 7 >= data.length });
    const response = await waitFor(() => peer.messages.find(message => message.id === 'unicode'));
    assert.deepEqual(response.result, payload.params);
    assert(!proxy.lines.some(line => line.id === 'unicode' || typeof line.id === 'number' && line.id < 0));
    proxy.child.stdin.write('plain passthrough\r\n');
    await waitFor(() => proxy.lines.includes('plain passthrough'));
  } finally { await proxy.close(); }
});

await check('desktop/phone approval arbitration in both directions', async () => {
  const proxy = await start();
  try {
    await proxy.parent('initialize'); const peer = await proxy.connect();
    await proxy.parent('test/approval', { requestId: 9001 });
    peer.ws.send(JSON.stringify({ type: 'server-response', requestId: 9001, result: { decision: 'accept' } }));
    await waitFor(() => proxy.lines.some(line => line.method === 'test/responseSeen'));
    proxy.child.stdin.write(JSON.stringify({ id: 9001, result: { decision: 'decline' } }) + '\n');
    await proxy.parent('test/echo');
    assert.equal(proxy.lines.filter(line => line.method === 'test/responseSeen' && line.params.id === 9001).length, 1);
    await proxy.parent('test/approval', { requestId: 9002 });
    proxy.child.stdin.write(JSON.stringify({ id: 9002, result: { decision: 'decline' } }) + '\n');
    await proxy.parent('test/echo');
    peer.ws.send(JSON.stringify({ type: 'server-response', requestId: 9002, result: { decision: 'accept' } }));
    await peer.request('test/echo');
    assert.equal(proxy.lines.filter(line => line.method === 'test/responseSeen' && line.params.id === 9002).length, 1);
  } finally { await proxy.close(); }
});

await check('timeouts and disconnected clients do not leak late responses to desktop', async () => {
  const proxy = await start();
  try {
    await proxy.parent('initialize'); const peer = await proxy.connect();
    assert.equal((await peer.request('test/delay', { delay: 5500 }, 'timeout')).error.code, -32098);
    await waitFor(() => peer.messages.some(message => message.type === 'control-response-abandoned'));
    peer.ws.send(JSON.stringify({ id: 'disconnected', method: 'test/delay', params: { delay: 200 } }));
    await delay(40); peer.ws.terminate();
    await delay(350);
    const next = await proxy.connect(); assert((await next.request('test/echo', { reconnect: true })).result.reconnect);
    assert(!proxy.lines.some(line => line.id === 'timeout' || line.id === 'disconnected' || typeof line.id === 'number' && line.id < 0));
  } finally { await proxy.close(); }
});

await check('bounded history, cursors and outstanding approvals survive reconnect', async () => {
  const proxy = await start();
  try {
    await proxy.parent('initialize'); await proxy.parent('test/approval', { requestId: 9003 });
    await proxy.parent('test/burst', { count: 160, size: 128 });
    const peer = await proxy.connect();
    peer.ws.send(JSON.stringify({ type: 'get-state', includeHistory: true, afterSeq: 0 }));
    const history = await waitFor(() => peer.messages.find(message => message.type === 'history'));
    assert(history.truncated); assert(history.events.length <= 101);
    assert(history.events.some(event => event.type === 'server-request' && event.request.id === 9003));
    const seqs = history.events.map(event => event.seq); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    peer.messages.length = 0;
    peer.ws.send(JSON.stringify({ type: 'get-state', includeHistory: true, afterSeq: history.newestAvailableSeq }));
    const empty = await waitFor(() => peer.messages.find(message => message.type === 'history')); assert.equal(empty.events.length, 0);
  } finally { await proxy.close(); }
});

await check('replay byte budget and slow control clients keep desktop usable', async () => {
  const proxy = await start({ CODEX_PROXY_CONTROL_HISTORY_LIMIT: '2500', CODEX_PROXY_CONTROL_HISTORY_MAX_BYTES: String(4 * 1024 * 1024), CODEX_PROXY_MAX_BUFFERED_BYTES: '65536' });
  try {
    await proxy.parent('initialize');
    const slow = await proxy.connect();
    slow.ws._socket.pause();
    assert.equal((await proxy.parent('test/burst', { count: 700, size: 32768 })).result.count, 700);
    slow.ws._socket.resume();
    await waitFor(() => slow.ws.readyState === WebSocket.CLOSED);
    const peer = await proxy.connect();
    peer.ws.send(JSON.stringify({ type: 'get-state', includeHistory: true, afterSeq: 0 }));
    const history = await waitFor(() => peer.messages.find(message => message.type === 'history'));
    assert(history.truncated);
    assert(history.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= 4 * 1024 * 1024);
    assert((await proxy.parent('test/echo', { alive: true })).result.alive);
  } finally { await proxy.close(); }
});

await check('heartbeat detects an unresponsive control client while desktop continues', async () => {
  const proxy = await start();
  try {
    await proxy.parent('initialize'); const peer = await proxy.connect(proxy.state.token, { autoPong: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('heartbeat timeout not enforced')), 18000);
      peer.ws.on('close', () => { clearTimeout(timer); resolve(); });
    });
    assert((await proxy.parent('test/echo', { alive: true })).result.alive);
  } finally { await proxy.close(); }
});

await check('multiple instances keep independent registry and request ownership', async () => {
  const a = await start(); const b = await start({ CODEX_PROXY_STATE: a.statePath });
  try {
    await a.parent('initialize'); await b.parent('initialize');
    // b may initially observe a's registration; select b's record by PID.
    const entries = await fs.readdir(a.statePath + '.instances');
    assert.equal(entries.filter(file => file.endsWith('.json')).length, 2);
    const record = JSON.parse(await fs.readFile(path.join(a.statePath + '.instances', entries.find(file => file.startsWith(`${b.child.pid}-`))), 'utf8'));
    assert.notEqual(a.state.instanceId, record.instanceId);
    assert.notEqual(a.state.controlUrl, record.controlUrl);
  } finally { await b.close(true); await a.close(true); }
});

await check('upstream exit propagates and forced proxy exit terminates owned upstream', async () => {
  const proxy = await start();
  try {
    await proxy.parent('initialize');
    proxy.child.stdin.write(JSON.stringify({ id: 'exit', method: 'test/exit', params: { code: 7 } }) + '\n');
    await waitFor(() => proxy.child.exitCode !== null); assert.equal(proxy.child.exitCode, 7);
  } finally { await proxy.close(); }
  const forced = await start();
  const upstream = forced.state.upstreamPid;
  await forced.close(true);
  await waitFor(() => { try { process.kill(upstream, 0); return false; } catch { return true; } });
});

await check('existing phone manager recognizes the native executable with explicit paths', async () => {
  const stateDir = path.join(scratch, `manager-${Date.now()}`);
  await fs.mkdir(stateDir);
  const settings = path.join(stateDir, 'settings.json');
  const config = path.join(stateDir, 'phone.ini');
  await fs.writeFile(settings, JSON.stringify({ 'chatgpt.cliExecutable': exe }, null, 2));
  await fs.writeFile(config, 'phone.mode=local\nphone.token=native-test\n');
  const proxy = await start({ CODEX_PROXY_STATE: path.join(stateDir, 'trae-proxy.json') });
  try {
    await proxy.parent('initialize');
    const { stdout } = await exec(managerExe, ['--action', 'Status', '--state-dir', stateDir,
      '--settings', settings, '--config', config, '--proxy', exe, '--bridge', path.join(stateDir, 'unused-bridge.exe'), '--port', '1'], { windowsHide: true });
    const result = JSON.parse(stdout);
    assert(result.operationSuccess); assert(result.status.proxyConfigured); assert(result.status.proxyConnected);
    assert(result.status.proxyPids.includes(proxy.child.pid));
  } finally { await proxy.close(); }
});
await fs.writeFile(path.join(scratch, 'result.json'), JSON.stringify({ passed: results.length, results }, null, 2));
console.log(`Contract checks: ${results.length} passed`);
