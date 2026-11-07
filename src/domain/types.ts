import type { DecisionBrief } from './brief';
export interface Order {
  id: string;
  product: string;
  units: number;
  gross: number;
  fee: number | null;
  net: number | null;
  cogs: number;
  shipping: number;
  refunded: number;
  reserved: number;
  currency: 'USD';
  captureId: string;
  captureGross: number;
  status: 'COMPLETED' | 'PENDING';
  version: number;
  request: string;
  reason: string;
  suggested: string;
  source: 'FICTIONAL_FIXTURE' | 'PAYPAL_SANDBOX';
  fetchedAt: string;
}
export interface AuditEvent {
  id: string;
  at: string;
  type: string;
  orderId: string;
  detail: string;
}
export interface Approval {
  id: string;
  payload: string;
  expiresAt: number;
  operationId: string | null;
}
export interface Operation {
  id: string;
  approvalId: string;
  orderId: string;
  amount: number;
  status: 'SIMULATED' | 'SANDBOX_COMPLETED';
  at: string;
  source: 'LOCAL_SIMULATION' | 'PAYPAL_SANDBOX';
}
export interface State {
  orders: Order[];
  approvals: Approval[];
  operations: Operation[];
  audit: AuditEvent[];
}
export interface RefundPayload {
  orderId: string;
  amount: string;
  evidence: string;
}
export interface Packet {
  order: Order;
  evidence: string;
  issues: string[];
  remaining: number;
  before: number | null;
  fullAfter: number | null;
  brief: DecisionBrief;
}
