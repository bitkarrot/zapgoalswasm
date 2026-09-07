# ZapGoals WASM

<img width="160" height="160" alt="ZapGoals WASM" align="right" src="https://raw.githubusercontent.com/bitkarrot/zapgoalswasm/main/static/assets/icon.png" /><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="title desc">
<title id="title">ZapGoals WASM</title>
<desc id="desc">A lightning bolt crossing a circular fundraising progress meter on a pink background</desc>
<defs>
<linearGradient id="background" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0" stop-color="#f472b6"/>
<stop offset="1" stop-color="#db2777"/>
</linearGradient>
<linearGradient id="bolt" x1="0%" y1="0%" x2="0%" y2="100%">
<stop offset="0" stop-color="#fde047"/>
<stop offset="1" stop-color="#f59e0b"/>
</linearGradient>
</defs>
<rect width="256" height="256" rx="48" fill="url(#background)"/>
<circle cx="128" cy="128" r="78" fill="none" stroke="#ffffff" stroke-opacity=".22" stroke-width="18"/>
<path d="M128 50a78 78 0 0 1 72.6 106.4" fill="none" stroke="#2dd4bf" stroke-width="18" stroke-linecap="round"/>
<circle cx="128" cy="128" r="50" fill="#201b57" fill-opacity=".88"/>
<path d="M142 62 89 139h35l-12 56 56-85h-36z" fill="url(#bolt)" stroke="#fff7c2" stroke-width="4" stroke-linejoin="round"/>
<circle cx="201" cy="157" r="9" fill="#2dd4bf" stroke="#d5fffa" stroke-width="4"/>
</svg>

ZapGoals WASM is a port of the classic LNbits ZapGoals extension for the current LNbits WASM extension runtime. It creates customizable public Lightning funding goals with wallet-specific accounting, direct invoices, LNURL-pay endpoints, recurring periods, embeddable cards, and live progress.

## Features

- Create, edit, list, publish, and delete funding goals.
- Choose a receiving wallet and set target amount/date.
- Configure descriptions, suggested contribution amounts, colors, fonts, and payment mode.
- Public goal page with suggested/custom amounts, QR-ready BOLT11 invoices, optional comments, and Bitcoin Connect mode.
- Live payment subscription with a paid checkmark and immediate public progress refresh.
- Direct LNURL-pay metadata/callback routes using millisatoshi protocol amounts.
- Progress is based only on settled invoices tagged to that goal and payment hashes are processed idempotently.
- Recurring goals with configurable periods, manual sweeps, rollover, and period history.
- Embeddable goal card via iframe or direct JavaScript widget with Shadow DOM.
- Responsive Quasar UI matching the classic extension in light and dark modes.
- Least-privilege WASM storage and public-invoice permissions.

## Current WASM boundary

The current LNbits WASM host contract does not expose a safe extension hook for owning `/.well-known/lnurlp` or NIP-57 event cryptography. Therefore the optional classic Lightning Address and NIP-57 fields are retained as presentation metadata, while supported payments use each goal's direct LNURL-pay URL. This extension never claims to verify Nostr signatures or issue NIP-57 receipts.

The WASM host does not support internal wallet transfers, so the actual movement of sats to a target wallet must be performed externally. However, **automated scheduling is supported** via the [Scheduler extension](https://github.com/bitkarrot/scheduler) — see [Automated sweeps](#automated-sweeps) below.

## Install

For a local checkout, add this repository's archive to a manifest served by LNbits, install `zapgoalswasm` from **Manage Extensions**, enable it for a user, and grant the requested storage/invoice permissions. The API is mounted at `/api/v1/ext/zapgoalswasm`; the authenticated page is `/ext/zapgoalswasm` and public pages are `/ext/zapgoalswasm/public/<goal-id>`.

## Use

1. Open ZapGoals and create a goal.
2. Select its receiving wallet, set the target amount and target date, then choose a payment mode.
3. Customize the goal colors, font family, and font weight.
4. Optionally enable recurring periods and configure the recurrence unit, interval, target wallet, sweep mode, and rollover mode.
5. Publish or copy the public goal URL. The page updates when tagged contribution invoices settle.
6. Use the **Embed** button to copy an iframe or script snippet for embedding on an external website.

The `vanilla` payment mode presents standard Lightning invoices, while `all` also enables Bitcoin Connect and its supported wallet connectors. Creators can configure one to four suggested zap amounts; contributors can select one or enter a custom amount and optional comment. Regardless of mode, only payments created for that goal count toward its progress.

## Recurring goals

A recurring goal reuses the same goal ID, public URL, LNURL endpoint, and embed snippet across multiple funding periods. At each period end, settled sats are swept and the progress counter resets for the next period.

### Setup

1. Create a goal and enable the **Recurring goal** toggle.
2. Choose a recurrence unit (daily, weekly, monthly, quarterly, semi-annual, or annual) and interval (e.g. every 1 month).
3. For monthly recurrence, optionally set a day of month (clamped to the last day of short months).
4. Select a **target wallet** — an LNbits wallet that will receive swept sats. The WASM host cannot perform internal transfers, so this field records the intended destination for external processing.
5. Choose a **sweep mode**:
   - **Target amount** — records `min(zapped, goal_amount)` as moved. Excess sats roll over.
   - **Entire amount** — records everything zapped this period as moved. No rollover.
6. Choose a **rollover mode**:
   - **Count excess as progress** — the next period starts with the rollover as its initial `currentAmount`.
   - **Reset to zero** — the counter drops to 0 each period (excess sats remain in the goal wallet).

### Manual sweeps

Because the WASM host does not support scheduling or internal wallet transfers, sweeps are triggered manually:

- Click the **sweep** button (broom icon) on a recurring goal in the admin panel.
- Alternatively, call `POST /api/v1/ext/zapgoalswasm/goals/{goalId}/sweep` with an authenticated session.

The sweep records the completed period in the ledger, advances the period index, computes the next period end date, and resets or rolls over the progress counter according to the configured mode. The actual transfer of sats to the target wallet must be performed separately.

### Automated sweeps

While the WASM host itself does not run a scheduler, the [Scheduler extension](https://github.com/bitkarrot/scheduler) can call the sweep-due endpoint on a cron schedule. This allows all due recurring goals to be swept automatically without manual intervention.

1. Install and enable the Scheduler extension.
2. Create a new scheduler job with:
   - **URL**: `http://127.0.0.1:5000/api/v1/ext/zapgoalswasm/recurring/sweep-due`
   - **Method**: `POST`
   - **Headers**: `Authorization: Bearer <your-api-key>` (or `X-Api-Key: <your-admin-key>`)
   - **Schedule**: e.g. `0 * * * *` (hourly) or `0 0 * * *` (daily at midnight)
3. The endpoint sweeps all recurring goals whose `periodEndDate` has passed, records each completed period, and advances to the next period.

The response returns a summary:

```json
{
  "swept": [{"goalId": "zg_...", "periodId": "zg_...", "movedAmount": 0, "rolloverAmount": 0, "newPeriodIndex": 1}],
  "errors": [],
  "totalDue": 1,
  "totalSwept": 1
}
```

The actual transfer of sats to each goal's target wallet must still be performed separately — the WASM host cannot initiate internal wallet transfers.

### Period history

Each completed period is recorded in a ledger accessible via `GET /api/v1/ext/zapgoalswasm/goals/{goalId}/periods` (authenticated) and in the admin panel via the **history** button. Each row records the period index, start/end dates, total zapped, amount moved, rollover, and sweep timestamp.

## Embedding a goal on an external website

Any ZapGoal can be embedded on an external website using one of two methods. The embed dialog (accessible via the **Embed** button in the admin panel) lets you choose between them and copy the snippet.

### JS widget (recommended)

A `<script>` tag that injects a Shadow DOM widget directly into your page. Bitcoin Connect works natively because the script runs in your page's first-party context — `localStorage` and popups are not restricted.

```html
<script
  src="https://your-lnbits.example.com/ext-assets/zapgoalswasm/js/embed.js"
  data-goal="{goal_id}"
  async
></script>
```

The script auto-detects the LNbits server URL from its own `src` attribute. It creates a container element, attaches a Shadow DOM (for CSS isolation from your page), and renders the full goal card with all features: live progress, countdown, recurring badge, zap button, invoice QR, and Bitcoin Connect.

### Iframe (simple)

Renders the goal in an iframe. Simpler but Bitcoin Connect may not work due to browser security restrictions on `localStorage` in cross-origin iframes (Safari blocks this by default). Falls back to QR-only with an "Open full page" link when Bitcoin Connect fails.

```html
<iframe
  src="https://your-lnbits.example.com/ext/zapgoalswasm/public/{goal_id}/embed"
  style="width:100%;max-width:500px;height:600px;border:0;border-radius:1rem;"
  loading="lazy"
  title="ZapGoal"
></iframe>
```

### What the embed shows

Both methods display the same content as the public page: goal title, descriptions, progress bar with live updates, current/goal amounts, countdown timer, recurring period badge (if applicable), zap button with suggested amounts, custom amount input, BOLT11 invoice QR code, and Bitcoin Connect (if enabled on the goal).

### Technical notes

- Both methods use the public API (`GET /goals/{id}/public`, `POST /goals/{id}/invoice`) and WebSockets (`/api/v1/ws/{goal_id}`) for live updates — no authentication required.
- CORS is permissive on LNbits by default, so cross-origin embedding works without additional configuration.
- The JS widget uses Shadow DOM for complete CSS isolation — your page's styles won't affect the widget and vice versa.
- The iframe auto-resizes to fit the card content via `postMessage`.
- The JS widget is served at `/ext-assets/zapgoalswasm/js/embed.js` and the iframe page at `/ext/zapgoalswasm/public/{goal_id}/embed`.
- The JS widget imports Bitcoin Connect from `esm.sh` at runtime; the iframe uses the bundled `bitcoin-connect.js` static asset.
- On successful payment via Bitcoin Connect, the widget calls `setPaid({preimage: ''})` on the payment controller to close the modal. If Bitcoin Connect fails to initialize, both methods fall back to the QR invoice dialog.

### Security considerations

- The JS widget executes in your page's first-party JavaScript context. Only use it on sites you control.
- The iframe provides stronger isolation but may limit Bitcoin Connect's `localStorage` and popup access.
- Neither method exposes private wallet credentials, admin keys, or authenticated API keys. Only public goal and invoice creation endpoints are used.

## Public API

Routes are mounted below the extension's `/api/v1/ext/zapgoalswasm` prefix:

- `GET /goals/{goalId}/public` returns public presentation settings, `goalAmount`, `currentAmount`, `targetDate`, status, percentage, and payment identifiers.
- `POST /goals/{goalId}/invoice` with `{"amount": 21, "comment": "Great goal"}` creates a goal-tagged BOLT11 invoice.
- `GET /lnurl/{goalId}` and `GET /lnurl/callback/{goalId}` implement LNURL-pay callbacks.
- `POST /goals/{goalId}/sweep` manually triggers a period-end sweep for a recurring goal (authenticated).
- `GET /goals/{goalId}/periods` returns the per-period ledger for a recurring goal (authenticated).
- `/api/v1/ws/{goal_id}` is the LNbits core WebSocket used as a realtime invalidation signal; clients should re-fetch the public endpoint after a message.

Goal and direct invoice amounts use satoshis; LNURL callback amounts use millisatoshis; target dates are normalized to UTC.

## Development

Install Node.js, Rust, `cargo-component`, and the WASM target, then run:

```sh
npm install
make check
make build
make package
```

The frontend build precompiles Vue templates for the strict iframe CSP and bundles the pinned Bitcoin Connect dependency into same-origin static assets.

The local manifest entry is in `manifest.json`; a release archive must contain `config.json`, `wasm/module.wasm`, `wasm/wit/world.wit`, `storage/`, `templates/`, and `static/`.

## Project

Created by [bitkarrot](https://github.com/bitkarrot). Source code and releases are available in the [ZapGoals WASM GitHub repository](https://github.com/bitkarrot/zapgoalswasm).

## License

ZapGoals WASM is original software licensed under the [MIT License](LICENSE).
