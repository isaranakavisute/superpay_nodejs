import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../errors.js';
import { withTransaction } from '../db/pool.js';
import { checkLoginCode } from '../profile/profile.service.js';
import * as repo from './auth.repository.js';

// Hash both sides first so the comparison is constant-time regardless of length.
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();

/** Returns the public user on success; never returns or logs the password. */
export async function login({ username, password, code }, { ip } = {}) {
  const candidates = await repo.findCredentials(username);
  const given = digest(password);
  // Compare against a dummy when the user is missing, so timing does not reveal which usernames exist.
  const match = (candidates.length ? candidates : [{ password: '\0' }]).find(
    (c) => c.id !== undefined && timingSafeEqual(digest(c.password), given),
  );
  if (!match) throw new UnauthorizedError('Invalid username or password');

  const profile = await repo.findProfile(match.id);
  if (profile && profile.status !== 'active') throw new UnauthorizedError(profile.status === 'locked' ? 'This account is locked' : 'This account is disabled');
  // Second factor only after the password matched, so it reveals nothing about unknown users.
  await withTransaction((client) => checkLoginCode(client, match.id, code));
  await repo.recordLogin(match.id, match.username, ip ?? null);
  return {
    id: match.id,
    username: match.username,
    fullName: profile?.fullName ?? match.username,
    roleCode: profile?.roleCode ?? null,
    roleName: profile?.roleName ?? null,
  };
}
