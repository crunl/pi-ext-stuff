import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { URL } from "node:url";

import { isLoopbackAddress, isValidNetworkPort, normalizeNetworkHost } from "../network-host.ts";
import type { SandboxNetworkEndpoint } from "../sandbox.ts";

const MAX_TICKETS = 256;
const TICKET_TTL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

function ticketKey(hostInput: string, port: number): string | undefined {
  const host = normalizeNetworkHost(hostInput);
  if (!host || !isValidNetworkPort(port)) return undefined;
  return `${host}:${port}`;
}

function parseAuthority(authority: string | undefined): { host: string; port: number } | undefined {
  if (!authority) return undefined;
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(authority.trim());
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !isValidNetworkPort(port)) return undefined;
  const normalized = normalizeNetworkHost(host);
  return normalized ? { host: normalized, port } : undefined;
}

function expectedBasic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function formatAuthority(host: string, port: number): string {
  const normalized = normalizeNetworkHost(host) ?? host;
  return `${isIP(normalized) === 6 ? `[${normalized}]` : normalized}:${port}`;
}

function requestAuth(request: IncomingMessage): string | undefined {
  const value = request.headers["proxy-authorization"];
  return Array.isArray(value) ? value[0] : value;
}

function closeSocket(socket: Duplex): void {
  socket.destroy();
}

function configuredProxy(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Invalid HTTP(S)_PROXY URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error("Only HTTP(S)_PROXY is supported by the network connect guard");
  }
  try {
    // URL preserves percent-encoded credentials. Validate them while the
    // synchronous start path can still report a clean configuration error;
    // proxy event handlers must never throw from decodeURIComponent later.
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error("Invalid HTTP(S)_PROXY credentials");
  }
  return parsed;
}

type NoProxyRule =
  | { kind: "host"; host: string }
  | { kind: "cidr"; address: string; prefix: number };

type ClientConnection = {
  readonly destroyed: boolean;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
};

function parseNoProxyRule(rawEntry: string): NoProxyRule | "*" | undefined {
  let value = rawEntry.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "*") return "*";

  // SRT treats every slash-containing entry as a CIDR candidate before it
  // considers host syntax. A `10.0.0.0/8:443` form is therefore malformed
  // and ignored, rather than becoming a port-qualified CIDR.
  const slash = value.indexOf("/");
  if (slash !== -1) {
    const rawAddress = value.slice(0, slash);
    const prefixText = value.slice(slash + 1);
    const family = isIP(rawAddress);
    const address = normalizeNetworkHost(rawAddress);
    const prefix = Number(prefixText);
    const maximum = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (
      !address ||
      family === 0 ||
      !/^\d+$/.test(prefixText) ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > maximum
    ) {
      return undefined;
    }
    return { kind: "cidr", address, prefix };
  }

  // Match SRT's parent-proxy parser: bracketed IPv6 may carry a numeric
  // suffix, but the suffix is discarded. An unbracketed IPv6 literal is
  // tested as a whole first, so its final hextet can never be mistaken for a
  // port. Domain/IPv4 `:port` suffixes are also stripped without validation;
  // parent-proxy matching is host-only.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1] ?? value;
  if (value.startsWith("*.")) value = value.slice(1);
  const bareFamily = isIP(value);
  if (bareFamily !== 0) {
    const host = normalizeNetworkHost(value);
    return host ? { kind: "host", host } : undefined;
  }
  const colon = value.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(value.slice(colon + 1))) {
    value = value.slice(0, colon);
  }
  if (value.startsWith(".")) value = value.slice(1);
  const host = normalizeNetworkHost(value);
  if (!host) return undefined;
  return { kind: "host", host };
}

function cidrMatches(host: string, address: string, prefix: number): boolean {
  const family = isIP(host);
  if (family === 0 || family !== isIP(address)) return false;
  const blockList = new BlockList();
  blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  return blockList.check(host, family === 4 ? "ipv4" : "ipv6");
}

/** Match a destination against conventional host-only NO_PROXY entries. */
export function noProxyMatchesHost(hostInput: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = normalizeNetworkHost(hostInput);
  if (!host) return false;
  return noProxy.split(",").some((entry) => {
    const rule = parseNoProxyRule(entry);
    if (rule === "*") return true;
    if (!rule) return false;
    if (rule.kind === "cidr") return cidrMatches(host, rule.address, rule.prefix);
    if (host === rule.host) return true;
    // A domain NO_PROXY entry covers its subdomains. IP literals never use
    // suffix matching, which also prevents `::1` from being treated as `:1`.
    return isIP(host) === 0 && isIP(rule.host) === 0 && host.endsWith(`.${rule.host}`);
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeNetworkHost(host);
  if (!normalized) return false;
  if (normalized === "localhost") return true;
  return isLoopbackAddress(normalized);
}

/** Apply SRT's unconditional loopback bypass before conventional NO_PROXY rules. */
export function shouldBypassParentProxy(hostInput: string, noProxy: string | undefined): boolean {
  return isLoopbackHost(hostInput) || noProxyMatchesHost(hostInput, noProxy);
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripHopByHopHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[] | undefined> {
  const connectionTokens = new Set(
    (typeof headers.connection === "string" ? headers.connection : "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  const result: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    result[name] = value;
  }
  return result;
}

/** Replace a URL authority with the already-pinned dial address. */
export function targetWithAddress(target: URL, address: string): URL {
  if (typeof address !== "string") return new URL(target.href);
  const rewritten = new URL(target.href);
  const normalized = normalizeNetworkHost(address);
  if (!normalized || isIP(normalized) === 0) return rewritten;
  // WHATWG URL silently ignores a bare IPv6 hostname assignment. Brackets
  // are part of the authority grammar and force the setter to replace the
  // original hostname instead of leaving a rebinding-prone domain behind.
  rewritten.hostname = isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  return rewritten;
}

function normalizeEndpoint(endpoint: SandboxNetworkEndpoint): SandboxNetworkEndpoint | undefined {
  if (!endpoint || typeof endpoint !== "object" || typeof endpoint.host !== "string") {
    return undefined;
  }
  const host = normalizeNetworkHost(endpoint.host);
  if (!host || !isValidNetworkPort(endpoint.port)) {
    return undefined;
  }
  if (!Array.isArray(endpoint.addresses) || endpoint.addresses.length === 0) return undefined;
  if (endpoint.addresses.some((address) => typeof address !== "string")) return undefined;
  const addresses = endpoint.addresses.map((address) => normalizeNetworkHost(address));
  if (
    addresses.some((address) => !address || isIP(address) === 0) ||
    new Set(addresses).size !== addresses.length
  ) {
    return undefined;
  }
  return Object.freeze({
    host,
    port: endpoint.port,
    addresses: Object.freeze(addresses as string[]),
  });
}

/**
 * A loopback-only HTTP parent proxy for SRT's internal authenticated proxy.
 * SRT authenticates the sandbox child; this second hop authenticates SRT and
 * consumes an address-bound, one-shot ticket minted by the network boundary.
 */
export class SandboxConnectGuard {
  private readonly username = "pi-permissions";
  private readonly password = randomBytes(32).toString("hex");
  private readonly tickets = new Map<string, SandboxNetworkEndpoint[]>();
  private readonly sockets = new Set<Duplex>();
  private server: Server | undefined;
  private port: number | undefined;
  private starting: Promise<void> | undefined;
  private ticketCount = 0;
  private upstreamHttpProxy: URL | undefined;
  private upstreamHttpsProxy: URL | undefined;
  private upstreamNoProxy: string | undefined;

  get isStarted(): boolean {
    return this.server !== undefined && this.port !== undefined;
  }

  get parentProxyUrl(): string | undefined {
    if (!this.port) return undefined;
    return `http://${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    this.upstreamHttpProxy = configuredProxy(process.env.HTTP_PROXY ?? process.env.http_proxy);
    this.upstreamHttpsProxy = configuredProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy);
    this.upstreamNoProxy = process.env.NO_PROXY ?? process.env.no_proxy;
    const server = createServer((request, response) => {
      request.once("error", () => {
        request.destroy();
        if (!response.headersSent && !response.destroyed) response.writeHead(400);
        if (!response.destroyed && !response.writableEnded) response.end();
      });
      response.once("error", () => response.destroy());
      void this.handleRequest(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed) response.writeHead(502);
        if (!response.destroyed && !response.writableEnded) response.end();
      });
    });
    server.on("connect", (request, socket, head) => {
      this.trackSocket(socket);
      socket.once("error", () => socket.destroy());
      void this.handleConnect(request, socket, head).catch(() => socket.destroy());
    });
    server.on("connection", (socket) => this.trackSocket(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("connect guard did not expose a TCP address"));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    }).catch((error) => {
      if (server.listening) server.close();
      throw error;
    });
  }

  issue(endpoint: SandboxNetworkEndpoint): boolean {
    const normalized = normalizeEndpoint(endpoint);
    const key = normalized && ticketKey(normalized.host, normalized.port);
    if (!normalized || !key) return false;
    if (this.ticketCount >= MAX_TICKETS) return false;
    const current = this.tickets.get(key) ?? [];
    current.push(
      Object.freeze({
        ...normalized,
        expiresAt: Date.now() + TICKET_TTL_MS,
      } as SandboxNetworkEndpoint & { expiresAt: number }),
    );
    this.tickets.set(key, current);
    this.ticketCount += 1;
    return true;
  }

  clearTickets(): void {
    this.tickets.clear();
    this.ticketCount = 0;
  }

  /**
   * End every relay belonging to one SRT execution while keeping the listener
   * available for the next execution. Tickets and live sockets are both
   * execution capabilities; neither may survive the coordinator lease.
   */
  resetExecution(): void {
    this.clearTickets();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async close(): Promise<void> {
    this.resetExecution();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private trackSocket(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private consume(hostInput: string, port: number): SandboxNetworkEndpoint | undefined {
    const key = ticketKey(hostInput, port);
    if (!key) return undefined;
    const entries = this.tickets.get(key);
    let endpoint = entries?.shift() as
      | (SandboxNetworkEndpoint & { expiresAt?: number })
      | undefined;
    while (endpoint && endpoint.expiresAt !== undefined && endpoint.expiresAt <= Date.now()) {
      this.ticketCount -= 1;
      endpoint = entries?.shift() as (SandboxNetworkEndpoint & { expiresAt?: number }) | undefined;
    }
    if (!entries || entries.length === 0) this.tickets.delete(key);
    if (endpoint) this.ticketCount -= 1;
    if (!endpoint) return undefined;
    const { expiresAt: _expiresAt, ...publicEndpoint } = endpoint;
    return publicEndpoint;
  }

  private authenticated(request: IncomingMessage): boolean {
    return requestAuth(request) === expectedBasic(this.username, this.password);
  }

  private async handleConnect(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.authenticated(request)) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
      return;
    }
    const authority = parseAuthority(request.url);
    const endpoint = authority ? this.consume(authority.host, authority.port) : undefined;
    if (!endpoint) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = await this.dial(endpoint, socket).catch(() => undefined);
    if (!upstream || socket.destroyed) {
      upstream?.destroy();
      closeSocket(socket);
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    this.trackSocket(upstream);
    upstream.on("error", () => upstream.destroy());
    socket.on("error", () => socket.destroy());
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.once("close", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authenticated(request)) {
      response.writeHead(407, { "Proxy-Authenticate": "Basic" });
      response.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const host = normalizeNetworkHost(target.hostname);
    const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    const endpoint = host ? this.consume(host, port) : undefined;
    if (!endpoint) {
      response.writeHead(403);
      response.end();
      return;
    }
    // Do not let a failed first candidate consume request bytes. A retry is
    // safe only before this request is committed to an upstream transport.
    request.pause();
    const headers = stripHopByHopHeaders(request.headers);
    headers.host = target.host;
    const proxy = this.proxyFor(host, false);
    const makeRequest = proxy?.protocol === "https:" ? httpsRequest : httpRequest;
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let lastError: Error | undefined;
    for (const address of endpoint.addresses) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let transport: Socket | undefined;
      try {
        transport = proxy
          ? await this.connectProxyTransport(proxy, request, remaining)
          : await this.dialDirect(address, port, request, remaining);
        if (request.destroyed || response.destroyed) {
          transport.destroy();
          return;
        }
        const proxyTarget = proxy ? targetWithAddress(target, address) : undefined;
        const outgoing = makeRequest(
          proxy
            ? {
                host: this.proxyHost(proxy),
                port: this.proxyPort(proxy),
                method: request.method,
                path: proxyTarget?.href ?? target.href,
                agent: false,
                createConnection: () => transport as Socket,
                headers: {
                  ...headers,
                  ...(proxy.username || proxy.password
                    ? { "proxy-authorization": this.proxyAuthorization(proxy) }
                    : {}),
                },
              }
            : {
                host: address,
                port,
                method: request.method,
                agent: false,
                createConnection: () => transport as Socket,
                headers,
              },
          (reply) => {
            reply.once("error", () => reply.destroy());
            try {
              response.writeHead(reply.statusCode ?? 502, reply.headers);
              reply.pipe(response);
            } catch {
              reply.destroy();
              response.destroy();
            }
          },
        );
        // Once request bytes are handed to Node, retrying could duplicate a
        // body. Candidate fallback therefore stops at this first committed
        // request; connection failures above remain safe to retry.
        outgoing.once("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.pipe(outgoing);
        response.once("close", () => outgoing.destroy());
        return;
      } catch (error) {
        transport?.destroy();
        lastError = error instanceof Error ? error : new Error(String(error));
        if (request.destroyed || response.destroyed) return;
      }
    }
    if (!response.headersSent && !response.destroyed) response.writeHead(502);
    if (!response.writableEnded) response.end(lastError?.message);
  }

  private dial(endpoint: SandboxNetworkEndpoint, client: Duplex): Promise<Socket> {
    const proxy = this.proxyFor(endpoint.host, true);
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    return this.dialCandidates(endpoint, client, proxy, deadline);
  }

  private async dialCandidates(
    endpoint: SandboxNetworkEndpoint,
    client: Duplex,
    proxy: URL | undefined,
    deadline: number,
  ): Promise<Socket> {
    let lastError: Error | undefined;
    for (const address of endpoint.addresses) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        return proxy
          ? await this.dialViaProxy(proxy, endpoint, address, client, remaining)
          : await this.dialDirect(address, endpoint.port, client, remaining);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (client.destroyed) break;
      }
    }
    throw lastError ?? new Error("connect guard dial timed out");
  }

  private dialDirect(
    address: string,
    port: number,
    client: ClientConnection,
    timeoutMs: number,
  ): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const normalized = normalizeNetworkHost(address);
      if (!normalized || isIP(normalized) === 0) {
        reject(new Error("invalid pinned network address"));
        return;
      }
      const upstream = netConnect({ host: normalized, port });
      this.trackSocket(upstream);
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error("connect guard dial timed out")),
        Math.max(1, timeoutMs),
      );
      const cleanup = (): void => {
        clearTimeout(timer);
        client.removeListener("close", onClientClose);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.sockets.delete(upstream);
        upstream.destroy();
        reject(error);
      };
      const onClientClose = (): void => fail(new Error("client disconnected"));
      client.once("close", onClientClose);
      if (client.destroyed) {
        fail(new Error("client disconnected"));
        return;
      }
      upstream.once("connect", () => {
        if (settled) return;
        if (client.destroyed) {
          fail(new Error("client disconnected"));
          return;
        }
        settled = true;
        cleanup();
        resolve(upstream);
      });
      upstream.once("error", fail);
      upstream.once("close", () => fail(new Error("connect guard upstream closed")));
    });
  }

  private proxyFor(host: string | undefined, tunnel: boolean): URL | undefined {
    if (!host || shouldBypassParentProxy(host, this.upstreamNoProxy)) return undefined;
    return tunnel ? (this.upstreamHttpsProxy ?? this.upstreamHttpProxy) : this.upstreamHttpProxy;
  }

  private proxyHost(proxy: URL): string {
    return normalizeNetworkHost(proxy.hostname) ?? "";
  }

  private proxyPort(proxy: URL): number {
    return Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
  }

  private proxyAuthorization(proxy: URL): string {
    const username = decodeURIComponent(proxy.username);
    const password = decodeURIComponent(proxy.password);
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  private dialViaProxy(
    proxy: URL,
    endpoint: SandboxNetworkEndpoint,
    address: string,
    client: ClientConnection,
    timeoutMs: number,
  ): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const proxyHost = this.proxyHost(proxy);
      const proxyPort = this.proxyPort(proxy);
      if (!proxyHost) {
        reject(new Error("invalid upstream proxy host"));
        return;
      }
      const upstream =
        proxy.protocol === "https:"
          ? tlsConnect({
              host: proxyHost,
              port: proxyPort,
              ...(isIP(proxyHost) ? {} : { servername: proxyHost }),
            })
          : netConnect({ host: proxyHost, port: proxyPort });
      this.trackSocket(upstream);
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error("upstream proxy connect timed out")),
        Math.max(1, timeoutMs),
      );
      let buffer = Buffer.alloc(0);
      const cleanup = (): void => {
        clearTimeout(timer);
        client.removeListener("close", onClientClose);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.sockets.delete(upstream);
        upstream.destroy();
        reject(error);
      };
      const onClientClose = (): void => fail(new Error("client disconnected"));
      client.once("close", onClientClose);
      if (client.destroyed) {
        fail(new Error("client disconnected"));
        return;
      }
      let connectSent = false;
      const onReady = (): void => {
        if (connectSent) return;
        connectSent = true;
        const auth =
          proxy.username || proxy.password
            ? `Proxy-Authorization: ${this.proxyAuthorization(proxy)}\r\n`
            : "";
        const authority = formatAuthority(address, endpoint.port);
        upstream.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
      };
      if (proxy.protocol === "https:") upstream.once("secureConnect", onReady);
      else upstream.once("connect", onReady);
      upstream.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > 16 * 1024) fail(new Error("upstream proxy response exceeded bound"));
          return;
        }
        const status = buffer.toString("latin1", 0, end).split("\r\n", 1)[0] ?? "";
        if (!/^HTTP\/1\.[01] 2\d\d(?:\s|$)/.test(status)) {
          fail(new Error(`Upstream proxy refused CONNECT: ${status}`));
          return;
        }
        clearTimeout(timer);
        upstream.pause();
        upstream.removeAllListeners("data");
        const rest = buffer.subarray(end + 4);
        if (rest.length > 0) upstream.unshift(rest);
        if (client.destroyed) {
          fail(new Error("client disconnected"));
          return;
        }
        settled = true;
        cleanup();
        resolve(upstream);
      });
      upstream.once("error", fail);
      upstream.once("close", () => fail(new Error("upstream proxy closed")));
    });
  }

  /** Connect to an HTTP(S) parent before sending a request body. */
  private connectProxyTransport(
    proxy: URL,
    client: ClientConnection,
    timeoutMs: number,
  ): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const proxyHost = this.proxyHost(proxy);
      const proxyPort = this.proxyPort(proxy);
      if (!proxyHost) {
        reject(new Error("invalid upstream proxy host"));
        return;
      }
      let upstream: Socket;
      try {
        upstream =
          proxy.protocol === "https:"
            ? tlsConnect({
                host: proxyHost,
                port: proxyPort,
                ...(isIP(proxyHost) ? {} : { servername: proxyHost }),
              })
            : netConnect({ host: proxyHost, port: proxyPort });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.trackSocket(upstream);
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error("upstream proxy connect timed out")),
        Math.max(1, timeoutMs),
      );
      const cleanup = (): void => {
        clearTimeout(timer);
        client.removeListener("close", onClientClose);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.sockets.delete(upstream);
        upstream.destroy();
        reject(error);
      };
      const onClientClose = (): void => fail(new Error("client disconnected"));
      client.once("close", onClientClose);
      if (client.destroyed) {
        fail(new Error("client disconnected"));
        return;
      }
      const onReady = (): void => {
        if (settled) return;
        if (client.destroyed) {
          fail(new Error("client disconnected"));
          return;
        }
        settled = true;
        cleanup();
        resolve(upstream);
      };
      if (proxy.protocol === "https:") upstream.once("secureConnect", onReady);
      else upstream.once("connect", onReady);
      upstream.once("error", fail);
      upstream.once("close", () => fail(new Error("upstream proxy closed")));
    });
  }
}
