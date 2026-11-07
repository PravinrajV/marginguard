import { createHash } from 'node:crypto';
import { buildBrief } from '../domain/brief';
import { parseAmountInput } from '../domain/amount';
import { formatUSD, parseUSD } from '../domain/money';
import type { DecisionService } from './service';
import {
  MODEL,
  PROMPT_VERSION,
  type AdvisoryAdapter,
  type AdvisoryFacts,
} from '../adapters/advisory';
export type AdvisoryResult = {
  status: 'NOT_CONNECTED' | 'READY' | 'NEEDS_REVIEW' | 'CAP_EXHAUSTED';
  model: string;
  message: string;
  result?: Awaited<ReturnType<AdvisoryAdapter['packet']>>;
};
/** Process-local demo budget. Failed packets count; cache hits do not.
 * Both session and global budgets reset at midnight America/New_York.
 * Not a durable production billing control. Restart resets budget and cache.
 */
export class AdvisoryService {
  private day = '';
  private used = 0;
  private sessions = new Map<string, number>();
  private cache = new Map<string, Promise<AdvisoryResult>>();
  constructor(
    private adapter: AdvisoryAdapter,
    private decisions: DecisionService,
    private now: () => number = Date.now,
    private dailyCap = 50,
    private sessionCap = 10,
  ) {}
  get configured() {
    return this.adapter.configured;
  }
  async packet(session: string, orderId: string, amount: string) {
    const packet = this.decisions.packet(session, orderId);
    const parsed = parseAmountInput(amount, packet.remaining);
    const brief = buildBrief(packet, parsed.error ? null : parsed.parsed);
    const base = { brief };
    if (!this.configured)
      return {
        ...base,
        advisory: {
          status: 'NOT_CONNECTED',
          model: MODEL,
          message: 'Runtime AI not connected',
        } as AdvisoryResult,
      };
    if (parsed.error)
      return {
        ...base,
        advisory: {
          status: 'NEEDS_REVIEW',
          model: MODEL,
          message: 'Check the proposed amount before requesting advisory AI.',
        } as AdvisoryResult,
      };
    const money = (n: number | null) => (n === null ? 'Unknown' : formatUSD(n));
    const facts: AdvisoryFacts = {
      orderId: packet.order.id,
      product: packet.order.product,
      requestText: packet.order.request,
      suggestedAmount: packet.order.suggested
        ? money(parseUSD(packet.order.suggested))
        : 'Not specified',
      proposedAmount: money(brief.proposed),
      beforeContribution: money(brief.facts[0].value),
      afterContribution: money(brief.facts[2].value),
      remaining: money(packet.remaining),
      issues: brief.issues,
      feeTreatment: brief.feeTreatment,
    };
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.now());
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
      this.sessions.clear();
      this.cache.clear();
    }
    const hash = createHash('sha256')
      .update(JSON.stringify([MODEL, PROMPT_VERSION, packet.evidence, facts]))
      .digest('hex');
    const key = `${session}:${hash}`;
    const cached = this.cache.get(key);
    if (cached) return { ...base, advisory: await cached };
    if (this.used >= this.dailyCap || (this.sessions.get(session) ?? 0) >= this.sessionCap) {
      return {
        ...base,
        advisory: {
          status: 'CAP_EXHAUSTED',
          model: MODEL,
          message: 'Advisory limit reached. Use the deterministic brief and human review.',
        } as AdvisoryResult,
      };
    }
    this.used++;
    this.sessions.set(session, (this.sessions.get(session) ?? 0) + 1);
    const work = (async (): Promise<AdvisoryResult> => {
      try {
        return {
          status: 'READY',
          model: MODEL,
          message: 'Model advisory only. Human review required.',
          result: await this.adapter.packet(facts),
        };
      } catch {
        return {
          status: 'NEEDS_REVIEW',
          model: MODEL,
          message: 'AI output unavailable or invalid. Needs human review.',
        };
      }
    })();
    this.cache.set(key, work); // Deduplicate in-flight requests as well as completed packets.
    return { ...base, advisory: await work };
  }
}
