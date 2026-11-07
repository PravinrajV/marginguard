import { afterEach, expect, it, vi } from 'vitest';
import {
  createAdvisory,
  MODEL,
  WorkersAI,
  type AdvisoryFacts,
  safeProse,
} from '../src/adapters/advisory';
import { AdvisoryService } from '../src/server/advisory';
import { DecisionService } from '../src/server/service';
import { SQLiteStore } from '../src/server/store';
import { createApp } from '../src/server/app';
const facts: AdvisoryFacts = {
  orderId: 'MG-1001',
  product: 'Mug',
  requestText: 'Chipped mug. Please refund $15 for MG-1001.',
  suggestedAmount: '$15.00',
  proposedAmount: '$15.00',
  beforeContribution: '$43.11',
  afterContribution: '$28.11',
  remaining: '$80.00',
  issues: [],
  feeTreatment: 'Original fee retained.',
};
const extraction = {
  explicitAmount: '15',
  reason: 'Chipped mug.',
  orderReference: 'MG-1001',
  missingInfo: [],
};
const explanation = {
  summary: 'The request describes damaged goods.',
  caveats: ['Fee retention is assumed.'],
  questions: ['Can you confirm the damage?'],
  unsentReply:
    'Thanks for flagging this. We can review a goodwill option, subject to confirmation.',
};
const response = (value: unknown) =>
  new Response(JSON.stringify({ success: true, result: { response: JSON.stringify(value) } }));
function network() {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return response(body.messages[0].content.includes('Extract only') ? extraction : explanation);
  });
}
const credentials = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_API_TOKEN: 'test-token-not-a-secret',
};
afterEach(() => vi.restoreAllMocks());
it.each([
  {},
  { CLOUDFLARE_ACCOUNT_ID: 'account' },
  { CLOUDFLARE_API_TOKEN: 'token' },
  { CLOUDFLARE_ACCOUNT_ID: ' ', CLOUDFLARE_API_TOKEN: 'token' },
])('missing credentials fail closed with zero calls: %j', async (env) => {
  const fetch = network();
  const adapter = createAdvisory(env, fetch);
  expect(adapter.configured).toBe(false);
  await expect(adapter.packet(facts)).rejects.toThrow('Runtime AI is not connected');
  expect(fetch).not.toHaveBeenCalled();
});
it('uses official REST URL, bearer auth and documented inputs only, without logging tokens', async () => {
  const fetch = network();
  const logs = vi.spyOn(console, 'log');
  const errors = vi.spyOn(console, 'error');
  const output = await createAdvisory(credentials, fetch).packet(facts);
  expect(output.explanation.summary).toBe(explanation.summary);
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/${MODEL}`);
  expect(init!.method).toBe('POST');
  expect(init!.headers).toEqual({
    Authorization: 'Bearer test-token-not-a-secret',
    'Content-Type': 'application/json',
  });
  expect(Object.keys(JSON.parse(init!.body as string)).sort()).toEqual([
    'max_tokens',
    'messages',
    'response_format',
    'temperature',
  ]);
  expect(JSON.parse(init!.body as string).response_format).toEqual({ type: 'json_object' });
  expect(JSON.stringify(output)).not.toContain('test-token');
  expect(logs).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});
it('accepts classic result.response and OpenAI-style choices envelopes, including fenced JSON', async () => {
  const openai = (value: unknown) =>
    new Response(
      JSON.stringify({
        success: true,
        result: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '```json\n' + JSON.stringify(value) + '\n```',
              },
            },
          ],
        },
      }),
    );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(openai(extraction))
    .mockResolvedValueOnce(openai(explanation));
  const output = await createAdvisory(credentials, fetch).packet(facts);
  expect(output.explanation.summary).toBe(explanation.summary);
  expect(output.extraction.explicitAmount).toBe('15');
});
it('isolates untrusted request as user data and sends no capture, payer, token or raw payload facts', async () => {
  const fetch = network();
  await createAdvisory(credentials, fetch).packet(facts);
  const first = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(JSON.parse(first.messages[1].content)).toEqual({ requestText: facts.requestText });
  expect(first.messages[0].content).toContain('untrusted evidence');
  expect(first.messages[0].content).toContain('small shop');
  expect(first.messages[0].content).toContain('contractions');
  const second = JSON.parse(fetch.mock.calls[1][1]!.body as string);
  expect(JSON.parse(second.messages[1].content)).toEqual(facts);
  expect(second.messages[0].content).toContain('nothing has gone through yet');
  expect(second.messages[0].content).toContain('contact support');
  expect(second.messages[0].content).toContain('Never copy amounts or order identifiers');
  expect(second.messages[0].content).toContain('JSON arrays of strings');
  expect(fetch.mock.calls.map((call) => call[1]!.body).join('')).not.toMatch(
    /test-token|captureId|payer/,
  );
});
it('rejects unexpected input facts before fetching', async () => {
  const fetch = network();
  await expect(
    createAdvisory(credentials, fetch).packet({ ...facts, payer: 'private' } as AdvisoryFacts),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('strips unsupported numeric sentences, even matching money and action claims, from prose', async () => {
  const fetch = network()
    .mockResolvedValueOnce(response(extraction))
    .mockResolvedValueOnce(
      response({
        ...explanation,
        summary: 'The request describes damage. Contribution is $999.00.',
        caveats: ['Keep $28.11.', 'Sixteen dollars are retained.', 'Fee evidence is assumed.'],
        unsentReply: 'Thanks for flagging this. We issued the refund.',
      }),
    );
  const result = await createAdvisory(credentials, fetch).packet(facts);
  expect(result.explanation.summary).toBe('The request describes damage.');
  expect(result.explanation.caveats).toEqual(['Fee evidence is assumed.']);
  expect(result.explanation.unsentReply).toBe('Thanks for flagging this.');
  expect(safeProse('We retain half.')).toBe('');
});
it('repairs malformed schema at most once for the whole packet', async () => {
  const fetch = network()
    .mockResolvedValueOnce(response({ bad: 'field' }))
    .mockResolvedValueOnce(response(extraction))
    .mockResolvedValueOnce(response(explanation));
  await createAdvisory(credentials, fetch).packet(facts);
  expect(fetch).toHaveBeenCalledTimes(3);
  const broken = network().mockResolvedValue(response({ bad: 'field' }));
  await expect(createAdvisory(credentials, broken).packet(facts)).rejects.toThrow(
    'Needs human review',
  );
  expect(broken).toHaveBeenCalledTimes(2);
});
it('never retries HTTP or transport errors and never returns raw errors', async () => {
  const fetch = network().mockRejectedValue(new Error('test-token-not-a-secret'));
  await expect(createAdvisory(credentials, fetch).packet(facts)).rejects.toThrow(
    'AI output unavailable or invalid. Needs human review.',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear().mockResolvedValue(new Response('upstream', { status: 429 }));
  await expect(createAdvisory(credentials, fetch).packet(facts)).rejects.toThrow(
    'Needs human review',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('aborts slow inference without retries', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
  await expect(new WorkersAI('account', 'token', fetch, 5).packet(facts)).rejects.toThrow(
    'Needs human review',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects hallucinated extraction amounts and references without granting financial authority', async () => {
  const fetch = network().mockResolvedValue(response({ ...extraction, explicitAmount: '999' }));
  await expect(createAdvisory(credentials, fetch).packet(facts)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('retries when number-bearing model prose is emptied, then accepts a number-free rewrite', async () => {
  const fetch = network()
    .mockResolvedValueOnce(response(extraction))
    .mockResolvedValueOnce(
      response({
        ...explanation,
        summary: 'Customer reports a chipped mug on MG-1001 and asks for $15.',
        unsentReply: 'We can review this request. No refund of $15 has been issued.',
      }),
    )
    .mockResolvedValueOnce(response(explanation));
  const output = await createAdvisory(credentials, fetch).packet(facts);
  expect(output.explanation.summary).toBe(explanation.summary);
  expect(output.explanation.unsentReply).toBe(explanation.unsentReply);
  expect(fetch).toHaveBeenCalledTimes(3);
  const retry = JSON.parse(fetch.mock.calls[2][1]!.body as string);
  expect(retry.messages[0].content).toContain('no digits');
});
it('keeps a human summary after removing copied amounts and order ids', async () => {
  const fetch = network()
    .mockResolvedValueOnce(response(extraction))
    .mockResolvedValueOnce(
      response({
        ...explanation,
        summary:
          'The customer says the mug arrived chipped and wants a refund of $15 from order MG-1001.',
      }),
    );
  const output = await createAdvisory(credentials, fetch).packet(facts);
  expect(output.explanation.summary).toBe(
    'The customer says the mug arrived chipped and wants a refund.',
  );
});
it('rejects a broken remnant instead of showing "wants taken off order"', async () => {
  const fetch = network()
    .mockResolvedValueOnce(response(extraction))
    .mockResolvedValueOnce(
      response({
        ...explanation,
        summary:
          'The customer says the mug they got is chipped and wants $15 taken off order MG-1001.',
      }),
    )
    .mockResolvedValueOnce(
      response({
        ...explanation,
        summary:
          'The customer says the mug arrived chipped and wants a refund of $15 from order MG-1001.',
      }),
    );
  const output = await createAdvisory(credentials, fetch).packet(facts);
  expect(output.explanation.summary).toBe(
    'The customer says the mug arrived chipped and wants a refund.',
  );
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('normalizes caveats and questions when the model returns them as one string', async () => {
  const fetch = network()
    .mockResolvedValueOnce(response(extraction))
    .mockResolvedValueOnce(
      response({
        ...explanation,
        caveats: 'Fee evidence is assumed. Photos would help.',
        questions: 'Does the chip look like shipping damage? Would a replacement be better?',
      }),
    );
  const output = await createAdvisory(credentials, fetch).packet(facts);
  expect(output.explanation.caveats).toEqual(['Fee evidence is assumed.', 'Photos would help.']);
  expect(output.explanation.questions).toEqual([
    'Does the chip look like shipping damage?',
    'Would a replacement be better?',
  ]);
});
it('accepts an extracted amount with trailing zeros when the request only states the shorter figure', async () => {
  const fetch = network().mockResolvedValueOnce(
    response({ ...extraction, explicitAmount: '15.00' }),
  );
  const output = await createAdvisory(credentials, fetch).packet(facts);
  expect(output.extraction.explicitAmount).toBe('15.00');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('caches successful, concurrent and failed packets per session and invalidates on evidence or proposal changes', async () => {
  const store = new SQLiteStore(':memory:');
  try {
    const fetch = network();
    const decisions = new DecisionService(store);
    const session = store.create().id;
    const service = new AdvisoryService(createAdvisory(credentials, fetch), decisions);
    const [a, b] = await Promise.all([
      service.packet(session, 'MG-1001', '15.00'),
      service.packet(session, 'MG-1001', '15.00'),
    ]);
    expect(a.advisory.status).toBe('READY');
    expect(b).toEqual(a);
    expect(fetch).toHaveBeenCalledTimes(2);
    await service.packet(session, 'MG-1001', '15.00');
    expect(fetch).toHaveBeenCalledTimes(2);
    await service.packet(session, 'MG-1001', '16.00');
    expect(fetch).toHaveBeenCalledTimes(4);
    const packet = decisions.packet(session, 'MG-1001');
    const payload = { orderId: 'MG-1001', amount: '15.00', evidence: packet.evidence };
    const approval = decisions.approve(session, payload, 'APPROVE $15.00 LOCAL SIMULATION');
    decisions.simulate(session, payload, approval.approvalId);
    await service.packet(session, 'MG-1001', '15.00');
    expect(fetch).toHaveBeenCalledTimes(6);
    const bad = network().mockResolvedValue(response({ nope: true }));
    const failed = new AdvisoryService(createAdvisory(credentials, bad), decisions);
    expect((await failed.packet(session, 'MG-1001', '15.00')).advisory.status).toBe('NEEDS_REVIEW');
    await failed.packet(session, 'MG-1001', '15.00');
    expect(bad).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
  }
});
it('enforces session and global daily caps before calling inference and resets next day', async () => {
  const store = new SQLiteStore(':memory:');
  try {
    let now = Date.parse('2026-11-06T12:00:00-05:00');
    const fetch = network();
    const decisions = new DecisionService(store);
    const a = store.create().id;
    const b = store.create().id;
    const service = new AdvisoryService(
      createAdvisory(credentials, fetch),
      decisions,
      () => now,
      2,
      1,
    );
    await service.packet(a, 'MG-1001', '15.00');
    expect((await service.packet(a, 'MG-1001', '16.00')).advisory.status).toBe('CAP_EXHAUSTED');
    await service.packet(b, 'MG-1001', '15.00');
    expect((await service.packet(store.create().id, 'MG-1001', '15.00')).advisory.status).toBe(
      'CAP_EXHAUSTED',
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    now += 86400000;
    await service.packet(a, 'MG-1001', '16.00');
    expect(fetch).toHaveBeenCalledTimes(6);
  } finally {
    store.close();
  }
});
it('API returns server-computed brief alongside validated AI, not tokens; unconfigured status stays honest', async () => {
  const store = new SQLiteStore(':memory:');
  const fetch = network();
  try {
    for (const configured of [true, false]) {
      const app = createApp(store, createAdvisory(configured ? credentials : {}, fetch));
      const session = await app.request('http://localhost:8787/api/session');
      const cookie = session.headers.get('set-cookie')!.split(';')[0];
      const meta = await session.json();
      expect(meta.ai).toBe(configured ? 'CONFIGURED' : 'NOT_CONNECTED');
      const result = await app.request('http://localhost:8787/api/advisory', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'http://localhost:8787',
          'X-CSRF-Token': meta.csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ orderId: 'MG-1001', amount: '15.00' }),
      });
      const body = await result.json();
      expect(body.brief.facts[2].value).toBe(2811);
      expect(body.advisory.status).toBe(configured ? 'READY' : 'NOT_CONNECTED');
      expect(JSON.stringify(body)).not.toContain('test-token');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
  }
});

it('withholds numeric-only model text instead of filling a template or showing unsupported claims', async () => {
  const store = new SQLiteStore(':memory:');
  try {
    const numeric = response({
      ...explanation,
      summary: 'Keep $999.00.',
      unsentReply: 'Refund is $999.00.',
    });
    const fetch = network()
      .mockResolvedValueOnce(response(extraction))
      .mockResolvedValueOnce(numeric)
      .mockResolvedValueOnce(numeric);
    const service = new AdvisoryService(
      createAdvisory(credentials, fetch),
      new DecisionService(store),
    );
    const output = await service.packet(store.create().id, 'MG-1001', '15.00');
    expect(output.advisory.status).toBe('NEEDS_REVIEW');
    expect(output.advisory.result).toBeUndefined();
    expect(output.brief.replyDraft.kind).toBe('TEMPLATE');
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    store.close();
  }
});
it('shares the single repair budget across extraction and explanation, with no retry storm', async () => {
  const fetch = network()
    .mockResolvedValueOnce(response({ bad: true }))
    .mockResolvedValueOnce(response(extraction))
    .mockResolvedValueOnce(response({ bad: true }));
  await expect(createAdvisory(credentials, fetch).packet(facts)).rejects.toThrow(
    'Needs human review',
  );
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('rejects a bounded-response overflow without retrying', async () => {
  const fetch = network().mockResolvedValue(new Response('x'.repeat(32769)));
  await expect(createAdvisory(credentials, fetch).packet(facts)).rejects.toThrow(
    'Needs human review',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
