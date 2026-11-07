import { describe, expect, it } from 'vitest';
import {
  cents,
  contribution,
  decimalUSD,
  formatUSD,
  parseUSD,
  sumMoney,
} from '../src/domain/money';
import { packetFor, reconcile } from '../src/domain/policy';
import { createFixtures } from '../src/server/fixtures';
describe('integer USD money', () => {
  it.each([
    ['0', 0],
    ['0.01', 1],
    ['15', 1500],
    ['15.1', 1510],
    ['80.00', 8000],
    ['99999999999.99', 9999999999999],
  ])('parses %s exactly', (input, output) => expect(parseUSD(input)).toBe(output));
  it.each([
    '-1',
    '1.001',
    'NaN',
    'Infinity',
    '1e2',
    ' 15',
    '15 ',
    '01.00',
    '.1',
    '1.',
    '100000000000.00',
    '1,000',
    '+1',
    '',
  ])('rejects invalid amount %s', (input) => expect(() => parseUSD(input)).toThrow());
  it('never accumulates floating point errors', () =>
    expect(sumMoney(Array(100).fill(parseUSD('0.01')))).toBe(100));
  it('rejects unsafe or fractional cents', () => {
    expect(() => cents(0.1)).toThrow();
    expect(() => sumMoney([Number.MAX_SAFE_INTEGER, 1])).toThrow();
  });
  it('computes the $80 / $15 decision packet', () => {
    expect(contribution(8000, 0, 289, 2800, 600)).toBe(4311);
    expect(contribution(8000, 1500, 289, 2800, 600)).toBe(2811);
    expect(contribution(8000, 8000, 289, 2800, 600)).toBe(-3689);
  });
  it('includes recoveries and prior refunds exactly once', () =>
    expect(contribution(8000, 2500, 289, 2800, 600, 500)).toBe(2311));
  it('keeps unknown fees unknown', () => expect(contribution(8000, 0, null, 2800, 600)).toBeNull());
  it('formats exact cents and negative margins', () => {
    expect(formatUSD(-3689)).toBe('−$36.89');
    expect(formatUSD(123456789)).toBe('$1,234,567.89');
    expect(decimalUSD(1)).toBe('0.01');
  });
});
describe('evidence reconciliation', () => {
  it('has exactly twelve unique fictional orders', () => {
    const orders = createFixtures().orders;
    expect(orders).toHaveLength(12);
    expect(new Set(orders.map((o) => o.id)).size).toBe(12);
    expect(orders.every((o) => o.source === 'FICTIONAL_FIXTURE')).toBe(true);
  });
  it('blocks missing fees, mismatched capture and pending status', () => {
    const orders = createFixtures().orders;
    expect(reconcile(orders[5])[0]).toMatch(/missing/);
    expect(reconcile(orders[6])[0]).toMatch(/match/);
    expect(reconcile(orders[11])[0]).toMatch(/not completed/);
  });
  it('rejects wrong net, currency and reserved balance', () => {
    const o = createFixtures().orders[0];
    expect(reconcile({ ...o, net: 1 })[0]).toMatch(/reconcile/);
    expect(reconcile({ ...o, currency: 'EUR' as 'USD' })[0]).toMatch(/USD/);
    expect(reconcile({ ...o, reserved: 1 })[0]).toMatch(/unresolved/);
  });
  it('subtracts prior refunds from available capacity', () =>
    expect(packetFor(createFixtures().orders[9]).remaining).toBe(3200));
});
