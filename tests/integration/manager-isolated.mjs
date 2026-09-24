import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { managerExe, managerFixture } from '../fixtures/native-manager.mjs';
import { root, build } from '../scripts/paths.mjs';

await import('./state-migration.mjs');

const exec = promisify(execFile);
const directory = path.join(build, 'manager', String(Date.now()));
const stateDir = path.join(directory, 'state');
const settings = path.join(directory, 'settings.json');
const config = path.join(directory, 'phone-mode.ini');
const bridge = path.join(directory, '隔离手机桥.exe');
const proxy = path.join(directory, 'isolated-proxy.exe');
const original = path.join(directory, 'original.exe');
const registry = path.join(stateDir, 'proxy/instances');
const managerState = path.join(stateDir, 'state.json');
async function readState() { return JSON.parse(await fs.readFile(managerState, 'utf8')); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set();
const cases = [];
await fs.mkdir(registry, { recursive: true });
await fs.copyFile(managerFixture, bridge);
await fs.writeFile(proxy, 'isolated proxy fixture');
const initialSettings = '{\r\n // 用户配置和中文注释\r\n "editor.fontSize": 14,\r\n "chatgpt.cliExecutable": ' +
  JSON.stringify(original) + ',\r\n "nested": {"keep": true},\r\n}\r\n';
await fs.writeFile(settings, initialSettings);
const productionFiles = [
  path.join(process.env.APPDATA, 'Trae CN/User/settings.json'),
  path.join(root, 'assistant/data/state.json')
];
async function hash(file) {
  try { return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return '<missing>'; throw error; }
}
const hashes = await Promise.all(productionFiles.map(hash));
const nativeProcessStart = new Date(Date.now() - process.uptime() * 1000).toISOString();
const primaryPath = path.join(registry, 'isolated-primary.json');
let sessionId = 'test-trae-session-A';
function proxyState(id = 'isolated-primary') {
  return { mode: 'stdio-tee', instanceId: id, loadedThreadIds: [], pid: process.pid, ppid: process.ppid,
    startedAt: nativeProcessStart, updatedAt: new Date().toISOString(),
    upstreamPid: process.pid, upstreamConnected: true, initialized: true,
    traePid: process.pid, traeSessionId: sessionId, traeStartedAt: nativeProcessStart };
}
await fs.writeFile(primaryPath, JSON.stringify(proxyState()));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
await fs.writeFile(config, '[phone]\nmode=relay\nlocal_host=127.0.0.1\nlocal_port=' + port +
  '\ntoken=isolated-test-token\n\n[relay]\nserver=127.0.0.1\nagent_port=1\npublic_port=2\n' +
  'reconnect_delay_ms=2000\nsecret=' + 'x'.repeat(32) + '\n');
const baseArgs = ['--root', root, '--settings', settings, '--state-dir', stateDir, '--config', config,
  '--proxy', proxy, '--bridge', bridge, '--port', String(port), '--timeout-ms', '6000'];
const environment = { ...process.env };
for (const key of ['CODEX_PHONE_AUTO_START_MARKER', 'CODEX_PHONE_TOKEN', 'CODEX_PHONE_RELAY_SECRET']) delete environment[key];
async function heartbeat() {
  for (const name of await fs.readdir(registry)) {
    const file = path.join(registry, name);
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    value.updatedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(value));
  }
}
async function invoke(action, extra = [], refresh = true) {
  if (refresh) await heartbeat();
  let result;
  try {
    const response = await exec(managerExe, ['--action', action, ...baseArgs, ...extra],
      { cwd: root, env: environment, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    result = { code: 0, text: response.stdout };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    result = { code: error.code, text: error.stdout };
  }
  if (!extra.includes('--gui-output')) {
    result.result = JSON.parse(result.text);
    if (result.result.status?.bridgePid) children.add(result.result.status.bridgePid);
  }
  return result;
}
async function pass(name, check) { await check(); cases.push(name); console.log('PASS ' + name); }
function success(response) { assert.equal(response.code, 0, response.text); assert.equal(response.result.operationSuccess, true); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function marker(name, enabled = true) {
  if (enabled) await fs.writeFile(path.join(directory, name), '1');
  else await fs.rm(path.join(directory, name), { force: true });
}
let currentPid;
try {
  await pass('Status', async () => {
    const value = await invoke('Status'); success(value);
    assert.equal(value.result.status.proxyMode, 'custom');
    assert.equal(value.result.status.proxyConnected, true);
    assert.equal(value.result.status.traeOnline, true);
    assert.equal(value.result.status.bridgeRunning, false);
  });
  await pass('Enable', async () => {
    const value = await invoke('Enable'); success(value);
    assert.equal(value.result.status.proxyMode, 'phone');
    const updated = await fs.readFile(settings, 'utf8');
    assert(updated.includes('// 用户配置和中文注释'));
    assert(updated.includes('"nested": {"keep": true}'));
    const mode = (await readState()).proxy;
    assert.equal(mode.previousCliExecutable, original);
    assert.equal(await fs.readFile(mode.backupPath, 'utf8'), initialSettings);
    success(await invoke('Enable'));
    assert.equal((await readState()).proxy.previousCliExecutable, original);
    const stored = await readState();
    assert.equal(stored.version, 1);
    assert.equal(stored.recent.action, 'Enable');
    assert.deepEqual(Object.keys(stored.proxy).sort(), ['backupPath', 'previousCliExecutable', 'previousCliExecutablePresent', 'settingsPath', 'updatedAt'].sort());
  });
  await pass('Restart', async () => {
    const value = await invoke('Restart'); success(value);
    assert.equal(value.result.status.bridgeConnected, true);
    assert.equal(value.result.status.bridgeAutoLifecycle, true);
    assert.equal(value.result.status.publicConnected, true);
    currentPid = value.result.status.bridgePid;
    assert(alive(currentPid));
    const call = JSON.parse(await fs.readFile(path.join(directory, 'bridge-call.json'), 'utf8'));
    assert.equal(call.autoLifecycle, true);
    assert.equal(call.port, port);
  });
  await pass('MultipleInstances', async () => {
    await fs.writeFile(path.join(registry, 'isolated-second.json'), JSON.stringify(proxyState('isolated-second')));
    await marker('missing-instance');
    const partial = await invoke('Status'); success(partial);
    assert.equal(partial.result.status.proxyInstanceCount, 2);
    assert.equal(partial.result.status.bridgeConnected, false);
    await marker('missing-instance', false);
    assert.equal((await invoke('Status')).result.status.bridgeConnected, true);
    await fs.rm(path.join(registry, 'isolated-second.json'));
  });
  await pass('RenamedRunningBridgeIdentified', async () => {
    await fs.mkdir(path.join(directory, 'archive'));
    await fs.rename(bridge, path.join(directory, 'archive', path.basename(bridge)));
    await fs.copyFile(managerFixture, bridge);
    const value = await invoke('Status'); success(value);
    assert.equal(value.result.status.bridgeHealthy, true);
    assert.equal(value.result.status.bridgePid, currentPid);
    assert(alive(currentPid));
  });
  await pass('AutomaticProtocolUpgrade', async () => {
    await marker('old-protocol');
    const value = await invoke('Restart', ['--automatic', '--proxy-pid', String(process.pid)]); success(value);
    assert.equal(value.result.status.bridgeInstanceRouting, true);
    assert.notEqual(value.result.status.bridgePid, currentPid);
    assert(!alive(currentPid));
    currentPid = value.result.status.bridgePid;
  });
  await pass('AutomaticReuse', async () => {
    const value = await invoke('Restart', ['--automatic', '--proxy-pid', String(process.pid)]); success(value);
    assert.equal(value.result.disposition, 'reused');
    assert.equal(value.result.status.bridgePid, currentPid);
  });
  await pass('AutomaticTransientProbe', async () => {
    await marker('health-fail-once');
    const value = await invoke('Restart', ['--automatic', '--proxy-pid', String(process.pid)]); success(value);
    assert.equal(value.result.status.bridgePid, currentPid);
  });
  await pass('Stop', async () => {
    const value = await invoke('Stop'); success(value);
    assert.equal(value.result.status.paused, true);
    assert.equal(value.result.status.bridgeRunning, false);
    assert(!alive(currentPid)); assert(alive(process.pid));
  });
  await pass('AutomaticSuppressed', async () => {
    const value = await invoke('Restart', ['--automatic']); success(value);
    assert.equal(value.result.disposition, 'suppressed');
    assert.equal(value.result.status.bridgeRunning, false);
    const stored = await readState();
    assert.equal(stored.proxy.previousCliExecutable, original);
    assert.equal(stored.pause.traeSessionId, sessionId);
    assert.equal(stored.recent.disposition, 'suppressed');
  });
  await pass('AutomaticNextSession', async () => {
    sessionId = 'test-trae-session-B';
    await fs.writeFile(primaryPath, JSON.stringify(proxyState()));
    const value = await invoke('Restart', ['--automatic']); success(value);
    assert.equal(value.result.disposition, 'started');
    assert.equal(value.result.status.bridgeConnected, true);
    assert.equal(value.result.status.paused, false);
    assert.equal((await readState()).pause, undefined);
    currentPid = value.result.status.bridgePid;
  });
  await pass('RelayDisconnected', async () => {
    await marker('relay-disconnected');
    const value = await invoke('Status'); success(value);
    assert.equal(value.result.status.bridgeHealthy, true);
    assert.equal(value.result.status.publicStatus, 'disconnected');
    assert.equal(value.result.status.publicConnected, false);
    await marker('relay-disconnected', false);
  });
  await pass('WrongRelayPid', async () => {
    await marker('wrong-relay-pid');
    assert.equal((await invoke('Status')).result.status.publicConnected, false);
    await marker('wrong-relay-pid', false);
  });
  await pass('FailedPreflightPreservesBridge', async () => {
    await marker('preflight-failure');
    const value = await invoke('Restart');
    assert.equal(value.code, 1);
    assert.equal(value.result.status.bridgePid, currentPid);
    assert(alive(currentPid));
    await marker('preflight-failure', false);
  });
  await pass('StaleAutomaticRequest', async () => {
    const value = await invoke('Restart', ['--automatic', '--proxy-pid', '1']); success(value);
    assert.equal(value.result.disposition, 'stale');
    assert.equal(value.result.status.bridgePid, currentPid);
  });
  await pass('ExpiredRegistry', async () => {
    const state = proxyState(); state.updatedAt = '2020-01-01T00:00:00Z';
    await fs.writeFile(primaryPath, JSON.stringify(state));
    assert.equal((await invoke('Status', [], false)).result.status.proxyConnected, false);
    await fs.writeFile(primaryPath, JSON.stringify(proxyState()));
  });
  await pass('PidReuseRejected', async () => {
    const state = proxyState(); state.startedAt = '2020-01-01T00:00:00Z';
    await fs.writeFile(primaryPath, JSON.stringify(state));
    assert.equal((await invoke('Status')).result.status.proxyConnected, false);
    await fs.writeFile(primaryPath, JSON.stringify(proxyState()));
  });
  await pass('ChangedSettingProtected', async () => {
    const saved = await fs.readFile(settings, 'utf8');
    await fs.writeFile(settings, '{"chatgpt.cliExecutable":"E:\\\\another.exe"}');
    const value = await invoke('Disable');
    assert.equal(value.code, 1);
    assert.equal(value.result.status.bridgePid, currentPid);
    assert.equal(value.result.status.paused, false);
    assert((await fs.readFile(settings, 'utf8')).includes('another.exe'));
    await fs.writeFile(settings, saved);
  });
  await pass('Disable', async () => {
    const value = await invoke('Disable'); success(value);
    assert.equal(value.result.status.proxyMode, 'custom');
    assert.equal(value.result.status.proxyConnected, true);
    assert.equal(value.result.status.bridgeRunning, false);
    assert.equal(await fs.readFile(settings, 'utf8'), initialSettings);
  });
  await pass('GuiOutput', async () => {
    const value = await invoke('Status', ['--gui-output']); assert.equal(value.code, 0, value.text);
    const fields = Object.fromEntries(value.text.trim().split(/\r?\n/).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.equal(fields.schemaVersion, '1');
    assert.equal(fields.stringEncoding, 'base64-utf8');
    assert.equal(fields.operationSuccess, 'true');
    assert.equal(fields.bridgeRunning, 'false');
    assert(Buffer.from(fields.message, 'base64').toString('utf8').includes('Trae'));
  });
  await pass('PortOwnerProtected', async () => {
    const sockets = new Set();
    const listener = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
    });
    await new Promise(resolve => listener.listen(port, '127.0.0.1', resolve));
    try {
      const value = await invoke('Start');
      assert.equal(value.code, 1);
      assert(value.result.message.includes('其他程序占用'));
      assert.equal((await invoke('Stop')).code, 0);
      assert.equal(listener.listening, true);
      assert.equal((await invoke('Status')).result.status.bridgeRunning, false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => listener.close(resolve));
    }
  });
  await pass('MalformedSettingsProtected', async () => {
    const bad = '{"editor.fontSize":';
    await fs.writeFile(settings, bad);
    assert.equal((await invoke('Enable')).code, 1);
    assert.equal(await fs.readFile(settings, 'utf8'), bad);
    await fs.writeFile(settings, initialSettings);
  });
  await pass('AbsentOriginalRestored', async () => {
    await fs.writeFile(settings, '{"editor.fontSize":14}');
    success(await invoke('Enable'));
    success(await invoke('Disable'));
    assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')), { 'editor.fontSize': 14 });
  });
  await pass('EmptyOriginalRestored', async () => {
    await fs.writeFile(settings, '{"editor.fontSize":14,"chatgpt.cliExecutable":""}');
    success(await invoke('Enable'));
    assert.equal((await readState()).proxy.previousCliExecutablePresent, true);
    success(await invoke('Disable'));
    assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')), { 'editor.fontSize': 14, 'chatgpt.cliExecutable': '' });
  });
  await pass('ActionMutex', async () => {
    success(await invoke('Enable'));
    await marker('relay-disconnected');
    const child = spawn(managerExe, ['--action', 'Restart', ...baseArgs, '--timeout-ms', '9000'],
      { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    const completed = new Promise(resolve => child.on('close', code => resolve({ code, output })));
    await delay(1000);
    const busy = await invoke('Stop');
    assert.equal(busy.code, 2, busy.text);
    assert(busy.result.message.includes('正忙'));
    const timedOut = await completed;
    assert.equal(timedOut.code, 1);
    await marker('relay-disconnected', false);
    success(await invoke('Stop'));
  });
  await pass('ProductionIsolation', async () => {
    assert.deepEqual(await Promise.all(productionFiles.map(hash)), hashes);
    assert(alive(process.pid));
  });
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: true, cases, realSettingsUnchanged: true }, null, 2));
  console.log(JSON.stringify({ passed: cases.length, evidence: directory }));
} finally {
  try { await invoke('Stop'); } catch {}
  for (const pid of children) if (alive(pid)) {
    try { process.kill(pid); } catch {}
  }
}
