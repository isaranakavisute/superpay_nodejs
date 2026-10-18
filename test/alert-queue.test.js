// Every Telegram post (shared/telegram-send.js): spaced per chat, and a 429 "retry after N" is waited out and retried.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_GAP_MS, tgSend } from '../src/shared/telegram-send.js';

describe('tgSend pacing and 429 handling', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });   // the suite shares one process: put the real fetch back
  it('two posts to the same chat are at least CHAT_GAP_MS apart; typing indicators are not queued', async () => {
    const at = [];
    globalThis.fetch = async (_url, o) => { at.push({ t: Date.now(), body: JSON.parse(o.body) }); return { json: async () => ({ ok: true }) }; };
    await Promise.all([tgSend('T1', 'sendMessage', { chat_id: 1, text: 'a' }), tgSend('T1', 'sendMessage', { chat_id: 1, text: 'b' }), tgSend('T1', 'sendChatAction', { chat_id: 1, action: 'typing' })]);
    const posts = at.filter((x) => x.body.text);
    assert.equal(posts.length, 2);
    assert.ok(posts[1].t - posts[0].t >= CHAT_GAP_MS - 50, `gap ${posts[1].t - posts[0].t} ms`);
    assert.ok(at.find((x) => x.body.action).t - posts[0].t < 1000, 'typing indicator sent immediately');
  });
  it('a 429 "retry after 1" is waited out, then the post succeeds', async () => {
    let n = 0; const at = [];
    globalThis.fetch = async () => { n += 1; at.push(Date.now()); return { json: async () => (n === 1 ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } : { ok: true }) }; };
    const r = await tgSend('T2', 'sendMessage', { chat_id: 2, text: 'x' });
    assert.equal(r.ok, true);
    assert.equal(n, 2);
    assert.ok(at[1] - at[0] >= 1900, `waited ${at[1] - at[0]} ms`);
  });
  it('a refusal that retrying cannot fix (bot removed) is returned at once', async () => {
    let n = 0;
    globalThis.fetch = async () => { n += 1; return { json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' }) }; };
    const r = await tgSend('T3', 'sendMessage', { chat_id: 3, text: 'x' });
    assert.equal(r.ok, false);
    assert.equal(n, 1);
  });
});
