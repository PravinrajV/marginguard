import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { PolicyError } from '../domain/policy';
import type { Store, Session } from './store';
import { DecisionService } from './service';
import { UnconfiguredAI, type AdvisoryAdapter } from '../adapters/advisory';
import { AdvisoryService } from './advisory';
import { UnconfiguredPayPalSandbox, type PayPalSandboxAdapter } from '../adapters/paypal';
const payload = z
  .object({
    orderId: z.string().regex(/^MG-\d{4}$/),
    amount: z.string().max(20),
    evidence: z.string().max(2000),
  })
  .strict();
const origins = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
]);
export function createApp(
  store: Store,
  adapter: AdvisoryAdapter = new UnconfiguredAI(),
  paypal: PayPalSandboxAdapter = new UnconfiguredPayPalSandbox(),
) {
  const app = new Hono<{ Variables: { session: Session } }>();
  const service = new DecisionService(store, Date.now, paypal);
  const advisory = new AdvisoryService(adapter, service);
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: 'Request is too large.' }, 413) }),
  );
  app.use('*', async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!['127.0.0.1', 'localhost'].includes(host))
      return c.json({ error: 'Local loopback access only.' }, 403);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    await next();
  });
  app.get('/api/session', (c) => {
    let session = store.session(getCookie(c, 'mg_session') ?? '');
    if (!session) {
      session = store.create();
      setCookie(c, 'mg_session', session.id, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        maxAge: 86400,
      });
    }
    return c.json({
      csrf: session.csrf,
      mode: 'LOCAL_FIXTURES',
      merchant: 'Kiln & Field / fictional merchant',
      paypal: paypal.configured ? 'CONFIGURED' : 'NOT_CONNECTED',
      ai: advisory.configured ? 'CONFIGURED' : 'NOT_CONNECTED',
    });
  });
  app.use('/api/*', async (c, next) => {
    const session = store.session(getCookie(c, 'mg_session') ?? '');
    if (!session)
      return c.json({ error: 'Session expired. Reload to start a local workspace.' }, 401);
    c.set('session', session);
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (
        !origins.has(c.req.header('Origin') ?? '') ||
        c.req.header('X-CSRF-Token') !== session.csrf
      )
        return c.json({ error: 'Origin or session confirmation failed.' }, 403);
      if (!c.req.header('Content-Type')?.startsWith('application/json'))
        return c.json({ error: 'JSON required.' }, 415);
    }
    await next();
  });
  app.get('/api/orders', (c) =>
    c.json({
      packets: service.list(c.get('session').id),
      audit: store.read(c.get('session').id).audit.slice(-30).reverse(),
    }),
  );
  app.get('/api/orders/:id', (c) => c.json(service.packet(c.get('session').id, c.req.param('id'))));
  app.post('/api/advisory', async (c) => {
    const body = z
      .object({ orderId: z.string().regex(/^MG-\d{4}$/), amount: z.string().max(20) })
      .strict()
      .parse(await c.req.json());
    return c.json(await advisory.packet(c.get('session').id, body.orderId, body.amount));
  });
  app.post('/api/approvals', async (c) => {
    const body = z
      .object({ payload, confirmation: z.string().max(100) })
      .strict()
      .parse(await c.req.json());
    return c.json(service.approve(c.get('session').id, body.payload, body.confirmation), 201);
  });
  app.post('/api/simulations', async (c) => {
    const body = z
      .object({ payload, approvalId: z.string().uuid() })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.fulfill(c.get('session').id, body.payload, body.approvalId));
  });
  app.post('/api/reset', (c) => {
    const session = store.create();
    setCookie(c, 'mg_session', session.id, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 86400,
    });
    return c.json({ csrf: session.csrf });
  });
  app.notFound((c) => c.json({ error: 'Route not found.' }, 404));
  app.onError((error, c) => {
    if (error instanceof PolicyError)
      return c.json({ error: error.message }, error.status as 400 | 401 | 403 | 404 | 409);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: 'Invalid request. Check the fields and try again.' }, 400);
    console.error('Local request failed:', error.name);
    return c.json(
      { error: 'Local request failed. Nothing is reported as a payment success.' },
      500,
    );
  });
  return app;
}
