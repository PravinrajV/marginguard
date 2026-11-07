import { readFileSync } from 'node:fs';
import { formatUSD } from '../domain/money';
import { FIXTURE_CAPTURE_PREFIX, isSandboxCapture } from '../domain/capture';
import type { State } from '../domain/types';
import { createFixtures } from './fixtures';

export const DEFAULT_OVERLAY_PATH = '.data/mg-1001-sandbox.json';
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const EXPECTED_GROSS_CENTS = 8000;

export interface SandboxSaleOverlay {
  localOrderId: 'MG-1001';
  paypalOrderId: string;
  captureId: string;
  amountCents: number;
  paypalFeeCents: number;
  netCents: number;
  currency: 'USD';
  status: 'COMPLETED';
  /** Manually verified snapshot only. Does not call PayPal or create a refund receipt. */
  refundedCents?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseSandboxOverlay(raw: unknown): SandboxSaleOverlay | null {
  const body = record(raw);
  if (!body) return null;
  if (body.localOrderId !== 'MG-1001') return null;
  if (body.currency !== 'USD') return null;
  if (body.status !== 'COMPLETED') return null;
  if (typeof body.paypalOrderId !== 'string' || !ID_PATTERN.test(body.paypalOrderId)) return null;
  if (typeof body.captureId !== 'string' || !ID_PATTERN.test(body.captureId)) return null;
  if (!isSandboxCapture(body.captureId) || body.captureId.startsWith(FIXTURE_CAPTURE_PREFIX))
    return null;
  const amountCents = body.amountCents;
  const paypalFeeCents = body.paypalFeeCents;
  const netCents = body.netCents;
  if (
    typeof amountCents !== 'number' ||
    !Number.isSafeInteger(amountCents) ||
    amountCents !== EXPECTED_GROSS_CENTS
  )
    return null;
  if (
    typeof paypalFeeCents !== 'number' ||
    !Number.isSafeInteger(paypalFeeCents) ||
    paypalFeeCents < 0 ||
    paypalFeeCents >= amountCents
  )
    return null;
  if (
    typeof netCents !== 'number' ||
    !Number.isSafeInteger(netCents) ||
    netCents !== amountCents - paypalFeeCents
  )
    return null;
  const refundedCents = body.refundedCents;
  if (
    refundedCents !== undefined &&
    (typeof refundedCents !== 'number' ||
      !Number.isSafeInteger(refundedCents) ||
      refundedCents < 0 ||
      refundedCents > amountCents)
  )
    return null;
  return {
    ...(refundedCents !== undefined ? { refundedCents } : {}),
    localOrderId: 'MG-1001',
    paypalOrderId: body.paypalOrderId,
    captureId: body.captureId,
    amountCents,
    paypalFeeCents,
    netCents,
    currency: 'USD',
    status: 'COMPLETED',
  };
}

export function loadSandboxOverlay(path = DEFAULT_OVERLAY_PATH): SandboxSaleOverlay | null {
  try {
    return parseSandboxOverlay(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function applySandboxOverlay(
  state: State,
  overlay: SandboxSaleOverlay | null,
  now = new Date().toISOString(),
): State {
  if (!overlay) return state;
  const order = state.orders.find((item) => item.id === overlay.localOrderId);
  if (!order) return state;
  order.captureId = overlay.captureId;
  order.fee = overlay.paypalFeeCents;
  order.net = overlay.netCents;
  order.captureGross = overlay.amountCents;
  order.gross = overlay.amountCents;
  order.status = 'COMPLETED';
  order.source = 'PAYPAL_SANDBOX';
  if (overlay.refundedCents !== undefined) {
    order.refunded = overlay.refundedCents;
    if (overlay.refundedCents > 0) order.suggested = '';
  }
  order.fetchedAt = now;
  state.audit.push({
    id: crypto.randomUUID(),
    at: now,
    type: 'SANDBOX_SALE_ATTACHED',
    orderId: order.id,
    detail: `PayPal Sandbox capture ${overlay.captureId} attached to ${order.id}. Observed sandbox fee ${formatUSD(overlay.paypalFeeCents)}.`,
  });
  if (overlay.refundedCents !== undefined)
    state.audit.push({
      id: crypto.randomUUID(),
      at: now,
      type: 'SANDBOX_REFUND_SNAPSHOT_ATTACHED',
      orderId: order.id,
      detail: `${formatUSD(overlay.refundedCents)} prior sandbox refunds imported from a manually verified snapshot. No PayPal call or refund receipt was created. This is not live reconciliation.`,
    });
  return state;
}

export function seedWithSandboxSale(): State {
  return applySandboxOverlay(createFixtures(), loadSandboxOverlay());
}
