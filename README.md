# ZapGoals WASM

<img width="160" height="160" alt="ZapGoals WASM" align="right" src="static/assets/icon.png" />

Invoice-only Lightning funding goals for the stock LNbits WASM sandbox. Create a public goal, choose its appearance and suggested amounts, and receive contributions through locally generated QR codes and BOLT11 invoices. There is no payment-mode selector, wallet connector, browser payer credential, or third-party QR service.

## Supported features

- Public funding pages with targets, deadlines, descriptions, colors, fonts, and live progress.
- One to four suggested whole-satoshi amounts, custom amounts, and optional comments.
- QR/BOLT11 invoices payable with any external Lightning wallet.
- Goal-bound invoice issuance records and receiving-wallet/amount verification before credit.
- Durable, verified receipt checks; WebSocket notifications alone never prove payment.
- Fixed-calendar recurring periods with derived allocation/rollover history.
- Manual sweeps that transfer a recurring goal's allocated sats to another wallet you own.
- A standalone JavaScript widget, including multiple independent widgets on one page.
- Archive goals without deleting their receipts or breaking settlement of existing invoices.

**Not supported:** Bitcoin Connect, Nostr/NIP-57, Lightning Addresses, LNURL-pay, automatic or scheduled wallet transfers, early/manual balance resets, or external iframe embedding. Wallet transfers happen only when an owner runs a manual sweep. The stock host blocks external iframes and browser networking inside its WASM frame; this extension does not relax those protections. Invoice and receipt requests on the main page use the approved host bridge.

## Installation

Requires **LNbits 1.6.0 or newer** with its stock WASM APIs. Use the explicit versioned install ZIP from the release, together with its SHA-256 manifest entry. Do **not** install GitHub's automatic source ZIP: it contains Python build/test files that the WASM host correctly rejects.

The repository's `manifest.json` is an explicit release manifest, not GitHub repository discovery. Its published entry must refer to a published install asset and matching checksum. A locally built candidate manifest is not a published release.

Enable the extension for the user and review its permissions:

- Read/write extension-owned storage and list the user's wallets.
- Read a restricted public goal/receipt projection.
- Create public incoming invoices only for the receiving wallet stored on the goal.
- Append private, goal-scoped issuance records before invoice creation.
- Create internal invoices on, and pay invoices from, wallets you already own — used exclusively by the manual sweep action.

There is **no outgoing-payment, generic network, or wallet-admin permission**. Upgrades adding the issuance permission require accepting that permission before invoice creation can work. Issuance records are not publicly readable. The host-enforced issuance limit is 10,000 attempts per goal; attempts that fail after recording issuance also consume a slot. Reaching the limit fails closed rather than creating an untracked invoice. There is no automatic deletion of security bindings.

## Create and share

1. Open ZapGoals, select a receiving wallet, and enter the title, satoshi target, and deadline.
2. Configure suggested amounts and optional presentation settings.
3. For a recurring goal, choose its fixed calendar rules before saving.
4. Share the public URL or copy the JavaScript widget snippet.

All contributions use vanilla invoices. The invoice/QR stays available if live monitoring temporarily fails; the page continues checking the verified receipt endpoint. A displayed success requires a verified contribution receipt, not an aggregate balance increase or an untrusted socket broadcast. Progress is always loaded from authoritative accounting, not optimistically incremented by editable form values.

## Fixed-calendar recurring goals

Recurring financial rules are immutable after creation: receiving wallet, recurrence mode, target amount, initial deadline/anchor, interval/day, and allocation/rollover settings. Create a new goal to change those rules. Titles, descriptions, colors, typography, and suggested contribution amounts remain editable. Ordinary goals may still edit their target amount and deadline, but cannot be converted into a recurring series.

The first period begins at creation and ends at the configured first deadline. Subsequent boundaries follow that anchor in UTC: daily, weekly, monthly, quarterly, semi-annual, or annual. Month-end days clamp to the actual target month's length without permanently drifting to the 28th.

Periods advance by the calendar—no scheduler or reset is needed. The recorded allocation is what a sweep may transfer; until you sweep, allocated sats simply remain in the goal's receiving wallet.

### Receipt-derived accounting

Only settled, verified invoices contribute. Each receipt is assigned using the private issuance record's creation time. A late payment therefore updates the period in which its invoice was issued, and may update later carry. **Historical amounts are projections, not frozen transfer records.**

For each closed period:

- Available amount = incoming carry + verified contributions issued in that period.
- **Target amount** allocates up to the period target; **entire amount** allocates everything available.
- With **counts as progress**, excess carries into the next period.
- With **reset to zero**, excess is reported separately as retained rather than silently disappearing from accounting.

“Allocated” and “retained” are accounting labels. Funds move only through the manual sweep below; retained excess always stays in the goal’s wallet. Period history exposes the latest 100 projected closed periods; projection fails explicitly instead of truncating totals if its supported period/read budget is exceeded.

Contribution receipts and opening balances are never overwritten by presentation edits or period advancement. Duplicate events are no-ops. Stable, checked receipt snapshots prevent paging races from displaying incomplete sums; a busy/changing read can return a retryable error instead of an incorrect total.

### Manual sweeps

For a recurring goal with a configured target wallet, the admin list offers a **Sweep to target wallet** action. A sweep:

- Transfers every sat allocated by closed periods and not yet swept — allocated minus already swept — from the goal’s receiving wallet to the target wallet through an internal invoice. Internal transfers between your own wallets settle immediately.
- Is confirmed explicitly, moves real funds, and never runs automatically or on a schedule.
- Is idempotent per accounting state: a repeated click at the same allocation cannot pay twice. A durable marker blocks concurrent sweeps, and a failed payment (for example, an empty goal wallet) is safely retryable.
- Never touches goal progress: sweep settlement events carry no issuance binding and are quarantined by the settlement verifier.

If late payments raise a closed period’s allocation after its range was already swept, reconcile manually — the same period range is never paid twice by an automatic re-sweep.

### Upgrading from 0.3.x

Back up the extension database and stop the old runtime before the upgrade. Migrations 005 and 006 are additive (issuance bindings and the sweep ledger):

- Existing `currentAmount` is preserved as the new series' opening balance; it is **not independently reconciled** by the migration.
- Historical receipt hashes remain deduplication records, but are not counted again.
- New, verified receipts are counted beyond the preserved opening balance.
- Existing legacy period rows remain stored as legacy history, distinct from the new projection.
- Old invoices without the new private issuance binding are quarantined rather than automatically credited. Reconcile any outstanding pre-upgrade invoice before accepting the cutover; the upgrade never claims those contributions vanished from the actual wallet.

Do not attempt to “repair” old balances automatically by summing historical `newTotal` fields. The previous implementation could contain accounting inconsistencies, and an owner must reconcile those against actual wallet receipts if necessary. Archived goals retain receipt/issuance data and continue accepting settlement of already-issued invoices; no new invoices can be issued for them.

## JavaScript widget

Copy the per-goal snippet from the admin page:

```html
<script
  src="https://your-lnbits.example.com/ext-assets/zapgoalswasm/js/embed.js"
  data-goal="YOUR_GOAL_ID"
  async
></script>
```

Each executing script reads its own configuration, so multiple goals and LNbits origins can coexist. The widget loads its QR implementation from the same LNbits origin and generates the QR locally. No invoice is sent to a third-party image service or CDN.

The widget runs in the embedding page's first-party JavaScript context. Use it only on sites you control; the site's script, style, connection, and CORS policies must allow the LNbits resources it uses. It does not receive wallet-admin keys. Shadow DOM isolates widget styling from ordinary page styles, but is not a security sandbox. External iframe snippets are intentionally not offered because stock LNbits prohibits that embedding route.

## API

Base: `/api/v1/ext/zapgoalswasm`.

- `GET /goals`, `POST /goals`, `PUT /goals/{goalId}` — owned goals.
- `DELETE /goals/{goalId}` — archive, retaining accounting records.
- `GET /wallets` — user's receiving-wallet choices.
- `GET /goals/{goalId}/public` — public presentation and derived progress.
- `POST /goals/{goalId}/invoice` — `{"amount":21,"comment":"Optional"}`; returns `paymentHash` and `paymentRequest`.
- `GET /goals/{goalId}/payments/{paymentHash}` — `{"paid":true}` only for a durable verified receipt belonging to that goal; otherwise false.
- `GET /goals/{goalId}/periods` — owned, derived period history.
- `POST /goals/{goalId}/sweep` — owner-only manual transfer of the unswept allocation to the goal’s target wallet.
- Existing `/recurring/sweep-due` remains a read-only compatibility summary.

On recurring updates, omit locked financial fields, especially the displayed `targetDate`: that value is the current derived deadline, not the immutable first-period anchor. Amounts are integer sats between 1 and 2,100,000,000; dates are validated and normalized to UTC.

## Development and verification

Build tools are pinned and checked in `build-tools.json` (Rust 1.98.0, cargo-component 0.21.1, Node 22.22.3). Install those versions and the `wasm32-wasip1` target before building. The build never silently installs or upgrades a toolchain. Existing Python config/package checks require pytest in the selected development Python environment.

```sh
npm ci --ignore-scripts
make check
make test PYTHON=/path/to/python-with-pytest
make test-browser
make package
```

`make test` uses isolated native Rust mock-host/accounting tests and Node/Python tests. Browser tests use guarded fixtures with all invoice/payment writes intercepted before navigation and stock sandbox/CSP restored in browser responses. The only actual POST permitted is the host's in-memory frame-token handshake. The old live-payment e2e scripts have been removed; maintained browser tests do not make real payments.

The frontend build precompiles Vue templates for stock CSP. The install packager sorts files, normalizes timestamps/permissions, includes license notices, and excludes source/build/test artifacts. Identical runtime files produce identical ZIP bytes. The release manifest is generated after packaging and is not included in the ZIP, avoiding a self-referential checksum.

## License

MIT; see `LICENSE`. The retained local QR generator includes its full MIT notice, with provenance in `static/js/qr.js` and `THIRD_PARTY_NOTICES.txt`. Bitcoin Connect and its bundled dependency tree are no longer distributed.
