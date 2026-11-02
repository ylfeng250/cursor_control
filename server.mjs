import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cookieHeader, loadOrCreateToken, readCookie, tokensMatch } from "./lib/access.mjs";
import {
  agentEnv,
  buildAgentArgs,
  cleanCliText,
  createEventParser,
  createLineBuffer,
  parseAuth,
  parseStreamLine,
} from "./lib/agent-cli.mjs";
import { phoneUrls } from "./lib/network.mjs";
import { emptyTask, readTask, reconcileTask, writeTask } from "./lib/task-store.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const files = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const MAX_PROMPT = 100_000;
const COOKIE = "cc";
const TAILSCALE_BINS = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

export function resolveAgentBin(env = process.env) {
  if (env.AGENT_BIN) return env.AGENT_BIN;
  const local = path.join(os.homedir(), ".local/bin/agent");
  if (fs.existsSync(local)) return local;
  return "agent";
}

export function start({
  port = 0,
  host = "127.0.0.1",
  agentBin = resolveAgentBin(),
  accessToken,
  dataDir = path.join(root, "data"),
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const token = accessToken || loadOrCreateToken(path.join(dataDir, "access-token"));
  const stateFile = path.join(dataDir, "state.json");
  const loaded = readTask(stateFile);
  const task = reconcileTask(loaded);
  if (loaded.phase === "running") writeTask(stateFile, task);
  const ctx = {
    host,
    agentBin,
    token,
    stateFile,
    task,
    child: null,
    awake: null,
    killed: false,
    cliCache: null,
    tailscale: { at: 0, installed: false, ips: [] },
    localHostName: readLocalHostName(),
    loginFails: new Map(),
  };
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((error) => {
      const status = error.status || 500;
      sendJson(res, status, { error: error.message || "服务器错误" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      ctx.port = address.port;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        token,
        dataDir,
        close() {
          if (ctx.child) ctx.child.kill("SIGTERM");
          if (ctx.awake) ctx.awake.kill("SIGTERM");
          return new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          });
        },
      });
    });
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && files[url.pathname]) {
    const item = files[url.pathname];
    const body = fs.readFileSync(path.join(publicDir, item.file));
    res.writeHead(200, { "content-type": item.type, "cache-control": "no-store" });
    res.end(body);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    await login(req, res, ctx);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/setup") {
    if (!isLocal(req)) fail(403, "口令只在这台 Mac 上显示");
    sendJson(res, 200, { password: ctx.token, ...endpointInfo(ctx) });
    return;
  }
  if (!authorized(req, ctx)) fail(401, "需要口令");
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, await publicState(ctx));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/runs") {
    const body = await readJson(req);
    createRun(ctx, body);
    sendJson(res, 201, await publicState(ctx));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/cancel") {
    cancelRun(ctx);
    sendJson(res, 200, await publicState(ctx));
    return;
  }
  sendJson(res, 404, { error: "没有这个地址" });
}

async function login(req, res, ctx) {
  const ip = req.socket.remoteAddress || "unknown";
  const limited = ctx.loginFails.get(ip);
  if (limited && limited.until > Date.now()) fail(429, "试得太勤，等半分钟再试");
  const body = await readJson(req);
  const password = typeof body.password === "string" ? body.password.trim() : "";
  if (!tokensMatch(password, ctx.token)) {
    const fails = (limited?.count || 0) + 1;
    ctx.loginFails.set(ip, {
      count: fails,
      until: fails >= 8 ? Date.now() + 30_000 : 0,
    });
    fail(401, "口令不对");
  }
  ctx.loginFails.delete(ip);
  res.setHeader("Set-Cookie", cookieHeader(COOKIE, ctx.token));
  sendJson(res, 200, { ok: true });
}

function authorized(req, ctx) {
  return tokensMatch(readCookie(req.headers.cookie, COOKIE), ctx.token);
}

function createRun(ctx, body) {
  if (ctx.task.phase === "running") fail(409, "已有运行中的任务，先停止再发送");
  const workspace = resolveWorkspace(body.workspace);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) fail(400, "提示不能为空");
  if (prompt.length > MAX_PROMPT) fail(400, "提示太长");
  const mode = body.mode ?? "agent";
  if (!["agent", "plan", "ask"].includes(mode)) fail(400, "模式无效");
  const model = cleanToken(body.model, 80);
  const resume = body.resume ? cleanToken(body.resume, 80) : "";
  if (body.resume && !resume) fail(400, "会话编号无效");
  const sandbox = body.sandbox ?? "enabled";
  if (!["enabled", "disabled", "default"].includes(sandbox)) fail(400, "沙箱设置无效");
  const args = buildAgentArgs({
    prompt,
    workspace,
    mode,
    model,
    resume,
    force: Boolean(body.force),
    sandbox: sandbox === "default" ? undefined : sandbox,
  });
  ctx.killed = false;
  ctx.task = {
    ...emptyTask(),
    phase: "running",
    id: crypto.randomUUID(),
    prompt,
    startedAt: Date.now(),
    sessionId: resume || null,
    workspace,
    mode,
    model: model || "",
  };
  persist(ctx);
  const stderr = [];
  let resultText = "";
  let resultIsError = false;
  const child = spawn(ctx.agentBin, args, {
    cwd: workspace,
    env: agentEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  ctx.child = child;
  ctx.awake = spawn("/usr/bin/caffeinate", ["-i", "-w", String(child.pid)], { stdio: "ignore" });
  ctx.awake.on("error", () => {});
  ctx.awake.unref?.();
  const parser = createEventParser();
  const stdout = createLineBuffer((line) => {
    for (const event of parseStreamLine(parser, line)) {
      if (event.sessionId) ctx.task.sessionId = event.sessionId;
      if (event.kind === "result") {
        resultText = event.text || "";
        resultIsError = Boolean(event.isError);
      }
    }
  });
  const errLines = createLineBuffer((line) => {
    const text = cleanCliText(line);
    if (text) stderr.push(text.slice(0, 2000));
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => errLines.push(chunk));
  child.on("error", (error) => {
    stderr.push(error.message);
    finish(ctx, 1, resultText, resultIsError, stderr);
  });
  child.on("close", (code) => {
    stdout.flush();
    errLines.flush();
    finish(ctx, code ?? 1, resultText, resultIsError, stderr);
  });
}

function finish(ctx, code, resultText, resultIsError, stderr) {
  if (ctx.task.phase !== "running") return;
  const killed = ctx.killed;
  const errorText = stderr.filter(Boolean).join("\n").slice(0, 20_000);
  let phase = "done";
  if (killed) phase = "stopped";
  else if (code !== 0 || resultIsError) phase = "error";
  ctx.task = {
    ...ctx.task,
    phase,
    result: (resultText || "").slice(0, 200_000),
    error: phase === "error" ? errorText || resultText || `退出码 ${code}` : "",
    finishedAt: Date.now(),
    exitCode: code,
  };
  ctx.child = null;
  if (ctx.awake) {
    ctx.awake.kill("SIGTERM");
    ctx.awake = null;
  }
  persist(ctx);
}

function cancelRun(ctx) {
  if (ctx.task.phase !== "running" || !ctx.child) fail(409, "现在没有在跑的任务");
  ctx.killed = true;
  ctx.child.kill("SIGTERM");
  const child = ctx.child;
  setTimeout(() => {
    if (ctx.task.phase === "running" && child) child.kill("SIGKILL");
  }, 2000).unref?.();
}

function persist(ctx) {
  writeTask(ctx.stateFile, ctx.task);
}

async function publicState(ctx) {
  const cli = await cliSnapshot(ctx);
  const urls = currentUrls(ctx);
  const runningForMs = ctx.task.phase === "running" && ctx.task.startedAt
    ? Date.now() - ctx.task.startedAt
    : null;
  return {
    ...ctx.task,
    now: Date.now(),
    runningForMs,
    cli,
    urls,
  };
}

function currentUrls(ctx) {
  refreshTailscale(ctx);
  const urls = phoneUrls({
    port: boundPort(ctx),
    localHostName: ctx.localHostName,
  });
  for (const ip of ctx.tailscale.ips) {
    const url = `http://${ip}:${boundPort(ctx)}`;
    if (!urls.tailscale.includes(url)) urls.tailscale.push(url);
  }
  return {
    ...urls,
    tailscaleInstalled: ctx.tailscale.installed,
  };
}

function boundPort(ctx) {
  return ctx.port || 8787;
}

function endpointInfo(ctx) {
  return { urls: currentUrls(ctx) };
}

async function cliSnapshot(ctx) {
  if (!ctx.cliCache) return refreshCli(ctx);
  if (Date.now() - ctx.cliCache.at > 30_000) refreshCli(ctx);
  return ctx.cliCache.value;
}

function refreshCli(ctx) {
  const pending = Promise.all([
    execAgent(ctx.agentBin, ["--version"]),
    execAgent(ctx.agentBin, ["status"]),
  ]).then(([versionResult, statusResult]) => {
    const version = cleanCliText(versionResult.stdout || versionResult.stderr).split("\n")[0] || null;
    const auth = parseAuth(`${statusResult.stdout}\n${statusResult.stderr}`);
    const missing = versionResult.error === "ENOENT" || statusResult.error === "ENOENT";
    const value = {
      ok: !missing,
      version,
      loggedIn: auth.loggedIn,
      email: auth.email,
      authText: missing ? "找不到 agent 命令" : auth.text,
      cwd: process.cwd(),
    };
    ctx.cliCache = { at: Date.now(), value };
    return value;
  });
  return pending;
}

function refreshTailscale(ctx) {
  if (Date.now() - ctx.tailscale.at < 30_000) return;
  ctx.tailscale.at = Date.now();
  const bin = TAILSCALE_BINS.find((candidate) => candidate.includes("/") && fs.existsSync(candidate)) || "tailscale";
  execFile(bin, ["ip", "-4"], { timeout: 1500 }, (error, stdout) => {
    if (error) {
      ctx.tailscale.installed = false;
      ctx.tailscale.ips = [];
      return;
    }
    ctx.tailscale.installed = true;
    ctx.tailscale.ips = String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => isIpv4(line));
  });
}

function execAgent(bin, args) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: 20000, env: agentEnv(), maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          error: error && error.code === "ENOENT" ? "ENOENT" : error?.killed ? "timeout" : null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function resolveWorkspace(input) {
  const raw = typeof input === "string" && input.trim() ? input.trim() : process.cwd();
  let resolved;
  try {
    resolved = fs.realpathSync(raw);
  } catch {
    fail(400, "工作区不存在");
  }
  if (!fs.statSync(resolved).isDirectory()) fail(400, "工作区需要是文件夹");
  return resolved;
}

function cleanToken(value, max) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  if (!text || text.length > max || !/^[A-Za-z0-9._:-]+$/.test(text)) return "";
  return text;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_PROMPT + 20_000) {
        reject(Object.assign(new Error("请求体太大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求不是 JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function isLocal(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address.endsWith("127.0.0.1");
}

function isIpv4(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

function readLocalHostName() {
  try {
    return execFileSync("scutil", ["--get", "LocalHostName"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
  } catch {
    return os.hostname().replace(/\.local$/i, "");
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  start({ port, host: "0.0.0.0" }).then((server) => {
    const urls = phoneUrls({ port: server.port, localHostName: readLocalHostName() });
    console.log(`Mac 打开 http://127.0.0.1:${server.port} 查看口令`);
    for (const url of urls.lan) console.log(`家里 ${url}`);
    if (urls.localName) console.log(`家里备用 ${urls.localName}`);
    console.log("不要把 8787 转到公网。出门用 Tailscale。");
  });
}
