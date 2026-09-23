import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  if (!message.method) { send({ method: 'test/responseSeen', params: message }); return; }
  const p = message.params || {};
  switch (message.method) {
    case 'initialize': send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.153.4' } }); break;
    case 'test/echo': send({ id: message.id, result: p }); break;
    case 'test/delay': setTimeout(() => send({ id: message.id, result: { thread: {
      id: p.threadId || 'late-thread', name: '', status: { type: 'idle' }, turns: []
    } } }), p.delay || 100); break;
    case 'test/approval':
      send({ id: p.requestId, method: 'item/commandExecution/requestApproval', params: { threadId: 'wire-thread' } });
      send({ id: message.id, result: {} }); break;
    case 'test/burst':
      for (let i = 0; i < p.count; i++) send({ method: 'test/event', params: { index: i, text: '中🙂' + 'x'.repeat(p.size || 64) } });
      send({ id: message.id, result: { count: p.count } }); break;
    case 'test/exit': process.exit(p.code || 7); break;
    default: send({ id: message.id, result: {} });
  }
});
input.on('close', () => process.exit(0));
