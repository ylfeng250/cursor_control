import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "../server.mjs";

const token = "test-token";

test("local setup shows the passphrase and the phone must log in", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-control-"));
  const server = await start({ port: 0, host: "127.0.0.1", accessToken: token, dataDir });
  try {
    const denied = await fetch(`${server.url}/api/state`);
    assert.equal(denied.status, 401);
    const setup = await fetch(`${server.url}/api/setup`).then((response) => response.json());
    assert.equal(setup.password, token);
    const cookie = await login(server);
    const state = await fetch(`${server.url}/api/state`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(state.phase, "idle");
  } finally {
    await server.close();
  }
});

test("cloudflare requests do not receive the passphrase", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-control-"));
  fs.writeFileSync(path.join(dataDir, "tunnel-url"), "https://cursor.hopev5.com\n");
  const server = await start({ port: 0, host: "127.0.0.1", accessToken: token, dataDir });
  try {
    const setup = await fetch(`${server.url}/api/setup`).then((response) => response.json());
    assert.equal(setup.urls.tunnel, "https://cursor.hopev5.com");
    const blocked = await rawRequest(`${server.url}/api/setup`, {
      "cf-connecting-ip": "203.0.113.8",
      "cf-ray": "test",
    });
    assert.equal(blocked.status, 403);
    const foreignHost = await rawRequest(`${server.url}/api/setup`, { host: "cursor.hopev5.com" });
    assert.equal(foreignHost.status, 403);
    const logged = await rawRequest(
      `${server.url}/api/login`,
      {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.8",
        "cf-ray": "test",
        "x-forwarded-proto": "https",
      },
      JSON.stringify({ password: token }),
    );
    assert.equal(logged.status, 200);
    assert.match(String(logged.headers["set-cookie"]), /Secure/);
  } finally {
    await server.close();
  }
});

test("a finished run keeps only the final result", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-control-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-control-"));
  const server = await start({
    port: 0,
    host: "127.0.0.1",
    accessToken: token,
    dataDir,
    agentBin: writeFakeAgent(workspace),
  });
  try {
    const cookie = await login(server);
    const created = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ workspace, prompt: "reply pong", mode: "ask" }),
    });
    assert.equal(created.status, 201);
    const done = await waitFor(server.url, cookie, (state) => state.phase === "done");
    assert.equal(done.result, "pong");
    assert.equal(done.result.includes("partial"), false);
    assert.equal(done.sessionId, "sess-1");
    const again = await fetch(`${server.url}/api/state`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(again.result, "pong");
  } finally {
    await server.close();
  }
});

test("a second run is rejected while one is still reserved", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-control-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-control-"));
  const server = await start({
    port: 0,
    host: "127.0.0.1",
    accessToken: token,
    dataDir,
    agentBin: writeFakeAgent(workspace),
  });
  try {
    const cookie = await login(server);
    const first = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ workspace, prompt: "hold" }),
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ workspace, prompt: "again" }),
    });
    assert.equal(second.status, 409);
    const cancelled = await fetch(`${server.url}/api/cancel`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(cancelled.status, 200);
    const state = await cancelled.json();
    assert.equal(state.phase === "running" || state.phase === "stopped", true);
  } finally {
    await server.close();
  }
});

test("restarting the service keeps an interrupted task", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-control-"));
  fs.writeFileSync(
    path.join(dataDir, "state.json"),
    JSON.stringify({ phase: "running", prompt: "写说明", result: "" }),
  );
  const server = await start({ port: 0, host: "127.0.0.1", accessToken: token, dataDir });
  try {
    const cookie = await login(server);
    const state = await fetch(`${server.url}/api/state`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(state.phase, "error");
    assert.match(state.error, /没有跑完/);
    assert.equal(state.prompt, "写说明");
  } finally {
    await server.close();
  }
});

function writeFakeAgent(workspace) {
  const fakeAgent = path.join(workspace, "fake-agent.mjs");
  fs.writeFileSync(
    fakeAgent,
    `#!${process.execPath}
const args = process.argv.slice(2);
const prompt = args.at(-1);
if (prompt === "hold") {
  setInterval(() => {}, 1000);
} else if (args.includes("--version")) {
  process.stdout.write("fake-1\\n");
} else if (args.includes("status")) {
  process.stdout.write("Not logged in\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "assistant", timestamp_ms: 1, message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "pong", session_id: "sess-1", duration_ms: 4 }) + "\\n");
}
`,
  );
  fs.chmodSync(fakeAgent, 0o755);
  return fakeAgent;
}

function rawRequest(url, headers, body) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: body ? "POST" : "GET",
        headers,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
      },
    );
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

async function login(server) {
  const response = await fetch(`${server.url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: token }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

async function waitFor(url, cookie, ready) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const state = await fetch(`${url}/api/state`, { headers: { cookie } }).then((response) => response.json());
    if (ready(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("结果没有在预期时间内出现");
}
