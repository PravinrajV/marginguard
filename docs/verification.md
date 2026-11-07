# Verification record

November 7, 2026 ET. Local preparation, not publication or submission.

## Current executed checks

Environment: Linux, Node 24.22.1, npm 11.21.1.

- `npm test`: **121 tests passed across 9 files**.
- `npm run typecheck`: **passed**.
- `npm run build`: **passed**, rebuilt the production client with corrected sandbox/refund wording.
- `npm run format:check`: **passed**. An earlier check found two pre-existing formatting issues in `src/client/style.css` and `src/domain/brief.ts`; formatting-only changes resolved them, then the entire test/typecheck/build sequence passed again.
- Clean source-only install rehearsal in `/tmp/marginguard-clean-jumznzvb`: `npm ci`, all 121 tests, typecheck and build **passed**. No existing dependencies, private `.data/`, overlay, database or environment files were copied. npm reported zero vulnerabilities at installation, a point-in-time result only. npm also warned about esbuild install-script approval; the actual Vite build succeeded without bypassing that policy.
- Release-candidate pattern scan: **zero unresolved secret/PII hits**. Seven candidates were reviewed as dummy test values, numeric boundaries, UUID/mock identifier segments or deliberately invalid URL userinfo. Two selected gallery PNGs were visually reviewed; neither showed credentials, prohibited identities or account dashboards. See the redacted parent-directory `secret-scan-report.json`.

## New snapshot coverage

Tests now validate optional refundedCents bounds/types, show a 1500-cent imported refund producing $28.44 contribution and $65 remaining, prove that an import creates no approval, operation or PayPal receipt, and preserve legacy behavior when the field is omitted. Default store tests still use fictional fixtures. Sandbox-path tests use fake test identifiers and mocked adapters, not the entrant capture IDs. No test loads the private capture overlay or executes a real refund.

The frontend clears the suggested proposal for an already-refunded sandbox capture on initial load, selection and session reset. This reduces accidental presentation of a second $15 proposal. It does not replace explicit approval or live reconciliation.

## Earlier real local integration evidence

The prior authorized local milestone captured an $80 PayPal Sandbox sale, observed a $2.56 fee and $77.44 net, and completed one human-approved $15 sandbox refund. The capture was partially refunded; current contribution was $28.44 and remaining refundable balance $65. Runtime Workers AI Granite advisory also ran locally. These facts come from the prior verified local evidence, not the mocked tests above. This preparation sent no additional PayPal request.

The original session retains its actual refund audit. The private overlay now includes refundedCents: 1500 for future seeded sessions. This is a manually verified import, not a new API verification or receipt. A running non-watch server must be restarted to load changed server code. Existing sessions are not rewritten. No server was restarted or browser session changed by this preparation.

## Remaining verification gates

- Real app walkthrough recording and export, original ElevenLabs music generation/provenance and final audiovisual/secret review.
- Current screenshots if desired: selected gallery images are historical and disclose the pre-correction labels.
- Browser keyboard/accessibility/responsive release smoke checks. This executor did not open the browser or claim new visual QA of the rebuilt client.
- Judge-owned integration setup and an approved no-charge judge access path through December 15, 2026, 11:00 AM ET. The clean install proves local build reproducibility, not external account access.
- Exact public release, license/source publication, final form/eligibility review and a public YouTube video under three minutes, each after approval.

This is a functioning local sandbox app, not a production financial system. Cross-session authoritative payment reconciliation, durable external reservations and crash-safe refund recovery remain absent. No remote repository, deployment, video upload or Devpost project was created.

## Public fixture demo checks

Same day, after the record above. These checks cover the opt-in fixture demo. They do not repeat the earlier sandbox refund.

- `npm test`: **133 tests passed across 10 files**. New cases cover loopback host refusal, public-host allowlisting, the Secure `__Host-` cookie, and process refusal when a PayPal sandbox credential is set. Adapters in those tests are unconfigured or mocked. No live network call.
- `npm run typecheck`, `npm run build`, and `npm run format:check`: **passed**.
- A process with `HOST=0.0.0.0` and `PORT=39999`, and without `PUBLIC_ORIGIN`, listened only on 127.0.0.1:8787. `Host: evil.example` returned 403.
- `PUBLIC_ORIGIN=https://example.com:8443` without PayPal credentials allowed that host, set `__Host-mg_session` with Secure, and reported `PUBLIC_FIXTURE_DEMO` with PayPal and Workers AI `NOT_CONNECTED`. `example.com` was a local test name, not a deployed host.
- The same public origin with `PAYPAL_SANDBOX_CLIENT_ID` set exited 1 before listen. The message did not include the credential.
- Browser check: `http://127.0.0.1:8787` showed `LOCAL FIXTURES · NO PAYPAL CONNECTION` and blocked MG-1006 for missing fee evidence. A temporary local TLS proxy for `https://example.com:8443` showed `PUBLIC FIXTURE DEMO · NO PAYPAL CONNECTION`, footer `PUBLIC FIXTURE DEMO / 0.1`, and MG-1001 fixture math of $43.11 then $28.11. No refund was submitted. This does not claim the demo is hosted.
