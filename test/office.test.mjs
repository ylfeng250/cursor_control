import assert from "node:assert/strict";
import test from "node:test";
import { createPassphrase, tokensMatch } from "../lib/access.mjs";
import { isTailnetAddress, normalizeTunnelUrl, phoneUrls } from "../lib/network.mjs";
import { reconcileTask } from "../lib/task-store.mjs";

test("phone urls separate home wifi from tailscale", () => {
  const urls = phoneUrls({
    port: 8787,
    localHostName: "liuqi.local",
    interfaces: {
      lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      en0: [{ family: "IPv4", internal: false, address: "192.168.31.179" }],
      utun: [{ family: "IPv4", internal: false, address: "100.99.1.2" }],
    },
  });
  assert.deepEqual(urls.lan, ["http://192.168.31.179:8787"]);
  assert.deepEqual(urls.tailscale, ["http://100.99.1.2:8787"]);
  assert.equal(urls.localName, "http://liuqi.local:8787");
  assert.equal(isTailnetAddress("100.64.0.1"), true);
  assert.equal(isTailnetAddress("192.168.1.2"), false);
});

test("a tunnel url is a bare https hostname", () => {
  assert.equal(normalizeTunnelUrl("https://cursor.hopev5.com"), "https://cursor.hopev5.com");
  assert.equal(normalizeTunnelUrl("https://cursor.hopev5.com/"), "https://cursor.hopev5.com");
  assert.equal(normalizeTunnelUrl("http://cursor.hopev5.com"), null);
  assert.equal(normalizeTunnelUrl("https://cursor.hopev5.com/office"), null);
});

test("a passphrase is readable and comparable", () => {
  const phrase = createPassphrase();
  assert.match(phrase, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(tokensMatch(phrase, phrase), true);
  assert.equal(tokensMatch(phrase, "nope-nope-nope"), false);
});

test("a running task becomes an interrupted result after restart", () => {
  const task = reconcileTask({ phase: "running", prompt: "写个说明", result: "" });
  assert.equal(task.phase, "error");
  assert.match(task.error, /没有跑完/);
});
