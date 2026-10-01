import * as repo from './dashboard.repository.js';
import { minBalanceFor } from '../config-admin/config.service.js';

export async function getSummary({ from = null, to = null, recent }) {
  const [paymentTotals, outflowTotals, pending, receivingAccounts, users, recentPayments, recentOutflows, merchants] =
    await Promise.all([
      repo.paymentStatusTotals(from, to),
      repo.outflowStatusTotals(from, to),
      repo.pendingCounts(),
      repo.receivingAccountCount(),
      repo.userCount(),
      repo.recentPayments(from, to, recent),
      repo.recentOutflows(from, to, recent),
      repo.merchantStats(from, to),
    ]);

  return {
    window: { from, to },
    payments: {
      byStatus: paymentTotals,
      totalCount: paymentTotals.reduce((n, r) => n + r.count, 0),
      pendingLiveCount: pending.payments,
      recent: recentPayments,
    },
    outflows: {
      byStatus: outflowTotals,
      pendingLiveCount: pending.outflows,
      recent: recentOutflows,
    },
    receivingAccounts,
    users,
    merchants,
    // Shops whose live balance is under their minimum (dashboard banner).
    lowBalanceMerchants: (await withEffectiveMin(merchants))
      .filter((m) => Number(m.currentBalance) < Number(m.minBalance))
      .map((m) => ({ id: m.id, name: m.name, slug: m.slug, currentBalance: m.currentBalance, minBalance: m.minBalance })),
  };
}

export const getTrend = ({ days, merchantId }) => repo.dailyTrend(days, merchantId ?? null);

/** A shop's own min_balance wins; otherwise the settings default applies. */
async function withEffectiveMin(merchants) {
  const fallback = await minBalanceFor(0);
  return merchants.map((m) => (Number(m.minBalance) > 0 || !fallback ? m : { ...m, minBalance: String(fallback) }));
}

/** Badges + low-balance banner, shown on every console page. Cheap: no window. */
export async function getAlerts() {
  const [queues, merchants] = await Promise.all([repo.queueCounts(), repo.merchantStats(null, null)]);
  const lowBalanceMerchants = (await withEffectiveMin(merchants))
    .filter((m) => m.status === 'active' && Number(m.currentBalance) < Number(m.minBalance))
    .map((m) => ({ id: m.id, name: m.name, slug: m.slug, currentBalance: m.currentBalance, minBalance: m.minBalance }));
  return { queues, lowBalanceMerchants };
}
