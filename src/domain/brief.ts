import { contribution, cents, formatUSD, parseUSD } from './money';
import type { Order } from './types';

/** Deterministic decision brief. Built only from server facts. No model, no inference. */
export interface BriefFact {
  label: string;
  value: number | null;
  sources: string[];
}
export interface DecisionBrief {
  source: 'DETERMINISTIC_BRIEF';
  ai: 'NOT_CONNECTED';
  intent: {
    reason: string;
    explicitAmount: number | null;
    mode: 'EXPLICIT_AMOUNT' | 'FULL_REFUND' | 'UNSPECIFIED';
    orderRef: string | null;
    needsReview: boolean;
    /** Amount field empty, nothing blocking: not a review case, just waiting on input. */
    awaitingAmount: boolean;
  };
  proposed: number | null;
  facts: BriefFact[];
  feeTreatment: string;
  issues: string[];
  citations: string[];
  replyDraft: { kind: 'TEMPLATE'; sent: false; text: string };
}
interface BriefInput {
  order: Order;
  issues: string[];
  remaining: number;
}
export const SOURCES = {
  gross: 'Captured gross',
  fee: 'Processing fee',
  goods: 'Goods cost',
  shipping: 'Shipping cost',
  refunds: 'Existing refunds',
  reserved: 'Reserved balance',
  capture: 'Capture status / id',
  request: 'Customer request text',
} as const;

export function explicitAmount(text: string): number | null {
  const match = /\$(\d{1,11}(?:\.\d{1,2})?)(?!\d)/.exec(text);
  if (!match) return null;
  try {
    return parseUSD(match[1]);
  } catch {
    return null;
  }
}

export function buildBrief(packet: BriefInput, proposed: number | null): DecisionBrief {
  const { order, issues, remaining } = packet;
  if (proposed !== null) cents(proposed);
  const amount = explicitAmount(order.request);
  const full = amount === null && /\bin full\b/i.test(order.request);
  const ref = /\bMG-\d{4}\b/.exec(order.request)?.[0] ?? null;
  const mode = amount !== null ? 'EXPLICIT_AMOUNT' : full ? 'FULL_REFUND' : 'UNSPECIFIED';
  const before = contribution(order.gross, order.refunded, order.fee, order.cogs, order.shipping);
  const after =
    proposed === null
      ? null
      : contribution(order.gross, order.refunded + proposed, order.fee, order.cogs, order.shipping);
  const c = [SOURCES.gross, SOURCES.fee, SOURCES.goods, SOURCES.shipping, SOURCES.refunds];
  const facts: BriefFact[] = [
    { label: 'Current contribution', value: before, sources: c },
    { label: 'Proposed refund', value: proposed, sources: [SOURCES.request] },
    { label: 'Contribution after', value: after, sources: c },
    {
      label: 'Remaining refundable',
      value: remaining,
      sources: [SOURCES.gross, SOURCES.refunds, SOURCES.reserved],
    },
  ];
  const blocked = issues.length > 0;
  const needsReview = mode === 'UNSPECIFIED' || blocked;
  const awaitingAmount = proposed === null && !blocked;
  const feeTreatment =
    order.fee === null
      ? 'Unknown because fee evidence is missing.'
      : 'Assumes the original processing fee is retained.';
  const who = 'Hi there,';
  const what = `thanks for flagging the issue with your ${order.product.toLowerCase()} (order ${order.id}).`;
  let body: string;
  if (blocked)
    body = `We're checking a few details on our side before we can propose anything. We'll follow up once that's done.`;
  else if (proposed === null && mode !== 'UNSPECIFIED')
    body = `Enter an amount to draft the next unsent reply.`;
  else if (mode === 'UNSPECIFIED' || proposed === null)
    body = `We'd like to make this right. Could you tell us what would feel fair? We'll review it and get back to you.`;
  else
    body = `We'd like to offer a refund of ${formatUSD(proposed)} for this. If that works for you, reply and we'll take it from there.`;
  return {
    source: 'DETERMINISTIC_BRIEF',
    ai: 'NOT_CONNECTED',
    intent: {
      reason: order.reason,
      explicitAmount: amount,
      mode,
      orderRef: ref,
      needsReview,
      awaitingAmount,
    },
    proposed,
    facts,
    feeTreatment,
    issues: [...issues],
    citations: Object.values(SOURCES),
    replyDraft: { kind: 'TEMPLATE', sent: false, text: `${who} ${what} ${body}` },
  };
}
