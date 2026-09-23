import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testRoot } from './paths.mjs';

const manifest = JSON.parse(await fs.readFile(path.join(testRoot, 'coverage.json'), 'utf8'));
assert.equal(manifest.files.length, 22, 'The 22 baseline module test files must remain mapped');
assert.equal(new Set(manifest.files.map(f => f.baseline)).size, 22);
let count = 0;
for (const file of manifest.files) {
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert(file.cases.length > 0, file.baseline);
  for (const entry of file.cases) {
    assert(entry.name && entry.checks.length > 0, file.baseline);
    for (const check of entry.checks) {
      const target = path.resolve(testRoot, check.file);
      assert(target.startsWith(testRoot + path.sep), 'Test reference escaped tests');
      const source = await fs.readFile(target, 'utf8');
      assert(source.includes(check.name), `${file.baseline}: missing ${check.name} in ${check.file}`);
    }
    count++;
  }
}
assert.equal(count, 93, 'All 89 named cases and four assertion scripts must remain mapped');
console.log(`PASS coverage references: 22 baseline files, ${count} mapped entries`);
