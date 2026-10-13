/** Commission a shop (`m`) has earned from its sub-merchants: its shares of approved payments and payouts. */
export const COMMISSION_SQL = `coalesce((SELECT sum(s.amount) FROM fee_splits s JOIN payments p ON s.source_kind = 'payment' AND p.id = s.source_id
                        WHERE s.merchant_id = m.id AND p.status = 'approved'), 0)
            + coalesce((SELECT sum(s.amount) FROM fee_splits s JOIN outflows o ON s.source_kind = 'outflow' AND o.id = s.source_id
                        WHERE s.merchant_id = m.id AND o.status = 'approved'), 0)`;

/**
 * A shop's live balance as SQL over `merchants m`: opening balance + approved payments (amount − fee)
 * − approved outflows (amount + outgoing fee) + credit adjustments + commission earned from its
 * sub-merchants (fee_splits of approved payments / payouts). One definition for every screen and check.
 */
export const BALANCE_SQL = `m.opening_balance
            + coalesce((SELECT sum(amount - fee) FROM payments WHERE merchant_id = m.id AND status = 'approved'), 0)
            - coalesce((SELECT sum(amount + fee) FROM outflows WHERE merchant_id = m.id AND status = 'approved'), 0)
            + coalesce((SELECT sum(amount) FROM merchant_credit_adjustments WHERE merchant_id = m.id), 0)
            + ${COMMISSION_SQL}`;
