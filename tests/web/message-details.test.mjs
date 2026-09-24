import assert from "node:assert/strict";
import test from "node:test";
import { createMessageDetails } from "../../public/state/message-details.js";
import { streamTextHash } from "../../public/transport/stream-protocol.js";

const body = "command\n\n" + "输出".repeat(6000);
const full = (text = body, threadId = "a") => ({
  id: "command-1", role: "tool", kind: "command", text, textHash: streamTextHash(text),
  originalLength: text.length, textTruncated: false, streaming: false,
  meta: { threadId, turnId: "turn-1", status: "completed", aggregatedOutput: text.slice(9) }
});
const compact = (text = body, threadId = "a") => {
  const message = full(text, threadId);
  delete message.meta.aggregatedOutput;
  return { ...message, text: "command\n\n[folded]", textTruncated: true };
};
const state = (messages = [compact()], epoch = "epoch-a") => ({ app: { bridgeEpoch: epoch }, messages });
function fixture(timeoutMs) {
  const sent = [], errors = [];
  let changes = 0, connected = true;
  const details = createMessageDetails({
    send: (request) => { sent.push(request); return connected; },
    createRequestId: () => "request-" + sent.length,
    onChange: () => changes++, onError: (error) => errors.push(error), timeoutMs
  });
  details.projectState(state());
  return { details, sent, errors, get changes() { return changes; }, set connected(value) { connected = value; } };
}
function load(f, message = full()) {
  assert.equal(f.details.request(compact(message.text, message.meta.threadId)), true);
  assert.equal(f.details.receive({ requestId: f.sent.at(-1).requestId, ok: true, message }), true);
}

test("full output survives snapshots, paging, thread switches and reconnects while metadata stays current", () => {
  const f = fixture(); load(f);
  const original = state();
  assert.equal(f.details.projectState(original).messages[0].text, body);
  assert.equal(original.messages[0].textTruncated, true, "projection does not mutate wire state");
  f.details.projectState(state([compact("other thread", "b")]));
  f.details.disconnect();
  const update = compact(); update.revision = 100; update.meta.status = "failed"; update.meta.exitCode = 1;
  const restored = f.details.projectState(state([compact("earlier item", "c"), update])).messages[1];
  assert.equal(restored.text, body);
  assert.equal(restored.textTruncated, false);
  assert.equal(restored.meta.aggregatedOutput, full().meta.aggregatedOutput);
  assert.equal(restored.meta.status, "failed");
  assert.equal(restored.meta.exitCode, 1);
  assert.equal(restored.revision, 100);
  assert.equal(f.details.request(restored), false);
  assert.equal(f.sent.length, 1, "sync does not download the output again");
});

test("changed hidden content invalidates cached full text even at the same length", () => {
  const f = fixture(); load(f);
  const changedBody = body.slice(0, 7000) + "改" + body.slice(7001);
  const changed = f.details.projectState(state([compact(changedBody)])).messages[0];
  assert.equal(changed.textTruncated, true);
  load(f, full(changedBody));
  assert.equal(f.details.projectState(state([compact(changedBody)])).messages[0].text, changedBody);
});

test("an out-of-order detail response cannot restore superseded content", () => {
  const f = fixture(); f.details.request(compact()); const oldId = f.sent.at(-1).requestId;
  const changedBody = body + "next";
  f.details.projectState(state([compact(changedBody)]));
  assert.equal(f.details.request(compact(changedBody)), true);
  assert.equal(f.details.receive({ requestId: oldId, ok: true, message: full() }), false);
  assert.equal(f.details.receive({ requestId: f.sent.at(-1).requestId, ok: true, message: full(changedBody) }), true);
  assert.equal(f.details.projectState(state([compact(changedBody)])).messages[0].text, changedBody);
});

test("a detail reply received after switching threads is cached only for its source thread", () => {
  const f = fixture(); f.details.request(compact());
  f.details.projectState(state([compact("other thread", "b")]));
  f.details.receive({ requestId: f.sent.at(-1).requestId, ok: true, message: full() });
  assert.equal(f.details.projectState(state([compact("other thread", "b")])).messages[0].textTruncated, true);
  assert.equal(f.details.projectState(state()).messages[0].text, body);
});

test("disconnects and failed sends release pending loads for retry", () => {
  const f = fixture(); f.details.request(compact()); const oldId = f.sent.at(-1).requestId;
  assert.equal(f.details.request(compact()), false);
  f.details.disconnect();
  assert.equal(f.details.receive({ requestId: oldId, ok: true, message: full() }), false);
  f.connected = false; assert.equal(f.details.request(compact()), false);
  f.connected = true; load(f);
  assert.equal(f.details.projectState(state()).messages[0].text, body);
});

test("timeouts release pending loads and malformed replies never mark content loaded", async () => {
  const f = fixture(10); f.details.request(compact());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.errors.length, 1);
  f.details.request(compact());
  assert.equal(f.details.receive({ requestId: f.sent.at(-1).requestId, ok: true, message: full(body, "b") }), false);
  assert.equal(f.details.projectState(state()).messages[0].textTruncated, true);
  load(f);
});

test("a new bridge epoch discards cached and pending details", () => {
  const f = fixture(); load(f);
  assert.equal(f.details.projectState(state(undefined, "epoch-b")).messages[0].textTruncated, true);
  f.details.request(compact()); const oldId = f.sent.at(-1).requestId;
  f.details.projectState(state(undefined, "epoch-c"));
  assert.equal(f.details.receive({ requestId: oldId, ok: true, message: full() }), false);
  load(f);
});
