import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outbound HTTP for webhooks, guarded against SSRF: https only, and every
 * address the host resolves to must be public (no loopback / private /
 * link-local / CGNAT / multicast / unspecified).
 */
function isPrivate(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

export class BlockedUrlError extends Error {}

async function guard(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new BlockedUrlError('Only https:// webhook URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivate(a.address))) {
    throw new BlockedUrlError(`Refusing to send to ${host}: it resolves to a private or local address`);
  }
  return u;
}

export async function safePost(url, { body, headers, timeoutMs = 10_000 }) {
  const u = await guard(url);
  const started = Date.now();
  const res = await fetch(u, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const text = (await res.text()).slice(0, 2000);
  return { status: res.status, body: text, ms: Date.now() - started };
}

export async function safeGet(url, { headers, timeoutMs = 10_000 } = {}) {
  const u = await guard(url);
  const started = Date.now();
  const res = await fetch(u, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const text = (await res.text()).slice(0, 4000);
  return { status: res.status, body: text, ms: Date.now() - started };
}

/** Any method / body (e.g. multipart slip uploads to verification providers). */
export async function safeRequest(url, { method = 'POST', headers, body, timeoutMs = 20_000 } = {}) {
  const u = await guard(url);
  const started = Date.now();
  const res = await fetch(u, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const text = (await res.text()).slice(0, 20_000);
  return { status: res.status, body: text, ms: Date.now() - started };
}
