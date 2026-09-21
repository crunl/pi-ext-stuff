import {
  createServer as createNetServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  noProxyMatchesHost,
  SandboxConnectGuard,
  shouldBypassParentProxy,
  targetWithAddress,
} from "../src/sandbox/connect-guard.ts";

const proxyEnvironment = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const savedEnvironment = new Map<string, string | undefined>();

function clearProxyEnvironment(): void {
  for (const key of proxyEnvironment) {
    savedEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
}

function restoreProxyEnvironment(): void {
  for (const key of proxyEnvironment) {
    const value = savedEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isNetworkBindUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPERM"
  );
}

function proxyRequest(
  parentProxyUrl: string,
  request: string,
  head = "",
  authenticate = true,
): Promise<string> {
  const proxy = new URL(parentProxyUrl);
  const auth = Buffer.from(
    `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
  ).toString("base64");
  return new Promise<string>((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy request timed out"));
    }, 2_000);
    socket.once("connect", () => {
      const authorization = authenticate ? `Proxy-Authorization: Basic ${auth}\r\n` : "";
      socket.write(`${request}${authorization}\r\n${head}`);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
  });
}

function openProxyTunnel(parentProxyUrl: string, authority: string): Promise<Socket> {
  const proxy = new URL(parentProxyUrl);
  const auth = Buffer.from(
    `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
  ).toString("base64");
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy tunnel timed out"));
    }, 2_000);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      const response = buffer.toString("latin1", 0, end);
      if (!response.includes(" 200 ")) {
        socket.destroy();
        reject(new Error(`proxy tunnel refused: ${response}`));
        return;
      }
      resolve(socket);
    };
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
    });
    socket.on("data", onData);
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });
  });
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 2_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("SandboxConnectGuard", () => {
  afterEach(() => restoreProxyEnvironment());

  it("rewrites an upstream absolute-form target with a bracketed frozen IPv6 authority", () => {
    const target = new URL("http://target.example/resource?x=1");

    expect(targetWithAddress(target, "2001:db8::1").href).toBe("http://[2001:db8::1]/resource?x=1");
    expect(targetWithAddress(target, "2001:db8::1").hostname).toBe("[2001:db8::1]");
  });

  it("rejects empty, duplicate, and non-IP ticket candidates", () => {
    const guard = new SandboxConnectGuard();

    expect(guard.issue({ host: "empty.example", port: 80, addresses: [] })).toBe(false);
    expect(
      guard.issue({
        host: "duplicate.example",
        port: 80,
        addresses: ["93.184.216.34", "93.184.216.34"],
      }),
    ).toBe(false);
    expect(guard.issue({ host: "invalid.example", port: 80, addresses: ["not-an-ip"] })).toBe(
      false,
    );
  });

  it.each([
    ["::1", "::1"],
    ["::1", "[::1]"],
    ["::ffff:127.0.0.1", "::ffff:127.0.0.1"],
    ["10.23.4.5", "10.0.0.0/8"],
    ["api.example.com", ".example.com"],
    ["api.example.com", "*.example.com"],
  ])("matches NO_PROXY host rule %s against %s", (host, rule) => {
    expect(noProxyMatchesHost(host, rule)).toBe(true);
  });

  it("keeps an IPv6 literal intact instead of treating its final group as a port", () => {
    expect(noProxyMatchesHost("::1", "::1:443")).toBe(false);
    expect(noProxyMatchesHost("::1", "[::1]:443")).toBe(true);
    expect(noProxyMatchesHost("::1", "[::1]:0")).toBe(true);
  });

  it("supports CIDR and strips host port suffixes without using them", () => {
    expect(noProxyMatchesHost("192.168.10.20", "192.168.0.0/16")).toBe(true);
    // SRT sees the slash first, so a port-shaped CIDR is malformed and ignored.
    expect(noProxyMatchesHost("192.168.10.20", "192.168.0.0/16:80")).toBe(false);
    expect(noProxyMatchesHost("api.example.com", "example.com:443")).toBe(true);
    expect(noProxyMatchesHost("api.example.com", "example.com:80")).toBe(true);
    expect(noProxyMatchesHost("127.0.0.1", "127.0.0.1:99999")).toBe(true);
  });

  it("bypasses the parent proxy for loopback even when NO_PROXY is empty", () => {
    expect(shouldBypassParentProxy("127.0.0.1", undefined)).toBe(true);
    expect(shouldBypassParentProxy("127.42.0.9", "")).toBe(true);
    expect(shouldBypassParentProxy("[::1]", undefined)).toBe(true);
    expect(shouldBypassParentProxy("::ffff:127.0.0.1", undefined)).toBe(true);
    expect(shouldBypassParentProxy("localhost", undefined)).toBe(true);
    expect(shouldBypassParentProxy("LOCALHOST", undefined)).toBe(true);
    expect(shouldBypassParentProxy("10.0.0.1", undefined)).toBe(false);
  });

  it("rejects malformed upstream proxy credentials during startup", async () => {
    clearProxyEnvironment();
    process.env.HTTP_PROXY = "http://proxy-user:%ZZ@proxy.example";
    const guard = new SandboxConnectGuard();
    await expect(guard.start()).rejects.toThrow("Invalid HTTP(S)_PROXY credentials");
    await guard.close();
  });

  it("rejects an unauthenticated CONNECT before consuming a ticket", async () => {
    clearProxyEnvironment();
    const guard = new SandboxConnectGuard();
    try {
      try {
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const response = await proxyRequest(
        parent,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n",
        "",
        false,
      );
      expect(response).toContain("407 Proxy Authentication Required");
    } finally {
      await guard.close();
    }
  });

  it("tears down a pending CONNECT dial when the client disconnects", async () => {
    clearProxyEnvironment();
    const guard = new SandboxConnectGuard();
    try {
      try {
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "interrupted.example",
        port: 443,
        addresses: ["192.0.2.1"],
      };
      expect(guard.issue(endpoint)).toBe(true);
      const proxy = new URL(parent);
      const auth = Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
      ).toString("base64");
      await new Promise<void>((resolve, reject) => {
        const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("interrupted CONNECT did not close"));
        }, 1_000);
        socket.once("error", () => undefined);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("connect", () => {
          socket.write(
            `CONNECT ${endpoint.host}:${endpoint.port} HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
          );
          setTimeout(() => socket.destroy(), 10);
        });
      });
    } finally {
      await guard.close();
    }
  });

  it("handles an interrupted plain HTTP dial without an uncaught socket error", async () => {
    clearProxyEnvironment();
    const guard = new SandboxConnectGuard();
    try {
      try {
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "interrupted-http.example",
        port: 80,
        addresses: ["::2"],
      };
      expect(guard.issue(endpoint)).toBe(true);
      const proxy = new URL(parent);
      await new Promise<void>((resolve, reject) => {
        const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
        const auth = Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64");
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("interrupted HTTP request did not close"));
        }, 1_000);
        socket.once("error", () => undefined);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("connect", () => {
          socket.write(
            `GET http://${endpoint.host}:${endpoint.port}/ HTTP/1.1\r\nHost: ${endpoint.host}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
          );
          setTimeout(() => socket.destroy(), 10);
        });
      });
      expect(guard.isStarted).toBe(true);
    } finally {
      await guard.close();
    }
  });

  it("requires an exact one-shot ticket and forwards CONNECT head bytes", async () => {
    clearProxyEnvironment();
    const target = createNetServer((socket) => {
      socket.once("data", (chunk) => {
        socket.end(`TARGET:${chunk.toString("latin1")}`);
      });
    });
    const guard = new SandboxConnectGuard();
    try {
      let targetPort: number;
      try {
        targetPort = await listen(target);
        await guard.start();
      } catch (error) {
        // The managed test runner may deny loopback binds. The integration
        // assertions still run in normal Node environments with networking.
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = { host: "target.example", port: targetPort, addresses: ["127.0.0.1"] };
      expect(guard.issue(endpoint)).toBe(true);

      const first = await proxyRequest(
        parent,
        `CONNECT ${endpoint.host}:${endpoint.port} HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\nX-Test: head\r\n`,
        "HEAD",
      );
      expect(first).toContain("200 Connection Established");
      expect(first).toContain("TARGET:HEAD");

      const second = await proxyRequest(
        parent,
        `CONNECT ${endpoint.host}:${endpoint.port} HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\n`,
      );
      expect(second).toContain("403 Forbidden");
    } finally {
      await guard.close();
      await closeServer(target);
    }
  });

  it("falls back to the next frozen address for CONNECT within one timeout budget", async () => {
    clearProxyEnvironment();
    const target = createNetServer((socket) => {
      socket.once("data", (chunk) => socket.end(`TARGET:${chunk.toString("latin1")}`));
    });
    const guard = new SandboxConnectGuard();
    try {
      let targetPort: number;
      try {
        targetPort = await listen(target);
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "fallback.example",
        port: targetPort,
        addresses: ["::1", "127.0.0.1"],
      };
      expect(guard.issue(endpoint)).toBe(true);

      const response = await proxyRequest(
        parent,
        `CONNECT ${endpoint.host}:${endpoint.port} HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\n`,
        "NEXT",
      );
      expect(response).toContain("200 Connection Established");
      expect(response).toContain("TARGET:NEXT");
    } finally {
      await guard.close();
      await closeServer(target);
    }
  });

  it("tries every frozen address and consumes the ticket when all CONNECT attempts fail", async () => {
    clearProxyEnvironment();
    const guard = new SandboxConnectGuard();
    try {
      try {
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "unreachable.example",
        port: 9,
        addresses: ["::1", "::2"],
      };
      expect(guard.issue(endpoint)).toBe(true);
      const failed = await proxyRequest(
        parent,
        `CONNECT ${endpoint.host}:${endpoint.port} HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\n`,
      );
      expect(failed).not.toContain("200 Connection Established");

      const replay = await proxyRequest(
        parent,
        `CONNECT ${endpoint.host}:${endpoint.port} HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\n`,
      );
      expect(replay).toContain("403 Forbidden");
    } finally {
      await guard.close();
    }
  });

  it("falls back before sending a plain HTTP request body", async () => {
    clearProxyEnvironment();
    const target = createNetServer((socket) => {
      socket.once("data", () =>
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"),
      );
    });
    const guard = new SandboxConnectGuard();
    try {
      let targetPort: number;
      try {
        targetPort = await listen(target);
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "http-fallback.example",
        port: targetPort,
        addresses: ["::1", "127.0.0.1"],
      };
      expect(guard.issue(endpoint)).toBe(true);
      const response = await proxyRequest(
        parent,
        `GET http://${endpoint.host}:${endpoint.port}/resource HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\n`,
      );
      expect(response).toContain("200 OK");
      expect(response).toContain("\r\n\r\nok");
    } finally {
      await guard.close();
      await closeServer(target);
    }
  });

  it("does not use HTTPS_PROXY for non-tunnel plain HTTP", async () => {
    clearProxyEnvironment();
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    const target = createNetServer((socket) => {
      socket.once("data", () =>
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"),
      );
    });
    const guard = new SandboxConnectGuard();
    try {
      let targetPort: number;
      try {
        targetPort = await listen(target);
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = { host: "plain-direct.example", port: targetPort, addresses: ["127.0.0.1"] };
      expect(guard.issue(endpoint)).toBe(true);
      const response = await proxyRequest(
        parent,
        `GET http://${endpoint.host}:${endpoint.port}/direct HTTP/1.1\r\nHost: ${endpoint.host}:${endpoint.port}\r\n`,
      );
      expect(response).toContain("200 OK");
      expect(response).toContain("\r\n\r\nok");
    } finally {
      await guard.close();
      await closeServer(target);
    }
  });

  it("pins an IPv6 target in the upstream HTTP absolute-form request and accepts bracketed proxy hosts", async () => {
    clearProxyEnvironment();
    const upstream = createNetServer((socket) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!buffer.includes(Buffer.from("\r\n\r\n"))) return;
        socket.removeListener("data", onData);
        captured = buffer.toString("latin1");
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      };
      socket.on("data", onData);
    });
    let captured = "";
    const guard = new SandboxConnectGuard();
    try {
      let upstreamPort: number;
      try {
        upstreamPort = await listen(upstream);
        process.env.HTTP_PROXY = `http://[::ffff:127.0.0.1]:${upstreamPort}`;
        process.env.HTTPS_PROXY = "http://127.0.0.1:1";
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "ipv6-target.example",
        port: 80,
        addresses: ["2001:db8::1"],
      };
      expect(guard.issue(endpoint)).toBe(true);
      const response = await proxyRequest(
        parent,
        `GET http://${endpoint.host}/resource?x=1 HTTP/1.1\r\nHost: ${endpoint.host}\r\n`,
      );
      expect(response).toContain("200 OK");
      expect(captured).toContain("GET http://[2001:db8::1]/resource?x=1 HTTP/1.1");
      expect(captured).not.toContain("GET http://ipv6-target.example/resource");
    } finally {
      await guard.close();
      await closeServer(upstream);
    }
  });

  it("uses the frozen IPv6 authority for both upstream CONNECT target and Host", async () => {
    clearProxyEnvironment();
    const upstream = createNetServer((socket) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!buffer.includes(Buffer.from("\r\n\r\n"))) return;
        socket.removeListener("data", onData);
        captured = buffer.toString("latin1");
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      };
      socket.on("data", onData);
    });
    let captured = "";
    const guard = new SandboxConnectGuard();
    let tunnel: Socket | undefined;
    try {
      let upstreamPort: number;
      try {
        upstreamPort = await listen(upstream);
        process.env.HTTP_PROXY = "http://127.0.0.1:1";
        process.env.HTTPS_PROXY = `http://[::ffff:127.0.0.1]:${upstreamPort}`;
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "tls-target.example",
        port: 443,
        addresses: ["2001:db8::1"],
      };
      expect(guard.issue(endpoint)).toBe(true);
      tunnel = await openProxyTunnel(parent, `${endpoint.host}:${endpoint.port}`);
      expect(captured).toContain("CONNECT [2001:db8::1]:443 HTTP/1.1");
      expect(captured).toContain("Host: [2001:db8::1]:443");
      expect(captured).not.toContain("Host: tls-target.example:443");
    } finally {
      tunnel?.destroy();
      await guard.close();
      await closeServer(upstream);
    }
  });

  it("falls back across frozen candidates when an upstream CONNECT rejects the first", async () => {
    clearProxyEnvironment();
    const requests: string[] = [];
    let connectionNumber = 0;
    const upstream = createNetServer((socket) => {
      const currentConnection = ++connectionNumber;
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!buffer.includes(Buffer.from("\r\n\r\n"))) return;
        socket.removeListener("data", onData);
        requests.push(buffer.toString("latin1"));
        if (currentConnection === 1) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        } else {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        }
      };
      socket.on("data", onData);
    });
    const guard = new SandboxConnectGuard();
    let tunnel: Socket | undefined;
    try {
      let upstreamPort: number;
      try {
        upstreamPort = await listen(upstream);
        process.env.HTTP_PROXY = `http://127.0.0.1:${upstreamPort}`;
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = {
        host: "upstream-fallback.example",
        port: 443,
        addresses: ["2001:db8::1", "2001:db8::2"],
      };
      expect(guard.issue(endpoint)).toBe(true);
      tunnel = await openProxyTunnel(parent, `${endpoint.host}:${endpoint.port}`);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain("CONNECT [2001:db8::1]:443 HTTP/1.1");
      expect(requests[0]).toContain("Host: [2001:db8::1]:443");
      expect(requests[1]).toContain("CONNECT [2001:db8::2]:443 HTTP/1.1");
      expect(requests[1]).toContain("Host: [2001:db8::2]:443");
    } finally {
      tunnel?.destroy();
      await guard.close();
      await closeServer(upstream);
    }
  });

  it("does not consume a ticket for a different host and keeps the listener after reset", async () => {
    clearProxyEnvironment();
    const target = createNetServer((socket) => socket.end());
    const guard = new SandboxConnectGuard();
    try {
      let targetPort: number;
      try {
        targetPort = await listen(target);
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = { host: "target.example", port: targetPort, addresses: ["127.0.0.1"] };
      expect(guard.issue(endpoint)).toBe(true);
      const wrongHost = await proxyRequest(
        parent,
        `CONNECT wrong.example:${targetPort} HTTP/1.1\r\nHost: wrong.example:${targetPort}\r\n`,
      );
      expect(wrongHost).toContain("403 Forbidden");
      expect(guard.isStarted).toBe(true);

      guard.resetExecution();
      const reset = await proxyRequest(
        parent,
        `CONNECT ${endpoint.host}:${targetPort} HTTP/1.1\r\nHost: ${endpoint.host}:${targetPort}\r\n`,
      );
      expect(reset).toContain("403 Forbidden");
      expect(guard.isStarted).toBe(true);
    } finally {
      await guard.close();
      await closeServer(target);
    }
  });

  it("destroys active relays when an execution is reset", async () => {
    clearProxyEnvironment();
    const target = createNetServer(() => undefined);
    const guard = new SandboxConnectGuard();
    let tunnel: Socket | undefined;
    try {
      let targetPort: number;
      try {
        targetPort = await listen(target);
        await guard.start();
      } catch (error) {
        if (isNetworkBindUnavailable(error)) return;
        throw error;
      }
      const parent = guard.parentProxyUrl;
      if (!parent) throw new Error("guard did not expose parent proxy");
      const endpoint = { host: "active.example", port: targetPort, addresses: ["127.0.0.1"] };
      expect(guard.issue(endpoint)).toBe(true);
      tunnel = await openProxyTunnel(parent, `${endpoint.host}:${endpoint.port}`);
      expect(tunnel.destroyed).toBe(false);

      guard.resetExecution();
      await waitForClose(tunnel);
      expect(tunnel.destroyed).toBe(true);
      expect(guard.isStarted).toBe(true);
    } finally {
      tunnel?.destroy();
      await guard.close();
      await closeServer(target);
    }
  });
});
