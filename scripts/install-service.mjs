import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serve = path.join(root, "bin/serve");
const label = "com.liuqi.cursor-control";
const plistPath = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
const logFile = path.join(root, "data/server.log");

fs.chmodSync(serve, 0o755);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.mkdirSync(path.dirname(plistPath), { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${serve}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${root}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
fs.writeFileSync(plistPath, plist);

const target = `gui/${process.getuid()}/${label}`;
const domain = `gui/${process.getuid()}`;
try {
  execFileSync("launchctl", ["bootout", target], { stdio: "ignore" });
} catch {
  // Not loaded yet.
}
execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
execFileSync("launchctl", ["enable", target], { stdio: "inherit" });
execFileSync("launchctl", ["kickstart", "-k", target], { stdio: "inherit" });
console.log(plistPath);

const tokenFile = path.join(root, "data/cloudflared-token");
if (fs.existsSync(tokenFile) && fs.statSync(tokenFile).size > 0) {
  execFileSync(process.execPath, [path.join(root, "scripts/install-tunnel.mjs")], { stdio: "inherit" });
}
