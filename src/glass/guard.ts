import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { resolve } from "node:path";

/**
 * Request guards for the Glass server. The server listens on loopback, but a
 * browser on the same machine can still be steered into talking to it (a hostile
 * web page posting a form, or DNS rebinding), so every request is checked for
 * Host, Origin and, on POST, a per-process CSRF token.
 */

export interface GuardFailure {
  status: 400 | 403;
  reason: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function hostWithPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Host header values the server answers to: 127.0.0.1 and localhost, plus ::1 when bound there. */
export function allowedHostHeaders(localPort: number, boundHost: string): Set<string> {
  const allowed = new Set([hostWithPort("127.0.0.1", localPort), hostWithPort("localhost", localPort)]);
  if (boundHost === "::1") allowed.add(hostWithPort("::1", localPort));
  return allowed;
}

export function checkHostAndOrigin(headers: IncomingHttpHeaders, localPort: number, boundHost: string): GuardFailure | null {
  const host = headers.host?.toLowerCase();
  if (!host || !allowedHostHeaders(localPort, boundHost).has(host)) {
    return { status: 403, reason: "Host header is not this Glass server." };
  }
  const origin = headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) {
    return { status: 403, reason: "Cross-origin requests are refused." };
  }
  return null;
}

export function csrfTokenValid(expected: string, provided: string | null | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ConfiguredSource {
  root: string;
  register?: string | undefined;
  memory?: boolean | undefined;
  proposalsDir?: string | undefined;
}

/**
 * The server only operates on the source it was launched with. Clients may not
 * choose a root, register, memory mode or proposals directory. A request that
 * names one is tolerated only when it names the configured value, so old links
 * keep working but nothing can redirect the server.
 */
export function checkSourceParams(params: URLSearchParams, configured: ConfiguredSource): GuardFailure | null {
  const root = params.get("root");
  if (root !== null && resolve(root) !== resolve(configured.root)) {
    return { status: 400, reason: "root is fixed when Glass starts and cannot be changed by a request." };
  }
  const proposals = params.get("proposals");
  if (proposals !== null && (!configured.proposalsDir || resolve(proposals) !== resolve(configured.proposalsDir))) {
    return { status: 400, reason: "proposals is fixed when Glass starts and cannot be changed by a request." };
  }
  const register = params.get("register");
  if (register !== null && register !== (configured.register ?? "")) {
    return { status: 400, reason: "register is fixed when Glass starts and cannot be changed by a request." };
  }
  const memory = params.get("memory");
  if (memory !== null && memory !== String(configured.memory ?? false)) {
    return { status: 400, reason: "memory is fixed when Glass starts and cannot be changed by a request." };
  }
  return null;
}
