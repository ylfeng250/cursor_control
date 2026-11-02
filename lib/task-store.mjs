import fs from "node:fs";
import path from "node:path";

export function emptyTask() {
  return {
    phase: "idle",
    id: null,
    prompt: "",
    result: "",
    error: "",
    startedAt: null,
    finishedAt: null,
    sessionId: null,
    workspace: "",
    mode: "agent",
    model: "",
    exitCode: null,
  };
}

export function readTask(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...emptyTask(), ...parsed };
  } catch {
    return emptyTask();
  }
}

export function reconcileTask(task, now = Date.now()) {
  if (task.phase !== "running") return task;
  return {
    ...task,
    phase: "error",
    error: "服务中断了，这次任务没有跑完。",
    finishedAt: now,
    exitCode: null,
  };
}

export function writeTask(file, task) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task));
  fs.renameSync(tmp, file);
}
