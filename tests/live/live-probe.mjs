import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { project, build, root, executable } from '../scripts/paths.mjs';

// Explicit opt-in: connects to the actual proxy, but never sends a model prompt.
if (!process.argv.includes('--live')) throw new Error('Use --live to inspect the current proxy');
const run = path.join(build, 'live-probe', String(Date.now()));
await fs.mkdir(run, { recursive: true });
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const token = 'isolated-native-live-read';
const bridge = spawn(executable, [], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
    CODEX_PHONE_REPO_ROOT: root, CODEX_PHONE_STATE_DIR: path.join(run, 'state'),
    CODEX_PROXY_REGISTRY: path.join(root, 'proxy/runtime/instances'),
    CODEX_PHONE_TOKEN: token, CODEX_PHONE_RELAY_DISABLED: '1',
    CODEX_PHONE_AUTO_LIFECYCLE: '0', PUBLIC_URL: '' }
});
let errors = '';
bridge.stdout.on('data', () => {});
bridge.stderr.on('data', data => { errors += data; });
try {
  let status;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (bridge.exitCode !== null) throw new Error(`Probe exited: ${errors}`);
    status = await fetch(`http://127.0.0.1:${port}/api/status?token=${token}`).then(r => r.json()).catch(() => null);
    if (status?.codex.status === 'connected' && status.threads.length > 0 && status.models.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(status?.codex.status, 'connected');
  assert.ok(status.threads.length > 0);
  assert.ok(status.models.length > 0);
  let disconnectedSamples = 0;
  for (let sample = 0; sample < 60; sample++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const health = await fetch(`http://127.0.0.1:${port}/api/health?token=${token}`).then(r => r.json());
    if (health.codex.status !== 'connected') disconnectedSamples++;
  }
  const facts = { connected: true, threads: status.threads.length, models: status.models.length,
    messages: status.messages.length, proxyPids: status.codex.info.instances.map(i => i.proxyPid),
    relayDisabled: status.publicAccess.relayStatus === 'disabled', disconnectedSamples, errors };
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(JSON.stringify({ ...facts, errors: errors ? 'See local results' : '' }, null, 2));
  assert.equal(disconnectedSamples, 0, errors);
} finally {
  if (bridge.exitCode === null) { const ended = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill(); await ended; }
}
