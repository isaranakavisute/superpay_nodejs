// Slip images as files (31 Oct 2026): payment / payout slips were stored only inside the database, which made it 33 GB,
// the nightly backup slow and the change log copy every image. Now each image is also written once to SLIP_STORE_DIR
// (a Docker volume) and the row keeps its path in `file_path`. Readers take the file and fall back to the database copy.
// File only (2 Nov 2026, after migration 076 + the clean-up of the old copies): a new slip whose file was written AND read
// back identical keeps no database copy (`data` NULL); only when the file could not be stored does the image go in the
// database, exactly as before — no slip is ever lost.
//
// Files are named by the SHA-256 of their bytes: the same image is written once, a re-check never adds a copy, and a
// damaged or wrong file is caught on every read (its bytes must hash to its own name).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/pool.js';
import logger from '../logger.js';

export const SLIP_DIR = process.env.SLIP_STORE_DIR || '/data/slips';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Only paths this module made are ever read — never a path built from user input.
const SAFE = /^(payment|outflow)\/\d{4}\/\d{2}\/([0-9a-f]{64})\.(jpg|png|webp)$/;
const TABLES = { payment_slips: 'payment_id', outflow_slips: 'outflow_id' };

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Write one slip image; returns its path (relative to SLIP_DIR) or null when it could not be written — the caller then
 * keeps the image in the database only, exactly as before. `at` = which month folder (backfill: the upload time).
 */
export async function saveSlipFile(kind, bytes, mime, hash = sha256(bytes), at = new Date()) {
  try {
    if (!['payment', 'outflow'].includes(kind) || !EXT[mime] || !bytes?.length) return null;
    const rel = `${kind}/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${hash}.${EXT[mime]}`;
    const abs = path.join(SLIP_DIR, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (st?.size === bytes.length) return rel;   // already there (same name = same bytes)
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, bytes, { flag: 'wx' });
    await fs.rename(tmp, abs);   // atomic: a reader never sees half a file
    return rel;
  } catch (err) {
    logger.warn({ err, kind }, 'slip file not written — kept in the database only');
    return null;
  }
}

/** The bytes of a stored slip file, or null (no path, missing, unreadable, or its bytes do not match its name). */
export async function readSlipFile(rel) {
  const m = typeof rel === 'string' ? SAFE.exec(rel) : null;
  if (!m) return null;
  try {
    const bytes = await fs.readFile(path.join(SLIP_DIR, rel));
    if (sha256(bytes) !== m[2]) {
      logger.error({ file: rel }, 'slip file does not match its checksum — using the database copy');
      return null;
    }
    return bytes;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn({ err, file: rel }, 'slip file unreadable — using the database copy');
    else logger.warn({ file: rel }, 'slip file missing — using the database copy');
    return null;
  }
}

/** What to keep in the database for a slip just saved to `rel`: nothing (null) when the file reads back identical, else the bytes. */
export async function dbCopyOf(bytes, rel) {
  const back = rel ? await readSlipFile(rel) : null;
  return back && back.equals(bytes) ? null : bytes;
}

/** A slip's image: the file when it is there and intact, else the database copy (null when neither exists). */
export async function slipImage(table, id, filePath) {
  const fromFile = filePath ? await readSlipFile(filePath) : null;
  if (fromFile) return fromFile;
  const key = TABLES[table];
  if (!key) throw new Error(`not a slip table: ${table}`);
  const { rows } = await query(`SELECT data FROM ${table} WHERE ${key} = $1`, [id]);
  return rows[0]?.data ?? null;
}
