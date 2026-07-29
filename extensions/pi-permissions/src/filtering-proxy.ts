import {
  createServer as createHttpServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { createServer as createTcpServer, connect, isIP, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { isPublicNetworkHost } from "./permissions/risk.ts";
import type { LocalProxyPorts } from "./sandbox.ts";

export interface HostFilteringProxy {
  ports: Required<LocalProxyPorts>;
  close(): Promise<void>;
}

export type HostResolver = (host: string) => Promise<readonly string[]>;

class DestinationResolutionError extends Error {
  readonly proxyError = "dns-resolution-failed";

  constructor(host: string, cause: unknown) {
    super(`DNS resolution failed for ${host}`, { cause });
    this.name = "DestinationResolutionError";
  }
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

function matchesDomainPattern(host: string, pattern: string): boolean {
  const normalizedPattern = normalizeHost(pattern);
  if (normalizedPattern.startsWith("*.")) {
    return host.endsWith(normalizedPattern.slice(1)) && host !== normalizedPattern.slice(2);
  }
  return host === normalizedPattern;
}

function isValidDestinationHost(host: string): boolean {
  if (isIP(host) !== 0) return true;
  return host.length <= 253
    && host.split(".").every((label) =>
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function destinationAuthority(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function readExactly(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;

    const cleanup = (): void => {
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("proxy connection ended before handshake completed"));
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      length += chunk.length;
      if (length < size) return;
      cleanup();
      const value = Buffer.concat(chunks, length);
      if (value.length > size) socket.unshift(value.subarray(size));
      resolve(value.subarray(0, size));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.resume();
  });
}

function readHttpHeaders(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;

    const cleanup = (): void => {
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("upstream proxy closed during CONNECT"));
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      length += chunk.length;
      if (length > 64 * 1024) {
        cleanup();
        reject(new Error("upstream proxy returned oversized headers"));
        return;
      }
      const value = Buffer.concat(chunks, length);
      const boundary = value.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      cleanup();
      const remainder = value.subarray(boundary + 4);
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(value.subarray(0, boundary).toString("latin1"));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.resume();
  });
}

type SocketTracker = (socket: Socket | Duplex) => void;

function connectLoopback(
  port: number,
  track?: SocketTracker,
  signal?: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, signal });
    track?.(socket);
    const onError = (error: Error): void => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.setNoDelay();
      resolve(socket);
    });
  });
}

async function connectThroughHttpProxy(
  proxyPort: number,
  host: string,
  port: number,
  track?: SocketTracker,
  signal?: AbortSignal,
): Promise<Socket> {
  const socket = await connectLoopback(proxyPort, track, signal);
  const authority = destinationAuthority(host, port);
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
  const headers = await readHttpHeaders(socket);
  const status = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(headers)?.[1];
  if (status !== "200") {
    socket.destroy();
    throw new Error(`upstream HTTP proxy rejected ${authority}: ${status ?? "invalid response"}`);
  }
  return socket;
}

function encodeSocksDestination(host: string): Buffer {
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return Buffer.from([0x01, ...host.split(".").map(Number)]);
  }
  if (ipVersion === 6) {
    const expanded = host.includes("::")
      ? (() => {
          const [left, right] = host.split("::");
          const leftParts = left ? left.split(":") : [];
          const rightParts = right ? right.split(":") : [];
          return [...leftParts, ...Array(8 - leftParts.length - rightParts.length).fill("0"), ...rightParts];
        })()
      : host.split(":");
    const bytes = expanded.flatMap((part) => {
      const value = Number.parseInt(part || "0", 16);
      return [value >> 8, value & 0xff];
    });
    return Buffer.from([0x04, ...bytes]);
  }
  const encoded = Buffer.from(host, "utf8");
  if (encoded.length === 0 || encoded.length > 255) throw new Error("invalid SOCKS destination host");
  return Buffer.concat([Buffer.from([0x03, encoded.length]), encoded]);
}

async function consumeSocksReply(socket: Socket): Promise<void> {
  const prefix = await readExactly(socket, 4);
  if (prefix[0] !== 0x05 || prefix[1] !== 0x00) {
    throw new Error(`upstream SOCKS proxy rejected connection with status ${prefix[1]}`);
  }
  if (prefix[3] === 0x01) await readExactly(socket, 4 + 2);
  else if (prefix[3] === 0x04) await readExactly(socket, 16 + 2);
  else if (prefix[3] === 0x03) {
    const length = (await readExactly(socket, 1))[0]!;
    await readExactly(socket, length + 2);
  } else {
    throw new Error("upstream SOCKS proxy returned an invalid address type");
  }
}

async function connectThroughSocksProxy(
  proxyPort: number,
  host: string,
  port: number,
  track?: SocketTracker,
  signal?: AbortSignal,
): Promise<Socket> {
  const socket = await connectLoopback(proxyPort, track, signal);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readExactly(socket, 2);
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
    socket.destroy();
    throw new Error("upstream SOCKS proxy does not support unauthenticated SOCKS5");
  }
  const destination = encodeSocksDestination(host);
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00]),
    destination,
    Buffer.from([port >> 8, port & 0xff]),
  ]));
  try {
    await consumeSocksReply(socket);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function connectThroughUpstream(
  upstream: LocalProxyPorts,
  host: string,
  port: number,
  track?: SocketTracker,
  signal?: AbortSignal,
): Promise<Socket> {
  if (upstream.http) return connectThroughHttpProxy(upstream.http, host, port, track, signal);
  if (upstream.socks) return connectThroughSocksProxy(upstream.socks, host, port, track, signal);
  throw new Error("no supported local upstream proxy is configured");
}

function isProxyFakeIp(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 198 && (second === 18 || second === 19);
}

interface DnsJsonResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

async function queryDnsOverHttps(
  upstream: LocalProxyPorts,
  host: string,
  recordType: "A" | "AAAA",
  track?: SocketTracker,
  signal?: AbortSignal,
): Promise<string[]> {
  const tunnel = await connectThroughUpstream(
    upstream,
    "cloudflare-dns.com",
    443,
    track,
    signal,
  );
  const secureSocket = connectTls({ socket: tunnel, servername: "cloudflare-dns.com" });
  track?.(secureSocket);
  secureSocket.setTimeout(10_000, () => secureSocket.destroy(new Error("DNS-over-HTTPS timeout")));
  await new Promise<void>((resolve, reject) => {
    secureSocket.once("secureConnect", resolve);
    secureSocket.once("error", reject);
  });

  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: "cloudflare-dns.com",
      path: `/dns-query?name=${encodeURIComponent(host)}&type=${recordType}`,
      method: "GET",
      headers: {
        accept: "application/dns-json",
        connection: "close",
        host: "cloudflare-dns.com",
      },
      agent: false,
      createConnection: () => secureSocket,
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 64 * 1024) {
          request.destroy(new Error("DNS-over-HTTPS response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`DNS-over-HTTPS returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as DnsJsonResponse;
          if (payload.Status !== 0) {
            reject(new Error(`DNS-over-HTTPS returned status ${payload.Status}`));
            return;
          }
          const expectedType = recordType === "A" ? 1 : 28;
          resolve((payload.Answer ?? [])
            .filter((answer) => answer.type === expectedType && typeof answer.data === "string")
            .map((answer) => answer.data!));
        } catch (error) {
          reject(error);
        }
      });
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end();
  });
}

async function defaultHostResolver(
  host: string,
  upstream: LocalProxyPorts,
  track?: SocketTracker,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (isIP(host) !== 0) return [host];
  const addresses = await lookup(host, { all: true, verbatim: true });
  const systemAddresses = addresses.map(({ address }) => address);
  if (!systemAddresses.every(isProxyFakeIp)) return systemAddresses;
  const [ipv4, ipv6] = await Promise.all([
    queryDnsOverHttps(upstream, host, "A", track, signal),
    queryDnsOverHttps(upstream, host, "AAAA", track, signal),
  ]);
  return [...ipv4, ...ipv6];
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("filtering proxy failed to allocate a loopback port"));
        return;
      }
      server.unref();
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

function parseIncomingSocksHost(request: Buffer): string {
  if (request[3] === 0x01) return [...request.subarray(4, 8)].join(".");
  if (request[3] === 0x03) return request.subarray(5, 5 + request[4]!).toString("utf8");
  if (request[3] === 0x04) {
    const groups: string[] = [];
    for (let index = 4; index < 20; index += 2) groups.push(request.readUInt16BE(index).toString(16));
    return groups.join(":");
  }
  throw new Error("unsupported SOCKS address type");
}

async function readIncomingSocksRequest(socket: Socket): Promise<{ host: string; port: number }> {
  const greeting = await readExactly(socket, 2);
  if (greeting[0] !== 0x05) throw new Error("unsupported SOCKS version");
  const methods = await readExactly(socket, greeting[1]!);
  if (!methods.includes(0x00)) {
    socket.write(Buffer.from([0x05, 0xff]));
    throw new Error("SOCKS client requires unsupported authentication");
  }
  socket.write(Buffer.from([0x05, 0x00]));

  const prefix = await readExactly(socket, 4);
  if (prefix[0] !== 0x05 || prefix[1] !== 0x01) throw new Error("only SOCKS5 CONNECT is supported");
  let suffixLength: number;
  if (prefix[3] === 0x01) suffixLength = 4 + 2;
  else if (prefix[3] === 0x04) suffixLength = 16 + 2;
  else if (prefix[3] === 0x03) {
    const length = (await readExactly(socket, 1))[0]!;
    const suffix = await readExactly(socket, length + 2);
    const request = Buffer.concat([prefix, Buffer.from([length]), suffix]);
    return {
      host: parseIncomingSocksHost(request),
      port: suffix.readUInt16BE(length),
    };
  } else {
    throw new Error("unsupported SOCKS address type");
  }
  const suffix = await readExactly(socket, suffixLength);
  const request = Buffer.concat([prefix, suffix]);
  return {
    host: parseIncomingSocksHost(request),
    port: suffix.readUInt16BE(suffix.length - 2),
  };
}

export async function startHostFilteringProxy(
  approvedHosts: readonly string[],
  upstream: LocalProxyPorts,
  deniedHosts: readonly string[] = [],
  resolveHost?: HostResolver,
): Promise<HostFilteringProxy> {
  if (!upstream.http && !upstream.socks) throw new Error("local upstream proxy is unavailable");
  const allowedPatterns = approvedHosts.map(normalizeHost);
  const deniedPatterns = deniedHosts.map(normalizeHost);
  let closed = false;
  const lifecycle = new AbortController();
  const activeSockets = new Set<Socket | Duplex>();
  const track = (socket: Socket | Duplex): void => {
    if (activeSockets.has(socket)) return;
    activeSockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => activeSockets.delete(socket));
  };
  const isAllowed = (host: string): boolean => {
    const normalized = normalizeHost(host);
    return !closed
      && isValidDestinationHost(normalized)
      && isPublicNetworkHost(normalized)
      && !deniedPatterns.some((pattern) => matchesDomainPattern(normalized, pattern))
      && allowedPatterns.some((pattern) => matchesDomainPattern(normalized, pattern));
  };
  const resolvedHosts = new Map<string, Promise<readonly string[] | undefined>>();
  const resolveAllowedAddresses = (host: string): Promise<readonly string[] | undefined> => {
    const normalized = normalizeHost(host);
    const cached = resolvedHosts.get(normalized);
    if (cached) return cached;
    const pending = (async () => {
      if (!isAllowed(normalized)) return undefined;
      let addresses: readonly string[];
      try {
        addresses = isIP(normalized) !== 0
          ? [normalized]
          : await (resolveHost
              ? resolveHost(normalized)
              : defaultHostResolver(normalized, upstream, track, lifecycle.signal));
      } catch (error) {
        throw new DestinationResolutionError(normalized, error);
      }
      if (closed) return undefined;
      const normalizedAddresses = [...new Set(addresses.map(normalizeHost))];
      if (
        normalizedAddresses.length === 0
        || normalizedAddresses.some((address) =>
          isIP(address) === 0 || !isPublicNetworkHost(address))
      ) return undefined;
      return normalizedAddresses;
    })();
    resolvedHosts.set(normalized, pending);
    return pending;
  };
  const connectPinned = async (
    addresses: readonly string[],
    port: number,
  ): Promise<Socket> => {
    let lastError: unknown;
    for (const address of addresses) {
      if (closed) throw new Error("filtering proxy is closed");
      try {
        const socket = await connectThroughUpstream(
          upstream,
          address,
          port,
          track,
          lifecycle.signal,
        );
        if (closed) {
          socket.destroy();
          throw new Error("filtering proxy is closed");
        }
        return socket;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("no validated destination address is available");
  };

  const httpServer = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "");
      const host = normalizeHost(url.hostname);
      const addresses = url.protocol === "http:"
        ? await resolveAllowedAddresses(host)
        : undefined;
      if (!addresses) {
        response.writeHead(403, { "X-Proxy-Error": "blocked-by-pi-permissions" });
        response.end("Connection blocked by pi-permissions");
        return;
      }
      const port = url.port ? Number(url.port) : 80;
      const tunnel = await connectPinned(addresses, port);
      track(tunnel);
      const headers: OutgoingHttpHeaders = { ...request.headers, host: url.host };
      delete headers["proxy-connection"];
      const proxyRequest = httpRequest({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        createConnection: () => tunnel,
        agent: false,
      }, (proxyResponse) => {
        response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(response);
      });
      proxyRequest.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Upstream proxy failure");
      });
      request.pipe(proxyRequest);
    } catch (error) {
      if (error instanceof DestinationResolutionError) {
        response.writeHead(502, { "X-Proxy-Error": error.proxyError });
        response.end("DNS resolution failed");
      } else {
        response.writeHead(400);
        response.end("Invalid proxy request");
      }
    }
  });
  httpServer.on("connection", track);
  httpServer.on("connect", async (request, clientSocket) => {
    track(clientSocket);
    try {
      const parsed = new URL(`https://${request.url}`);
      const host = normalizeHost(parsed.hostname);
      const port = parsed.port ? Number(parsed.port) : 443;
      const addresses = await resolveAllowedAddresses(host);
      if (!addresses) {
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nX-Proxy-Error: blocked-by-pi-permissions\r\n\r\n");
        return;
      }
      const tunnel = await connectPinned(addresses, port);
      track(tunnel);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      tunnel.pipe(clientSocket);
      clientSocket.pipe(tunnel);
    } catch (error) {
      const proxyError = error instanceof DestinationResolutionError
        ? `X-Proxy-Error: ${error.proxyError}\r\n`
        : "";
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n${proxyError}\r\n`);
    }
  });

  const socksServer = createTcpServer((clientSocket) => {
    track(clientSocket);
    void (async () => {
      try {
        const { host: rawHost, port } = await readIncomingSocksRequest(clientSocket);
        const host = normalizeHost(rawHost);
        const addresses = await resolveAllowedAddresses(host);
        if (!addresses) {
          clientSocket.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const tunnel = await connectPinned(addresses, port);
        track(tunnel);
        clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        tunnel.pipe(clientSocket);
        clientSocket.pipe(tunnel);
      } catch {
        clientSocket.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      }
    })();
  });

  try {
    const [http, socks] = await Promise.all([listen(httpServer), listen(socksServer)]);
    return {
      ports: { http, socks },
      async close() {
        closed = true;
        lifecycle.abort(new Error("filtering proxy closed"));
        for (const socket of activeSockets) {
          socket.destroy(new Error("filtering proxy closed"));
        }
        await Promise.all([closeServer(httpServer), closeServer(socksServer)]);
      },
    };
  } catch (error) {
    for (const socket of activeSockets) socket.destroy(error instanceof Error ? error : undefined);
    await Promise.allSettled([closeServer(httpServer), closeServer(socksServer)]);
    throw error;
  }
}
