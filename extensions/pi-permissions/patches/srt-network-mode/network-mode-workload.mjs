// Synthetic workload for network-mode-harness.mjs. Never executes during static checks.

import assert from "node:assert/strict";
import dgram from "node:dgram";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

assert.equal(process.argv.length, 3);
let spec;
try {
  spec = JSON.parse(process.argv[2]);
} catch {
  process.stderr.write("Invalid synthetic workload specification\n");
  process.exit(2);
}
assert.ok(path.isAbsolute(spec.root));
assert.match(path.basename(spec.root), /^nm-[A-Za-z0-9]+$/);
assert.equal(process.env.HOME, spec.root);
// A failed external signal must not leave an owned synthetic workload alive.
setTimeout(() => {
  process.stderr.write("forced workload self-exit; not native acceptance\n");
  process.exit(124);
}, 10000).unref();
const outcome = (ok, code) => (code ? { ok, code } : { ok });
function tcp(options) {
  return new Promise((resolve) => {
    const socket = net.connect(options);
    let done = false;
    const finish = (ok, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome(ok, code));
    };
    const timer = setTimeout(() => finish(false, "TIMEOUT"), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", (e) => finish(false, e.code));
  });
}
function udp(type, host, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(type);
    let done = false;
    const finish = (ok, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(outcome(ok, code));
    };
    const timer = setTimeout(() => finish(false, "TIMEOUT"), 500);
    socket.once("error", (e) => finish(false, e.code));
    socket.once("message", (data) =>
      finish(
        data.toString() === "synthetic-ack",
        data.toString() === "synthetic-ack" ? undefined : "BAD_REPLY",
      ),
    );
    try {
      socket.bind(0, host, () =>
        socket.send("synthetic-ping", port, host, (e) => {
          if (e) finish(false, e.code);
        }),
      );
    } catch (e) {
      finish(false, e.code);
    }
  });
}
function bind(options) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.end("synthetic-inbound-ack");
      finish(true);
    });
    let done = false;
    const finish = (ok, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close(() => resolve(outcome(ok, code)));
    };
    const timer = setTimeout(() => finish(false, "TIMEOUT"), 1500);
    server.once("error", (e) => finish(false, e.code));
    try {
      server.listen(options, () => {
        if (typeof options === "string")
          finish(true); // Existing Unix opt-in promises bind/connect, not inbound.
        else
          process.stdout.write(
            `${JSON.stringify({ listen: { host: options.host, port: server.address().port } })}\n`,
          );
      });
    } catch (e) {
      finish(false, e.code);
    }
  });
}
async function file(action) {
  try {
    await action();
    return outcome(true);
  } catch (e) {
    return outcome(false, e.code);
  }
}
const root = spec.root;
const values = await Promise.all([
  tcp({ host: "127.0.0.1", port: spec.tcp4 }),
  tcp({ host: "::1", port: spec.tcp6 }),
  tcp({ host: "::ffff:127.0.0.1", port: spec.tcp4 }),
  tcp({ host: "127.0.0.1", port: spec.proxy }),
  tcp({ host: "127.0.0.1", port: spec.guard }),
  udp("udp4", "127.0.0.1", spec.udp4),
  udp("udp6", "::1", spec.udp6),
  tcp({ path: `${root}/ipc/allowed.sock` }),
  tcp({ path: `${root}/blocked.sock` }),
  bind({ host: "127.0.0.1", port: 0 }),
  bind({ host: "::1", port: 0, ipv6Only: true }),
  bind(`${root}/ipc/client.sock`),
  file(() => writeFile(`${root}/allowed/ok.txt`, "synthetic-write")),
  file(() => readFile(`${root}/allowed/secret.txt`, "utf8")),
  file(() => writeFile(`${root}/allowed/locked.txt`, "changed")),
  file(() => writeFile(`${root}/outside.txt`, "changed")),
  file(() => writeFile(`${root}/allowed/.git/config`, "changed")),
  file(() => writeFile(`${root}/allowed/.git/hooks/pre-commit`, "changed")),
]);
const keys = [
  "tcp4",
  "tcp6",
  "tcpMapped",
  "proxy",
  "guard",
  "udp4",
  "udp6",
  "unixAllowed",
  "unixBlocked",
  "bind4",
  "bind6",
  "bindUnix",
  "allowedWrite",
  "denyRead",
  "denyWrite",
  "outsideWrite",
  "gitConfig",
  "gitHook",
];
const result = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
if (spec.caPath) {
  result.caRead = await file(() => readFile(spec.caPath));
  result.agentRead = await file(() => readFile(spec.agentPath));
}
result.proxyEnvironment = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
].some((key) => key in process.env);
result.agentEnvironment = "JAVA_TOOL_OPTIONS" in process.env || "GIT_SSH_COMMAND" in process.env;
result.caEnvironment = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE"].some(
  (key) => key in process.env,
);
result.credentialDenied = !("SRT_SYNTHETIC_DENY" in process.env);
process.stdout.write(`${JSON.stringify(result)}\n`);
