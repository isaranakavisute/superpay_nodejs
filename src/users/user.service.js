import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../errors.js';
import * as repo from './user.repository.js';

export async function getUser(id) {
  const user = await repo.findUserById(id);
  if (!user) throw new NotFoundError(`User ${id} does not exist`);
  return user;
}

export const listUsers = (filters) => repo.listUsers(filters);

/**
 * users.email has no unique index in the target database and the schema is not
 * ours to change, so uniqueness is enforced here. The check and the insert run
 * in one transaction to narrow the race window, but without a DB constraint two
 * concurrent writers can still both succeed — add a unique index to close it.
 */
export async function createUser(input) {
  return withTransaction(async (client) => {
    const existing = await repo.findUserByEmail(input.email, client);
    if (existing) {
      throw new ConflictError(`Email ${input.email} is already registered`);
    }
    return repo.insertUser(input, client);
  });
}

export async function updateUser(id, patch) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'SELECT 1 FROM users WHERE id = $1',
      [id],
    );
    if (rowCount === 0) throw new NotFoundError(`User ${id} does not exist`);

    if (patch.email) {
      const owner = await repo.findUserByEmail(patch.email, client);
      if (owner && owner.id !== id) {
        throw new ConflictError(`Email ${patch.email} is already registered`);
      }
    }
    return repo.updateUser(id, patch, client);
  });
}
