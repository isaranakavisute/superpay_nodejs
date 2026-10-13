import { AppError } from '../errors.js';

const bad = (code) => (msg) => new AppError(msg, { status: 400, code });

/**
 * Sub-merchant tree helpers. A shop's chain = its ancestors (root first) + itself.
 * Fees cascade as a markup: each shop's rate is at least its parent's; the platform gets the root's
 * rate, each ancestor gets (its child-on-the-chain's rate − its own rate); the shop pays its own rate.
 */
export const MAX_DEPTH = 10;   // levels below a top-level shop
const round2 = (n) => Math.round(n * 100) / 100;

export async function chainOf(c, merchantId) {
  const { rows } = await c.query(
    `SELECT m.* FROM merchants m, (SELECT path || id AS chain FROM merchants WHERE id = $1) x
      WHERE m.id = ANY (x.chain) ORDER BY array_position(x.chain, m.id)`,
    [merchantId],
  );
  return rows;
}

const RATE = { in: ['fee_percent', 'fee_flat'], out: ['out_fee_percent', 'out_fee_flat'] };
export const feeAt = (m, amount, dir = 'in') => round2((Number(amount) * Number(m[RATE[dir][0]])) / 100 + Number(m[RATE[dir][1]]));

/** Shares of a fee along the chain: [{ merchantId | null (platform), amount }] summing to the shop's own fee. */
export function splitFee(chain, amount, dir = 'in') {
  if (!chain.length) return [];
  const out = [{ merchantId: null, amount: feeAt(chain[0], amount, dir) }];
  for (let i = 0; i < chain.length - 1; i++) out.push({ merchantId: chain[i].id, amount: round2(feeAt(chain[i + 1], amount, dir) - feeAt(chain[i], amount, dir)) });
  return out.filter((s) => s.amount !== 0);
}

/** (Re)write the fee shares of one payment / outflow / withdrawal request. */
export async function writeSplits(c, kind, sourceId, merchantId, amount, dir) {
  await c.query('DELETE FROM fee_splits WHERE source_kind = $1 AND source_id = $2', [kind, sourceId]);
  if (merchantId == null) return;
  const chain = await chainOf(c, merchantId);
  for (const s of splitFee(chain, amount, dir)) {
    await c.query('INSERT INTO fee_splits (source_kind, source_id, from_merchant_id, merchant_id, amount) VALUES ($1, $2, $3, $4, $5)', [kind, sourceId, merchantId, s.merchantId, s.amount]);
  }
}

/** A payment's shares from its current merchant and amount. */
export async function syncPaymentSplits(c, paymentId) {
  const { rows } = await c.query('SELECT merchant_id, amount FROM payments WHERE id = $1', [paymentId]);
  if (rows[0]) await writeSplits(c, 'payment', paymentId, rows[0].merchant_id, rows[0].amount, 'in');
}

/** A withdrawal request's shares move to the payout row created for it. */
export const moveWithdrawalSplits = (c, withdrawalId, outflowId) =>
  c.query(`UPDATE fee_splits SET source_kind = 'outflow', source_id = $2 WHERE source_kind = 'withdrawal' AND source_id = $1`, [withdrawalId, outflowId]);

/** 'active' only when the shop and every ancestor are active; else the first non-active status found. */
export async function effectiveStatus(c, merchantId) {
  const chain = await chainOf(c, merchantId);
  if (!chain.length) return null;
  return chain.find((m) => m.status === 'suspended')?.status ?? chain.find((m) => m.status === 'pending')?.status ?? 'active';
}

/** Is `id` the shop `rootId` itself or somewhere below it? */
export async function inSubtree(c, rootId, id) {
  if (Number(rootId) === Number(id)) return true;
  const { rows } = await c.query('SELECT 1 FROM merchants WHERE id = $1 AND $2 = ANY (path)', [id, rootId]);
  return rows.length > 0;
}

/** A child's rates must not be below its parent's (else the parent pays for every child sale). */
export function checkRatesAgainstParent(parent, r, err = bad('RATE_BELOW_PARENT')) {
  if (!parent) return;
  const low = [
    r.feePercent < Number(parent.fee_percent) && `ค่าธรรมเนียมเงินเข้า (%) ต่ำสุด ${Number(parent.fee_percent)}%`,
    r.feeFlat < Number(parent.fee_flat) && `ค่าธรรมเนียมเงินเข้าคงที่ ต่ำสุด ${Number(parent.fee_flat)} บาท`,
    r.outFeePercent < Number(parent.out_fee_percent) && `ค่าธรรมเนียมเงินออก (%) ต่ำสุด ${Number(parent.out_fee_percent)}%`,
    r.outFeeFlat < Number(parent.out_fee_flat) && `ค่าธรรมเนียมเงินออกคงที่ ต่ำสุด ${Number(parent.out_fee_flat)} บาท`,
  ].filter(Boolean);
  if (low.length) throw err(`อัตราค่าธรรมเนียมต้องไม่ต่ำกว่าของร้านแม่ — ${low.join(' · ')}`);
}

/** A shop's new rates must not be above any direct child's (else that parent loses money on the child). */
export async function checkRatesAgainstChildren(c, id, r, err = bad('RATE_ABOVE_CHILD')) {
  const { rows } = await c.query('SELECT name, fee_percent, fee_flat, out_fee_percent, out_fee_flat FROM merchants WHERE parent_id = $1', [id]);
  const over = rows.filter((k) => r.feePercent > Number(k.fee_percent) || r.feeFlat > Number(k.fee_flat) || r.outFeePercent > Number(k.out_fee_percent) || r.outFeeFlat > Number(k.out_fee_flat));
  if (over.length) throw err(`อัตราใหม่สูงกว่าร้านย่อย ${over.map((k) => k.name).join(', ')} — ปรับอัตราของร้านย่อยให้สูงขึ้นก่อน`);
}
