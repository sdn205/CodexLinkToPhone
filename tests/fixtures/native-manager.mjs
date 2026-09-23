import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, build } from '../scripts/paths.mjs';

const output = path.join(build, 'assistant');
export const managerExe = process.env.ASSISTANT_TEST_EXE || path.join(output, 'Release/CodexPhoneAssistant.exe');
export const managerFixture = path.join(output, 'Release/phone-manager-fixture.exe');
const sources = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (/\.(cpp|h|hpp)$/.test(entry.name)) sources.push(file);
  }
}
collect(path.join(root, 'assistant/src'));
collect(path.join(root, 'tests/assistant'));
sources.push(path.join(root, 'assistant/CMakeLists.txt'));
const latest = Math.max(...sources.map(file => fs.statSync(file).mtimeMs));
if (!fs.existsSync(managerExe) || !fs.existsSync(managerFixture) ||
    Math.min(fs.statSync(managerExe).mtimeMs, fs.statSync(managerFixture).mtimeMs) < latest) {
  const temp = path.join(build, 'temp');
  fs.mkdirSync(temp, { recursive: true });
  for (const args of [
    ['-S', path.join(root, 'assistant'), '-B', output, '-A', 'x64'],
    ['--build', output, '--config', 'Release']
  ]) {
    const result = spawnSync('cmake', args, { cwd: root, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, TEMP: temp, TMP: temp }, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw result.error || new Error(result.stdout + result.stderr);
  }
}
