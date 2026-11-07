import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { contribution, decimalUSD, formatUSD, sumMoney } from '../domain/money';
import type { AuditEvent, Operation, Packet, RefundPayload } from '../domain/types';
import { buildBrief, type DecisionBrief } from '../domain/brief';
import type { AdvisoryResult } from '../server/advisory';
import { parseAmountInput } from '../domain/amount';
import './style.css';
const money = (value: number | null) => (value === null ? 'Unknown' : formatUSD(value));
type View = 'decisions' | 'audit';
function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`mark ${small ? 'small' : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function App() {
  const [csrf, setCsrf] = useState('');
  const [aiConfigured, setAiConfigured] = useState(false);
  const [paypalConfigured, setPaypalConfigured] = useState(false);
  const [publicDemo, setPublicDemo] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPacket, setAiPacket] = useState<{
    key: string;
    brief: DecisionBrief;
    advisory: AdvisoryResult;
  } | null>(null);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [selected, setSelected] = useState('MG-1001');
  const [amount, setAmount] = useState('15.00');
  const [view, setView] = useState<View>('decisions');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState(false);
  const [receipt, setReceipt] = useState<Operation | null>(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resetRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = packets.find((packet) => packet.order.id === selected);
  const sandboxCapture = Boolean(current && !current.order.captureId.startsWith('FIXTURE-CAP-'));
  const sandboxSaleCount = packets.filter(
    (packet) => !packet.order.captureId.startsWith('FIXTURE-CAP-'),
  ).length;
  async function api<T>(path: string, data?: unknown): Promise<T> {
    const response = await fetch(`/api/${path}`, {
      credentials: 'same-origin',
      method: data === undefined ? 'GET' : 'POST',
      headers:
        data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The local workspace could not respond.');
    return result as T;
  }
  async function refresh() {
    const result = await api<{ packets: Packet[]; audit: AuditEvent[] }>('orders');
    setPackets(result.packets);
    setAudit(result.audit);
    return result;
  }
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const session = await api<{ csrf: string; ai: string; paypal: string; mode: string }>(
          'session',
        );
        if (!active) return;
        setCsrf(session.csrf);
        setAiConfigured(session.ai === 'CONFIGURED');
        setPaypalConfigured(session.paypal === 'CONFIGURED');
        setPublicDemo(session.mode === 'PUBLIC_FIXTURE_DEMO');
        const result = await api<{ packets: Packet[]; audit: AuditEvent[] }>('orders');
        if (active) {
          setPackets(result.packets);
          setAudit(result.audit);
          const first = result.packets.find((packet) => packet.order.id === 'MG-1001');
          setAmount(
            first?.order.source === 'PAYPAL_SANDBOX' && first.order.refunded > 0
              ? ''
              : (first?.order.suggested ?? ''),
          );
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (confirm) {
      dialogRef.current?.showModal();
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
      triggerRef.current?.focus();
    }
  }, [confirm]);
  useEffect(() => {
    if (resetConfirm) resetRef.current?.showModal();
    else resetRef.current?.close();
  }, [resetConfirm]);
  const { parsed, error: amountError } = parseAmountInput(amount, current?.remaining);
  const after =
    current && parsed !== null
      ? contribution(
          current.order.gross,
          current.order.refunded + parsed,
          current.order.fee,
          current.order.cogs,
          current.order.shipping,
        )
      : null;
  const before = current?.before ?? null;
  const brief = current ? buildBrief(current, amountError ? null : parsed) : null;
  const advisoryKey = JSON.stringify([csrf, selected, amount, current?.evidence]);
  const visibleAI = aiPacket?.key === advisoryKey ? aiPacket : null;
  async function requestAdvisory() {
    if (!current || aiBusy) return;
    const key = advisoryKey;
    setAiBusy(true);
    try {
      const result = await api<{ brief: DecisionBrief; advisory: AdvisoryResult }>('advisory', {
        orderId: current.order.id,
        amount,
      });
      setAiPacket({ key, ...result });
    } catch {
      setAiPacket({
        key,
        brief: buildBrief(current, null),
        advisory: {
          status: 'NEEDS_REVIEW',
          model: '@cf/ibm-granite/granite-4.0-h-micro',
          message: 'Advisory unavailable. Needs human review.',
        },
      });
    } finally {
      setAiBusy(false);
    }
  }
  const [receiptBefore, setReceiptBefore] = useState<number | null>(null);
  const issues = packets.filter((packet) => packet.issues.length > 0).length;
  const known = packets.filter((packet) => packet.before !== null && packet.issues.length === 0);
  const totalMargin = sumMoney(known.map((packet) => packet.before!));
  const gross = sumMoney(packets.map((packet) => packet.order.gross));
  const visible = packets.filter(
    (packet) =>
      (filter !== 'blocked' || packet.issues.length > 0) &&
      `${packet.order.id} ${packet.order.product}`.toLowerCase().includes(search.toLowerCase()),
  );
  function select(packet: Packet) {
    setSelected(packet.order.id);
    setAmount(
      packet.order.source === 'PAYPAL_SANDBOX' && packet.order.refunded > 0
        ? ''
        : packet.order.suggested,
    );
    setReceipt(null);
    setError('');
    setChecked(false);
  }
  async function simulate() {
    if (!current || parsed === null || !checked || busy) return;
    setBusy(true);
    setError('');
    const payload: RefundPayload = {
      orderId: current.order.id,
      amount: decimalUSD(parsed),
      evidence: current.evidence,
    };
    try {
      const approval = await api<{ approvalId: string }>('approvals', {
        payload,
        confirmation: `APPROVE ${formatUSD(parsed)} ${
          sandboxCapture ? 'PAYPAL SANDBOX REFUND' : 'LOCAL SIMULATION'
        }`,
      });
      const result = await api<Operation>('simulations', {
        payload,
        approvalId: approval.approvalId,
      });
      setReceiptBefore(before);
      setReceipt(result);
      setAmount('');
      setConfirm(false);
      setChecked(false);
      await refresh();
    } catch (e) {
      setConfirm(false);
      setError((e as Error).message);
      try {
        await refresh();
      } catch {
        /* retain the original request error */
      }
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      const result = await api<{ csrf: string }>('reset', {});
      setCsrf(result.csrf);
      const next = await refresh();
      setSelected('MG-1001');
      const first = next.packets.find((packet) => packet.order.id === 'MG-1001');
      setAmount(
        first?.order.source === 'PAYPAL_SANDBOX' && first.order.refunded > 0
          ? ''
          : (first?.order.suggested ?? ''),
      );
      setReceipt(null);
      setError('');
      setResetConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shell">
      <aside className="rail">
        <a href="#main" className="rail-logo" aria-label="MarginGuard home">
          <Mark />
        </a>
        <div className="rail-rule" />
        <button
          className={view === 'decisions' ? 'rail-button active' : 'rail-button'}
          onClick={() => setView('decisions')}
          title="Decision workspace"
          aria-label="Decision workspace"
          aria-pressed={view === 'decisions'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" />
          </svg>
        </button>
        <button
          className={view === 'audit' ? 'rail-button active' : 'rail-button'}
          onClick={() => setView('audit')}
          title="Activity ledger"
          aria-label="Activity ledger"
          aria-pressed={view === 'audit'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4" />
          </svg>
        </button>
        <div className="rail-bottom">
          <span className="vertical">CONTROL · NOT AUTOPILOT</span>
          <span className="avatar" title="Local fictional workspace">
            KF
          </span>
        </div>
      </aside>
      <div className="workspace">
        <div className="sandbox">
          <span className="pulse" />
          Sandbox only <span className="banner-divider">/</span> Fictional merchant{' '}
          <span className="banner-divider">/</span> No real money{' '}
          <span className="local-badge">
            {publicDemo ? 'PUBLIC FIXTURE DEMO' : 'LOCAL FIXTURES'} ·{' '}
            {paypalConfigured ? 'PAYPAL SANDBOX CONNECTED' : 'NO PAYPAL CONNECTION'}
          </span>
        </div>
        <header className="topbar">
          <a href="#main" className="wordmark">
            MARGIN<span>GUARD</span>
            <sup> / 01</sup>
          </a>
          <div className="merchant">
            <span className="merchant-icon">K/F</span>
            <div>
              Kiln & Field <small>FICTIONAL MERCHANT · USD</small>
            </div>
          </div>
          <button className="quiet" onClick={() => setResetConfirm(true)} disabled={busy}>
            New local session <span aria-hidden="true">↗</span>
          </button>
        </header>
        <main id="main">
          <section className="hero">
            <div>
              <p className="eyebrow">
                MERCHANT OPERATIONS / {view === 'audit' ? 'TRACEABILITY' : 'DECISION CONTROL'}
              </p>
              <h1>
                {view === 'audit' ? (
                  'Every decision leaves a trail.'
                ) : (
                  <>
                    Goodwill has a cost.
                    <br />
                    <span>Know yours.</span>
                  </>
                )}
              </h1>
              <p className="hero-copy">Understand the margin before approving the refund.</p>
            </div>
            <div className="system-note">
              <span className="status-dot" /> Human in command
              <p>
                Deterministic math. Exact approval.
                <br />
                AI has no authority to move money.
              </p>
            </div>
          </section>
          {error && (
            <div className="error" role="alert">
              <strong>Review required.</strong> {error}
              <button onClick={() => setError('')} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading" role="status">
              Opening your fictional merchant ledger…
            </div>
          ) : (
            <>
              <section className="metrics" aria-label="Fictional merchant overview">
                <article>
                  <p>
                    ORDER GROSS{' '}
                    <span>
                      {sandboxSaleCount
                        ? `${packets.length - sandboxSaleCount} FIXTURES + ${sandboxSaleCount} SANDBOX`
                        : '12 FIXTURES'}
                    </span>
                  </p>
                  <strong>{money(gross)}</strong>
                  <small>Fictional order totals · not payment evidence</small>
                </article>
                <article>
                  <p>
                    KNOWN CONTRIBUTION <span>{known.length} RECONCILED</span>
                  </p>
                  <strong>{money(totalMargin)}</strong>
                  <small>Excludes blocked orders · before new refund</small>
                </article>
                <button
                  className="metric-alert"
                  onClick={() => {
                    setView('decisions');
                    setFilter(filter === 'blocked' ? '' : 'blocked');
                  }}
                >
                  <p>
                    NEEDS REVIEW <span aria-hidden="true">↗</span>
                  </p>
                  <strong>
                    {String(issues).padStart(2, '0')}
                    <em> orders</em>
                  </strong>
                  <small>Evidence gaps are not permission to guess</small>
                </button>
              </section>
              {view === 'audit' ? (
                <section className="audit-page">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">LOCAL ACTIVITY</p>
                      <h2>The decision ledger</h2>
                    </div>
                    <span className="chip">Application audit · not tamper-proof</span>
                  </div>
                  <p>
                    {paypalConfigured
                      ? 'PayPal Sandbox connected. Fixture orders stay local; live captures refund in sandbox.'
                      : 'Local approvals and simulations only. No PayPal transaction receipts.'}
                  </p>
                  <div className="audit-list">
                    {audit.map((event) => (
                      <article key={event.id}>
                        <span className="audit-dot" />
                        <div>
                          <strong>{event.type.replaceAll('_', ' ')}</strong>
                          <p>{event.detail}</p>
                          <small>
                            {event.orderId} /{' '}
                            {new Date(event.at).toLocaleString('en-US', {
                              timeZone: 'America/New_York',
                            })}{' '}
                            ET
                          </small>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : (
                <section className="workbench">
                  <aside className="order-panel">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">THE REVIEW QUEUE</p>
                        <h2>
                          Orders <span>{visible.length}</span>
                        </h2>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => setFilter(filter === 'blocked' ? '' : 'blocked')}
                      >
                        {filter === 'blocked' ? 'Show all' : 'Flagged only'}
                      </button>
                    </div>
                    <label className="search">
                      <span aria-hidden="true">⌕</span>
                      <input
                        aria-label="Search orders"
                        placeholder="Find an order or product"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                    <div className="order-list">
                      {visible.length === 0 ? (
                        <p className="empty">
                          No matching orders. Try an order number or product name.
                        </p>
                      ) : (
                        visible.map((packet) => (
                          <button
                            key={packet.order.id}
                            onClick={() => select(packet)}
                            className={`order-row ${selected === packet.order.id ? 'selected' : ''}`}
                            aria-pressed={selected === packet.order.id}
                          >
                            <span className="order-line">
                              <strong>{packet.order.id}</strong>
                              <span>{money(packet.order.gross)}</span>
                            </span>
                            <span className="product">{packet.order.product}</span>
                            <span className="order-meta">
                              <span className={packet.issues.length ? 'flag' : 'ready'}>
                                {packet.issues.length ? 'Review blocked' : 'Ready to review'}
                              </span>
                              <span aria-hidden="true">↗</span>
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    <div className="queue-footer">
                      <span className="status-dot" />{' '}
                      {sandboxSaleCount
                        ? 'MG-1001 carries a PayPal Sandbox capture; other orders are fixtures'
                        : 'No live payment data in this workspace'}
                    </div>
                  </aside>
                  {current && (
                    <article className="packet" aria-label="Refund decision packet">
                      <header className="packet-header">
                        <div>
                          <p className="eyebrow">REFUND DECISION PACKET</p>
                          <h2>
                            {current.order.id}
                            <span> / {current.order.product}</span>
                          </h2>
                        </div>
                        <span className={`chip ${current.issues.length ? 'warn' : ''}`}>
                          {current.issues.length
                            ? 'Evidence blocked'
                            : sandboxCapture
                              ? 'Sandbox reconciled'
                              : 'Fixture reconciled'}
                        </span>
                      </header>
                      <section className="request">
                        <span className="quote-mark" aria-hidden="true">
                          “
                        </span>
                        <div>
                          <p className="eyebrow">FICTIONAL CUSTOMER REQUEST</p>
                          <blockquote>{current.order.request}</blockquote>
                          <div className="request-foot">
                            <span>{current.order.reason}</span>
                            <span>
                              {aiConfigured
                                ? 'Fictional sample text · advisory available'
                                : 'No runtime AI · sample text only'}
                            </span>
                          </div>
                        </div>
                      </section>
                      {current.issues.length > 0 && (
                        <div className="blocked" role="status">
                          <strong>Resolve the evidence. Then decide.</strong>
                          {current.issues.map((issue) => (
                            <p key={issue}>{issue}</p>
                          ))}
                        </div>
                      )}
                      {receipt && receipt.orderId === current.order.id && (
                        <div className="receipt" role="status">
                          <div className="receipt-head">
                            <span className="receipt-tag">
                              {receipt.source === 'PAYPAL_SANDBOX'
                                ? 'PAYPAL SANDBOX REFUND · NO LIVE MONEY'
                                : 'LOCAL LEDGER ONLY · NOT A PAYPAL RECEIPT'}
                            </span>
                            <code>{receipt.id}</code>
                          </div>
                          <div className="receipt-grid">
                            <div>
                              <small>
                                {receipt.source === 'PAYPAL_SANDBOX'
                                  ? 'Sandbox refund'
                                  : 'Simulated refund'}
                              </small>
                              <strong>{money(receipt.amount)}</strong>
                            </div>
                            <div>
                              <small>Contribution before</small>
                              <span className="was">{money(receiptBefore)}</span>
                            </div>
                            <div>
                              <small>Contribution now</small>
                              <span className="now">{money(current.before)}</span>
                            </div>
                          </div>
                          <p>
                            {receipt.source === 'PAYPAL_SANDBOX'
                              ? `PayPal Sandbox refund recorded for ${receipt.orderId}. No live money moved.`
                              : `Fictional ledger updated for ${receipt.orderId}. No PayPal refund was made and no money moved.`}
                          </p>
                        </div>
                      )}
                      <section className="margin-section">
                        <div className="section-heading">
                          <div>
                            <p className="eyebrow">THE TRADE-OFF</p>
                            <h3>Keep the customer. See the cost.</h3>
                          </div>
                          <span className="currency">USD</span>
                        </div>
                        <div className="margin-bridge">
                          <div>
                            <p>CURRENT CONTRIBUTION</p>
                            <strong>{money(before)}</strong>
                            <small>After existing refunds & original costs</small>
                          </div>
                          <div className="bridge-arrow" aria-hidden="true">
                            <span className="delta">
                              {before !== null && after !== null && !amountError
                                ? `−${money(before - after)}`
                                : 'Not set'}
                            </span>
                            <span className="delta-pct">
                              {before !== null && before > 0 && after !== null && !amountError
                                ? `−${Math.trunc(((before - after) * 100) / before)}% margin`
                                : 'margin'}
                            </span>
                            <i />
                          </div>
                          <div className={after !== null && after < 0 ? 'after negative' : 'after'}>
                            <p>AFTER PROPOSED REFUND</p>
                            <strong>{amountError ? 'Not set' : money(after)}</strong>
                            <small>
                              {amountError
                                ? 'Check the amount below'
                                : after !== null && after < 0
                                  ? 'This scenario takes the order below zero.'
                                  : 'Estimated · assumes original fee retained'}
                            </small>
                          </div>
                        </div>
                        <progress
                          className="margin-track"
                          aria-label="Proposed contribution retained"
                          max={100}
                          value={
                            before !== null && before > 0 && after !== null
                              ? Math.max(0, Math.min(100, Math.trunc((after * 100) / before)))
                              : 0
                          }
                        />
                        <div className="scenario-input">
                          <label htmlFor="refund">
                            Proposed refund <small>Maximum {money(current.remaining)}</small>
                          </label>
                          <div className="money-input">
                            <span>$</span>
                            <input
                              id="refund"
                              inputMode="decimal"
                              value={amount}
                              aria-invalid={!!amountError}
                              aria-describedby="amount-help"
                              onChange={(e) => {
                                setAmount(e.target.value);
                                setReceipt(null);
                              }}
                            />
                            <span>USD</span>
                          </div>
                          <button
                            className="text-button"
                            onClick={() => {
                              setAmount(decimalUSD(current.remaining));
                              setReceipt(null);
                            }}
                          >
                            Use full balance
                          </button>
                        </div>
                        <p id="amount-help" className={amountError ? 'field-error' : 'amount-help'}>
                          {amountError ||
                            'Exact cents. No automatic approval. Every edit requires a fresh confirmation.'}
                        </p>
                        <div className="scenario-compare">
                          <span>
                            Full-balance alternative <strong>{money(current.remaining)}</strong>
                          </span>
                          <span>
                            Contribution after{' '}
                            <strong
                              className={
                                current.fullAfter !== null && current.fullAfter < 0 ? 'loss' : ''
                              }
                            >
                              {money(current.fullAfter)}
                            </strong>
                          </span>
                        </div>
                      </section>
                      <details className="evidence" open>
                        <summary>
                          Evidence & cost assumptions{' '}
                          <span>
                            {sandboxCapture ? 'SANDBOX' : 'FIXTURE'} / V{current.order.version}
                          </span>
                        </summary>
                        <div className="evidence-grid">
                          <div>
                            <span>Captured gross</span>
                            <strong>{money(current.order.captureGross)}</strong>
                          </div>
                          <div>
                            <span>
                              Processing fee{' '}
                              <small>{sandboxCapture ? 'sandbox' : 'fictional'}</small>
                            </span>
                            <strong>{money(current.order.fee)}</strong>
                          </div>
                          <div>
                            <span>
                              Original goods cost <small>assumed</small>
                            </span>
                            <strong>{money(current.order.cogs)}</strong>
                          </div>
                          <div>
                            <span>
                              Shipping <small>assumed</small>
                            </span>
                            <strong>{money(current.order.shipping)}</strong>
                          </div>
                          <div>
                            <span>
                              {sandboxCapture
                                ? 'Recorded sandbox refunds'
                                : 'Existing simulated refunds'}
                            </span>
                            <strong>{money(current.order.refunded)}</strong>
                          </div>
                          <div>
                            <span>
                              Recoveries <small>none assumed</small>
                            </span>
                            <strong>$0.00</strong>
                          </div>
                        </div>
                        <p className="source">
                          <code>{current.order.captureId}</code> · {current.order.status} ·{' '}
                          {sandboxCapture
                            ? 'PayPal Sandbox capture · attached snapshot'
                            : 'Fictional fixture, not a PayPal ID'}
                        </p>
                        <p className="assumption">
                          Contribution ≠ net profit. Original goods and shipping costs are sunk. Fee
                          retention is a scenario assumption, not verified PayPal behavior. Tax
                          excluded.
                        </p>
                      </details>
                      {brief && (
                        <section className="brief" aria-label="Decision brief">
                          <div className="section-heading">
                            <div>
                              <p className="eyebrow">DECISION BRIEF</p>
                              <h3>Here is what the facts say.</h3>
                            </div>
                            <span className="brief-badge">
                              Deterministic math ·{' '}
                              {aiConfigured ? 'Not model output' : 'Runtime AI not connected'}
                            </span>
                          </div>
                          <div className="brief-grid">
                            <div className="brief-intent">
                              <p className="brief-label">THE ASK</p>
                              <dl>
                                <div>
                                  <dt>Reason</dt>
                                  <dd>{brief.intent.reason}</dd>
                                </div>
                                <div>
                                  <dt>Amount named</dt>
                                  <dd>
                                    {brief.intent.explicitAmount !== null
                                      ? money(brief.intent.explicitAmount)
                                      : brief.intent.mode === 'FULL_REFUND'
                                        ? 'Full refund, no figure'
                                        : 'None. Not guessing.'}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Order cited</dt>
                                  <dd>{brief.intent.orderRef ?? 'Not cited'}</dd>
                                </div>
                              </dl>
                              {brief.intent.needsReview && (
                                <p className="brief-review">Needs human review before any reply.</p>
                              )}
                              {!brief.intent.needsReview && brief.intent.awaitingAmount && (
                                <p className="brief-awaiting">
                                  Enter an amount to brief the next decision.
                                </p>
                              )}
                            </div>
                            <ol className="brief-facts">
                              {brief.facts.map((fact, i) => (
                                <li key={fact.label}>
                                  <span className="fact-n">{String(i + 1).padStart(2, '0')}</span>
                                  <span className="fact-label">{fact.label}</span>
                                  <strong>{money(fact.value)}</strong>
                                  <small>{fact.sources.join(' · ')}</small>
                                </li>
                              ))}
                              <li>
                                <span className="fact-n">05</span>
                                <span className="fact-label">Fee treatment</span>
                                <strong className="fact-text">{brief.feeTreatment}</strong>
                                <small>Processing fee</small>
                              </li>
                            </ol>
                          </div>
                          {brief.issues.length > 0 && (
                            <div className="brief-blockers">
                              <p className="brief-label">BLOCKERS</p>
                              {brief.issues.map((issue) => (
                                <p key={issue}>{issue}</p>
                              ))}
                            </div>
                          )}
                          <div className="unsent">
                            <div className="unsent-head">
                              <span>UNSENT · REPLY TEMPLATE</span>
                              <span>
                                Filled from facts above · not written by a model · never sent
                              </span>
                            </div>
                            <p>{brief.replyDraft.text}</p>
                          </div>
                          <p className="brief-cite">Sources: {brief.citations.join(' / ')}</p>
                        </section>
                      )}
                      {aiConfigured && (
                        <section className="brief model-advisory" aria-label="Model advisory">
                          <div className="section-heading">
                            <div>
                              <p className="eyebrow">MODEL ADVISORY · NOT A DECISION</p>
                              <h3>A second read. You stay in control.</h3>
                            </div>
                            <button
                              className="quiet"
                              onClick={requestAdvisory}
                              disabled={aiBusy || !!amountError || busy}
                            >
                              {aiBusy ? 'Reading fictional evidence…' : 'Request AI advisory'}
                            </button>
                          </div>
                          <p className="brief-cite">Model: @cf/ibm-granite/granite-4.0-h-micro</p>
                          <p role="status">
                            {visibleAI?.advisory.message ??
                              'Configured, not yet requested for this scenario. No model output is shown.'}
                          </p>
                          {visibleAI?.advisory.status === 'READY' && visibleAI.advisory.result && (
                            <>
                              <p>{visibleAI.advisory.result.explanation.summary}</p>
                              <p className="brief-label">SERVER FACTS · NOT MODEL CALCULATIONS</p>
                              <ol className="brief-facts">
                                {visibleAI.brief.facts.map((fact) => (
                                  <li key={fact.label}>
                                    <span className="fact-label">{fact.label}</span>
                                    <strong>{money(fact.value)}</strong>
                                  </li>
                                ))}
                              </ol>
                              <p className="brief-label">CAVEATS</p>
                              <ul>
                                {visibleAI.advisory.result.explanation.caveats.map((item, i) => (
                                  <li key={i}>{item}</li>
                                ))}
                              </ul>
                              <p className="brief-label">QUESTIONS FOR REVIEW</p>
                              <ul>
                                {[
                                  ...visibleAI.advisory.result.explanation.questions,
                                  ...visibleAI.advisory.result.extraction.missingInfo,
                                ].map((item, i) => (
                                  <li key={i}>{item}</li>
                                ))}
                              </ul>
                              <details>
                                <summary>
                                  Advisory request interpretation · not financial evidence
                                </summary>
                                <p>{visibleAI.advisory.result.extraction.reason}</p>
                              </details>
                              <div className="unsent">
                                <div className="unsent-head">
                                  <span>UNSENT · MODEL REPLY DRAFT</span>
                                  <span>Human review required · never sent</span>
                                </div>
                                <p>{visibleAI.advisory.result.explanation.unsentReply}</p>
                              </div>
                            </>
                          )}
                          <p className="brief-cite">
                            Model prose omits numeric claims. Amounts above come only from server
                            facts. AI cannot approve refunds or call PayPal.
                          </p>
                        </section>
                      )}
                      <footer className="decision-footer">
                        <div>
                          <strong>You decide. The model never does.</strong>
                          <p>
                            {sandboxCapture
                              ? 'Review an exact amount before a PayPal Sandbox refund.'
                              : 'Review an exact amount before a local ledger simulation.'}
                          </p>
                        </div>
                        <button
                          ref={triggerRef}
                          className="primary"
                          disabled={
                            !!amountError || parsed === null || current.issues.length > 0 || busy
                          }
                          onClick={() => {
                            setChecked(false);
                            setConfirm(true);
                          }}
                        >
                          Review {parsed !== null ? money(parsed) : 'amount'}{' '}
                          <span aria-hidden="true">↗</span>
                        </button>
                      </footer>
                    </article>
                  )}
                </section>
              )}
              <footer className="page-footer">
                <span>MARGIN, WITHOUT THE GUESSWORK.</span>
                <span>
                  PayPal adapter: {paypalConfigured ? 'sandbox configured' : 'not connected'} <i />{' '}
                  Runtime AI: {aiConfigured ? 'configured · advisory only' : 'not connected'}
                </span>
                <span>{publicDemo ? 'PUBLIC FIXTURE DEMO / 0.1' : 'LOCAL BUILD / 0.1'}</span>
              </footer>
            </>
          )}
        </main>
      </div>
      <dialog
        ref={dialogRef}
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else setConfirm(false);
        }}
        onClose={() => {
          if (!busy) setConfirm(false);
        }}
        aria-labelledby="confirm-title"
      >
        <div className="dialog-content">
          <p className="eyebrow">EXACT-AMOUNT CONFIRMATION</p>
          <h2 id="confirm-title">Goodwill, on your terms.</h2>
          <p>
            {sandboxCapture
              ? 'This sends a PayPal Sandbox refund for this exact amount. It does not move live money.'
              : 'This changes the fictional ledger only. It does not call PayPal or move money.'}
          </p>
          <dl>
            <div>
              <dt>Merchant</dt>
              <dd>Kiln & Field · fictional</dd>
            </div>
            <div>
              <dt>{sandboxCapture ? 'Order / sandbox capture' : 'Order / fixture capture'}</dt>
              <dd>
                {current?.order.id}
                <small>{current?.order.captureId}</small>
              </dd>
            </div>
            <div>
              <dt>{sandboxCapture ? 'Exact sandbox refund' : 'Exact simulated refund'}</dt>
              <dd className="dialog-money">
                {parsed !== null ? money(parsed) : 'Not set'} <small>USD</small>
              </dd>
            </div>
            <div>
              <dt>Contribution after</dt>
              <dd>
                {money(after)} <small>fee-retention estimate</small>
              </dd>
            </div>
          </dl>
          <label className="consent">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={busy}
            />
            {sandboxCapture
              ? 'I approve this exact amount as a PayPal Sandbox refund. No live money will move.'
              : 'I approve this exact amount for a local simulation. No real or PayPal Sandbox refund will be made.'}
          </label>
          <div className="dialog-actions">
            <button className="quiet" onClick={() => setConfirm(false)} disabled={busy}>
              Back to review
            </button>
            <button className="primary" onClick={simulate} disabled={!checked || busy}>
              {busy
                ? sandboxCapture
                  ? 'Sending sandbox refund…'
                  : 'Recording locally…'
                : sandboxCapture
                  ? `Approve ${parsed !== null ? money(parsed) : ''} sandbox refund`
                  : `Approve ${parsed !== null ? money(parsed) : ''} local simulation`}
            </button>
          </div>
        </div>
      </dialog>
      <dialog ref={resetRef} onCancel={() => setResetConfirm(false)} aria-labelledby="reset-title">
        <div className="dialog-content">
          <p className="eyebrow">ISOLATED WORKSPACE</p>
          <h2 id="reset-title">Start a fresh local session?</h2>
          <p>
            A new local session will load. If a sandbox sale file is present, MG-1001 uses that live
            sandbox capture and the other orders stay fictional. The previous session and its audit
            stay in the local database; no payment capacity is restored. The attached snapshot is
            not live reconciliation. Without refundedCents in the sale file, previous sandbox
            refunds are not loaded into the new session. Never repeat a completed refund just to
            restore its display.
          </p>
          <div className="dialog-actions">
            <button className="quiet" onClick={() => setResetConfirm(false)} disabled={busy}>
              Keep this session
            </button>
            <button className="primary" onClick={reset} disabled={busy}>
              {busy ? 'Creating…' : 'Create local session'}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
