import { query } from '../db/pool.js';

// user_password is pre-existing (id, myuser, mypassword) and is only ever
// read here. Its passwords are plaintext varchar; see README "Known gaps".
// myuser has no unique index and "admin" appears twice (ids 7 and 9), so
// every row for the username is returned and the service checks each one.
export async function findCredentials(username) {
  const { rows } = await query(
    `SELECT id, myuser AS username, mypassword AS password
       FROM user_password
      WHERE lower(trim(myuser)) = $1
      ORDER BY id`,
    [username],
  );
  return rows;
}

/** Display name and role from console_user_profiles (null if the account has none). */
export async function findProfile(userPasswordId) {
  const { rows } = await query(
    `SELECT p.full_name AS "fullName", p.status, r.code AS "roleCode", r.name AS "roleName"
       FROM console_user_profiles p
       JOIN console_roles r ON r.code = p.role_code
      WHERE p.user_password_id = $1`,
    [userPasswordId],
  );
  return rows[0] ?? null;
}

/** Login bookkeeping: console's own tables only. */
export async function recordLogin(userPasswordId, username, ip) {
  await query('INSERT INTO console_logins (user_password_id, ip) VALUES ($1, $2)', [userPasswordId, ip]);
  await query(
    `INSERT INTO audit_logs (actor, action, entity, detail, ip) VALUES ($1, 'auth.login', 'session', 'เข้าสู่ระบบสำเร็จ', $2)`,
    [username, ip],
  );
}
