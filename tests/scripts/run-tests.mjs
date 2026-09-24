import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root, build } from './paths.mjs';

const suites = ['coverage', 'front-modules', 'bridge-modules', 'web-modules', 'proxy-contracts', 'registry', 'registration-faults',
  'stability', 'complex', 'ui', 'todo', 'latency', 'lifecycle', 'routing', 'history', 'delivery',
  'bridge-integration', 'manager', 'assistant', 'relay', 'relay-client', 'relay-slow'];
const directory = path.join(build, 'runs', String(Date.now()));
fs.mkdirSync(directory, { recursive: true });
const results = [];
for (const name of suites) {
  console.log(`\nRunning ${name}`);
  const started = Date.now(), log = path.join(directory, name + '.log');
  const output = fs.createWriteStream(log);
  const code = await new Promise(resolve => {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `npm run test:${name}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('npm', ['run', `test:${name}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { process.stdout.write(data); output.write(data); });
    child.stderr.on('data', data => { process.stderr.write(data); output.write(data); });
    child.on('error', error => { output.write(String(error)); resolve(1); });
    child.on('close', value => resolve(value ?? 1));
  });
  await new Promise(resolve => output.end(resolve));
  results.push({ suite: name, passed: code === 0, exitCode: code, durationMs: Date.now() - started, log });
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
}
fs.writeFileSync(path.join(build, 'results-latest.json'), JSON.stringify(results, null, 2));
console.log(`\nSuites: ${results.filter(r => r.passed).length}/${results.length} passed; evidence: ${directory}`);
process.exitCode = results.every(r => r.passed) ? 0 : 1;
