# Architecture and boundaries

## Implemented local system

React 19 and Vite serve a TypeScript SPA. Same-origin JSON requests reach Hono on `@hono/node-server`. The default bind is 127.0.0.1:8787 and the host allowlist is `127.0.0.1` and `localhost`. `PUBLIC_ORIGIN` opts into a fixture-only public demo: the process may bind a platform address, allow that https host, and set a Secure `__Host-` cookie. That mode refuses to start when either PayPal sandbox credential is set, and it does not construct the sandbox adapter. Zod checks request boundaries. Pure domain modules calculate safe integer-cent contribution and reconcile capture/fee evidence. `DecisionService` enforces canonical payload matching, session ownership, approval expiry and exact human confirmation.

`SQLiteStore` persists a per-session JSON aggregate and application audit rows using `node:sqlite`. This is a local stand-in, not D1 or a deployed Worker. A D1 migration would require asynchronous transactions, conditional writes and redesigned reservation/recovery semantics. Audit is application append-only, not tamper-proof.

## Actual integration paths

- `SandboxPayPal` is server-only and pins `https://api-m.sandbox.paypal.com`. It implements OAuth, Orders v2 create/capture/read and Payments v2 capture/refund/read. Fixture IDs are refused before network access.
- `DecisionService.fulfill` uses the sandbox adapter for attached non-fixture captures; fixture orders remain local simulations. Only completed outcomes update the ledger. Approval IDs become PayPal request IDs. No SQLite lock spans a network request.
- `createAdvisory` selects the Workers AI adapter only with both environment values. The model is `@cf/ibm-granite/granite-4.0-h-micro`, prompt `advisory-v4`. It receives read-only allowlisted facts, not capture IDs, payer data or secrets. The model has no payment or approval tools.
- The sandbox overlay is a manually attached snapshot, not automatic reconciliation. Optional `refundedCents` imports recorded prior refunds without a network call or invented receipt. A nested `refund` documentation object does not seed a balance.

## Routes

- `GET /api/session`: isolated 24-hour workspace, CSRF and connection statuses, no secrets.
- `GET /api/orders` and `GET /api/orders/:id`: current-session packets and audit evidence.
- `POST /api/approvals`: exact canonical payload and human confirmation.
- `POST /api/simulations`: consumes the matching approval; executes a fixture simulation or attached PayPal Sandbox refund.
- `POST /api/advisory`: explicitly requested model read plus deterministic server brief.
- `POST /api/reset`: new isolated session; previous records retained, no payment balance restored.

Mutation routes require JSON, an allowlisted Origin and CSRF. The allowlist is the loopback dev origins, plus the public https origin when `PUBLIC_ORIGIN` is set. Request bodies are capped at 8 KiB. The browser has no cross-origin API access or credentials. Loopback HTTP cookies are not marked Secure. The public fixture demo sets a Secure `__Host-` cookie for its https origin.

## Production gaps, not hidden features

The sandbox refund integration is meaningful but intentionally local. It does not implement durable capture-wide reservation across sessions, automatic authoritative reconciliation, authenticated merchant tenancy or crash-safe external recovery. Separate approvals can race outside the local transaction. Pending/unknown outcomes are not successes, but require manual reconciliation before any retry. Restarted AI processes lose their cache and budget counters. These are reasons not to deploy the app as a real financial system.
