import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, build, testRoot } from '../scripts/paths.mjs';
export const proxyExe = process.env.PROXY_TEST_EXE || path.join(root, 'proxy/dist/codex-phone.exe');
export const fake = path.join(build, 'bin/FakeCodex/release/fake-codex.exe');
const sdk = path.join(process.env.ProgramFiles || 'C:\Program Files', 'dotnet');
export const fixtureEnvironment = { DOTNET_ROOT: sdk, DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  TEMP: path.join(build, 'temp'), TMP: path.join(build, 'temp') };
fs.accessSync(proxyExe);
fs.mkdirSync(fixtureEnvironment.TEMP, { recursive: true });
if (!fs.existsSync(fake) || ['Program.cs', 'FakeCodex.csproj'].some(name =>
  fs.statSync(path.join(testRoot, 'fixtures/FakeCodex', name)).mtimeMs > fs.statSync(fake).mtimeMs)) {
  const result = spawnSync(path.join(sdk, 'dotnet.exe'), ['build', path.join(testRoot, 'fixtures/FakeCodex/FakeCodex.csproj'), '-c', 'Release', '--nologo'], {
    cwd: root, env: { ...process.env, ...fixtureEnvironment }, windowsHide: true, encoding: 'utf8'
  });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stdout + result.stderr);
}
export function fakeEnv(script) {
  return { ...fixtureEnvironment, CODEX_PHONE_REAL_CODEX_EXE: fake,
    FAKE_SCRIPT: script, FAKE_NODE: process.execPath, CODEX_PHONE_REPO_ROOT: root };
}
