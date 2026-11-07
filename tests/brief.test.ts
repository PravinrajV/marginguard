import { describe, expect, it } from 'vitest';
import { createFixtures } from '../src/server/fixtures';
import { packetFor } from '../src/domain/policy';
import { buildBrief } from '../src/domain/brief';
const packets = createFixtures('2026-01-01T00:00:00.000Z').orders.map(packetFor);
const get = (id: string) => packets.find((p) => p.order.id === id)!;
const fact = (b: ReturnType<typeof buildBrief>, label: string) =>
  b.facts.find((f) => f.label === label)!.value;
describe('deterministic decision brief', () => {
  it('MG-1001 $15: 4311 -> 2811, explicit $15, honest template', () => {
    const b = get('MG-1001').brief;
    expect(b.source).toBe('DETERMINISTIC_BRIEF');
    expect(b.ai).toBe('NOT_CONNECTED');
    expect(b.intent.explicitAmount).toBe(1500);
    expect(b.intent.orderRef).toBe('MG-1001');
    expect(fact(b, 'Current contribution')).toBe(4311);
    expect(fact(b, 'Contribution after')).toBe(2811);
    expect(b.replyDraft.kind).toBe('TEMPLATE');
    expect(b.replyDraft.sent).toBe(false);
    expect(b.replyDraft.text).toContain('$15.00');
    expect(b.replyDraft.text).not.toMatch(/issued|refunded|processed|sent you/i);
    expect(b.feeTreatment).toMatch(/retained/);
  });
  it('MG-1005: no guessed amount', () => {
    const b = get('MG-1005').brief;
    expect(b.intent.explicitAmount).toBeNull();
    expect(b.intent.mode).toBe('UNSPECIFIED');
    expect(b.intent.needsReview).toBe(true);
    expect(b.proposed).toBeNull();
    expect(fact(b, 'Contribution after')).toBeNull();
    expect(b.replyDraft.text).not.toMatch(/\$\d/);
  });
  it('MG-1006/1007: blockers surface, no fabricated fee or margin', () => {
    const six = get('MG-1006').brief;
    expect(six.issues.some((i) => /Fee or net evidence is missing/.test(i))).toBe(true);
    expect(fact(six, 'Current contribution')).toBeNull();
    expect(fact(six, 'Contribution after')).toBeNull();
    expect(six.feeTreatment).toMatch(/Unknown/);
    const seven = get('MG-1007').brief;
    expect(seven.issues).toEqual(get('MG-1007').issues);
    expect(seven.issues.some((i) => /Capture gross/.test(i))).toBe(true);
    for (const b of [six, seven]) {
      expect(b.intent.needsReview).toBe(true);
      expect(b.replyDraft.text).not.toMatch(/\$\d/);
    }
  });
  it('changing the proposed amount changes after-contribution and template', () => {
    const b = buildBrief(get('MG-1001'), 2000);
    expect(fact(b, 'Contribution after')).toBe(2311);
    expect(b.replyDraft.text).toContain('$20.00');
    expect(b.replyDraft.text).not.toContain('$15.00');
  });
  it('MG-1001 with empty amount after simulation: awaiting amount, not review', () => {
    const b = buildBrief(get('MG-1001'), null);
    expect(b.intent.needsReview).toBe(false);
    expect(b.intent.awaitingAmount).toBe(true);
    expect(b.replyDraft.kind).toBe('TEMPLATE');
    expect(b.replyDraft.sent).toBe(false);
    expect(b.replyDraft.text).toMatch(/Enter an amount/);
    expect(b.replyDraft.text).not.toMatch(/feel fair/i);
    expect(b.replyDraft.text).not.toMatch(/\$\d/);
    expect(b.replyDraft.text).not.toMatch(/issued|refunded|processed|sent you/i);
  });
  it('MG-1005 with empty amount still needs review and does not guess', () => {
    const b = buildBrief(get('MG-1005'), null);
    expect(b.intent.needsReview).toBe(true);
    expect(b.replyDraft.text).toMatch(/feel fair/);
    expect(b.replyDraft.text).not.toMatch(/\$\d/);
  });
});
