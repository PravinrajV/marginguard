import { expect, it, vi } from 'vitest';
import {
  centsToUsd,
  createPayPal,
  PAYPAL_SANDBOX_ORIGIN,
  SandboxPayPal,
  UnconfiguredPayPalSandbox,
  usdToCents,
} from '../src/adapters/paypal';
import { createApp } from '../src/server/app';
import { SQLiteStore } from '../src/server/store';

const ID = 'test-client-id';
const SECRET = 'test-client-secret';
const tokenBody = { access_token: 'tok-1', token_type: 'Bearer', expires_in: 32400 };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const refundBody = (status: string, value = '15.00') => ({
  id: '1JU08902781691411',
  status,
  amount: { value, currency_code: 'USD' },
  seller_payable_breakdown: {
    gross_amount: { value, currency_code: 'USD' },
    paypal_fee: { value: '0.33', currency_code: 'USD' },
    net_amount: { value: '14.67', currency_code: 'USD' },
  },
});
const input = {
  captureId: '2GG279541U471931P',
  amountCents: 1500,
  currency: 'USD' as const,
  requestId: '123e4567-e89b-12d3-a456-426655440010',
};
function client(...responses: Array<Response | Error>) {
  const network = vi.fn<typeof fetch>();
  for (const r of responses)
    if (r instanceof Error) network.mockRejectedValueOnce(r);
    else network.mockResolvedValueOnce(r);
  return { network, paypal: new SandboxPayPal(ID, SECRET, { fetch: network }) };
}

it('converts cents and decimal strings without floating point', () => {
  expect(centsToUsd(1500)).toBe('15.00');
  expect(centsToUsd(7)).toBe('0.07');
  expect(usdToCents('0.29')).toBe(29);
  expect(usdToCents('80.1')).toBe(8010);
  expect(usdToCents('-2.89')).toBe(-289);
  expect(() => centsToUsd(1.5)).toThrow();
  expect(() => centsToUsd(0)).toThrow();
  expect(() => usdToCents('1.001')).toThrow();
  expect(() => usdToCents('1e3')).toThrow();
});

it('requests a client credentials token with Basic auth on the sandbox origin', async () => {
  const { network, paypal } = client(json(tokenBody), json(refundBody('COMPLETED'), 201));
  await paypal.refund(input);
  const [url, init] = network.mock.calls[0]!;
  expect(url).toBe(`${PAYPAL_SANDBOX_ORIGIN}/v1/oauth2/token`);
  const headers = init!.headers as Record<string, string>;
  expect(init!.method).toBe('POST');
  expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${ID}:${SECRET}`).toString('base64')}`);
  expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(init!.body).toBe('grant_type=client_credentials');
});

it('refunds with PayPal-Request-Id, a decimal USD amount and maps fees to cents', async () => {
  const { network, paypal } = client(json(tokenBody), json(refundBody('COMPLETED'), 201));
  const result = await paypal.refund(input);
  expect(result).toEqual({
    id: '1JU08902781691411',
    status: 'COMPLETED',
    requestId: input.requestId,
    amountCents: 1500,
    paypalFeeCents: 33,
    netCents: 1467,
  });
  const [url, init] = network.mock.calls[1]!;
  expect(url).toBe(`${PAYPAL_SANDBOX_ORIGIN}/v2/payments/captures/2GG279541U471931P/refund`);
  const headers = init!.headers as Record<string, string>;
  expect(headers.Authorization).toBe('Bearer tok-1');
  expect(headers['PayPal-Request-Id']).toBe(input.requestId);
  expect(JSON.parse(String(init!.body))).toEqual({
    amount: { value: '15.00', currency_code: 'USD' },
  });
  expect(JSON.stringify(result)).not.toContain('tok-1');
});

it('caches the token until shortly before expiry', async () => {
  let now = 0;
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ ...tokenBody, expires_in: 3600 }))
    .mockResolvedValueOnce(json(refundBody('COMPLETED')))
    .mockResolvedValueOnce(json(refundBody('COMPLETED')))
    .mockResolvedValueOnce(json({ ...tokenBody, access_token: 'tok-2' }))
    .mockResolvedValueOnce(json(refundBody('COMPLETED')));
  const paypal = new SandboxPayPal(ID, SECRET, { fetch: network, now: () => now });
  await paypal.refund(input);
  now = 3_000_000;
  await paypal.refund(input);
  expect(network).toHaveBeenCalledTimes(3);
  now = 3_541_000;
  await paypal.refund(input);
  expect(network.mock.calls[3]![0]).toContain('/v1/oauth2/token');
  expect((network.mock.calls[4]![1]!.headers as Record<string, string>).Authorization).toBe(
    'Bearer tok-2',
  );
});

it('maps PENDING, FAILED and undocumented statuses carefully', async () => {
  for (const [given, expected] of [
    ['PENDING', 'PENDING'],
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
    ['PARTIALLY_COMPLETED', 'UNKNOWN'],
  ] as const) {
    const { paypal } = client(json(tokenBody), json(refundBody(given), 201));
    expect((await paypal.refund(input)).status).toBe(expected);
  }
});

it('treats a mismatched refunded amount as UNKNOWN', async () => {
  const { paypal } = client(json(tokenBody), json(refundBody('COMPLETED', '80.00'), 201));
  expect((await paypal.refund(input)).status).toBe('UNKNOWN');
});

it('returns UNKNOWN, not COMPLETED, after a timeout or 5xx on the refund POST', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const a = client(json(tokenBody), timeout);
  expect(await a.paypal.refund(input)).toEqual({
    id: '',
    status: 'UNKNOWN',
    requestId: input.requestId,
  });
  const b = client(json(tokenBody), json({ name: 'INTERNAL_SERVER_ERROR' }, 500));
  expect((await b.paypal.refund(input)).status).toBe('UNKNOWN');
});

it('aborts slow requests with a real timeout signal', async () => {
  const network = vi.fn<typeof fetch>((_url, init) =>
    String(_url).endsWith('/token')
      ? Promise.resolve(json(tokenBody))
      : new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
        ),
  );
  const paypal = new SandboxPayPal(ID, SECRET, { fetch: network, timeoutMs: 20 });
  expect((await paypal.refund(input)).status).toBe('UNKNOWN');
});

it('throws a definite error on documented 4xx refusals without leaking secrets', async () => {
  const { paypal } = client(
    json(tokenBody),
    json(
      {
        name: 'UNPROCESSABLE_ENTITY',
        debug_id: 'abc123',
        details: [{ issue: 'REFUND_AMOUNT_EXCEEDED' }],
      },
      422,
    ),
  );
  const error = await paypal.refund(input).catch((e: Error) => e);
  expect(String(error)).toMatch(/REFUND_AMOUNT_EXCEEDED/);
  expect(String(error)).not.toContain(SECRET);
});

it('does not send the refund when authentication fails', async () => {
  const { network, paypal } = client(json({ error: 'invalid_client' }, 401));
  await expect(paypal.refund(input)).rejects.toThrow(/rejected the credentials/);
  expect(network).toHaveBeenCalledTimes(1);
});

it('refuses FIXTURE-CAP- ids with zero network calls', async () => {
  const { network, paypal } = client();
  await expect(paypal.refund({ ...input, captureId: 'FIXTURE-CAP-1001' })).rejects.toThrow(
    /No PayPal call was made/,
  );
  await expect(paypal.getCapture('FIXTURE-CAP-1001')).rejects.toThrow(/local only/);
  expect(network).not.toHaveBeenCalled();
});

it('rejects live and arbitrary base URLs and unsafe ids', async () => {
  for (const baseUrl of [
    'https://api-m.paypal.com',
    'https://api.paypal.com',
    'http://api-m.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com.evil.test',
    'https://user@api-m.sandbox.paypal.com',
    'https://example.com',
  ])
    expect(() => new SandboxPayPal(ID, SECRET, { baseUrl })).toThrow(/Sandbox API origin|valid/);
  const { network, paypal } = client();
  await expect(paypal.refund({ ...input, captureId: '../../v1/x' })).rejects.toThrow();
  await expect(paypal.refund({ ...input, requestId: 'x'.repeat(39) })).rejects.toThrow();
  await expect(paypal.refund({ ...input, amountCents: -5 })).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});

it('creates a CAPTURE intent USD order and parses captures from a captured order', async () => {
  const { network, paypal } = client(
    json(tokenBody),
    json(
      {
        id: '5O190127TN364715T',
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          },
        ],
      },
      201,
    ),
    json(
      {
        id: '5O190127TN364715T',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: '3C679366HH908993F',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '80.00' },
                  seller_receivable_breakdown: {
                    gross_amount: { currency_code: 'USD', value: '80.00' },
                    paypal_fee: { currency_code: 'USD', value: '3.28' },
                    net_amount: { currency_code: 'USD', value: '76.72' },
                  },
                },
              ],
            },
          },
        ],
      },
      201,
    ),
  );
  const order = await paypal.createOrder({
    amountCents: 8000,
    currency: 'USD',
    requestId: 'order-1',
  });
  expect(order.approveUrl).toContain('sandbox.paypal.com');
  expect(JSON.parse(String(network.mock.calls[1]![1]!.body))).toEqual({
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: '80.00' } }],
  });
  const captured = await paypal.captureOrder(order.id, 'capture-1');
  expect(network.mock.calls[2]![0]).toBe(
    `${PAYPAL_SANDBOX_ORIGIN}/v2/checkout/orders/5O190127TN364715T/capture`,
  );
  expect(captured.captures).toEqual([
    {
      id: '3C679366HH908993F',
      status: 'COMPLETED',
      amountCents: 8000,
      paypalFeeCents: 328,
      netCents: 7672,
    },
  ]);
});

it('reads order, capture and refund details with GET only', async () => {
  const { network, paypal } = client(
    json(tokenBody),
    json({ id: 'O1', status: 'APPROVED' }),
    json({
      id: 'C1',
      status: 'PARTIALLY_REFUNDED',
      amount: { currency_code: 'USD', value: '80.00' },
    }),
    json({
      ...refundBody('PENDING'),
      links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/C1' }],
    }),
  );
  expect((await paypal.getOrder('O1')).status).toBe('APPROVED');
  expect((await paypal.getCapture('C1')).status).toBe('PARTIALLY_REFUNDED');
  const refund = await paypal.getRefund('1JU08902781691411');
  expect(refund.status).toBe('PENDING');
  expect(refund.captureId).toBe('C1');
  expect(network.mock.calls.slice(1).every(([, init]) => init!.method === 'GET')).toBe(true);
});

it('factory stays unconfigured unless both env values are set', async () => {
  const network = vi.fn<typeof fetch>();
  expect(createPayPal({}, network)).toBeInstanceOf(UnconfiguredPayPalSandbox);
  expect(createPayPal({ PAYPAL_SANDBOX_CLIENT_ID: ID }, network)).toBeInstanceOf(
    UnconfiguredPayPalSandbox,
  );
  expect(
    createPayPal({ PAYPAL_SANDBOX_CLIENT_ID: ' ', PAYPAL_SANDBOX_CLIENT_SECRET: SECRET }, network),
  ).toBeInstanceOf(UnconfiguredPayPalSandbox);
  const configured = createPayPal(
    { PAYPAL_SANDBOX_CLIENT_ID: ID, PAYPAL_SANDBOX_CLIENT_SECRET: SECRET },
    network,
  );
  expect(configured).toBeInstanceOf(SandboxPayPal);
  expect(JSON.stringify(configured)).not.toContain(SECRET);
  expect(network).not.toHaveBeenCalled();
});

it('session reports CONFIGURED only for a configured adapter and never exposes secrets', async () => {
  const network = vi.fn<typeof fetch>();
  const read = async (paypal = createPayPal({}, network)) => {
    const app = createApp(new SQLiteStore(':memory:'), undefined, paypal);
    const res = await app.request('http://127.0.0.1/api/session');
    return res.text();
  };
  expect(JSON.parse(await read()).paypal).toBe('NOT_CONNECTED');
  const body = await read(
    createPayPal({ PAYPAL_SANDBOX_CLIENT_ID: ID, PAYPAL_SANDBOX_CLIENT_SECRET: SECRET }, network),
  );
  expect(JSON.parse(body).paypal).toBe('CONFIGURED');
  expect(body).not.toContain(SECRET);
  expect(body).not.toContain(ID);
  expect(network).not.toHaveBeenCalled();
});
