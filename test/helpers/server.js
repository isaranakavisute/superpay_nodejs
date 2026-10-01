import { createApp } from '../../src/app.js';

/**
 * Boots the app on an ephemeral port and returns a fetch helper bound to it.
 * Call `close()` when the suite finishes.
 */
export async function startTestServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text };
  }

  return {
    base,
    request,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
