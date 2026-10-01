import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import config from '../config.js';

/**
 * Encrypts small secrets at rest (webhook signing secrets) with AES-256-GCM.
 * The key is derived from CONSOLE_API_KEY, so a database dump alone cannot
 * recover them. Format: base64url(iv) . base64url(tag) . base64url(ciphertext)
 */
function key() {
  if (!config.consoleApiKey) throw new Error('CONSOLE_API_KEY is required to encrypt/decrypt secrets');
  return createHash('sha256').update(`${config.consoleApiKey}:webhook-secrets:v1`).digest();
}

export function seal(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function open(sealed) {
  const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
