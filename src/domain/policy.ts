import { contribution, cents, parseUSD, sumMoney } from './money';
import { buildBrief } from './brief';
import type { Order, Packet, RefundPayload } from './types';
export class PolicyError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function reconcile(order: Order): string[] {
  const issues: string[] = [];
  if (order.currency !== 'USD') issues.push('Only USD is supported.');
  if (order.status !== 'COMPLETED') issues.push('Capture is not completed.');
  if (order.captureGross !== order.gross)
    issues.push('Capture gross does not match the order. Resolve the evidence mismatch first.');
  if (order.fee === null || order.net === null)
    issues.push('Fee or net evidence is missing. Margin is unknown; approval is blocked.');
  else if (sumMoney([order.captureGross, -order.fee]) !== order.net)
    issues.push('Gross, fee and net do not reconcile.');
  if (order.reserved > 0) issues.push('An unresolved operation reserves refundable balance.');
  if (order.refunded + order.reserved > order.captureGross)
    issues.push('Refund ledger exceeds the capture.');
  return issues;
}
/** Canonical, complete evidence snapshot, stored server-side, not a client authority. */
export function evidenceFor(order: Order): string {
  return JSON.stringify([
    order.id,
    order.captureId,
    order.currency,
    order.captureGross,
    order.gross,
    order.fee,
    order.net,
    order.cogs,
    order.shipping,
    order.refunded,
    order.reserved,
    order.status,
    order.version,
    order.fetchedAt,
  ]);
}
export function packetFor(order: Order): Packet {
  const remaining = cents(order.captureGross - order.refunded - order.reserved);
  const issues = reconcile(order);
  let proposed: number | null = null;
  try {
    proposed = order.suggested ? parseUSD(order.suggested) : null;
  } catch {
    proposed = null;
  }
  if (proposed !== null && proposed > remaining) proposed = null;
  return {
    brief: buildBrief({ order, issues, remaining }, proposed),
    order,
    evidence: evidenceFor(order),
    issues,
    remaining,
    before: contribution(order.gross, order.refunded, order.fee, order.cogs, order.shipping),
    fullAfter: contribution(
      order.gross,
      order.refunded + remaining,
      order.fee,
      order.cogs,
      order.shipping,
    ),
  };
}
export function validateRefund(order: Order, payload: RefundPayload): number {
  const issues = reconcile(order);
  if (issues.length) throw new PolicyError(issues[0]);
  if (payload.evidence !== evidenceFor(order))
    throw new PolicyError('Evidence changed. Review a fresh decision packet.');
  let amount: number;
  try {
    amount = parseUSD(payload.amount);
  } catch {
    throw new PolicyError('Enter a valid USD amount.', 400);
  }
  if (amount <= 0) throw new PolicyError('Refund must be greater than zero.', 400);
  if (amount > order.captureGross - order.refunded - order.reserved)
    throw new PolicyError('Refund exceeds the remaining refundable balance.', 400);
  return amount;
}
export function canonicalPayload(payload: RefundPayload): string {
  let amount: number;
  try {
    amount = parseUSD(payload.amount);
  } catch {
    throw new PolicyError('Enter a valid USD amount.', 400);
  }
  return JSON.stringify([payload.orderId, amount, 'USD', payload.evidence]);
}
