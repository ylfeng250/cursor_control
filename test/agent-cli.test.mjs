import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentArgs,
  createEventParser,
  createLineBuffer,
  parseAuth,
  parseStreamLine,
} from "../lib/agent-cli.mjs";

test("print-mode args match the installed CLI", () => {
  const args = buildAgentArgs({
    prompt: "fix the test",
    workspace: "/tmp/project",
    mode: "ask",
    model: "composer-2.5",
    resume: "chat-1",
    force: false,
    sandbox: "enabled",
  });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    "/tmp/project",
    "--mode",
    "ask",
    "--model",
    "composer-2.5",
    "--resume",
    "chat-1",
    "--sandbox",
    "enabled",
    "--",
    "fix the test",
  ]);
  assert.equal(args.includes("--trust"), false);
  assert.equal(args.includes("--force"), false);
});

test("auth text treats the logged-out banner as logged out", () => {
  const parsed = parseAuth("\u001b[2K\u001b[GStarting login process...\nNot logged in\n");
  assert.equal(parsed.loggedIn, false);
  assert.equal(parsed.text, "未登录");
});

test("partial assistant deltas drop duplicate flushes", () => {
  const parser = createEventParser();
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp_ms: 1,
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
      session_id: "s1",
    }),
    JSON.stringify({
      type: "assistant",
      timestamp_ms: 2,
      message: { role: "assistant", content: [{ type: "text", text: "lo" }] },
      session_id: "s1",
    }),
    JSON.stringify({
      type: "assistant",
      timestamp_ms: 3,
      model_call_id: "call-1",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      session_id: "s1",
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      session_id: "s1",
    }),
  ];
  const events = lines.flatMap((line) => parseStreamLine(parser, line));
  assert.deepEqual(
    events.map((event) => event.text),
    ["Hel", "lo"],
  );
});

test("aggregated assistant text is kept when no deltas arrived", () => {
  const parser = createEventParser();
  const [event] = parseStreamLine(
    parser,
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    }),
  );
  assert.equal(event.kind, "message");
  assert.equal(event.text, "Done");
});

test("tool calls keep a short target and hide file bodies", () => {
  const parser = createEventParser();
  const [started] = parseStreamLine(
    parser,
    JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "c1",
      tool_call: {
        writeToolCall: {
          args: { path: "summary.txt", fileText: "x".repeat(5000) },
        },
      },
    }),
  );
  assert.equal(started.label, "写入");
  assert.equal(started.target, "summary.txt");
  assert.equal(started.target.includes("xxxx"), false);
});

test("thinking deltas stay off the transcript", () => {
  const parser = createEventParser();
  const events = parseStreamLine(
    parser,
    JSON.stringify({
      type: "thinking",
      subtype: "delta",
      text: "先看一下文件",
      session_id: "s1",
      timestamp_ms: 10,
    }),
  );
  assert.deepEqual(events, []);
});

test("line buffer splits chunks on newlines", () => {
  const lines = [];
  const buffer = createLineBuffer((line) => lines.push(line));
  buffer.push('{"type":"system"');
  buffer.push('}\n{"type":"result"}\n');
  buffer.flush();
  assert.deepEqual(lines, ['{"type":"system"}', '{"type":"result"}']);
});
