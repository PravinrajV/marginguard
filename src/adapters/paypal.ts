/**
 * PayPal Sandbox adapter. Server-side only.
 *
 * Shapes follow the official PayPal REST references (fetched November 7, 2026):
 * - Authentication: POST /v1/oauth2/token, HTTP Basic base64(client_id:client_secret),
 *   form body grant_type=client_credentials, response { access_token, token_type, expires_in }.
 * - Payments v2: POST /v2/payments/captures/{capture_id}/refund (200 or 201),
 *   GET /v2/payments/captures/{capture_id}, GET /v2/payments/refunds/{refund_id}.
 *   Refund status enum: CANCELLED, FAILED, PENDING, COMPLETED.
 *   Capture status enum: COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED.
 * - Orders v2: POST /v2/checkout/orders, GET /v2/checkout/orders/{id},
 *   POST /v2/checkout/orders/{id}/capture. Order status enum: CREATED, SAVED, APPROVED,
 *   VOIDED, COMPLETED, PAYER_ACTION_REQUIRED.
 * - Idempotency: PayPal-Request-Id on POST. Reusing it returns the latest status of the
 *   original request, so a timed out refund may be retried with the same id.
 * Money values are decimal strings. They are never parsed through floating point here.
 */
export interface SandboxRefundInput {
  captureId: string;
  amountCents: number;
  currency: 'USD';
  requestId: string;
}
export type SandboxRefundStatus = 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export interface SandboxRefundResult {
  /** PayPal refund id, or an empty string when the outcome is UNKNOWN and no body was read. */
  id: string;
  status: SandboxRefundStatus;
  /** Echo of the idempotency key, so an UNKNOWN outcome can be reconciled or retried safely. */
  requestId?: string;
  amountCents?: number;
  /** PayPal fee returned to the merchant on this refund, when PayPal reports it. */
  paypalFeeCents?: number;
  netCents?: number;
}
export interface PayPalSandboxAdapter {
  readonly configured?: boolean;
  refund(input: SandboxRefundInput): Promise<SandboxRefundResult>;
}
export class UnconfiguredPayPalSandbox implements PayPalSandboxAdapter {
  readonly configured = false;
  async refund(_input: SandboxRefundInput): Promise<SandboxRefundResult> {
    throw new Error('PayPal Sandbox is not connected. No payment call was made.');
  }
}

/** The only origin this adapter will ever contact. */
export const PAYPAL_SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';
const FIXTURE_PREFIX = 'FIXTURE-CAP-';
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_CENTS = 1_000_000_00;

export class PayPalSandboxError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly issue?: string,
    readonly debugId?: string,
  ) {
    super(message);
    this.name = 'PayPalSandboxError';
  }
}

/** Integer cents to a USD decimal string. 1500 becomes "15.00". */
export function centsToUsd(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS)
    throw new PayPalSandboxError('Amount must be a positive whole number of cents.');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
/** USD decimal string to integer cents without floating point. Rejects more than 2 decimals. */
export function usdToCents(value: string): number {
  const match = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new PayPalSandboxError('PayPal returned an amount that is not valid USD.');
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}

export function assertSandboxOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PayPalSandboxError('PayPal base URL is not valid.');
  }
  if (
    parsed.origin !== PAYPAL_SANDBOX_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    (parsed.pathname !== '/' && parsed.pathname)
  )
    throw new PayPalSandboxError('Only the PayPal Sandbox API origin is allowed.');
  return PAYPAL_SANDBOX_ORIGIN;
}
function assertId(kind: string, id: string): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id))
    throw new PayPalSandboxError(`${kind} is not a valid PayPal id.`);
  return id;
}
function assertRequestId(id: string): string {
  // PayPal recommends a UUID and documents a 38 single-byte character limit.
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,38}$/.test(id))
    throw new PayPalSandboxError('Request id must be 1 to 38 letters, digits or hyphens.');
  return id;
}

type Json = Record<string, unknown>;
function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}
function moneyCents(value: unknown): number | undefined {
  const money = obj(value);
  if (!money) return undefined;
  if (money.currency_code !== 'USD')
    throw new PayPalSandboxError('PayPal returned a non USD amount.');
  if (typeof money.value !== 'string')
    throw new PayPalSandboxError('PayPal returned an amount that is not a string.');
  return usdToCents(money.value);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function pick<T extends string>(value: unknown, allowed: readonly T[]): T | 'UNKNOWN' {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : 'UNKNOWN';
}

const REFUND_STATUSES = ['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED'] as const;
const CAPTURE_STATUSES = [
  'COMPLETED',
  'DECLINED',
  'PARTIALLY_REFUNDED',
  'PENDING',
  'REFUNDED',
  'FAILED',
] as const;
const ORDER_STATUSES = [
  'CREATED',
  'SAVED',
  'APPROVED',
  'VOIDED',
  'COMPLETED',
  'PAYER_ACTION_REQUIRED',
] as const;
export type SandboxCaptureStatus = (typeof CAPTURE_STATUSES)[number] | 'UNKNOWN';
export type SandboxOrderStatus = (typeof ORDER_STATUSES)[number] | 'UNKNOWN';

export interface SandboxCapture {
  id: string;
  status: SandboxCaptureStatus;
  amountCents?: number;
  paypalFeeCents?: number;
  netCents?: number;
}
export interface SandboxRefund extends SandboxRefundResult {
  captureId?: string;
}
export interface SandboxOrder {
  id: string;
  status: SandboxOrderStatus;
  /** Buyer approval URL (rel "payer-action" or "approve"), when present. */
  approveUrl?: string;
  captures: SandboxCapture[];
}
export interface CreateOrderInput {
  amountCents: number;
  currency: 'USD';
  requestId: string;
  referenceId?: string;
  description?: string;
}

function parseRefund(body: unknown, requestId?: string): SandboxRefund {
  const b = obj(body) ?? {};
  const breakdown = obj(b.seller_payable_breakdown);
  const upLink = Array.isArray(b.links)
    ? (b.links as unknown[]).map(obj).find((l) => l?.rel === 'up')
    : undefined;
  const captureId = str(upLink?.href)?.match(/\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/)?.[1];
  return {
    id: str(b.id) ?? '',
    status: pick(b.status, REFUND_STATUSES),
    ...(requestId ? { requestId } : {}),
    ...defined('amountCents', moneyCents(b.amount)),
    ...defined('paypalFeeCents', moneyCents(breakdown?.paypal_fee)),
    ...defined('netCents', moneyCents(breakdown?.net_amount)),
    ...(captureId ? { captureId } : {}),
  };
}
function parseCapture(body: unknown): SandboxCapture {
  const b = obj(body) ?? {};
  const breakdown = obj(b.seller_receivable_breakdown);
  return {
    id: str(b.id) ?? '',
    status: pick(b.status, CAPTURE_STATUSES),
    ...defined('amountCents', moneyCents(b.amount)),
    ...defined('paypalFeeCents', moneyCents(breakdown?.paypal_fee)),
    ...defined('netCents', moneyCents(breakdown?.net_amount)),
  };
}
function parseOrder(body: unknown): SandboxOrder {
  const b = obj(body) ?? {};
  const links = Array.isArray(b.links) ? (b.links as unknown[]).map(obj) : [];
  const approve =
    links.find((l) => l?.rel === 'payer-action') ?? links.find((l) => l?.rel === 'approve');
  const captures: SandboxCapture[] = [];
  for (const unit of Array.isArray(b.purchase_units) ? b.purchase_units : []) {
    const list = obj(obj(unit)?.payments)?.captures;
    if (Array.isArray(list)) for (const c of list) captures.push(parseCapture(c));
  }
  const approveUrl = str(approve?.href);
  return {
    id: str(b.id) ?? '',
    status: pick(b.status, ORDER_STATUSES),
    ...(approveUrl ? { approveUrl } : {}),
    captures,
  };
}
function defined<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

class NetworkUnknown extends Error {}

export interface SandboxPayPalOptions {
  fetch?: typeof fetch;
  /** Only https://api-m.sandbox.paypal.com is accepted. */
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => number;
}

/** Real PayPal Sandbox REST client. Credentials and tokens stay private to this instance. */
export class SandboxPayPal implements PayPalSandboxAdapter {
  readonly configured = true;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #token: { value: string; expiresAt: number } | undefined;
  #tokenInFlight: Promise<string> | undefined;

  constructor(clientId: string, clientSecret: string, options: SandboxPayPalOptions = {}) {
    if (!clientId?.trim() || !clientSecret?.trim())
      throw new PayPalSandboxError('PayPal Sandbox credentials are incomplete.');
    this.#clientId = clientId.trim();
    this.#clientSecret = clientSecret.trim();
    this.#fetch = options.fetch ?? fetch;
    this.#origin = assertSandboxOrigin(options.baseUrl ?? PAYPAL_SANDBOX_ORIGIN);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  toJSON() {
    return { adapter: 'SandboxPayPal', origin: this.#origin };
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.#origin);
    if (url.origin !== PAYPAL_SANDBOX_ORIGIN)
      throw new PayPalSandboxError('Only the PayPal Sandbox API origin is allowed.');
    try {
      return await this.#fetch(url.toString(), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new NetworkUnknown();
    }
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt) return this.#token.value;
    this.#tokenInFlight ??= this.#fetchToken().finally(() => {
      this.#tokenInFlight = undefined;
    });
    return this.#tokenInFlight;
  }

  async #fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.#send('/v1/oauth2/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (error) {
      if (error instanceof NetworkUnknown)
        throw new PayPalSandboxError('Could not reach PayPal Sandbox for authentication.');
      throw error;
    }
    if (!res.ok)
      throw new PayPalSandboxError('PayPal Sandbox rejected the credentials.', res.status);
    const body = obj(await res.json().catch(() => undefined));
    const token = str(body?.access_token);
    const expiresIn = body?.expires_in;
    if (
      !token ||
      typeof expiresIn !== 'number' ||
      !(expiresIn > 0) ||
      String(body?.token_type).toLowerCase() !== 'bearer'
    )
      throw new PayPalSandboxError('PayPal Sandbox returned an unexpected token response.');
    const lifetime = expiresIn * 1000;
    this.#token = {
      value: token,
      expiresAt: this.#now() + Math.max(0, lifetime - Math.min(TOKEN_SKEW_MS, lifetime / 2)),
    };
    return token;
  }

  async #api(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; requestId?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers.Prefer = 'return=representation';
      if (options.requestId) headers['PayPal-Request-Id'] = options.requestId;
    }
    const res = await this.#send(path, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
    if (res.status === 401) this.#token = undefined;
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  }

  #fail(status: number, body: unknown): never {
    const b = obj(body);
    const detail = Array.isArray(b?.details) ? obj(b.details[0]) : undefined;
    const issue = str(detail?.issue) ?? str(b?.name);
    throw new PayPalSandboxError(
      `PayPal Sandbox request failed${issue ? ` (${issue})` : ''}.`,
      status,
      issue,
      str(b?.debug_id),
    );
  }

  async refund(input: SandboxRefundInput): Promise<SandboxRefundResult> {
    if (typeof input?.captureId === 'string' && input.captureId.startsWith(FIXTURE_PREFIX))
      throw new PayPalSandboxError('Fixture capture ids are local only. No PayPal call was made.');
    if (input.currency !== 'USD') throw new PayPalSandboxError('Only USD refunds are supported.');
    const captureId = assertId('Capture id', input.captureId);
    const requestId = assertRequestId(input.requestId);
    const value = centsToUsd(input.amountCents);
    // Authenticate first: a failure here means the refund POST was never sent.
    await this.#accessToken();
    let result: { status: number; body: unknown };
    try {
      result = await this.#api('POST', `/v2/payments/captures/${captureId}/refund`, {
        requestId,
        body: { amount: { value, currency_code: 'USD' } },
      });
    } catch (error) {
      // Timeout or connection loss after the POST may have been sent. Never invent success.
      if (error instanceof NetworkUnknown) return { id: '', status: 'UNKNOWN', requestId };
      throw error;
    }
    if (result.status >= 500) return { id: '', status: 'UNKNOWN', requestId };
    if (result.status !== 200 && result.status !== 201) this.#fail(result.status, result.body);
    const { captureId: _c, ...refund } = parseRefund(result.body, requestId);
    if (refund.amountCents !== undefined && refund.amountCents !== input.amountCents)
      return { ...refund, status: 'UNKNOWN' };
    return refund;
  }

  async createOrder(input: CreateOrderInput): Promise<SandboxOrder> {
    if (input.currency !== 'USD') throw new PayPalSandboxError('Only USD orders are supported.');
    const requestId = assertRequestId(input.requestId);
    const unit: Json = { amount: { currency_code: 'USD', value: centsToUsd(input.amountCents) } };
    if (input.referenceId) unit.reference_id = input.referenceId.slice(0, 256);
    if (input.description) unit.description = input.description.slice(0, 127);
    const { status, body } = await this.#strict('POST', '/v2/checkout/orders', {
      requestId,
      body: { intent: 'CAPTURE', purchase_units: [unit] },
    });
    if (status !== 200 && status !== 201) this.#fail(status, body);
    return parseOrder(body);
  }

  async captureOrder(orderId: string, requestId: string): Promise<SandboxOrder> {
    const id = assertId('Order id', orderId);
    const { status, body } = await this.#strict('POST', `/v2/checkout/orders/${id}/capture`, {
      requestId: assertRequestId(requestId),
      body: {},
    });
    if (status !== 200 && status !== 201) this.#fail(status, body);
    return parseOrder(body);
  }

  async getOrder(orderId: string): Promise<SandboxOrder> {
    return parseOrder(await this.#get(`/v2/checkout/orders/${assertId('Order id', orderId)}`));
  }
  async getCapture(captureId: string): Promise<SandboxCapture> {
    if (captureId.startsWith(FIXTURE_PREFIX))
      throw new PayPalSandboxError('Fixture capture ids are local only. No PayPal call was made.');
    return parseCapture(
      await this.#get(`/v2/payments/captures/${assertId('Capture id', captureId)}`),
    );
  }
  async getRefund(refundId: string): Promise<SandboxRefund> {
    return parseRefund(await this.#get(`/v2/payments/refunds/${assertId('Refund id', refundId)}`));
  }

  async #get(path: string): Promise<unknown> {
    const { status, body } = await this.#strict('GET', path);
    if (status !== 200) this.#fail(status, body);
    return body;
  }
  async #strict(
    method: 'GET' | 'POST',
    path: string,
    options?: { body?: unknown; requestId?: string },
  ) {
    try {
      return await this.#api(method, path, options);
    } catch (error) {
      if (error instanceof NetworkUnknown)
        throw new PayPalSandboxError(
          'PayPal Sandbox did not respond in time. The outcome is unknown; retry with the same request id.',
        );
      throw error;
    }
  }
}

/** Called in the server entry point only. Environment is never bundled into the client. */
export function createPayPal(
  env: { PAYPAL_SANDBOX_CLIENT_ID?: string; PAYPAL_SANDBOX_CLIENT_SECRET?: string },
  network: typeof fetch = fetch,
): PayPalSandboxAdapter {
  const id = env.PAYPAL_SANDBOX_CLIENT_ID?.trim();
  const secret = env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim();
  return id && secret
    ? new SandboxPayPal(id, secret, { fetch: network })
    : new UnconfiguredPayPalSandbox();
}
