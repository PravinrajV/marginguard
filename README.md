# MarginGuard

**Understand the margin before approving the refund.**

Built by Pravinraj Vincent, Independent developer, Sunbury, Ohio, United States. Solo, original project started November 6–7, 2026 ET during the submission period. No earlier competition project was reused.

## The problem

A refund amount tells a merchant what leaves the account. It does not show what remains after processing fees, goods and shipping. A rushed decision can also overlook missing or inconsistent payment evidence.

MarginGuard puts that evidence beside the decision. It is a functioning local web application with deterministic contribution calculations, an advisory-only AI second read and a human-approved PayPal Sandbox refund path. Kiln & Field, its products, requests and operating costs are fictional. No live money moves.

## Current status

The local build has been exercised with a genuine $80 PayPal Sandbox sale, an observed $2.56 processing fee and a completed, human-approved $15 sandbox refund. Runtime Cloudflare Workers AI has also been exercised locally. These are verified local milestones, not claims of production readiness. There is no public repository, hosted deployment, published video or submitted Devpost entry yet. MIT license text is prepared in `LICENSE`; publishing it and the source still requires the entrant to approve release.

## Run locally

Require **Node 24+** for built-in `node:sqlite`. Local verification used Node 24.22.1 and npm 11.21.1 on Linux. Initial dependency installation needs internet access. SQLite may emit an experimental-feature warning.

From the project root (the directory containing `package.json`):

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

Open **http://127.0.0.1:8787**. The built SPA and API share this loopback-only port. Keep port 8787 free, run commands from this directory, and stop with Ctrl+C. No database service is required: the first start applies `migrations/001_local.sql` and creates `.data/marginguard.sqlite`.

For development, `npm run dev` starts the API on 127.0.0.1:8787 and Vite on **http://127.0.0.1:5173**, with `/api` proxied to the API. Neither server binds publicly.

### Fixture mode needs no accounts

A clean checkout has twelve fictional orders and no external connection. Inspect MG-1001, edit the proposed amount and open the exact-amount review. Fixture approvals create `SIM-` local records, never PayPal refunds. MG-1006 has a missing fee and blocks approval. MG-1007 has inconsistent capture evidence; MG-1012 has a pending capture. Unknown evidence is not replaced with a guessed zero.

The fixture MG-1001 fee is $2.89, producing $43.11 contribution before a refund and $28.11 after a $15 simulation. These are fictional fixture values, not a PayPal fee schedule. The locally attached sandbox capture instead has a verified $2.56 fee.

### Optional real integrations: server environment only

`.env.example` contains commented placeholders, not usable credentials. **The app does not automatically load `.env` files.** Set the following variables securely in the server process environment and restart:

| Variable                       | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `PAYPAL_SANDBOX_CLIENT_ID`     | Your own sandbox REST app client ID   |
| `PAYPAL_SANDBOX_CLIENT_SECRET` | Your own sandbox REST app secret      |
| `CLOUDFLARE_ACCOUNT_ID`        | Your own Cloudflare account ID        |
| `CLOUDFLARE_API_TOKEN`         | Your own token with Workers AI access |

For example, Bash can prompt without putting values in command history:

```bash
read -rsp 'PayPal sandbox client ID: ' PAYPAL_SANDBOX_CLIENT_ID; printf '\n'
read -rsp 'PayPal sandbox secret: ' PAYPAL_SANDBOX_CLIENT_SECRET; printf '\n'
read -rsp 'Cloudflare account ID: ' CLOUDFLARE_ACCOUNT_ID; printf '\n'
read -rsp 'Workers AI token: ' CLOUDFLARE_API_TOKEN; printf '\n'
export PAYPAL_SANDBOX_CLIENT_ID PAYPAL_SANDBOX_CLIENT_SECRET
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
npm start
```

Supply only the integration pair you want to test. Missing either value in a pair keeps that adapter disconnected without a network call. Never use `VITE_` variables for secrets, paste them into source, record them on video or commit local environment files. Judges use their own accounts, not the entrant account. Check current service allowances before enabling external calls; this repository does not grant free API credits or authorize paid usage.

### Attach your own PayPal Sandbox capture

The app is a refund decision desk, not a checkout UI. Sale creation and buyer approval are a separate sandbox setup step. Use the [PayPal sandbox guide](https://developer.paypal.com/tools/sandbox/) and [Orders v2 reference](https://developer.paypal.com/docs/api/orders/v2/):

1. In the PayPal Developer Dashboard, choose **Sandbox**, create a REST app for a sandbox business account, and use that app client ID and secret. Use a separate sandbox personal buyer. Never use a live account, live card or live API app.
2. Against **https://api-m.sandbox.paypal.com** only, obtain a client-credentials OAuth token. Create an Orders v2 order with `intent: CAPTURE`, one purchase unit for USD `80.00` and an MG-1001 reference. Follow the returned buyer approval link in the sandbox and approve as the sandbox buyer.
3. Capture the approved order, then read its capture with Payments v2. Verify the capture belongs to the same sandbox business account, is completed, is USD 80.00, and has `seller_receivable_breakdown.paypal_fee` plus `net_amount`. Use observed values, not an assumed fee. Retain request IDs privately for idempotency.
4. The server-side `SandboxPayPal` helpers in `src/adapters/paypal.ts` implement `createOrder`, `captureOrder`, `getOrder`, `getCapture` and `getRefund`. They are not exposed as browser sale routes. Official [Payments v2 documentation](https://developer.paypal.com/docs/api/payments/v2/) describes capture and refund reads.
5. Create `.data/mg-1001-sandbox.json` locally using the schema below. Replace both ID placeholders with **your own** IDs and the fee/net with your observed cents. An overlay must total exactly 8000 gross cents, with net equal to gross minus fee. The example fee is the locally observed amount, not a promised rate.

```json
{
  "localOrderId": "MG-1001",
  "paypalOrderId": "YOUR-SANDBOX-ORDER-ID",
  "captureId": "YOUR-SANDBOX-CAPTURE-ID",
  "amountCents": 8000,
  "paypalFeeCents": 256,
  "netCents": 7744,
  "currency": "USD",
  "status": "COMPLETED",
  "refundedCents": 0
}
```

6. Choose **New local session** after the file is in place. MG-1001 now uses the attached sandbox snapshot; the other eleven orders remain fixtures. Capture IDs are evidence, not credentials. The entrant capture IDs are not required for judge setup and are not included in this example. Invalid overlays are ignored and leave fixtures in place.
7. Inspect the packet and its source label. A connected adapter alone does not make fixtures real. Only a non-fixture capture attached to MG-1001 enters the sandbox refund path. Review, exact human confirmation and approval are required before any refund POST. Do not repeat the entrant completed refund. A judge may independently authorize a test on a new capture they own.

**No live mode exists.** The adapter pins the official sandbox origin, rejects other origins and refuses `FIXTURE-CAP-` IDs before network access. It uses Orders v2 for setup and Payments v2 for capture/refund evidence and refund execution. OAuth tokens and app credentials remain on the server. `PayPal-Request-Id` uses the approval ID. Uncertain or non-completed outcomes are not recorded as success.

### Verified local evidence, not a step to repeat

On November 7, 2026 ET, the attached $80 sandbox sale reported a $2.56 fee and $77.44 net. The authorized $15 refund completed in PayPal Sandbox; the capture became partially refunded. With fictional goods cost $28 and shipping $6, current contribution became **$28.44**, with **$65.00** remaining refundable. This preparation did not execute another refund.

The optional `refundedCents` overlay field imports a **manually verified snapshot** of prior refunds. It must be a safe integer between zero and gross. It performs no network call, creates no refund operation or PayPal receipt, and records a clearly labeled snapshot audit event. A positive imported amount clears the order suggested proposal. The local evidence overlay now carries 1500 cents for the completed refund; the private overlay and SQLite database must not be published.

**New-session caveat:** sessions are isolated, not a shared PayPal ledger. Without `refundedCents`, a new session still starts MG-1001 with zero local refunds even if PayPal already refunded it. An extra nested `refund` documentation object is ignored. With `refundedCents`, new sessions show that recorded balance, not a fresh PayPal reconciliation. Existing sessions are not patched. Do not approve another refund to restore a display or receipt. A new session does not reverse a refund or restore payment capacity. The original completed-refund audit lives in its original local session.

## What the AI does

Runtime AI uses Cloudflare Workers AI **`@cf/ibm-granite/granite-4.0-h-micro`**, prompt version **`advisory-v4`**. The explicit **Request AI advisory** button asks the model to interpret the fictional request and explain allowlisted facts, caveats, questions and an unsent reply. It is not the deterministic Decision brief, which is labeled separately.

Two bounded jobs run with strict Zod schemas, a 12-second timeout per call and at most one shared repair attempt, for at most three inference calls per packet. Numeric/action-completed model prose is filtered; authoritative amounts are always server facts. Invalid or empty output becomes **needs human review**, not fabricated model success. Extraction cannot set the proposed refund amount. No capture IDs, payer data, credentials or raw PayPal payloads enter prompts. The model has no approval tools, SQL access or PayPal authority.

Session-scoped cache/in-flight deduplication and process-local caps permit at most 50 uncached packets daily in total and 10 per session. Failed packets count. Limits reset at midnight America/New_York; process restarts clear these demo limits. They are not durable spending controls. Page loads and typing do not invoke inference. Judges need their own permitted Workers AI access to exercise this integration. See the [model documentation](https://developers.cloudflare.com/workers-ai/models/granite-4.0-h-micro/).

## Architecture

```text
React 19 + TypeScript + Vite SPA
  -> same-origin Hono API / @hono/node-server
  -> deterministic integer-cents money, reconciliation and policy modules
  -> SQLite local store (stand-in for a future D1 implementation)
  -> server-only PayPal Sandbox adapter / Workers AI advisory adapter
```

Zod validates boundaries. Vitest covers domain logic, local API/session boundaries and mocked integration behavior. SQLite uses a per-session JSON aggregate with application audit events; it is not Cloudflare D1. Complete evidence snapshots bind exact approvals to order, cents, currency, costs, capture, version and prior refunds. Approvals expire after five minutes. Identical completed retries return the same local operation. Network calls run outside database locks.

Contribution = gross minus recorded refunds, retained fee, goods cost and shipping. Recoveries are zero here. This is not net profit, tax advice or GAAP accounting. Fee retention is a scenario assumption. Missing fee or inconsistent evidence blocks approval. After an executed refund the proposal clears; an empty proposal means **Unknown / Not set** for the next hypothetical scenario, not a failed previous refund.

## Safety and limitations

- Sandbox only, fictional merchant, no real customer data, no autonomous money movement.
- Human review binds the exact amount and evidence; the AI cannot approve or call PayPal.
- Strict decimal-string parsing and safe integer cents; invalid, excessive and stale amounts fail closed.
- Opaque HttpOnly / SameSite=Strict local session cookies, origin/CSRF checks, request-size caps, loopback restriction and production CSP. HTTP local cookies intentionally do not claim public HTTPS hardening.
- Local sessions last 24 hours and remain isolated. Audit is application append-only, not tamper-proof. Local SQLite is not encrypted.
- This is not a production refund engine. There is no authenticated merchant tenancy, durable cross-session capture reservation, automatic payment reconciliation or crash-safe external refund recovery. Separate approvals can race externally before local state is committed. Do not use this app for real financial activity or expose it publicly as-is.
- A timeout can mean PayPal received the request. Do not generate a new approval to retry an uncertain refund. Investigate using the same request ID and authoritative refund/capture reads. Recovery is not an automated workflow in this build.
- `.data/`, `.env*` other than the placeholder example, `.dev.vars*`, logs, secrets and build output are ignored. Do not share the private database or overlay.

## Verification, provenance and release gates

```bash
npm test
npm run typecheck
npm run build
npm run format:check
```

Automated tests use fictional data, mock network adapters and in-memory SQLite; they never execute a live sandbox refund. See [verification](docs/verification.md), [architecture](docs/architecture.md), [development AI disclosure](docs/tool-use.md) and [dependency notices](docs/third-party.md). No savings, customers, production deployment or security certification is claimed.

For judging, the intended path is complete local run instructions plus the real integration evidence and a public demo video, not a mandatory hosted service. Public source availability, MIT publication approval, a clean release rehearsal, a public YouTube demo under three minutes, final Devpost form review and submission remain gates. Judge access must remain free through **December 15, 2026, 11:00 AM ET**. Do not promise paid third-party API access; the entrant must resolve a permitted free access path before submission. The official deadline is **November 12, 2026, 3:00 PM ET**; Official Rules prevail.
