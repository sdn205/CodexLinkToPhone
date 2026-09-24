import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, build } from '../scripts/paths.mjs';

const exec = promisify(execFile);
const directory = path.join(build, 'state-migration', String(Date.now()));
const script = path.join(root, 'assistant/scripts/migrate-state.ps1');
const run = target => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-RepositoryRoot', target],
  { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value), 'utf8');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

for (const originalPresent of [false, true]) {
  const target = path.join(directory, originalPresent ? 'empty-original' : 'absent-original');
  const legacy = path.join(target, '.state');
  await fs.mkdir(path.join(legacy, 'uploads'), { recursive: true });
  await fs.mkdir(path.join(legacy, 'trae-proxy.json.instances'));
  await writeJson(path.join(legacy, 'phone-selection.json'), { version: 1, threadId: originalPresent ? '' : 'selected-thread' });
  await writeJson(path.join(legacy, 'unread-threads.json'), ['unread-a', 'unread-b']);
  const operations = { version: 4, updatedAt: 'unchanged', messageRequests: [{ requestId: 'unknown-request', status: 'uncertain' }],
    pendingThreadTitles: [{ threadId: 'title-thread', prompt: 'title prompt' }],
    discardedPlanTurns: Array.from({ length: 500 }, (_, i) => ({ threadId: 'thread-' + (i % 5), turnId: 'turn-' + i })) };
  const operationBytes = JSON.stringify(operations, null, 2) + '\n';
  await fs.writeFile(path.join(legacy, 'phone-operations.json'), operationBytes);
  const backup = path.join(legacy, 'trae-settings-before-phone-mode-fixture.json');
  await fs.writeFile(backup, '{"chatgpt.cliExecutable":""}');
  await writeJson(path.join(legacy, 'phone-proxy-mode.json'), { settingsPath: path.join(target, 'settings.json'), backupPath: backup,
    previousCliExecutablePresent: originalPresent, previousCliExecutable: '', updatedAt: 'unchanged',
    targetExtensionVersion: 'obsolete', targetCliVersion: 'obsolete', extensionVersion: 'obsolete', cliVersion: 'obsolete', compatible: true });
  const recent = { action: 'Stop', success: true, message: 'fixture', completedAt: 'unchanged' };
  const pause = { paused: true, traeSessionId: 'current-session' };
  await writeJson(path.join(legacy, 'phone-manager-recent.json'), recent);
  await writeJson(path.join(legacy, 'phone-bridge-pause.json'), pause);
  await writeJson(path.join(legacy, 'token.json'), { token: 'fixture-token' });
  await writeJson(path.join(legacy, 'relay-agent.json'), { status: 'connected' });
  const image = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  await fs.writeFile(path.join(legacy, 'uploads/image.png'), image);
  await fs.writeFile(path.join(legacy, 'uploads/duplicate.png'), image);
  await writeJson(path.join(legacy, 'trae-proxy.json.instances/current.json'), { instanceId: 'current' });
  await fs.writeFile(path.join(legacy, 'codex-proxy-native.log'), 'old proxy log\n');
  await fs.writeFile(path.join(legacy, 'phone-bridge-8787.err.log'), 'old bridge log\n');

  await run(target);
  const state = await readJson(path.join(target, 'server/data/state.json'));
  assert.deepEqual(state.selection, { threadId: originalPresent ? '' : 'selected-thread' });
  assert.deepEqual(state.unreadThreads, ['unread-a', 'unread-b']);
  assert.equal(await fs.readFile(path.join(target, 'server/data/operations.json'), 'utf8'), operationBytes);
  const manager = await readJson(path.join(target, 'assistant/data/state.json'));
  assert.equal(manager.version, 1);
  assert.equal(manager.proxy.previousCliExecutablePresent, originalPresent);
  assert.equal(manager.proxy.previousCliExecutable, '');
  assert.deepEqual(Object.keys(manager.proxy).sort(), ['settingsPath', 'backupPath', 'previousCliExecutablePresent', 'previousCliExecutable', 'updatedAt'].sort());
  assert.equal(await fs.readFile(manager.proxy.backupPath, 'utf8'), '{"chatgpt.cliExecutable":""}');
  assert.deepEqual(manager.recent, recent);
  assert.deepEqual(manager.pause, pause);
  assert.deepEqual(await fs.readFile(path.join(legacy, 'uploads/image.png')), image);
  assert.deepEqual(await fs.readFile(path.join(target, 'server/data/uploads/duplicate.png')), image);
  await fs.writeFile(path.join(legacy, 'trae-proxy.json.instances/next.json'), '{"heartbeat":true}');
  assert.deepEqual(await readJson(path.join(target, 'proxy/runtime/instances/next.json')), { heartbeat: true });
  await fs.appendFile(path.join(legacy, 'codex-proxy-native.log'), 'next heartbeat\n');
  assert.equal(await fs.readFile(path.join(target, 'proxy/logs/proxy.log'), 'utf8'), 'old proxy log\nnext heartbeat\n');
  assert.equal(await fs.readFile(path.join(target, 'server/logs/phone-bridge-8787.err.log'), 'utf8'), 'old bridge log\n');
  const backupDirs = (await fs.readdir(path.join(target, 'assistant/backups'))).filter(name => name.startsWith('state-migration-'));
  assert.equal(backupDirs.length, 1);
  assert.equal(await fs.readFile(path.join(target, 'assistant/backups', backupDirs[0], 'phone-operations.json'), 'utf8'), operationBytes);
  assert.deepEqual((await fs.readdir(legacy)).sort(), ['codex-proxy-native.log', 'trae-proxy.json.instances', 'uploads'].sort());
  const stateBefore = await fs.readFile(path.join(target, 'server/data/state.json'), 'utf8');
  await run(target);
  assert.equal(await fs.readFile(path.join(target, 'server/data/state.json'), 'utf8'), stateBefore);
}
for (const unread of [[], ['only-unread']]) {
  const target = path.join(directory, 'unread-only-' + unread.length);
  await fs.mkdir(path.join(target, '.state'), { recursive: true });
  await writeJson(path.join(target, '.state/unread-threads.json'), unread);
  await run(target);
  const state = await readJson(path.join(target, 'server/data/state.json'));
  assert.equal(state.selection, null, 'absence of a saved selection must keep desktop following');
  assert.deepEqual(state.unreadThreads, unread);
  await run(target);
}
const conflict = path.join(directory, 'conflict');
await fs.mkdir(path.join(conflict, '.state'), { recursive: true });
await fs.mkdir(path.join(conflict, 'server/data'), { recursive: true });
await writeJson(path.join(conflict, '.state/phone-selection.json'), { threadId: 'old' });
await writeJson(path.join(conflict, 'server/data/state.json'), { selection: { threadId: 'new' } });
await assert.rejects(run(conflict));
assert.deepEqual(await readJson(path.join(conflict, '.state/phone-selection.json')), { threadId: 'old' });
assert.deepEqual(await readJson(path.join(conflict, 'server/data/state.json')), { selection: { threadId: 'new' } });
console.log('PASS state-migration: data, empty/absent setting, legacy paths, repeat and conflict protection');
