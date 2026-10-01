import { BadRequestError, NotFoundError } from '../errors.js';
import { merchantStats } from '../dashboard/dashboard.repository.js';
import { RESOURCES } from './console.registry.js';
import * as repo from './console.repository.js';

export const resourceNames = () => [...Object.keys(RESOURCES), 'merchants'];

export async function listResource(name, { q, from, to, limit, offset, ...rest }) {
  // Merchants carry windowed money totals, computed by the dashboard query.
  if (name === 'merchants') return listMerchants({ q, from, to, ...rest });

  const res = Object.hasOwn(RESOURCES, name) ? RESOURCES[name] : null;
  if (!res) throw new NotFoundError(`Unknown resource "${name}"`);

  const allowed = res.filters ?? {};
  const unknown = Object.keys(rest).filter((k) => !Object.hasOwn(allowed, k));
  if (unknown.length) {
    throw new BadRequestError(`Unsupported filter(s) for ${name}: ${unknown.join(', ')}`, {
      allowed: Object.keys(allowed),
    });
  }

  const args = { q, from, to, limit, offset, filters: rest };
  const [{ items, total }, summary] = await Promise.all([repo.list(res, args), repo.summary(res, args)]);
  return { data: items, pagination: { total, limit, offset }, summary };
}

async function listMerchants({ q, from, to, status, ...rest }) {
  if (Object.keys(rest).length) throw new BadRequestError(`Unsupported filter(s) for merchants: ${Object.keys(rest).join(', ')}`);
  const all = await merchantStats(from ?? null, to ?? null);
  const needle = q?.toLowerCase();
  const matches = all.filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.slug.includes(needle));
  const data = status ? matches.filter((m) => m.status === status) : matches;
  const summary = Object.entries(Object.groupBy(matches, (m) => m.status)).map(([key, xs]) => ({ key, count: xs.length }));
  return { data, pagination: { total: data.length, limit: data.length, offset: 0 }, summary };
}
