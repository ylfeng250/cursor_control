import os from "node:os";
import path from "node:path";

const TOOL_LABELS = {
  read: "读取",
  write: "写入",
  edit: "编辑",
  delete: "删除",
  shell: "命令",
  bash: "命令",
  grep: "搜索",
  glob: "查找",
  ls: "列出",
  todo: "待办",
  function: "调用",
};

export function agentEnv(base = process.env) {
  const env = { ...base };
  const localBin = path.join(os.homedir(), ".local/bin");
  const parts = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (!parts.includes(localBin)) {
    env.PATH = [localBin, ...parts].join(path.delimiter);
  }
  return env;
}

export function buildAgentArgs({
  prompt,
  workspace,
  mode,
  model,
  resume,
  force = false,
  sandbox,
}) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    workspace,
  ];
  if (mode === "plan" || mode === "ask") args.push("--mode", mode);
  if (model) args.push("--model", model);
  if (resume) args.push("--resume", resume);
  if (force) args.push("--force");
  if (sandbox === "enabled" || sandbox === "disabled") {
    args.push("--sandbox", sandbox);
  }
  args.push("--", prompt);
  return args;
}

export function cleanCliText(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^loading\b/i.test(line)) return false;
      if (/starting login process/i.test(line)) return false;
      if (/checking authentication status/i.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function parseAuth(text) {
  const clean = cleanCliText(text);
  if (/not logged in/i.test(clean)) {
    return { loggedIn: false, email: null, text: "未登录" };
  }
  const email = clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email || /logged in/i.test(clean)) {
    return { loggedIn: true, email: email?.[0] ?? null, text: clean || "已登录" };
  }
  return { loggedIn: false, email: null, text: clean || "无法确认登录状态" };
}

export function createLineBuffer(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    },
  };
}

export function createEventParser() {
  let sawDelta = false;
  return {
    parse(event) {
      if (!event || typeof event !== "object") return [];
      if (event.type === "system" && event.subtype === "init") {
        return [
          {
            kind: "init",
            sessionId: event.session_id ?? null,
            model: event.model ?? null,
            cwd: event.cwd ?? null,
            permissionMode: event.permissionMode ?? null,
          },
        ];
      }
      if (event.type === "user") {
        return [{ kind: "user", text: textOf(event), sessionId: event.session_id ?? null }];
      }
      if (event.type === "assistant") {
        const text = textOf(event);
        const hasTimestamp = event.timestamp_ms != null;
        const hasModelCall = event.model_call_id != null;
        if (hasTimestamp && !hasModelCall) {
          sawDelta = true;
          return text ? [{ kind: "delta", text, sessionId: event.session_id ?? null }] : [];
        }
        if (hasModelCall || sawDelta) return [];
        return text ? [{ kind: "message", text, sessionId: event.session_id ?? null }] : [];
      }
      if (event.type === "tool_call") {
        const tool = summarizeTool(event.tool_call);
        return [
          {
            kind: "tool",
            phase: event.subtype === "completed" ? "completed" : "started",
            callId: event.call_id ?? null,
            sessionId: event.session_id ?? null,
            ...tool,
          },
        ];
      }
      if (event.type === "thinking") return [];
      if (event.type === "result") {
        return [
          {
            kind: "result",
            subtype: event.subtype ?? null,
            isError: Boolean(event.is_error),
            text: typeof event.result === "string" ? event.result : "",
            durationMs: event.duration_ms ?? null,
            sessionId: event.session_id ?? null,
          },
        ];
      }
      return [];
    },
  };
}

export function parseStreamLine(parser, line) {
  try {
    return parser.parse(JSON.parse(line));
  } catch {
    return [{ kind: "log", text: String(line).slice(0, 2000) }];
  }
}

function textOf(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function unwrapTool(toolCall) {
  if (!toolCall || typeof toolCall !== "object") {
    return { name: "tool", args: {}, result: null };
  }
  if (toolCall.function && typeof toolCall.function === "object") {
    return {
      name: String(toolCall.function.name || "function"),
      args: toolCall.function.arguments ?? {},
      result: toolCall.function.result ?? null,
    };
  }
  const key = Object.keys(toolCall)[0];
  if (!key) return { name: "tool", args: {}, result: null };
  const body = toolCall[key] && typeof toolCall[key] === "object" ? toolCall[key] : {};
  return {
    name: key.replace(/ToolCall$/, "").replace(/^[A-Z]/, (char) => char.toLowerCase()),
    args: body.args && typeof body.args === "object" ? body.args : {},
    result: body.result ?? null,
  };
}

export function summarizeTool(toolCall) {
  const { name, args, result } = unwrapTool(toolCall);
  const normalized = name.toLowerCase();
  return {
    name: normalized,
    label: TOOL_LABELS[normalized] ?? normalized,
    target: pickTarget(args),
    detail: summarizeResult(result),
    ok: result ? !(result.error || result.failure) : null,
  };
}

function pickTarget(args) {
  if (typeof args === "string") return clip(args, 240);
  if (!args || typeof args !== "object") return "";
  const preferred = ["command", "cmd", "path", "file_path", "target_file", "pattern", "query", "glob"];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim(), 240);
  }
  const compact = { ...args };
  delete compact.fileText;
  delete compact.contents;
  delete compact.content;
  const json = JSON.stringify(compact);
  return json && json !== "{}" ? clip(json, 240) : "";
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return "";
  const failure = result.error || result.failure;
  if (failure) {
    return clip(typeof failure === "string" ? failure : JSON.stringify(failure), 600);
  }
  const success = result.success && typeof result.success === "object" ? result.success : result;
  if (typeof success.linesCreated === "number") return `写入 ${success.linesCreated} 行`;
  if (typeof success.totalLines === "number") return `${success.totalLines} 行`;
  if (typeof success.exitCode === "number") return `退出码 ${success.exitCode}`;
  const output = success.stdout || success.output || success.stderr || success.content;
  if (typeof output === "string" && output.trim()) return clip(output.trim(), 600);
  return "";
}

function clip(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
