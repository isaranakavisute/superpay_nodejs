import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// scrypt password hashes for merchant portal logins: "scrypt$<salt>$<hash>" (base64url).
const scrypt = promisify(scryptCb);

export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(plain), salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(plain, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  // Always do the work, so a missing hash costs the same time as a wrong one.
  const want = kind === 'scrypt' && hash ? Buffer.from(hash, 'base64url') : Buffer.alloc(32);
  const got = await scrypt(String(plain), salt ? Buffer.from(salt, 'base64url') : Buffer.alloc(16), want.length);
  return kind === 'scrypt' && timingSafeEqual(got, want);
}
