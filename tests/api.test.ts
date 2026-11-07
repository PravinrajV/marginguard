import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { SQLiteStore } from '../src/server/store';
let store: SQLiteStore;
let app: ReturnType<typeof createApp>;
let cookie: string;
let csrf: string;
const url = 'http://localhost:8787';
beforeEach(async () => {
  store = new SQLiteStore(':memory:');
  app = createApp(store);
  const r = await app.request(url + '/api/session');
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  csrf = (await r.json()).csrf;
});
afterEach(() => store.close());
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(url + path, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: url,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
it('requires a session for every protected resource', async () =>
  expect((await app.request(url + '/api/orders')).status).toBe(401));
it('refuses non-local host access', async () =>
  expect((await app.request('http://evil.example/api/session')).status).toBe(403));
it('refuses cross-origin mutations', async () =>
  expect((await post('/api/reset', {}, { Origin: 'https://evil.example' })).status).toBe(403));
it('refuses missing or wrong CSRF token', async () =>
  expect((await post('/api/reset', {}, { 'X-CSRF-Token': 'wrong' })).status).toBe(403));
it('rejects non-JSON mutation', async () =>
  expect((await post('/api/reset', {}, { 'Content-Type': 'text/plain' })).status).toBe(415));
it('rejects oversized bodies', async () =>
  expect((await post('/api/approvals', { padding: 'x'.repeat(9000) })).status).toBe(413));
it('validates schemas, rejecting autonomous or unknown fields', async () =>
  expect((await post('/api/approvals', { autoRefund: true })).status).toBe(400));
it('runs a clearly labeled local approval and simulation end-to-end', async () => {
  const packets = (
    await (await app.request(url + '/api/orders', { headers: { Cookie: cookie } })).json()
  ).packets;
  const payload = { orderId: 'MG-1001', amount: '15.00', evidence: packets[0].evidence };
  const approved = await post('/api/approvals', {
    payload,
    confirmation: 'APPROVE $15.00 LOCAL SIMULATION',
  });
  expect(approved.status).toBe(201);
  const { approvalId } = await approved.json();
  const result = await post('/api/simulations', { payload, approvalId });
  expect(result.status).toBe(200);
  expect((await result.json()).status).toBe('SIMULATED');
});
it('sets HttpOnly SameSite cookie and restrictive API headers', async () => {
  const r = await app.request(url + '/api/session');
  const cookie = r.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  expect(cookie).not.toContain('Secure');
  expect(cookie).not.toContain('__Host-');
  expect(r.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect((await r.json()).mode).toBe('LOCAL_FIXTURES');
});
