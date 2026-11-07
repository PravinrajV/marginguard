import { describe, expect, it } from 'vitest';
import { parseAmountInput } from '../src/domain/amount';
import { parseUSD } from '../src/domain/money';

describe('parseAmountInput', () => {
  it('treats blank input as quiet, not invalid', () => {
    expect(parseAmountInput('')).toEqual({ parsed: null, error: '' });
    expect(parseAmountInput('   ', 4311)).toEqual({ parsed: null, error: '' });
  });
  it('keeps errors once the user types', () => {
    expect(parseAmountInput('1.234').error).toMatch(/two decimal/);
    expect(parseAmountInput('abc').error).toMatch(/two decimal/);
    expect(parseAmountInput('0').error).toMatch(/greater than zero/);
    expect(parseAmountInput('99', 4311).error).toMatch(/exceeds/);
  });
  it('parses valid amounts', () => {
    const r = parseAmountInput('15.00', 4311);
    expect(r.error).toBe('');
    expect(r.parsed).toBe(parseUSD('15.00'));
  });
});
