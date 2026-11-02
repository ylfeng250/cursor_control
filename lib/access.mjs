import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";

export function createPassphrase() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function loadOrCreateToken(file) {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First run creates the passphrase.
  }
  const token = createPassphrase();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // The file is still created; the mode is best-effort.
  }
  return token;
}

export function tokensMatch(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export function readCookie(header, name) {
  const source = String(header || "");
  for (const part of source.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function cookieHeader(name, value) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
}
