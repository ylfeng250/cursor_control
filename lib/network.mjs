import fs from "node:fs";
import os from "node:os";

export function isTailnetAddress(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function phoneUrls({ port, interfaces = os.networkInterfaces(), localHostName = "" }) {
  const lan = [];
  const tailscale = [];
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      const ipv4 = entry.family === "IPv4" || entry.family === 4;
      if (!ipv4 || entry.internal) continue;
      if (String(entry.address).startsWith("169.254.")) continue;
      const url = `http://${entry.address}:${port}`;
      if (isTailnetAddress(entry.address)) tailscale.push(url);
      else lan.push(url);
    }
  }
  const name = String(localHostName || "").trim().replace(/\.local$/i, "");
  return {
    lan,
    localName: name ? `http://${name}.local:${port}` : null,
    tailscale,
  };
}

const tunnelUrlPattern = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function normalizeTunnelUrl(value) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (!tunnelUrlPattern.test(text)) return null;
  return text;
}

export function readTunnelUrl(file) {
  try {
    return normalizeTunnelUrl(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
