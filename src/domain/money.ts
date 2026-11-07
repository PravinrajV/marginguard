/** All authoritative monetary values are integer USD cents. Never parseFloat. */
export function cents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Money must be safe integer cents.');
  return value;
}
export function parseUSD(value: string): number {
  if (!/^(0|[1-9]\d{0,10})(\.\d{1,2})?$/.test(value))
    throw new Error('Use a USD amount with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return cents(Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}
export function decimalUSD(value: number): string {
  cents(value);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
export function formatUSD(value: number): string {
  const raw = decimalUSD(value);
  const [whole, frac] = raw.split('.');
  return `${value < 0 ? '−' : ''}$${whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
export function sumMoney(values: number[]): number {
  return values.reduce((sum, item) => cents(cents(sum) + cents(item)), 0);
}
export function contribution(
  gross: number,
  refunded: number,
  fee: number | null,
  cogs: number,
  shipping: number,
  recoveries = 0,
): number | null {
  if (fee === null) return null;
  return sumMoney([gross, -refunded, -fee, -cogs, -shipping, recoveries]);
}
