import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args), "utf8");
}
const listenIndex = args.findIndex((arg) => arg === "--listen");
const listenValue = listenIndex >= 0 ? args[listenIndex + 1] : args.find((arg) => arg.startsWith("--listen="))?.slice("--listen=".length);
if (!listenValue) runStdio();
else runWebSocket(listenValue);

function runWebSocket(value) {
  const url = new URL(value);
  const server = new WebSocketServer({ host: url.hostname, port: Number(url.port) });
  server.on("connection", (ws) => {
    if (process.env.FAKE_SEND_BUSY === "1") {
      sendBusyState((message) => ws.send(JSON.stringify(message)));
    }

    ws.on("message", (data) => {
      handleMessage(data.toString("utf8"), (message) => ws.send(JSON.stringify(message)));
    });
  });
}

function runStdio() {
  if (process.env.FAKE_SEND_BUSY === "1") {
    sendBusyState(write);
  }

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => handleMessage(line, write));
  input.on("close", () => process.exit(0));
}

function handleMessage(line, send) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
    if (message.method === "initialize" && !isCurrentInitializeParams(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "invalid 0.153.4 initialize params" } });
      return;
    }
    if (message.method === "test/status-idle") {
      send({
        method: "thread/status/changed",
        params: {
          threadId: "fake-thread",
          status: { type: "idle" }
        }
      });
    }
    if (message.method === "test/subagent-events") {
      const subagentThread = fakeThread("fake-subagent-thread", {
        sessionId: "fake-session",
        parentThreadId: "fake-thread",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "fake-thread",
              depth: 1,
              agent_path: "test-agent"
            }
          }
        }
      });
      send({
        method: "thread/started",
        params: {
          thread: subagentThread
        }
      });
      send({
        method: "turn/started",
        params: {
          threadId: "fake-subagent-thread",
          turn: fakeTurn("fake-subagent-turn")
        }
      });
      send({
        method: "thread/status/changed",
        params: {
          threadId: "fake-subagent-thread",
          status: { type: "active", activeFlags: [] }
        }
      });
    }
    let result = {};
    if (message.method === "initialize") {
      result = {
        userAgent: "codex_vscode/0.153.4 (Windows 10.0.26100; x86_64) test",
        codexHome: path.join(root, "tests/build", "proxy-test", "codex-home"),
        platformFamily: "windows",
        platformOs: "windows"
      };
    } else if (message.method === "thread/read") {
      result = { thread: fakeThread(message.params?.threadId || "fake-thread") };
    } else if (message.method === "thread/list") {
      result = { data: [fakeThread("fake-thread")], nextCursor: null, backwardsCursor: null };
    } else if (message.method === "turn/steer") {
      const turnId = message.params?.expectedTurnId || "fake-turn";
      const item = {
        id: `steer-user-${message.params?.clientUserMessageId || "anonymous"}`,
        type: "userMessage",
        clientId: message.params?.clientUserMessageId || null,
        userMessageOrderAt: Date.now(),
        content: message.params?.input || []
      };
      send({ method: "item/started", params: { threadId: message.params?.threadId || "fake-thread", turnId, startedAtMs: Date.now(), item } });
      send({ method: "item/completed", params: { threadId: message.params?.threadId || "fake-thread", turnId, completedAtMs: Date.now(), item } });
      result = { turnId };
    } else if (message.method === "turn/start") {
      result = { turn: fakeTurn("fake-control-turn", message.params?.input || []) };
    } else if (String(message.method || "").startsWith("test/")) {
      result = { ok: true };
    }
    send({ id: message.id, result });
  }
}

function busyNotification() {
  return {
    method: "thread/status/changed",
    params: {
      threadId: "fake-thread",
      status: { type: "active", activeFlags: [] }
    }
  };
}

function sendBusyState(send) {
  send({
    method: "thread/started",
    params: { thread: fakeThread("fake-thread", { status: { type: "active", activeFlags: [] } }) }
  });
  send({
    method: "turn/started",
    params: { threadId: "fake-thread", turn: fakeTurn("fake-turn") }
  });
  send(busyNotification());
}

function fakeThread(id, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    extra: null,
    sessionId: overrides.sessionId || `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: `fixture ${id}`,
    ephemeral: false,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: now,
    updatedAt: now,
    recencyAt: now,
    status: { type: "idle" },
    path: null,
    cwd: root,
    cliVersion: "0.153.4",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: `Fixture ${id}`,
    turns: [],
    ...overrides
  };
}

function fakeTurn(id, input = []) {
  const items = input.length
    ? [{ id: `${id}-user`, type: "userMessage", clientId: null, content: input }]
    : [];
  return {
    id,
    items,
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null
  };
}

function isCurrentInitializeParams(params) {
  return typeof params?.clientInfo?.name === "string" &&
    typeof params?.clientInfo?.title === "string" &&
    typeof params?.clientInfo?.version === "string" &&
    params?.capabilities?.experimentalApi === true &&
    params?.capabilities?.mcpServerOpenaiFormElicitation === true &&
    typeof params?.capabilities?.requestAttestation === "boolean";
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

setInterval(() => {}, 1000).unref();
