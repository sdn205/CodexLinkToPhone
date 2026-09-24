import assert from "node:assert/strict";
import test from "node:test";
import { reducePhoneState } from "../../public/state/phone-state.js";
import { createSubmissionState } from "../../public/state/submission-state.js";
import { streamTextHash } from "../../public/transport/stream-protocol.js";

const message = (id, text = id) => ({ id, role: "assistant", kind: "text", text, meta: { threadId: "a", turnId: "turn-a" } });
const snapshot = () => ({
  currentThreadId: "a", threadRevision: 4, busy: true, messages: [message("first")],
  app: { bridgeEpoch: "epoch-a" }, codex: {}, threads: [], models: [], sync: {}
});

test("snapshots respect revision within a bridge epoch and accept a new process", () => {
  const state = snapshot();
  const older = { ...snapshot(), threadRevision: 1 };
  assert.equal(reducePhoneState(state, { type: "state", state: older }).status, "ignored");
  const restarted = { ...older, app: { bridgeEpoch: "epoch-b" } };
  assert.equal(reducePhoneState(state, { type: "state", state: restarted }, { firstForConnection: true }).status, "applied");
});

test("reconnecting to the same bridge establishes a new PhoneSession revision baseline", () => {
  const previous = { ...snapshot(), threadRevision: 8 };
  const reconnected = { ...snapshot(), threadRevision: 7, busy: false };
  const first = reducePhoneState(previous, { type: "state", state: reconnected }, { firstForConnection: true });
  assert.equal(first.status, "applied");
  assert.equal(first.state.busy, false);
  const update = reducePhoneState(first.state, { type: "state:patch", patch: { messages: { items: [message("first", "after reconnect")] } } });
  assert.equal(update.state.messages[0].text, "after reconnect");
  assert.equal(reducePhoneState(update.state, { type: "state", state: { ...snapshot(), threadRevision: 6 } }).status, "ignored");
  assert.equal(reducePhoneState(update.state, { type: "state:patch", patch: { threadRevision: 6, busy: true } }).status, "ignored");
});

test("a missing patch item cannot partially change runtime or messages", () => {
  const state = snapshot();
  const before = structuredClone(state);
  const result = reducePhoneState(state, { type: "state:patch", patch: { busy: false, messages: { ids: ["missing"] } } });
  assert.equal(result.status, "gap");
  assert.equal(result.state, state);
  assert.deepEqual(state, before);
});

test("cross-thread patches require their own snapshot baseline", () => {
  const state = snapshot();
  assert.equal(reducePhoneState(state, { type: "state:patch", patch: { currentThreadId: "b", messages: { ids: [] } } }).status, "gap");
  assert.equal(state.currentThreadId, "a");
});

test("message patch identity and order come from one state transition", () => {
  const state = snapshot();
  const result = reducePhoneState(state, { type: "state:patch", patch: {
    busy: false, messages: { ids: ["second", "first"], items: [message("second"), message("first", "updated")] }
  } });
  assert.equal(result.status, "applied");
  assert.deepEqual(result.state.messages.map((entry) => entry.id), ["second", "first"]);
  assert.equal(result.state.messages[1].text, "updated");
  assert.equal(state.messages[0].text, "first");
});

test("stream append and completion share the snapshot message model", () => {
  const state = snapshot();
  const frame = {
    type: "stream:append", threadId: "a", turnId: "turn-a", messageId: "stream", frameId: 1,
    offset: 0, delta: "hello", afterId: "first", message: message("stream", "")
  };
  const appended = reducePhoneState(state, frame);
  assert.equal(appended.status, "applied");
  assert.equal(appended.inserted, true);
  assert.deepEqual(appended.ack, { ok: true, offset: 5 });
  assert.equal(state.messages.length, 1);
  const completed = reducePhoneState(appended.state, {
    type: "stream:complete", threadId: "a", messageId: "stream", offset: 5, textHash: streamTextHash("hello"), message: { revision: 9 }
  });
  assert.equal(completed.status, "applied");
  assert.equal(completed.state.messages[1].text, "hello");
  assert.equal(completed.state.messages[1].streaming, false);
});

test("bad stream offsets and hashes leave prior state intact", () => {
  const state = snapshot();
  const rejected = reducePhoneState(state, { type: "stream:append", threadId: "a", messageId: "first", frameId: 1, offset: 0, delta: "wrong" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.state, state);
  const gap = reducePhoneState(state, { type: "stream:complete", threadId: "a", messageId: "first", offset: 5, textHash: "wrong" });
  assert.equal(gap.status, "gap");
  assert.equal(gap.state, state);
});

test("a submission has only one active state and stale callbacks cannot replace it", () => {
  const state = createSubmissionState();
  const a = { threadId: "a", payload: { requestId: "a" } };
  const b = { threadId: "b", payload: { requestId: "b" } };
  state.start(a);
  assert.equal(state.pending, a);
  assert.equal(state.recoverable, null);
  state.recover(a);
  assert.equal(state.pending, null);
  assert.equal(state.recoverable, a);
  state.start(b);
  assert.equal(state.recover(a), false);
  assert.equal(state.settle("a"), null);
  assert.equal(state.pending, b);
  assert.equal(state.settle("b"), b);
  assert.equal(state.current, null);
});

test("canonical confirmation must match both client identity and thread", () => {
  const state = createSubmissionState();
  state.start({ threadId: "a", payload: { type: "message:send", requestId: "request", clientUserMessageId: "client" } });
  const accepted = { id: "canonical", role: "user", meta: { threadId: "b", turnId: "turn", clientUserMessageId: "client" } };
  assert.equal(state.confirmation([accepted], "b"), null);
  accepted.meta.threadId = "a";
  accepted.meta.submissionState = "pending";
  assert.equal(state.confirmation([accepted], "a"), null);
  accepted.meta.submissionState = "accepted";
  assert.equal(state.confirmation([accepted], "a").requestId, "request");
});
