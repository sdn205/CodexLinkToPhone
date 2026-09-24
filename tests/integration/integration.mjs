import { proxyExe } from '../fixtures/native-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { project, build, root, executable as native } from '../scripts/paths.mjs';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { WebSocket } from 'ws';

const run = path.join(build, 'integration', String(Date.now()));
const token = 'isolated-native-bridge-token';
const children = new Set(), sockets = new Set();
let bridge, relay;
const facts = {};
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(read, timeout = 15000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch (e) { last = e; } await delay(60); }
  throw last || new Error('Timed out');
}
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function child(exe, args, env = {}) {
  const p = spawn(exe, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(p); p.errors = ''; p.output = ''; p.stderr.on('data', b => p.errors += b); p.stdout.on('data', b => p.output += b); p.stdin.on('error', () => {}); return p;
}
async function stop(p) { if (!p || p.exitCode !== null) return; const ended = new Promise(r => p.once('exit', r)); p.kill(); await ended; children.delete(p); }
function memory(pid) {
  const command = `$p = Get-Process -Id ${Number(pid)}; [pscustomobject]@{ workingSetMiB = [math]::Round($p.WorkingSet64 / 1MB, 2); privateMiB = [math]::Round($p.PrivateMemorySize64 / 1MB, 2) } | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
async function socket(base) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${token}&streamProtocol=1`); sockets.add(ws);
  ws.frames = []; ws.on('message', d => { const f = JSON.parse(d); ws.frames.push(f); }); ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); return ws;
}

await fs.mkdir(run, { recursive: true });
const bridgeRoot = path.join(run, 'bridge-root'), bridgeData = path.join(bridgeRoot, 'server/data');
const uploads = path.join(bridgeData, 'uploads'), legacyUploads = path.join(bridgeRoot, '.state/uploads');
await fs.mkdir(uploads, { recursive: true });
await fs.mkdir(path.dirname(legacyUploads), { recursive: true });
await fs.symlink(path.join(root, 'public'), path.join(bridgeRoot, 'public'), 'junction');
await fs.symlink(uploads, legacyUploads, 'junction');
const imageBytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
await fs.writeFile(path.join(uploads, 'image.png'), imageBytes);
const outside = path.join(bridgeRoot, 'outside');
await fs.mkdir(outside);
await fs.writeFile(path.join(outside, 'image.png'), imageBytes);
await fs.symlink(outside, path.join(uploads, 'escape'), 'junction');
const localPort = await port(), publicPort = await port(), agentPort = await port();
const config = path.join(run, 'phone-mode.ini');
const secret = 'isolated-native-relay-secret-0123456789';
await fs.writeFile(config, `[phone]\nmode=relay\nlocal_host=127.0.0.1\nlocal_port=${localPort}\ntoken=${token}\n[relay]\nserver=127.0.0.1\nagent_port=${agentPort}\npublic_port=${publicPort}\nsecret=${secret}\nreconnect_delay_ms=500\n`, 'utf8');
const proxyState = path.join(run, 'instances');
await fs.mkdir(proxyState, { recursive: true });
const bridgeEnv = { HOST: '127.0.0.1', PORT: String(localPort), CODEX_PHONE_REPO_ROOT: bridgeRoot, CODEX_PHONE_STATE_DIR: bridgeData, CODEX_PHONE_MODE_CONFIG: config, CODEX_PROXY_REGISTRY: proxyState, CODEX_PHONE_TOKEN: token, CODEX_PHONE_AUTO_LIFECYCLE: '0', PUBLIC_URL: '' };
const local = `http://127.0.0.1:${localPort}`, remote = `http://127.0.0.1:${publicPort}`;
const health = () => fetch(`${local}/api/health?token=${token}`).then(r => r.json());
function startRelay() { return child(path.join(root, 'relay/dist/relay-server.exe'), ['run', '--public-bind', '127.0.0.1', '--public-port', String(publicPort), '--agent-bind', '127.0.0.1', '--agent-port', String(agentPort), '--secret', secret, '--log', path.join(run, 'relay.log')]); }
try {
  const proxy = child(proxyExe, ['app-server'], {
    CODEX_PHONE_REAL_CODEX_EXE: path.join(root, 'tests/build/bin/FakeCodex/release/fake-codex.exe'),
    DOTNET_ROOT: path.join(process.env.ProgramFiles, 'dotnet'), FAKE_NODE: process.execPath,
    FAKE_SCRIPT: path.join(root, 'tests/fixtures/fake-scenario-app-server.mjs'), FAKE_SCENARIO_LOG: path.join(run, 'fake.log'),
    CODEX_PHONE_REPO_ROOT: root, CODEX_PROXY_REGISTRY: proxyState, CODEX_PROXY_LOG: path.join(run, 'proxy.log'), CODEX_PHONE_AUTO_START: '0'
  });
  const replies = []; readline.createInterface({ input: proxy.stdout, crlfDelay: Infinity }).on('line', line => { try { replies.push(JSON.parse(line)); } catch {} });
  const ask = async (id, method, params = {}) => { proxy.stdin.write(JSON.stringify({ id, method, params }) + '\n'); return wait(() => replies.find(x => x.id === id)); };
  const initialized = await ask('initialize', 'initialize', { clientInfo: { name: 'native-test', title: 'Native bridge integration', version: '26.901.22334' }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true, requestAttestation: false } });
  assert.equal(initialized.error, undefined);
  await wait(async () => (await fs.readdir(proxyState)).some(f => f.endsWith('.json')));

  relay = startRelay();
  bridge = child(native, [], { ...bridgeEnv, CODEX_PHONE_RELAY_DISABLED: '0' });
  console.log('Measuring native bridge', bridge.pid);
  await wait(async () => { const h = await health(); return h.codex.status === 'connected' && h.publicAccess.relayStatus === 'connected'; });
  await delay(1000); facts.nativeBridgeWithRelay = memory(bridge.pid);
  assert.equal((await fetch(`${local}/api/health?token=wrong`)).status, 401);
  assert.equal((await fetch(`${remote}/api/status?token=wrong`)).status, 401);
  const html = await fetch(`${remote}/`); assert.equal(html.status, 200); assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await html.arrayBuffer()), await fs.readFile(path.join(root, 'public/index.html')));
  const css = await fs.readdir(path.join(root, 'public/styles')).catch(() => []);
  const asset = css.length ? `/styles/${css[0]}` : '/app.js';
  const expected = await fs.readFile(path.join(root, 'public', asset));
  await Promise.all(Array.from({ length: 12 }, async () => { const r = await fetch(remote + asset); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), expected); }));
  const qr = await fetch(`${remote}/qr.svg?token=${token}`); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
  assert.equal((await fetch(`${local}/local-image?token=${token}&path=${encodeURIComponent(path.join(root, 'public/index.html'))}`)).status, 404);
  const imageResponse = file => fetch(`${local}/local-image?token=${token}&path=${encodeURIComponent(file)}`);
  for (const directory of [uploads, legacyUploads]) {
    const image = await imageResponse(path.join(directory, 'image.png'));
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
    assert.equal((await imageResponse(path.join(directory, 'escape/image.png'))).status, 404);
  }
  assert.equal((await imageResponse(path.join(outside, 'image.png'))).status, 404);
  assert.equal((await imageResponse(legacyUploads + '/../outside/image.png')).status, 404);
  await fs.unlink(legacyUploads);
  await fs.symlink(outside, legacyUploads, 'junction');
  assert.equal((await imageResponse(path.join(legacyUploads, 'image.png'))).status, 404);
  await fs.unlink(legacyUploads);
  await fs.symlink(uploads, legacyUploads, 'junction');
  facts.migratedImagesAndPathBoundaries = 'passed';
  const phone = await socket(remote); await wait(() => phone.frames.some(f => f.type === 'state' && f.state.currentThreadId === 'thread-a'));
  phone.send(JSON.stringify({ type: 'state:request' })); await wait(() => phone.frames.filter(f => f.type === 'state').length >= 2);
  facts.httpAuthStaticQrParallelAndWebSocket = 'passed';
  await stop(relay); await wait(async () => (await health()).publicAccess.relayStatus === 'disconnected'); relay = startRelay();
  await wait(async () => (await health()).publicAccess.relayStatus === 'connected');
  assert.equal((await fetch(`${remote}/api/health?token=${token}`)).status, 200); facts.relayReconnect = 'passed';
  const before = await health(), proxyPid = before.codex.info.proxyPid, upstreamPid = before.codex.info.upstreamPid;
  await stop(bridge); assert.equal(proxy.exitCode, null); await ask('bridge-stopped', 'test/old-delta');
  bridge = child(native, [], { ...bridgeEnv, CODEX_PHONE_RELAY_DISABLED: '0' });
  const after = await wait(async () => { const h = await health(); return h.codex.status === 'connected' && h.publicAccess.relayStatus === 'connected' ? h : null; });
  assert.equal(after.codex.info.proxyPid, proxyPid); assert.equal(after.codex.info.upstreamPid, upstreamPid);
  assert.notEqual(after.app.bridgeEpoch, before.app.bridgeEpoch); await ask('bridge-restarted', 'test/old-delta');
  facts.bridgeRestartPreservedProxyAndUpstream = { proxyPid, upstreamPid };
  const modules = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${bridge.pid}).Modules | Select-Object -ExpandProperty ModuleName | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
  assert.equal(modules.status, 0); assert.doesNotMatch(modules.stdout, /coreclr|hostfxr|node\.dll/i); facts.nativeRuntimeIndependent = true;
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(JSON.stringify(facts, null, 2));
} catch (error) {
  for (const p of children) console.error(`child pid=${p.pid} exit=${p.exitCode}: ${p.errors} ${p.output.slice(0,1500)}`);
  throw error;
} finally {
  for (const ws of sockets) ws.terminate();
  for (const p of children) await stop(p);
}
