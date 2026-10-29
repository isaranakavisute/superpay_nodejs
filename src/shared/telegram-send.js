/**
 * EVERY message Option Pay posts to Telegram goes through tgSend (rule, 18 Oct 2026):
 *   - per bot and chat, messages are queued at least CHAT_GAP_MS apart (Telegram allows a bot ~20 messages a minute
 *     in one group — 18 of 38 midnight alerts were dropped on 18 Oct when they all went out at once);
 *   - a 429 "Too Many Requests: retry after N" is waited out (N + 1 s, at most MAX_RETRY_AFTER_S) and retried;
 *   - network errors are retried with a short back-off; any other refusal (bot removed, bad chat id) is returned as is.
 * Not posts, so not queued: sendChatAction ("typing…") and reads such as getFile.
 */
export const CHAT_GAP_MS = 3100;
const MAX_RETRY_AFTER_S = 120;
const ATTEMPTS = 4;
const queues = new Map();   // `${bot}:${chat}` → promise of the last message queued there

function queued(key, job) {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(async () => { try { return await job(); } finally { await new Promise((r) => setTimeout(r, CHAT_GAP_MS)); } });
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

// A FormData body (file uploads: sendPhoto / sendVideo / sendMediaGroup with attach://) goes as multipart; else JSON.
const isForm = (body) => typeof FormData !== 'undefined' && body instanceof FormData;
const call = (token, method, body, timeoutMs) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', ...(isForm(body) ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
}).then((r) => r.json());

/**
 * Telegram Bot API call; posts (send*, except sendChatAction — and pinChatMessage) are paced per chat and retried on 429.
 * Returns Telegram's JSON. `body` may be a FormData (uploads) carrying chat_id.
 */
export function tgSend(token, method, body, { timeoutMs = 15_000 } = {}) {
  const chatId = isForm(body) ? body.get('chat_id') : body?.chat_id;
  const isPost = (/^send/.test(method) && method !== 'sendChatAction') || method === 'pinChatMessage' || method === 'unpinChatMessage';
  if (!isPost || chatId == null) return call(token, method, body, timeoutMs);
  return queued(`${String(token).slice(-10)}:${chatId}`, async () => {
    let last = { ok: false, description: 'ส่งไม่ได้' };
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        last = await call(token, method, body, timeoutMs);
        if (last.ok) return last;
        if (last.error_code === 429) {
          const after = Number(last.parameters?.retry_after ?? String(last.description ?? '').match(/retry after (\d+)/)?.[1] ?? 30);
          await new Promise((r) => setTimeout(r, (Math.min(after, MAX_RETRY_AFTER_S) + 1) * 1000));
          continue;
        }
        return last;   // bot removed / bad chat / bad request: retrying won't help
      } catch (err) {
        last = { ok: false, description: err?.cause?.code ?? err?.message ?? 'ส่งไม่ได้' };
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    return last;
  });
}
