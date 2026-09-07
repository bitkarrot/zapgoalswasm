# ZapGoals WASM

ZapGoals lets LNbits users create branded public fundraising pages with a satoshi target, deadline, live progress bar, descriptive text, configurable colors and fonts, and suggested contribution amounts.

Supporters can contribute through Bitcoin Connect or standard BOLT11 invoices and QR codes. Each settled contribution updates every open goal page in realtime. Goal totals include only invoices issued for that goal, not unrelated activity in the receiving wallet.

## Features

- Public goal pages with targets, deadlines, countdowns, and realtime updates
- One to four configurable suggested zap amounts plus custom amounts and comments
- Bitcoin Connect wallet connections and standard Lightning invoice payments
- Custom colors, typography, titles, and text above or below the progress bar
- Public goal and invoice APIs for alternate frontends
- Direct LNURL-pay endpoints for each goal
- Recurring goals with period-end sweeps, rollover modes, and a per-period ledger (daily, weekly, monthly, quarterly, semi-annual, or annual cycles)
- Embeddable goal card via JS widget (Shadow DOM) or iframe for external websites

This WASM port runs in a sandboxed WebAssembly module. Lightning Address routing and NIP-57 signature/receipt processing require host capabilities not currently exposed to WASM and are not included. Internal wallet transfers for recurring sweeps are not supported by the WASM host; sweeps can be triggered manually from the admin UI or via the scheduler-compatible endpoint.

Created by [bitkarrot](https://github.com/bitkarrot). Source code and releases are available at [github.com/bitkarrot/zapgoalswasm](https://github.com/bitkarrot/zapgoalswasm).
