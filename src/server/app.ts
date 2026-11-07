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
import {
  localRequestSecurity,
  PublicDemoRefusedError,
  type RequestSecurity,
} from './runtime-config';
const payload = z
  .object({
    orderId: z.string().regex(/^MG-\d{4}$/),
    amount: z.string().max(20),
    evidence: z.string().max(2000),
  })
  .strict();
export function createApp(
  store: Store,
  adapter: AdvisoryAdapter = new UnconfiguredAI(),
  paypal: PayPalSandboxAdapter = new UnconfiguredPayPalSandbox(),
  security: RequestSecurity = localRequestSecurity(),
) {
  if (security.publicDemo && paypal.configured) {
    throw new PublicDemoRefusedError(
      'Public fixture demo cannot start with a configured PayPal sandbox adapter. This mode serves fixtures only and must not send PayPal sandbox refunds.',
    );
  }
  const app = new Hono<{ Variables: { session: Session } }>();
  const service = new DecisionService(store, Date.now, paypal);
  const advisory = new AdvisoryService(adapter, service);
  const allowedHosts = new Set(security.allowedHosts.map((host) => host.toLowerCase()));
  const cookiePrefix = security.secureCookies ? ('host' as const) : undefined;
  const sessionCookie = {
    httpOnly: true as const,
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: 86400,
    ...(security.secureCookies ? { secure: true as const, prefix: 'host' as const } : {}),
  };
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: 'Request is too large.' }, 413) }),
  );
  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz' && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
      return c.json({ ok: true });
    }
    const host = new URL(c.req.url).hostname.toLowerCase();
    if (!allowedHosts.has(host))
      return c.json(
        {
          error: security.publicDemo
            ? 'This host is not allowed for the fixture demo.'
            : 'Local loopback access only.',
        },
        403,
      );
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
    let session = store.session(getCookie(c, 'mg_session', cookiePrefix) ?? '');
    if (!session) {
      session = store.create();
      setCookie(c, 'mg_session', session.id, sessionCookie);
    }
    return c.json({
      csrf: session.csrf,
      mode: security.publicDemo ? 'PUBLIC_FIXTURE_DEMO' : 'LOCAL_FIXTURES',
      merchant: 'Kiln & Field / fictional merchant',
      paypal: paypal.configured ? 'CONFIGURED' : 'NOT_CONNECTED',
      ai: advisory.configured ? 'CONFIGURED' : 'NOT_CONNECTED',
    });
  });
  app.use('/api/*', async (c, next) => {
    const session = store.session(getCookie(c, 'mg_session', cookiePrefix) ?? '');
    if (!session)
      return c.json({ error: 'Session expired. Reload to start a local workspace.' }, 401);
    c.set('session', session);
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (
        !security.allowedOrigins.has(c.req.header('Origin') ?? '') ||
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
    setCookie(c, 'mg_session', session.id, sessionCookie);
    return c.json({ csrf: session.csrf });
  });
  app.notFound((c) => {
    if (c.req.method === 'GET' && c.req.path === '/') return c.body(null, 200);
    return c.json({ error: 'Route not found.' }, 404);
  });
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
