import { parseUSD } from './money';

export function parseAmountInput(
  raw: string,
  remaining?: number,
): { parsed: number | null; error: string } {
  if (raw.trim() === '') return { parsed: null, error: '' };
  try {
    const parsed = parseUSD(raw);
    if (parsed <= 0) return { parsed, error: 'Enter an amount greater than zero.' };
    if (remaining !== undefined && parsed > remaining)
      return { parsed, error: 'That exceeds the refundable balance.' };
    return { parsed, error: '' };
  } catch {
    return { parsed: null, error: 'Enter USD with at most two decimal places.' };
  }
}
