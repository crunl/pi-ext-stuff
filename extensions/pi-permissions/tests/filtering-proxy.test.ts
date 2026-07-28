import { createServer, connect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHostFilteringProxy, type HostFilteringProxy } from "../src/filtering-proxy.ts";

const publicResolver = async (): Promise<readonly string[]> => ["93.184.216.34"];

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("missing test server port"));
      else resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

function readAtLeast(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      length += chunk.length;
      if (length < size) return;
      cleanup();
      resolve(Buffer.concat(chunks, length));
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function httpConnectStatus(proxyPort: number, authority: string): Promise<number> {
  const socket = await open(proxyPort);
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const response = await readAtLeast(socket, 12);
  socket.destroy();
  const status = /^HTTP\/1\.1\s+(\d{3})/.exec(response.toString("latin1"))?.[1];
  if (!status) throw new Error(`invalid HTTP proxy response: ${response.toString("latin1")}`);
  return Number(status);
}

async function socksConnectStatus(proxyPort: number, host: string, port: number): Promise<number> {
  const socket = await open(proxyPort);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  expect([...await readAtLeast(socket, 2)].slice(0, 2)).toEqual([0x05, 0x00]);
  const encoded = Buffer.from(host);
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, encoded.length]),
    encoded,
    Buffer.from([port >> 8, port & 0xff]),
  ]));
  const response = await readAtLeast(socket, 2);
  socket.destroy();
  return response[1]!;
}

describe("host filtering proxy", () => {
  let filteringProxy: HostFilteringProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    await filteringProxy?.close();
    filteringProxy = undefined;
    if (upstream?.listening) await closeServer(upstream);
    upstream = undefined;
  });

  it("forwards only approved HTTP CONNECT hosts to the upstream proxy", async () => {
    const targets: string[] = [];
    upstream = createServer((socket) => {
      void (async () => {
        const request = await readAtLeast(socket, 1);
        const target = /^CONNECT\s+(\S+)/.exec(request.toString("latin1"))?.[1];
        if (target) targets.push(target);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      })();
    });
    const upstreamPort = await listen(upstream);
    filteringProxy = await startHostFilteringProxy(
      ["allowed.example"],
      { http: upstreamPort },
      [],
      publicResolver,
    );

    await expect(httpConnectStatus(filteringProxy.ports.http, "allowed.example:443"))
      .resolves.toBe(200);
    await expect(httpConnectStatus(filteringProxy.ports.http, "blocked.example:443"))
      .resolves.toBe(403);
    expect(targets).toEqual(["93.184.216.34:443"]);
  });

  it("applies the same host boundary to SOCKS5 traffic", async () => {
    const targets: string[] = [];
    upstream = createServer((socket) => {
      void (async () => {
        const request = await readAtLeast(socket, 1);
        const target = /^CONNECT\s+(\S+)/.exec(request.toString("latin1"))?.[1];
        if (target) targets.push(target);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      })();
    });
    const upstreamPort = await listen(upstream);
    filteringProxy = await startHostFilteringProxy(
      ["allowed.example"],
      { http: upstreamPort },
      [],
      publicResolver,
    );

    await expect(socksConnectStatus(filteringProxy.ports.socks, "allowed.example", 22))
      .resolves.toBe(0x00);
    await expect(socksConnectStatus(filteringProxy.ports.socks, "blocked.example", 22))
      .resolves.toBe(0x02);
    expect(targets).toEqual(["93.184.216.34:22"]);
  });

  it("rejects private targets even when they appear in the approved host set", async () => {
    let upstreamConnections = 0;
    upstream = createServer(() => {
      upstreamConnections += 1;
    });
    const upstreamPort = await listen(upstream);
    filteringProxy = await startHostFilteringProxy(
      ["127.0.0.1", "169.254.169.254"],
      { http: upstreamPort },
    );

    await expect(httpConnectStatus(filteringProxy.ports.http, "127.0.0.1:80"))
      .resolves.toBe(403);
    await expect(socksConnectStatus(filteringProxy.ports.socks, "169.254.169.254", 80))
      .resolves.toBe(0x02);
    expect(upstreamConnections).toBe(0);
  });

  it("supports allowed wildcards while giving denied domains precedence", async () => {
    const targets: string[] = [];
    upstream = createServer((socket) => {
      void (async () => {
        const request = await readAtLeast(socket, 1);
        const target = /^CONNECT\s+(\S+)/.exec(request.toString("latin1"))?.[1];
        if (target) targets.push(target);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      })();
    });
    const upstreamPort = await listen(upstream);
    filteringProxy = await startHostFilteringProxy(
      ["*.example.com"],
      { http: upstreamPort },
      ["blocked.example.com"],
      publicResolver,
    );

    await expect(httpConnectStatus(filteringProxy.ports.http, "api.example.com:443"))
      .resolves.toBe(200);
    await expect(httpConnectStatus(filteringProxy.ports.http, "blocked.example.com:443"))
      .resolves.toBe(403);
    await expect(httpConnectStatus(filteringProxy.ports.http, "example.com:443"))
      .resolves.toBe(403);
    expect(targets).toEqual(["93.184.216.34:443"]);
  });

  it("rejects the whole host when any DNS result is private", async () => {
    let upstreamConnections = 0;
    upstream = createServer(() => {
      upstreamConnections += 1;
    });
    const upstreamPort = await listen(upstream);
    const resolver = vi.fn(async () => ["93.184.216.34", "10.0.0.8"]);
    filteringProxy = await startHostFilteringProxy(
      ["mixed.example"],
      { http: upstreamPort },
      [],
      resolver,
    );

    await expect(httpConnectStatus(filteringProxy.ports.http, "mixed.example:443"))
      .resolves.toBe(403);
    expect(resolver).toHaveBeenCalledOnce();
    expect(upstreamConnections).toBe(0);
  });

  it("caches validated DNS results for the command lifetime", async () => {
    const targets: string[] = [];
    upstream = createServer((socket) => {
      void (async () => {
        const request = await readAtLeast(socket, 1);
        const target = /^CONNECT\s+(\S+)/.exec(request.toString("latin1"))?.[1];
        if (target) targets.push(target);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      })();
    });
    const upstreamPort = await listen(upstream);
    const resolver = vi.fn(async () => ["93.184.216.34"]);
    filteringProxy = await startHostFilteringProxy(
      ["cached.example"],
      { http: upstreamPort },
      [],
      resolver,
    );

    await expect(httpConnectStatus(filteringProxy.ports.http, "cached.example:443"))
      .resolves.toBe(200);
    await expect(socksConnectStatus(filteringProxy.ports.socks, "cached.example", 22))
      .resolves.toBe(0x00);
    expect(resolver).toHaveBeenCalledOnce();
    expect(targets).toEqual(["93.184.216.34:443", "93.184.216.34:22"]);
  });

  it("fails closed when DNS resolution fails", async () => {
    let upstreamConnections = 0;
    upstream = createServer(() => {
      upstreamConnections += 1;
    });
    const upstreamPort = await listen(upstream);
    filteringProxy = await startHostFilteringProxy(
      ["missing.example"],
      { http: upstreamPort },
      [],
      async () => {
        throw new Error("DNS unavailable");
      },
    );

    await expect(httpConnectStatus(filteringProxy.ports.http, "missing.example:443"))
      .resolves.toBe(403);
    expect(upstreamConnections).toBe(0);
  });

  it("does not establish an upstream connection after close wins a pending resolution", async () => {
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    let finishResolution!: (addresses: readonly string[]) => void;
    const resolver = vi.fn(async () => {
      markResolverStarted();
      return new Promise<readonly string[]>((resolve) => {
        finishResolution = resolve;
      });
    });
    let markUpstreamConnected!: () => void;
    const upstreamConnected = new Promise<void>((resolve) => {
      markUpstreamConnected = resolve;
    });
    upstream = createServer((socket) => {
      socket.destroy();
      markUpstreamConnected();
    });
    const upstreamPort = await listen(upstream);
    filteringProxy = await startHostFilteringProxy(
      ["pending.example"],
      { http: upstreamPort },
      [],
      resolver,
    );
    const client = await open(filteringProxy.ports.http);
    client.write("CONNECT pending.example:443 HTTP/1.1\r\nHost: pending.example:443\r\n\r\n");
    await resolverStarted;

    await filteringProxy.close();
    filteringProxy = undefined;
    finishResolution(["93.184.216.34"]);

    const outcome = await Promise.race([
      upstreamConnected.then(() => "connected"),
      new Promise<"closed">((resolve) => setTimeout(() => resolve("closed"), 50)),
    ]);
    client.destroy();
    expect(outcome).toBe("closed");
  });

  it("destroys an upstream CONNECT handshake that is still in flight", async () => {
    let upstreamSocket!: Socket;
    let markUpstreamConnected!: () => void;
    const upstreamConnected = new Promise<void>((resolve) => {
      markUpstreamConnected = resolve;
    });
    upstream = createServer((socket) => {
      upstreamSocket = socket;
      upstreamSocket.resume();
      markUpstreamConnected();
    });
    const upstreamPort = await listen(upstream);
    filteringProxy = await startHostFilteringProxy(
      ["pending.example"],
      { http: upstreamPort },
      [],
      publicResolver,
    );
    const client = await open(filteringProxy.ports.http);
    client.write("CONNECT pending.example:443 HTTP/1.1\r\nHost: pending.example:443\r\n\r\n");
    await upstreamConnected;
    const upstreamClosed = new Promise<"closed">((resolve) => {
      upstreamSocket.once("end", () => resolve("closed"));
      upstreamSocket.once("close", () => resolve("closed"));
    });

    await filteringProxy.close();
    filteringProxy = undefined;
    const outcome = await Promise.race([
      upstreamClosed,
      new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 50)),
    ]);
    client.destroy();
    upstreamSocket.destroy();
    expect(outcome).toBe("closed");
  });
});
