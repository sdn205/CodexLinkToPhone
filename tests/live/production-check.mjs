import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { project, root, build } from '../scripts/paths.mjs';

// Read the live bridge and its public route without sending a model message.
const config = {};
let section = '';
for (const raw of (await fs.readFile(path.join(root, 'config/phone-mode.ini'), 'utf8')).split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith(';')) continue;
  if (line.startsWith('[')) { section = line.slice(1, -1); continue; }
  const equals = line.indexOf('=');
  if (equals > 0) config[`${section}.${line.slice(0, equals).trim()}`] = line.slice(equals + 1).trim();
}
const token = encodeURIComponent(config['phone.token']);
const local = `http://127.0.0.1:${config['phone.local_port']}`;
const get = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); assert.equal(r.status, 200); return r.json(); };
const health = await get(`${local}/api/health?token=${token}`);
assert.equal(health.codex.status, 'connected');
assert.equal(health.publicAccess.relayStatus, 'connected');
const remote = health.app.publicUrl.replace(/\/$/, '');
assert.equal((await fetch(`${remote}/api/health?token=invalid`, { signal: AbortSignal.timeout(15000) })).status, 401);
const publicHealth = await get(`${remote}/api/health?token=${token}`);
assert.equal(publicHealth.app.bridgeEpoch, health.app.bridgeEpoch);
const html = await fetch(`${remote}/`, { signal: AbortSignal.timeout(15000) });
assert.deepEqual(Buffer.from(await html.arrayBuffer()), await fs.readFile(path.join(root, 'public/index.html')));
const ws = new WebSocket(`${remote.replace(/^http/, 'ws')}/ws?token=${token}&streamProtocol=1`);
let state;
try {
  state = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Public WebSocket state timed out')), 15000);
    ws.on('error', error => { clearTimeout(deadline); reject(error); });
    ws.on('message', data => { const f = JSON.parse(data); if (f.type === 'state') { clearTimeout(deadline); resolve(f.state); } });
  });
  assert.equal(state.codex.status, 'connected');
} finally { ws.terminate(); }
const command = `$p = Get-Process -Id ${Number(health.app.pid)}; [pscustomobject]@{ executable=$p.Path; workingSetMiB=[math]::Round($p.WorkingSet64/1MB,2); privateMiB=[math]::Round($p.PrivateMemorySize64/1MB,2); modules=@($p.Modules | Select-Object -ExpandProperty ModuleName) } | ConvertTo-Json -Compress`;
const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 0);
const processInfo = JSON.parse(result.stdout);
assert.equal(path.resolve(processInfo.executable).toLowerCase(), path.join(project, 'dist/codex-phone-bridge.exe').toLowerCase());
assert.ok(!processInfo.modules.some(name => /coreclr|hostfxr|node\.dll/i.test(name)));
const facts = { bridgePid: health.app.pid, proxyPid: health.codex.info.proxyPid,
  upstreamPid: health.codex.info.upstreamPid, publicHttp: true, publicWebSocket: true,
  authBoundary: true, externalFrontend: true, nativeRuntimeIndependent: true,
  threads: state.threads.length, visibleMessages: state.messages.length,
  memory: { workingSetMiB: processInfo.workingSetMiB, privateMiB: processInfo.privateMiB } };
await fs.mkdir(path.join(build, 'verification'), { recursive: true });
await fs.writeFile(path.join(build, 'verification/production.json'), JSON.stringify(facts, null, 2), 'utf8');
console.log(JSON.stringify(facts, null, 2));
