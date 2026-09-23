import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root, testRoot, build, executable } from './paths.mjs';
import '../fixtures/native-fixture.mjs';
const suites = { complex: 'integration/complex-test.mjs', ui: 'web/ui-test.mjs',
  latency: 'integration/latency-audit.mjs', lifecycle: 'integration/lifecycle-test.mjs', todo: 'web/todo-regression.mjs' };
const suite = process.argv[2] || 'complex';
if (!suites[suite]) throw new Error('Unknown suite: ' + suite);
const runDir = path.join(build, 'regression', suite, String(Date.now()));
await fs.mkdir(runDir, { recursive: true });
const child = spawn(process.execPath, [path.join(testRoot, suites[suite])], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BRIDGE_TEST_EXE: executable, BRIDGE_TEST_DIR: path.join(runDir, 'state'), BRIDGE_SCREENSHOT_DIR: path.join(runDir, 'screenshots') }
});
let output = '';
for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]])
  stream.on('data', data => { output += data; target.write(data); });
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
await fs.writeFile(path.join(runDir, 'result.txt'), output, 'utf8');
process.exitCode = code ?? 1;
