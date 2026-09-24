import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { root, project, build, executable } from '../scripts/paths.mjs';

const run = path.join(build, 'history', String(Date.now()));
const token = 'history-fixture-token';
const registry = path.join(run, 'instances');
await fs.mkdir(registry, { recursive: true });
const control = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => control.once('listening', resolve));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const state = { instanceId: 'history', mode: 'stdio-tee', pid: process.pid, upstreamPid: process.pid,
  initialized: true, upstreamConnected: true, loadedThreadIds: ['history-thread'], currentThreadId: 'history-thread',
  controlUrl: `ws://127.0.0.1:${control.address().port}`, token: 'fixture', startedAt: new Date().toISOString() };
async function register() { await fs.writeFile(path.join(registry, 'history.json'), JSON.stringify({ ...state, updatedAt: new Date().toISOString() })); }
await register();
const heartbeat = setInterval(() => register().catch(() => {}), 1000);
const calls = [];
let failPage = true;
const turn = (id, text) => ({ id, status: 'completed', startedAt: 1700000000, completedAt: 1700000001,
  itemsView: 'full', items: [{ id: `${id}-answer`, type: 'agentMessage', text }] });
const thread = { id: 'history-thread', name: 'Paged history', cwd: root, status: { type: 'idle' }, turns: [] };
control.on('connection', socket => {
  let sequence = 100;
  socket.send(JSON.stringify({ type: 'hello', state }));
  socket.on('message', raw => {
    const m = JSON.parse(raw); calls.push(m);
    if (m.type === 'get-state') { socket.send(JSON.stringify({ type: 'history', events: [], complete: true, newestAvailableSeq: 100 })); return; }
    let result = {};
    if (m.method === 'model/list') result = { data: [], nextCursor: null };
    if (m.method === 'thread/list') result = { data: [thread], nextCursor: null };
    if (m.method === 'thread/resume') {
      assert.equal(m.params.excludeTurns, true); assert.equal(m.params.initialTurnsPage.itemsView, 'full');
      result = { thread, initialTurnsPage: { data: [turn('new', 'new complete history')], nextCursor: 'older' } };
    }
    if (m.method === 'thread/turns/list') {
      assert.equal(m.params.itemsView, 'full');
      if (failPage) { failPage = false; socket.send(JSON.stringify({ id: m.id, error: { code: -32001, message: 'temporary read unavailable' } })); return; }
      result = { data: [turn('old', 'old complete history')], nextCursor: null };
    }
    // A broadcast with the same id must not complete this pending RPC.
    socket.send(JSON.stringify({ type: 'control-response', id: m.id, result: { wrong: true }, seq: ++sequence }));
    socket.send(JSON.stringify({ id: m.id, result }));
  });
});
const bridge = spawn(executable, [], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_PHONE_REPO_ROOT: root,
  CODEX_PHONE_STATE_DIR: path.join(run, 'state'), CODEX_PROXY_REGISTRY: path.join(run, 'instances'),
  CODEX_PHONE_TOKEN: token, CODEX_PHONE_RELAY_DISABLED: '1', CODEX_PHONE_AUTO_LIFECYCLE: '0'
} });
let errors = '';
bridge.stdout.on('data', () => {}); bridge.stderr.on('data', data => { errors += data; });
try {
  let status;
  for (let i = 0; i < 100; i++) {
    status = await fetch(`http://127.0.0.1:${port}/api/status?token=${token}`).then(r => r.json()).catch(() => null);
    if (status?.messages.some(m => m.text === 'new complete history') && status.messages.some(m => m.text === 'old complete history')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(status?.messages.some(m => m.text === 'new complete history'), errors);
  assert.ok(status.messages.some(m => m.text === 'old complete history'), errors);
  assert.equal(calls.filter(m => m.method === 'thread/read' && m.params.includeTurns).length, 0);
  assert.equal(calls.filter(m => m.method === 'thread/items/list').length, 0);
  assert.ok(calls.filter(m => m.method === 'thread/turns/list').length >= 2, 'Failed history reads must retry');
  const facts = { fullResume: true, pagedTurns: true, readFailureRetry: true, broadcastIdIsolation: true };
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(JSON.stringify(facts));
} finally {
  clearInterval(heartbeat);
  if (bridge.exitCode === null) { const ended = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill(); await ended; }
  for (const socket of control.clients) socket.terminate();
  await new Promise(resolve => control.close(resolve));
}
