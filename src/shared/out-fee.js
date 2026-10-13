/**
 * Outgoing fee (ค่าธรรมเนียมเงินออก) of a shop-initiated withdrawal / payout: amount × out_fee_percent / 100
 * + out_fee_flat, charged on top — the shop's balance is debited amount + fee, the receiver gets the amount.
 */
export function outFeeFor(m, amount) {
  if (!m) return 0;
  return Math.round(((Number(amount) * Number(m.out_fee_percent ?? 0)) / 100 + Number(m.out_fee_flat ?? 0)) * 100) / 100;
}
