import { AppError } from '../errors.js';

/**
 * Receiving accounts shared by several shops (bank_account_merchants). A payment always belongs to one order
 * and one shop: the slip is attached to that order, so sharing an account never changes the amount the shop asked
 * for — satang are added only when "ยอดไม่ซ้ำ" is switched on in settings (customers pay round amounts; forced
 * satang on a shared account made their slips fail). With it on, a shared account also keeps an amount away from
 * new orders for `cooldown` minutes after an order with that amount was created.
 */
export const DEFAULT_COOLDOWN_MIN = 60;

export async function linkCount(c, accountId) {
  const { rows } = await c.query('SELECT count(*)::int AS n FROM bank_account_merchants WHERE bank_account_id = $1', [accountId]);
  return rows[0].n;
}

/** The amount (base + 0–maxSatang satang) no pending order — nor any order of the last `cooldownMin` minutes — on the account has. */
export async function uniqueAmount(c, accountId, amount, maxSatang, cooldownMin = 0) {
  await c.query('SELECT 1 FROM bank_accounts WHERE id = $1 FOR UPDATE', [accountId]);
  const { rows } = await c.query(
    `SELECT amount FROM payments
      WHERE bank_account_id = $1 AND amount >= $2 AND amount <= $3
        AND (status = 'pending' OR ($4::int > 0 AND created_at > now() - make_interval(mins => $4::int)))`,
    [accountId, amount, Math.round((amount + maxSatang / 100) * 100) / 100, cooldownMin],
  );
  const taken = new Set(rows.map((r) => Math.round(Number(r.amount) * 100)));
  for (let s = 0; s <= maxSatang; s++) {
    const cents = Math.round(amount * 100) + s;
    if (!taken.has(cents)) return cents / 100;
  }
  throw new AppError('มีออเดอร์ยอดนี้รอชำระเต็มทุกช่องสตางค์แล้ว — ลองใหม่อีกครั้ง', { status: 400, code: 'DUPLICATE_PENDING_AMOUNT' });
}

/** Unique-amount settings for an account: forced on (with cool-down) when it is shared. */
export async function amountRule(c, accountId, slip) {
  const shared = (await linkCount(c, accountId)) > 1;
  return {
    shared,
    // Only the setting adds satang — never the account being shared.
    unique: !!slip.uniqueAmount,
    maxSatang: Number(slip.uniqueAmountMaxSatang ?? 99),
    cooldown: slip.uniqueAmount && shared ? Number(slip.uniqueAmountCooldownMinutes ?? DEFAULT_COOLDOWN_MIN) : 0,
  };
}

/** Shops that still have orders waiting for payment on the account can't be unlinked from it. */
export async function refuseUnlinkWithPending(c, accountId, merchantIds) {
  if (!merchantIds.length) return;
  const { rows } = await c.query(
    `SELECT m.name, count(*)::int AS n FROM payments p JOIN merchants m ON m.id = p.merchant_id
      WHERE p.bank_account_id = $1 AND p.merchant_id = ANY ($2) AND p.status = 'pending' AND (p.expires_at IS NULL OR p.expires_at > now())
      GROUP BY m.name`,
    [accountId, merchantIds],
  );
  if (rows.length) {
    throw new AppError(`ยังมีออเดอร์รอชำระบนบัญชีนี้: ${rows.map((r) => `${r.name} ${r.n} รายการ`).join(', ')} — รอให้ชำระหรือหมดอายุก่อน แล้วค่อยเลิกผูก`,
      { status: 409, code: 'ACCOUNT_HAS_PENDING_ORDERS' });
  }
}

/** bank_accounts.merchant_id mirrors the first linked shop (kept for rollback; nothing reads it for routing). */
export const syncPrimaryShop = (c, accountId) => c.query(
  `UPDATE bank_accounts SET merchant_id = (SELECT min(merchant_id) FROM bank_account_merchants WHERE bank_account_id = $1) WHERE id = $1`, [accountId]);
