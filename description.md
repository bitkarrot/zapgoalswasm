# ZapGoals WASM

Create branded public Lightning funding goals with targets, deadlines, suggested contributions, configurable colors and fonts, and verified progress.

**Invoice-only:** supporters scan a locally generated QR or copy a BOLT11 invoice into any Lightning wallet. There is no Bitcoin Connect, wallet-mode selector, payer credential, CDN, or third-party QR request.

## Features

- Public goal pages and a multi-goal JavaScript widget.
- Suggested/custom whole-satoshi amounts and optional comments.
- Private invoice issuance binding and receiving-wallet/amount verification.
- Durable receipt checks: socket broadcasts alone never confirm payment.
- Fixed UTC calendar periods with immutable financial rules and derived history.
- Explicit allocation, rollover, and retained excess accounting, with **manual sweeps** that transfer allocated sats to a target wallet you own.
- Goal archiving that preserves receipts and existing invoice settlement.

Recurring periods advance automatically from their fixed calendar. Late payments update the invoice's original period and subsequent carry; history is a projection, not a frozen transfer record. Changing a recurring goal's financial rules requires a new goal.

Sweeps are manual, owner-confirmed transfers between your own wallets; nothing is ever sent automatically. This extension respects the stock LNbits WASM sandbox. Bitcoin Connect, LNURL-pay, Lightning Addresses, NIP-57, manual/early resets, and external iframe embedding are not offered. The supported embed is a first-party JavaScript widget for websites you control.

An upgrade from 0.3.x preserves the old displayed balance as an **unreconciled opening balance**, retains legacy records without recounting them, and quarantines old invoices lacking a private issuance record. Review the upgrade instructions and reconcile outstanding old invoices before cutover.

Created by bitkarrot. MIT licensed, with the retained QR generator's notices included.
