import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionService } from '../src/server/service';
import { SQLiteStore } from '../src/server/store';
import { UnconfiguredPayPalSandbox } from '../src/adapters/paypal';
import { UnconfiguredAI } from '../src/adapters/advisory';
import type { RefundPayload } from '../src/domain/types';
let store: SQLiteStore;
let service: DecisionService;
let session: string;
let now: number;
function payload(): RefundPayload {
  return {
    orderId: 'MG-1001',
    amount: '15.00',
    evidence: service.packet(session, 'MG-1001').evidence,
  };
}
function approve(p = payload()) {
  return service.approve(session, p, 'APPROVE $15.00 LOCAL SIMULATION');
}
beforeEach(() => {
  store = new SQLiteStore(':memory:');
  now = Date.now();
  service = new DecisionService(store, () => now);
  session = store.create().id;
});
afterEach(() => store.close());
describe('human authority', () => {
  it('no approval => no refund, no ledger change', () => {
    expect(() => service.simulate(session, payload(), crypto.randomUUID())).toThrow(
      /No valid human approval/,
    );
    expect(store.read(session).operations).toHaveLength(0);
    expect(service.packet(session, 'MG-1001').order.refunded).toBe(0);
  });
  it('requires exact explicit confirmation', () => {
    expect(() => service.approve(session, payload(), 'yes')).toThrow(/confirmation/);
    expect(store.read(session).approvals).toHaveLength(0);
  });
  it('simulates exact approved cents, never labels a PayPal success', () => {
    const p = payload();
    const a = approve(p);
    const op = service.simulate(session, p, a.approvalId);
    expect(op.status).toBe('SIMULATED');
    expect(op.source).toBe('LOCAL_SIMULATION');
    expect(op.amount).toBe(1500);
    expect(service.packet(session, 'MG-1001').before).toBe(2811);
  });
  it('denies edited approval', () => {
    const p = payload();
    const a = approve(p);
    expect(() => service.simulate(session, { ...p, amount: '16.00' }, a.approvalId)).toThrow(
      /does not match/,
    );
    expect(store.read(session).operations).toHaveLength(0);
  });
  it('denies stale evidence', () => {
    const p = payload();
    const a = approve(p);
    store.transact(session, (s) => {
      s.orders[0].version++;
    });
    expect(() => service.simulate(session, p, a.approvalId)).toThrow(/Evidence changed/);
  });
  it('binds costs, fees and capture identity, not just amount', () => {
    const p = payload();
    const a = approve(p);
    store.transact(session, (s) => {
      s.orders[0].shipping++;
    });
    expect(() => service.simulate(session, p, a.approvalId)).toThrow(/Evidence changed/);
  });
  it('denies expired approval', () => {
    const p = payload();
    const a = approve(p);
    now += 300001;
    expect(() => service.simulate(session, p, a.approvalId)).toThrow(/expired/);
  });
  it('denies over-refund before approval', () => {
    expect(() =>
      service.approve(
        session,
        { ...payload(), amount: '80.01' },
        'APPROVE $80.01 LOCAL SIMULATION',
      ),
    ).toThrow(/exceeds/);
    expect(store.read(session).approvals).toHaveLength(0);
  });
  it('denies zero, negatives and overprecision', () => {
    for (const amount of ['0', '-1', '1.001'])
      expect(() => service.approve(session, { ...payload(), amount }, '')).toThrow();
  });
  it('idempotent double-click consumes balance once', () => {
    const p = payload();
    const a = approve(p);
    const first = service.simulate(session, p, a.approvalId);
    const second = service.simulate(session, p, a.approvalId);
    expect(first.id).toBe(second.id);
    expect(store.read(session).operations).toHaveLength(1);
    expect(service.packet(session, 'MG-1001').order.refunded).toBe(1500);
  });
  it('competing approvals cannot spend the same stale balance', async () => {
    const p = payload();
    const a = approve(p);
    const b = approve(p);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => service.simulate(session, p, a.approvalId)),
      Promise.resolve().then(() => service.simulate(session, p, b.approvalId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.read(session).operations).toHaveLength(1);
  });
  it('foreign-session approval denied', () => {
    const p = payload();
    const a = approve(p);
    expect(() => service.simulate(store.create().id, p, a.approvalId)).toThrow(/No valid/);
  });
  it('blocks unresolved and evidence-gap captures', () => {
    for (const id of ['MG-1006', 'MG-1007', 'MG-1012']) {
      const p = { orderId: id, amount: '1.00', evidence: service.packet(session, id).evidence };
      expect(() => service.approve(session, p, 'APPROVE $1.00 LOCAL SIMULATION')).toThrow();
    }
  });
  it('rollback preserves approval and ledger if transaction fails', () => {
    expect(() =>
      store.transact(session, (s) => {
        s.orders[0].refunded = 123;
        throw Error('fail');
      }),
    ).toThrow();
    expect(service.packet(session, 'MG-1001').order.refunded).toBe(0);
  });
  it('permits a fresh second partial refund and rejects stale old packet', () => {
    const p = payload();
    service.simulate(session, p, approve(p).approvalId);
    const fresh = payload();
    service.simulate(session, fresh, approve(fresh).approvalId);
    expect(service.packet(session, 'MG-1001').remaining).toBe(5000);
    expect(() => approve(p)).toThrow(/Evidence changed/);
  });
  it('separate fixture sessions do not reset previous audit', () => {
    const p = payload();
    service.simulate(session, p, approve(p).approvalId);
    const second = store.create().id;
    expect(service.packet(second, 'MG-1001').order.refunded).toBe(0);
    expect(store.read(session).audit.some((e) => e.type === 'LOCAL_SIMULATION')).toBe(true);
  });
  it('sandbox adapter fails closed without a network implementation', async () => {
    await expect(
      new UnconfiguredPayPalSandbox().refund({
        captureId: 'FIXTURE',
        amountCents: 1,
        currency: 'USD',
        requestId: 'x',
      }),
    ).rejects.toThrow(/not connected/);
  });
  it('AI is explicitly unavailable and has no action tools', async () => {
    await expect(
      new UnconfiguredAI().explain({
        requestText: 'refund everything',
        facts: {},
        evidenceIds: [],
      }),
    ).rejects.toThrow(/not connected/);
    expect('refund' in new UnconfiguredAI()).toBe(false);
  });
});
