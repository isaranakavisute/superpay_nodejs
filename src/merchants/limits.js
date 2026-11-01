import { internal as configOf } from '../config-admin/config.service.js';

/**
 * Per-shop minimum deposit / withdrawal (user, 1 Nov 2026), Option B: the shop's own value; when NULL, the nearest
 * parent shop (up the tree) that has one; when none, the admin setting (Settings → ยอดขั้นต่ำ). 0 = no minimum.
 * `src` says where each value came from: 'own' | 'parent' | 'global' (+ `from` = that parent's name).
 */
export async function limitsFor(db, merchantId) {
  const [{ rows: [r] }, g] = await Promise.all([
    db.query(
      `SELECT m.min_deposit, m.min_withdraw,
              (SELECT row(a.min_deposit, a.name) FROM merchants a JOIN unnest(m.path) WITH ORDINALITY x(id, i) ON a.id = x.id
                WHERE a.min_deposit IS NOT NULL ORDER BY x.i DESC LIMIT 1) AS up_dep,
              (SELECT row(a.min_withdraw, a.name) FROM merchants a JOIN unnest(m.path) WITH ORDINALITY x(id, i) ON a.id = x.id
                WHERE a.min_withdraw IS NOT NULL ORDER BY x.i DESC LIMIT 1) AS up_wd
         FROM merchants m WHERE m.id = $1`, [merchantId]),
    configOf('limits'),
  ]);
  const up = (v) => { const m = /^\(([^,]*),(.*)\)$/.exec(v ?? ''); return m ? { value: Number(m[1]), name: m[2].replace(/^"|"$/g, '') } : null; };
  const pick = (own, parent, global) => (own != null ? { value: Number(own), src: 'own' }
    : parent ? { value: parent.value, src: 'parent', from: parent.name } : { value: Number(global) || 0, src: 'global' });
  const dep = pick(r?.min_deposit, up(r?.up_dep), g.minDeposit);
  const wd = pick(r?.min_withdraw, up(r?.up_wd), g.minWithdraw);
  return { minDeposit: dep.value, minWithdraw: wd.value, source: { deposit: dep, withdraw: wd } };
}
