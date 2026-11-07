import { expect, it, vi } from 'vitest';
import { createFixtures } from '../src/server/fixtures';
import { SQLiteStore } from '../src/server/store';
import {
  applySandboxOverlay,
  parseSandboxOverlay,
  type SandboxSaleOverlay,
} from '../src/server/sandbox-sale';
import { DecisionService } from '../src/server/service';
import type { PayPalSandboxAdapter, SandboxRefundResult } from '../src/adapters/paypal';

const valid: SandboxSaleOverlay = {
  localOrderId: 'MG-1001',
  paypalOrderId: 'TEST-SANDBOX-ORDER-1001',
  captureId: 'TEST-SANDBOX-CAPTURE-1001',
  amountCents: 8000,
  paypalFeeCents: 256,
  netCents: 7744,
  currency: 'USD',
  status: 'COMPLETED',
};

function overlayState(overlay: SandboxSaleOverlay | null = valid) {
  return applySandboxOverlay(
    createFixtures('2026-01-01T00:00:00.000Z'),
    overlay,
    '2026-11-07T13:00:00.000Z',
  );
}

it('parseSandboxOverlay accepts the known-good sale and rejects unsafe values', () => {
  expect(parseSandboxOverlay(valid)?.captureId).toBe('TEST-SANDBOX-CAPTURE-1001');
  expect(parseSandboxOverlay({ ...valid, extra: 'notes' })?.netCents).toBe(7744);
  expect(parseSandboxOverlay({ ...valid, localOrderId: 'MG-1002' })).toBeNull();
  expect(parseSandboxOverlay({ ...valid, amountCents: 7900 })).toBeNull();
  expect(parseSandboxOverlay({ ...valid, netCents: 7700 })).toBeNull();
  expect(parseSandboxOverlay({ ...valid, captureId: 'FIXTURE-CAP-1001' })).toBeNull();
  expect(parseSandboxOverlay({ ...valid, currency: 'EUR' })).toBeNull();
  expect(parseSandboxOverlay({ ...valid, status: 'PENDING' })).toBeNull();
  expect(parseSandboxOverlay(null)).toBeNull();
});

it('applySandboxOverlay patches only MG-1001 and leaves fixtures unchanged when overlay is invalid', () => {
  const applied = overlayState(valid);
  const mug = applied.orders.find((order) => order.id === 'MG-1001')!;
  expect(mug.captureId).toBe('TEST-SANDBOX-CAPTURE-1001');
  expect(mug.fee).toBe(256);
  expect(mug.net).toBe(7744);
  expect(mug.source).toBe('PAYPAL_SANDBOX');
  expect(applied.audit.some((event) => event.type === 'SANDBOX_SALE_ATTACHED')).toBe(true);
  expect(applied.orders.find((order) => order.id === 'MG-1002')?.captureId).toBe(
    'FIXTURE-CAP-1002',
  );

  const untouched = overlayState(null);
  expect(untouched.orders[0]?.captureId).toBe('FIXTURE-CAP-1001');
  expect(untouched.orders[0]?.fee).toBe(289);
  expect(untouched.orders[0]?.source).toBe('FICTIONAL_FIXTURE');
});

it('default SQLiteStore sessions keep fictional MG-1001 even if an overlay file exists', () => {
  const store = new SQLiteStore(':memory:');
  try {
    const service = new DecisionService(store);
    const session = store.create().id;
    const order = service.packet(session, 'MG-1001').order;
    expect(order.captureId).toBe('FIXTURE-CAP-1001');
    expect(order.fee).toBe(289);
    expect(service.packet(session, 'MG-1001').before).toBe(4311);
  } finally {
    store.close();
  }
});

it('seeded store uses the overlay contribution numbers', () => {
  const store = new SQLiteStore(':memory:', {
    seed: () => overlayState(valid),
  });
  try {
    const service = new DecisionService(store);
    const session = store.create().id;
    const packet = service.packet(session, 'MG-1001');
    expect(packet.order.captureId).toBe('TEST-SANDBOX-CAPTURE-1001');
    expect(packet.before).toBe(4344);
    expect(packet.order.source).toBe('PAYPAL_SANDBOX');
  } finally {
    store.close();
  }
});

it('fixture approve and simulate still do not call PayPal', async () => {
  const refund = vi.fn();
  const paypal = { configured: true, refund } satisfies PayPalSandboxAdapter;
  const store = new SQLiteStore(':memory:');
  try {
    const service = new DecisionService(store, Date.now, paypal);
    const session = store.create().id;
    const payload = {
      orderId: 'MG-1001',
      amount: '15.00',
      evidence: service.packet(session, 'MG-1001').evidence,
    };
    const approval = service.approve(session, payload, 'APPROVE $15.00 LOCAL SIMULATION');
    const operation = await service.fulfill(session, payload, approval.approvalId);
    expect(operation.status).toBe('SIMULATED');
    expect(operation.source).toBe('LOCAL_SIMULATION');
    expect(service.packet(session, 'MG-1001').order.refunded).toBe(1500);
    expect(refund).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it('rejects local-simulation confirmation on a sandbox capture', () => {
  const store = new SQLiteStore(':memory:', { seed: () => overlayState(valid) });
  try {
    const service = new DecisionService(store);
    const session = store.create().id;
    const payload = {
      orderId: 'MG-1001',
      amount: '15.00',
      evidence: service.packet(session, 'MG-1001').evidence,
    };
    expect(() => service.approve(session, payload, 'APPROVE $15.00 LOCAL SIMULATION')).toThrow(
      /Exact human confirmation/,
    );
    expect(service.packet(session, 'MG-1001').order.refunded).toBe(0);
  } finally {
    store.close();
  }
});

it('sandbox confirmation plus a completed refund updates the ledger and never sends fixture ids', async () => {
  const refund = vi.fn(async (input) => {
    expect(input.captureId).toBe('TEST-SANDBOX-CAPTURE-1001');
    expect(input.captureId.startsWith('FIXTURE-CAP-')).toBe(false);
    expect(input.amountCents).toBe(1500);
    return {
      id: 'REFUND-1',
      status: 'COMPLETED',
      amountCents: 1500,
      requestId: input.requestId,
    } satisfies SandboxRefundResult;
  });
  const paypal = { configured: true, refund } satisfies PayPalSandboxAdapter;
  const store = new SQLiteStore(':memory:', { seed: () => overlayState(valid) });
  try {
    const service = new DecisionService(store, Date.now, paypal);
    const session = store.create().id;
    const payload = {
      orderId: 'MG-1001',
      amount: '15.00',
      evidence: service.packet(session, 'MG-1001').evidence,
    };
    const approval = service.approve(session, payload, 'APPROVE $15.00 PAYPAL SANDBOX REFUND');
    const operation = await service.fulfill(session, payload, approval.approvalId);
    expect(refund).toHaveBeenCalledOnce();
    expect(refund.mock.calls[0]?.[0].requestId).toBe(approval.approvalId);
    expect(operation.status).toBe('SANDBOX_COMPLETED');
    expect(operation.source).toBe('PAYPAL_SANDBOX');
    expect(operation.id.startsWith('SB-')).toBe(true);
    expect(service.packet(session, 'MG-1001').order.refunded).toBe(1500);
    expect(service.packet(session, 'MG-1001').before).toBe(2844);
    expect(await service.fulfill(session, payload, approval.approvalId)).toEqual(operation);
    expect(refund).toHaveBeenCalledOnce();
  } finally {
    store.close();
  }
});

it('does not mark the ledger successful when the sandbox refund is UNKNOWN', async () => {
  const refund = vi.fn(async (input): Promise<SandboxRefundResult> => ({
    id: '',
    status: 'UNKNOWN',
    requestId: input.requestId,
  }));
  const paypal = { configured: true, refund } satisfies PayPalSandboxAdapter;
  const store = new SQLiteStore(':memory:', { seed: () => overlayState(valid) });
  try {
    const service = new DecisionService(store, Date.now, paypal);
    const session = store.create().id;
    const payload = {
      orderId: 'MG-1001',
      amount: '15.00',
      evidence: service.packet(session, 'MG-1001').evidence,
    };
    const approval = service.approve(session, payload, 'APPROVE $15.00 PAYPAL SANDBOX REFUND');
    await expect(service.fulfill(session, payload, approval.approvalId)).rejects.toThrow(
      /did not complete/,
    );
    expect(service.packet(session, 'MG-1001').order.refunded).toBe(0);
    expect(store.read(session).operations).toHaveLength(0);
  } finally {
    store.close();
  }
});

it('rejects overlay identifiers with URL or path characters', () => {
  expect(
    parseSandboxOverlay({ ...valid, captureId: 'https://example.invalid/capture' }),
  ).toBeNull();
});

it('validates optional prior-refund snapshots without accepting malformed balances', () => {
  for (const refundedCents of [-1, 8001, 1.5, '1500', null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(parseSandboxOverlay({ ...valid, refundedCents })).toBeNull();
  }
  for (const refundedCents of [0, 1500, 8000]) {
    expect(parseSandboxOverlay({ ...valid, refundedCents })?.refundedCents).toBe(refundedCents);
  }
});

it('imports a refund snapshot without a PayPal call, approval, operation or receipt', () => {
  const state = overlayState({ ...valid, refundedCents: 1500 });
  const store = new SQLiteStore(':memory:', { seed: () => state });
  try {
    const service = new DecisionService(store);
    const session = store.create().id;
    const packet = service.packet(session, 'MG-1001');
    expect(packet.order.refunded).toBe(1500);
    expect(packet.before).toBe(2844);
    expect(packet.remaining).toBe(6500);
    expect(packet.order.suggested).toBe('');
    expect(state.operations).toHaveLength(0);
    expect(state.approvals).toHaveLength(0);
    expect(state.audit.some((event) => event.type === 'SANDBOX_REFUND_SNAPSHOT_ATTACHED')).toBe(
      true,
    );
  } finally {
    store.close();
  }
});

it('omitted refundedCents preserves the legacy unrefunded snapshot', () => {
  expect(overlayState(valid).orders[0]?.refunded).toBe(0);
  expect(overlayState(valid).orders[0]?.suggested).toBe('15.00');
});
