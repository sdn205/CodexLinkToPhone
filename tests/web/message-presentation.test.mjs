import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createMessagePresentation } from '../../public/conversation/message-presentation.js';

const view = createMessagePresentation({ getState: () => ({ app: { cwd: 'E:/project' } }),
  getToken: () => 'test-token', formatElapsed: value => `${value / 1000}s` });

test('C# command, dynamic tool and plan projections retain browser display data', () => {
  const { command, tool, plan } = JSON.parse(fs.readFileSync(new URL('../build/contracts/projection.json', import.meta.url), 'utf8'));
  assert.equal(view.toolTitle(command), 'git status');
  assert.equal(view.toolOutput(command), 'clean');
  assert.equal(view.toolStatusKey(command), 'running');
  assert.equal(view.dynamicToolName(tool), 'tools.lookup');
  assert.equal(view.imagesForMessage(tool).length, 1);
  assert.deepEqual(view.planStepsForMessage(plan, plan.text), [{ index: 1, text: 'test', status: 'in_progress' }]);
});

test('all three diff presentations stay distinct and paths are normalized', () => {
  assert.equal(view.fileChangesForMessage({ meta: { changes: [{ path: 'E:\\project\\a.js', added: 1, deleted: 1 }] } })[0].path, 'a.js');
  for (const display of ['timeline_rows', 'above_composer', 'completed_card']) {
    const message = { kind: 'turn_diff', meta: { display } };
    assert.equal(view.isAboveComposerTurnDiff(message), display === 'above_composer');
    assert.equal(view.isTimelineRowsTurnDiff(message), display === 'timeline_rows');
    assert.equal(view.isCompletedTurnDiffCard(message), display === 'completed_card');
  }
});

test('display transformations preserve quoted code and original message', () => {
  const message = { role: 'assistant', text: '`![example](https://example.test/a.png)`', meta: {} };
  const before = structuredClone(message);
  assert.equal(view.displayTextForMessage(message), message.text);
  assert.equal(view.imagesForMessage(message, message.text).length, 0);
  assert.deepEqual(message, before);
  assert.equal(view.displayFilePath('\\\\host\\share\\a.js'), '//host/share/a.js');
});
