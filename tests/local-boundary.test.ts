import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore } from '../src/server/store';
import { DecisionService } from '../src/server/service';
import { UnconfiguredPayPalSandbox } from '../src/adapters/paypal';
import { UnconfiguredAI } from '../src/adapters/advisory';
it('the entire local flow and disconnected adapters make zero network calls', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Network forbidden in this test'));
  const store = new SQLiteStore(':memory:');
  try {
    const service = new DecisionService(store);
    const session = store.create().id;
    const payload = {
      orderId: 'MG-1001',
      amount: '15.00',
      evidence: service.packet(session, 'MG-1001').evidence,
    };
    const approval = service.approve(session, payload, 'APPROVE $15.00 LOCAL SIMULATION');
    service.simulate(session, payload, approval.approvalId);
    await expect(
      new UnconfiguredPayPalSandbox().refund({
        captureId: 'FIXTURE',
        amountCents: 1500,
        currency: 'USD',
        requestId: 'x',
      }),
    ).rejects.toThrow('not connected');
    await expect(
      new UnconfiguredAI().explain({ requestText: 'untrusted text', facts: {}, evidenceIds: [] }),
    ).rejects.toThrow('not connected');
    expect(network).not.toHaveBeenCalled();
  } finally {
    store.close();
    network.mockRestore();
  }
});
it('persists exact ledger, consumed approval and audit across SQLite reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-store-'));
  const path = join(dir, 'local.sqlite');
  let store = new SQLiteStore(path);
  try {
    let service = new DecisionService(store);
    const session = store.create().id;
    const payload = {
      orderId: 'MG-1001',
      amount: '15.00',
      evidence: service.packet(session, 'MG-1001').evidence,
    };
    const approval = service.approve(session, payload, 'APPROVE $15.00 LOCAL SIMULATION');
    const operation = service.simulate(session, payload, approval.approvalId);
    store.close();
    store = new SQLiteStore(path);
    service = new DecisionService(store);
    expect(service.packet(session, 'MG-1001').before).toBe(2811);
    expect(service.simulate(session, payload, approval.approvalId).id).toBe(operation.id);
    expect(store.read(session).operations).toHaveLength(1);
    expect(store.read(session).audit.some((event) => event.type === 'LOCAL_SIMULATION')).toBe(true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('enforces remaining balance after a prior refund, including full exhaustion', () => {
  const store = new SQLiteStore(':memory:');
  try {
    const service = new DecisionService(store);
    const session = store.create().id;
    const p = {
      orderId: 'MG-1010',
      amount: '32.01',
      evidence: service.packet(session, 'MG-1010').evidence,
    };
    expect(() => service.approve(session, p, 'APPROVE $32.01 LOCAL SIMULATION')).toThrow(/exceeds/);
    p.amount = '32.00';
    const approval = service.approve(session, p, 'APPROVE $32.00 LOCAL SIMULATION');
    service.simulate(session, p, approval.approvalId);
    expect(service.packet(session, 'MG-1010').remaining).toBe(0);
    const next = { ...p, amount: '0.01', evidence: service.packet(session, 'MG-1010').evidence };
    expect(() => service.approve(session, next, 'APPROVE $0.01 LOCAL SIMULATION')).toThrow(
      /exceeds/,
    );
  } finally {
    store.close();
  }
});
