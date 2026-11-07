import { canonicalPayload, packetFor, PolicyError, validateRefund } from '../domain/policy';
import { formatUSD } from '../domain/money';
import { isSandboxCapture } from '../domain/capture';
import type { Operation, RefundPayload, State } from '../domain/types';
import type { Store } from './store';
import {
  UnconfiguredPayPalSandbox,
  type PayPalSandboxAdapter,
  type SandboxRefundResult,
} from '../adapters/paypal';

function findOrder(state: State, id: string) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) throw new PolicyError('Order not found in this session.', 404);
  return order;
}

export function requiredConfirmation(captureId: string, amount: number): string {
  return isSandboxCapture(captureId)
    ? `APPROVE ${formatUSD(amount)} PAYPAL SANDBOX REFUND`
    : `APPROVE ${formatUSD(amount)} LOCAL SIMULATION`;
}

export class DecisionService {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
    private paypal: PayPalSandboxAdapter = new UnconfiguredPayPalSandbox(),
  ) {}
  list(session: string) {
    return this.store.read(session).orders.map(packetFor);
  }
  packet(session: string, id: string) {
    return packetFor(findOrder(this.store.read(session), id));
  }
  approve(session: string, payload: RefundPayload, confirmation: string) {
    return this.store.transact(session, (state) => {
      const order = findOrder(state, payload.orderId);
      const amount = validateRefund(order, payload);
      if (confirmation !== requiredConfirmation(order.captureId, amount))
        throw new PolicyError('Exact human confirmation is required.', 400);
      const approval = {
        id: crypto.randomUUID(),
        payload: canonicalPayload(payload),
        expiresAt: this.now() + 5 * 60 * 1000,
        operationId: null,
      };
      const sandbox = isSandboxCapture(order.captureId);
      state.approvals.push(approval);
      state.audit.push({
        id: crypto.randomUUID(),
        at: new Date(this.now()).toISOString(),
        type: 'HUMAN_APPROVED',
        orderId: order.id,
        detail: sandbox
          ? `Exact ${formatUSD(amount)} PayPal Sandbox refund approved. Expires in five minutes.`
          : `Exact ${formatUSD(amount)} local simulation approved. Expires in five minutes.`,
      });
      return { approvalId: approval.id, expiresAt: approval.expiresAt };
    });
  }
  simulate(session: string, payload: RefundPayload, approvalId: string) {
    return this.store.transact(session, (state) => {
      const prepared = this.#prepared(state, payload, approvalId);
      if (prepared.existing) return prepared.existing;
      if (isSandboxCapture(prepared.order.captureId))
        throw new PolicyError(
          'This capture is a PayPal Sandbox sale. It cannot be fulfilled as a local simulation.',
        );
      return this.#applyLocal(
        state,
        prepared.approval,
        prepared.order,
        prepared.amount,
        approvalId,
      );
    });
  }
  async fulfill(session: string, payload: RefundPayload, approvalId: string): Promise<Operation> {
    const preview = this.#prepared(this.store.read(session), payload, approvalId);
    if (preview.existing) return preview.existing;
    if (!isSandboxCapture(preview.order.captureId))
      return this.simulate(session, payload, approvalId);

    let result: SandboxRefundResult;
    try {
      result = await this.paypal.refund({
        captureId: preview.order.captureId,
        amountCents: preview.amount,
        currency: 'USD',
        requestId: approvalId,
      });
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError(
        error instanceof Error
          ? error.message
          : 'PayPal Sandbox refund failed. Nothing was recorded as a success.',
      );
    }
    if (
      result.status !== 'COMPLETED' ||
      (result.amountCents !== undefined && result.amountCents !== preview.amount)
    )
      throw new PolicyError(
        'PayPal Sandbox did not complete this refund. Nothing was recorded as a success.',
      );

    return this.store.transact(session, (state) => {
      const prepared = this.#prepared(state, payload, approvalId, { ignoreExpiry: true });
      if (prepared.existing) return prepared.existing;
      if (!isSandboxCapture(prepared.order.captureId))
        throw new PolicyError('Evidence changed. Review a fresh decision packet.');
      const operation: Operation = {
        id: `SB-${crypto.randomUUID()}`,
        approvalId,
        orderId: prepared.order.id,
        amount: prepared.amount,
        status: 'SANDBOX_COMPLETED',
        at: new Date(this.now()).toISOString(),
        source: 'PAYPAL_SANDBOX',
      };
      prepared.order.refunded += prepared.amount;
      prepared.order.version += 1;
      prepared.approval.operationId = operation.id;
      state.operations.push(operation);
      state.audit.push({
        id: crypto.randomUUID(),
        at: operation.at,
        type: 'PAYPAL_SANDBOX_REFUND',
        orderId: prepared.order.id,
        detail: `${formatUSD(prepared.amount)} refunded in PayPal Sandbox${result.id ? ` (${result.id})` : ''}. No live money moved.`,
      });
      return operation;
    });
  }
  #prepared(
    state: State,
    payload: RefundPayload,
    approvalId: string,
    options: { ignoreExpiry?: boolean } = {},
  ) {
    const approval = state.approvals.find((item) => item.id === approvalId);
    if (!approval) throw new PolicyError('No valid human approval. Nothing was simulated.', 403);
    if (approval.payload !== canonicalPayload(payload))
      throw new PolicyError('Approval does not match the exact amount and evidence. Review again.');
    if (approval.operationId) {
      const existing = state.operations.find((item) => item.id === approval.operationId);
      if (!existing) throw new PolicyError('Operation record is unresolved. Review required.');
      return {
        approval,
        existing,
        order: findOrder(state, payload.orderId),
        amount: existing.amount,
      };
    }
    if (!options.ignoreExpiry && approval.expiresAt <= this.now())
      throw new PolicyError('Approval expired. Review the current packet.');
    const order = findOrder(state, payload.orderId);
    const amount = validateRefund(order, payload);
    return { approval, existing: undefined, order, amount };
  }
  #applyLocal(
    state: State,
    approval: State['approvals'][number],
    order: State['orders'][number],
    amount: number,
    approvalId: string,
  ) {
    const operation: Operation = {
      id: `SIM-${crypto.randomUUID()}`,
      approvalId,
      orderId: order.id,
      amount,
      status: 'SIMULATED',
      at: new Date(this.now()).toISOString(),
      source: 'LOCAL_SIMULATION',
    };
    order.refunded += amount;
    order.version += 1;
    approval.operationId = operation.id;
    state.operations.push(operation);
    state.audit.push({
      id: crypto.randomUUID(),
      at: operation.at,
      type: 'LOCAL_SIMULATION',
      orderId: order.id,
      detail: `${formatUSD(amount)} applied only to the fictional ledger. ${operation.id}. No PayPal refund exists.`,
    });
    return operation;
  }
}
