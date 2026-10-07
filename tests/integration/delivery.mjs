import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { root, build, executable } from '../scripts/paths.mjs';
import { createPhoneReceiver } from '../../public/transport/phone-receiver.js';
import { reducePhoneState } from '../../public/state/phone-state.js';

const run = path.join(build, 'delivery', String(Date.now()));
const registry = path.join(run, 'instances');
await fs.mkdir(registry, { recursive: true });
const control = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => control.once('listening', resolve));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const token = 'delivery-isolated';
const calls = [], sockets = [], measurements = {};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 8000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { const value = test(); if (value) return value; await pause(5); }
  throw new Error(`Timed out: ${label}`);
}
const a = { id: 'a', name: 'large conversation', status: { type: 'idle' }, turns: [{
  id: 'turn-a', status: 'completed', startedAt: 1700000000, completedAt: 1700000001, itemsView: 'full',
  items: Array.from({ length: 600 }, (_, i) => ({ id: `a-${i}`, type: 'agentMessage', text: `${i}:` + '内容🙂'.repeat(800) }))
}] };
const b = { id: 'b', name: 'small conversation', status: { type: 'idle' }, turns: [{
  id: 'turn-b', status: 'completed', startedAt: 1700000000, completedAt: 1700000001, itemsView: 'full',
  items: [{ id: 'b-answer', type: 'agentMessage', text: 'selected B' }]
}] };
const registration = { instanceId: 'delivery', mode: 'stdio-tee', pid: process.pid, upstreamPid: process.pid,
  initialized: true, upstreamConnected: true, loadedThreadIds: ['a', 'b'], currentThreadId: 'a',
  controlUrl: `ws://127.0.0.1:${control.address().port}`, token: 'control', startedAt: new Date().toISOString() };
const register = () => fs.writeFile(path.join(registry, 'delivery.json'), JSON.stringify({ ...registration, updatedAt: new Date().toISOString() }));
await register();
const timer = setInterval(() => register().catch(() => {}), 1000);
let sequence = 1;
control.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'hello', state: registration }));
  socket.on('message', data => {
    const message = JSON.parse(data); calls.push(message);
    if (message.type === 'get-state') { socket.send(JSON.stringify({ type: 'history', events: [], complete: true, newestAvailableSeq: sequence })); return; }
    const thread = message.params?.threadId === 'b' ? b : a;
    let result = {};
    if (message.method === 'model/list') result = { data: [] };
    if (message.method === 'thread/list') result = { data: [a, b].map(({ turns, ...summary }) => summary) };
    if (message.method === 'thread/read') {
      assert.equal(message.params.includeTurns, false);
      const { turns, ...summary } = thread; result = { thread: summary };
    }
    if (message.method === 'thread/resume') {
      const { turns, ...summary } = thread;
      result = { thread: summary, initialTurnsPage: { data: turns, nextCursor: null } };
    }
    if (message.method === 'thread/turns/list') result = { data: thread.turns, nextCursor: null };
    socket.send(JSON.stringify({ id: message.id, result }));
  });
});
function notify(method, params) {
  const payload = JSON.stringify({ type: 'notification', seq: ++sequence, notification: { method, params } });
  for (const socket of control.clients) socket.send(payload);
}
async function phone(holdFirstState = false) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}&streamProtocol=1`);
  sockets.push(socket);
  const client = { socket, state: null, payloads: [], frames: [], held: null, snapshots: 0, error: null };
  const receiver = createPhoneReceiver({
    send: value => { if (value.id !== client.held) socket.send(JSON.stringify(value)); },
    receive: value => {
      client.payloads.push(value);
      if (!['state', 'state:patch', 'stream:append', 'stream:complete'].includes(value.type)) return;
      const result = reducePhoneState(client.state, value);
      assert.equal(result.status, 'applied', JSON.stringify({ type: value.type, status: result.status }));
      client.state = result.state;
      if (value.type === 'state') client.snapshots++;
    }
  });
  socket.on('message', data => {
    try {
      const value = JSON.parse(data); client.frames.push(value);
      if (holdFirstState && value.type === 'transport:chunk' && value.total > 100000) { client.held = value.id; holdFirstState = false; }
      receiver.accept(value);
    } catch (error) { client.error = error; }
  });
  socket.on('error', error => { client.error = error; });
  client.send = value => socket.send(JSON.stringify(value));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return client;
}
const bridge = spawn(executable, [], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_PHONE_REPO_ROOT: root,
  CODEX_PHONE_STATE_DIR: path.join(run, 'state'), CODEX_PROXY_REGISTRY: registry,
  CODEX_PHONE_TOKEN: token, CODEX_PHONE_RELAY_DISABLED: '1', CODEX_PHONE_AUTO_LIFECYCLE: '0'
} });
let stderr = '';
bridge.stdout.on('data', () => {}); bridge.stderr.on('data', data => { stderr += data; });
try {
  for (let i = 0; i < 100; i++) {
    const status = await fetch(`http://127.0.0.1:${port}/api/status?token=${token}`).then(r => r.json()).catch(() => null);
    if (status?.messages?.length === 600) break;
    if (i === 99) throw new Error('History not ready: ' + stderr);
    await pause(50);
  }
  const initial = performance.now(); const client = await phone();
  await until(() => client.state?.messages.length === 200, 'first 200');
  measurements.first200Ms = Math.round(performance.now() - initial);
  assert.equal(client.state.messages[0].meta.sourceItemId, 'a-400');
  assert.equal(client.state.messages[199].text, a.turns[0].items[599].text);
  assert.equal(client.state.sync.totalMessages, 600);
  client.send({ type: 'thread:open', threadId: 'a', requestId: 'pin-a' });
  await until(() => client.payloads.some(p => p.requestId === 'pin-a'), 'pin first client');
  const stalled = await phone(true);
  await until(() => stalled.held !== null, 'paused state');
  await until(() => stalled.payloads.some(p => p.type === 'state:catalog'), 'independent catalog');
  const probe = performance.now(); stalled.send({ type: 'transport:ping', nonce: 9 });
  await until(() => stalled.frames.some(p => p.type === 'transport:pong' && p.nonce === 9), 'independent heartbeat');
  measurements.heartbeatDuringStallMs = Math.round(performance.now() - probe);
  const switchStart = performance.now(); stalled.send({ type: 'thread:open', threadId: 'b', requestId: 'open-b' });
  await until(() => stalled.state?.messages.some(m => matchesMessage(m, 'b-answer')), 'switch cancels old delivery');
  measurements.switchDuringStallMs = Math.round(performance.now() - switchStart);
  assert.ok(stalled.frames.some(p => p.type === 'transport:cancel' && p.id === stalled.held));
  assert.equal(stalled.socket.readyState, WebSocket.OPEN);
  const reads = calls.filter(c => ['thread/read', 'thread/resume', 'thread/turns/list'].includes(c.method)).length;
  stalled.send({ type: 'thread:open', threadId: 'a', requestId: 'open-a' });
  await until(() => stalled.state?.currentThreadId === 'a' && stalled.state.messages.length === 200, 'warm switch');
  assert.equal(calls.filter(c => ['thread/read', 'thread/resume', 'thread/turns/list'].includes(c.method)).length, reads);
  client.send({ type: 'messages:more', threadId: 'a', threadRevision: client.state.threadRevision, requestId: 'more' });
  await until(() => client.state.messages.length === 600, 'all history');
  notify('turn/started', { threadId: 'a', turn: { id: 'live', status: 'inProgress' } });
  notify('item/started', { threadId: 'a', turnId: 'live', item: { id: 'live-answer', type: 'agentMessage', text: 'seed' } });
  await until(() => client.state.messages.some(m => matchesMessage(m, 'live-answer')), 'live start');
  const text = 'seed' + '完整流式输出🙂'.repeat(15000);
  notify('item/agentMessage/delta', { threadId: 'a', turnId: 'live', itemId: 'live-answer', delta: text.slice(4) });
  await until(() => client.state.messages.find(m => matchesMessage(m, 'live-answer'))?.text === text, 'long stream');
  notify('item/completed', { threadId: 'a', turnId: 'live', item: { id: 'live-answer', type: 'agentMessage', text } });
  await until(() => client.state.messages.find(m => matchesMessage(m, 'live-answer'))?.streaming === false, 'completion');
  assert.equal(client.state.messages.find(m => matchesMessage(m, 'live-answer')).text, text);
  const beforeSnapshot = client.snapshots; client.send({ type: 'state:request' });
  await until(() => client.snapshots > beforeSnapshot, 'explicit full state');
  assert.equal(client.state.messages.find(m => matchesMessage(m, 'live-answer')).text, text);
  assert.equal(client.error, null); assert.equal(stalled.error, null);
  assert.ok(measurements.switchDuringStallMs < 1000, JSON.stringify(measurements));
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify(measurements));
} finally {
  clearInterval(timer); for (const socket of sockets) socket.terminate();
  if (bridge.exitCode === null) { const exited = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill(); await exited; }
  for (const socket of control.clients) socket.terminate();
  await new Promise(resolve => control.close(resolve));
}

function matchesMessage(message, sourceId) { return message.id === sourceId || message.meta?.sourceItemId === sourceId; }
