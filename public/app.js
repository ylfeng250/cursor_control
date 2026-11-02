const phaseEl = document.querySelector("#phase");
const addresses = document.querySelector("#addresses");
const addressList = document.querySelector("#address-list");
const passphrase = document.querySelector("#passphrase");
const awayHint = document.querySelector("#away-hint");
const banner = document.querySelector("#banner");
const bannerText = document.querySelector("#banner-text");
const copyLogin = document.querySelector("#copy-login");
const gate = document.querySelector("#gate");
const passwordInput = document.querySelector("#password");
const gateError = document.querySelector("#gate-error");
const office = document.querySelector("#office");
const taskPrompt = document.querySelector("#task-prompt");
const resultText = document.querySelector("#result-text");
const workspaceInput = document.querySelector("#workspace");
const modeInput = document.querySelector("#mode");
const modelInput = document.querySelector("#model");
const sandboxInput = document.querySelector("#sandbox");
const forceInput = document.querySelector("#force");
const resumeInput = document.querySelector("#resume");
const sessionLabel = document.querySelector("#session-id");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send");
const stopButton = document.querySelector("#stop");
const formError = document.querySelector("#form-error");
const settings = document.querySelector("#settings");
const settingsToggle = document.querySelector("#settings-toggle");
const settingsLabel = document.querySelector("#settings-label");
const settingsSummary = document.querySelector("#settings-summary");

const view = { task: null, receivedAt: 0, sessionId: null };

gate.addEventListener("submit", (event) => {
  event.preventDefault();
  enter(passwordInput.value);
});
document.querySelector("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  startRun();
});
stopButton.addEventListener("click", cancelRun);
settingsToggle.addEventListener("click", () => setSettingsOpen(!settings.classList.contains("open")));
for (const control of [modeInput, sandboxInput, forceInput]) {
  control.addEventListener("change", renderSettingsSummary);
}
copyLogin.addEventListener("click", () => copyText("agent login", copyLogin, "复制命令"));
promptInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    startRun();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !office.hidden) refresh();
});
setInterval(() => {
  if (view.task?.phase === "running") renderPhase(view.task);
}, 1000);

boot();

async function boot() {
  const setup = await fetch("/api/setup");
  if (setup.ok) {
    const info = await setup.json();
    showAddresses(info);
    await enter(info.password);
    return;
  }
  await refresh();
}

async function enter(password) {
  gateError.textContent = "";
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: password.trim() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    showGate(body.error || "口令不对");
    return;
  }
  await refresh();
}

async function refresh() {
  try {
    const task = await fetchJson("/api/state");
    view.task = task;
    view.receivedAt = Date.now();
    showOffice(task);
  } catch (error) {
    if (error.status === 401) showGate("");
    else formError.textContent = error.message;
  }
}

function showGate(message) {
  gate.hidden = false;
  office.hidden = true;
  gateError.textContent = message || "";
  passwordInput.focus();
}

function showOffice(task) {
  gate.hidden = true;
  office.hidden = false;
  if (!workspaceInput.value) workspaceInput.value = task.workspace || task.cli?.cwd || "";
  renderPhase(task);
  renderResult(task);
  renderBanner(task.cli || {});
  renderSession(task.sessionId);
  const running = task.phase === "running";
  document.body.classList.toggle("running", running);
  sendButton.disabled = running;
  stopButton.disabled = !running;
}

function renderPhase(task) {
  document.body.className = `phase-${task.phase || "idle"}${task.phase === "running" ? " running" : ""}`;
  if (task.phase === "running") {
    const base = task.runningForMs || 0;
    const extra = view.receivedAt ? Date.now() - view.receivedAt : 0;
    phaseEl.textContent = `运行中 · ${formatElapsed(base + extra)}`;
    return;
  }
  phaseEl.textContent = { idle: "空闲", done: "完成", error: "失败", stopped: "已停止" }[task.phase] || "空闲";
}

function renderResult(task) {
  taskPrompt.textContent = task.prompt ? `这次的任务：${task.prompt}` : "";
  if (task.phase === "running") {
    resultText.textContent = "正在这台 Mac 上跑。可以锁屏，回来这里看结果。";
    return;
  }
  if (task.phase === "error") {
    resultText.textContent = task.error || "这次没有跑完。";
    return;
  }
  if (task.phase === "stopped") {
    resultText.textContent = "已停止。";
    return;
  }
  if (task.phase === "done") {
    resultText.textContent = task.result || "这次没有文本结果。";
    return;
  }
  resultText.textContent = "还没有结果。发送一条提示，结束后会出现在这里。";
}

function renderBanner(cli) {
  if (!cli.ok && cli.authText) {
    banner.hidden = false;
    bannerText.textContent = cli.authText;
    return;
  }
  if (cli.loggedIn || cli.authText === "检查中") {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  bannerText.textContent = "CLI 未登录。在这台 Mac 的终端执行 agent login，完成后再打开这个页面。";
}

function showAddresses(info) {
  const urls = info.urls || {};
  const rows = [
    ...(urls.lan || []).map((url) => ["家里", url]),
    ...(urls.localName ? [["家里备用", urls.localName]] : []),
    ...(urls.tunnel ? [["出门", urls.tunnel]] : []),
    ...(urls.tailscale || []).map((url) => ["出门备用", url]),
  ];
  addressList.replaceChildren();
  for (const [where, url] of rows) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "where";
    label.textContent = where;
    const code = document.createElement("code");
    code.textContent = url;
    item.append(label, code);
    addressList.append(item);
  }
  passphrase.textContent = info.password || "";
  awayHint.textContent = awayHintText(urls);
  addresses.hidden = false;
}

function awayHintText(urls) {
  if (urls.tunnel && urls.tailscale?.length) {
    return "出门先打开 Cloudflare 地址。同一账号的 Tailscale 地址也可以用。不要把 8787 转到公网。";
  }
  if (urls.tunnel) {
    return "出门打开上面的 Cloudflare 地址。手机先完成邮箱验证，再输入访问口令。不要把 8787 转到公网。";
  }
  if (urls.tailscale?.length) {
    return "出门用上面的 Tailscale 地址。不要把 8787 转到公网。";
  }
  return "出门可以走 Cloudflare 隧道，也可以在 Mac 和 Android 安装 Tailscale 并登录同一个账号。不要把 8787 转到公网。";
}

async function startRun() {
  formError.textContent = "";
  if (sendButton.disabled) return;
  if (!workspaceInput.value.trim()) {
    formError.textContent = "先填写工作区";
    if (window.matchMedia("(max-width: 860px)").matches) setSettingsOpen(true);
    workspaceInput.focus();
    return;
  }
  sendButton.disabled = true;
  try {
    const task = await fetchJson("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: workspaceInput.value,
        prompt: promptInput.value,
        mode: modeInput.value,
        model: modelInput.value.trim(),
        sandbox: sandboxInput.value,
        force: forceInput.checked,
        resume: resumeInput.checked && view.sessionId ? view.sessionId : "",
      }),
    });
    view.task = task;
    view.receivedAt = Date.now();
    promptInput.value = "";
    if (window.matchMedia("(max-width: 860px)").matches) setSettingsOpen(false);
    showOffice(task);
  } catch (error) {
    sendButton.disabled = false;
    formError.textContent = error.message;
  }
}

async function cancelRun() {
  formError.textContent = "";
  try {
    const task = await fetchJson("/api/cancel", { method: "POST" });
    view.task = task;
    view.receivedAt = Date.now();
    showOffice(task);
  } catch (error) {
    formError.textContent = error.message;
  }
}

function renderSession(id) {
  const had = Boolean(view.sessionId);
  view.sessionId = id || null;
  sessionLabel.textContent = id || "还没有会话";
  resumeInput.disabled = !id;
  if (!id) resumeInput.checked = false;
  else if (!had) resumeInput.checked = true;
}

function setSettingsOpen(open) {
  settings.classList.toggle("open", open);
  settingsToggle.setAttribute("aria-expanded", String(open));
  settingsLabel.textContent = open ? "收起设置" : "运行设置";
}

function renderSettingsSummary() {
  const mode = { agent: "执行", plan: "计划", ask: "提问" }[modeInput.value] || "执行";
  const sandbox = { enabled: "沙箱", disabled: "无沙箱", default: "默认沙箱" }[sandboxInput.value] || "沙箱";
  const force = forceInput.checked ? " · 可改文件" : "";
  settingsSummary.textContent = `${mode} · ${sandbox}${force}`;
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function copyText(text, button, restore) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  setTimeout(() => {
    button.textContent = restore;
  }, 1600);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

setInterval(() => {
  if (!office.hidden) refresh();
}, 2000);
