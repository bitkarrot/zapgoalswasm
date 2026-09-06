# ZapGoals WASM

ZapGoals WASM is a port of the classic LNbits ZapGoals extension for the current LNbits WASM extension runtime. It creates customizable public Lightning funding goals with wallet-specific accounting, direct invoices, LNURL-pay endpoints, and live progress.

## Features

- Create, edit, list, publish, and delete funding goals.
- Choose a receiving wallet and set target amount/date.
- Configure descriptions, suggested contribution amounts, colors, fonts, and payment mode.
- Public goal page with suggested/custom amounts, QR-ready BOLT11 invoices, optional comments, and Bitcoin Connect mode.
- Live payment subscription with a paid checkmark and immediate public progress refresh.
- Direct LNURL-pay metadata/callback routes using millisatoshi protocol amounts.
- Progress is based only on settled invoices tagged to that goal and payment hashes are processed idempotently.
- Responsive Quasar UI matching the classic extension in light and dark modes.
- Least-privilege WASM storage and public-invoice permissions.

## Current WASM boundary

The current LNbits WASM host contract does not expose a safe extension hook for owning `/.well-known/lnurlp` or NIP-57 event cryptography. Therefore the optional classic Lightning Address and NIP-57 fields are retained as presentation metadata, while supported payments use each goal's direct LNURL-pay URL. This extension never claims to verify Nostr signatures or issue NIP-57 receipts.

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

## Local LNbits installation

For a local checkout, add this repository's archive to a manifest served by LNbits, install `zapgoalswasm` from **Manage Extensions**, enable it for a user, and grant the requested storage/invoice permissions. The API is mounted at `/api/v1/ext/zapgoalswasm`; the authenticated page is `/ext/zapgoalswasm` and public pages are `/ext/zapgoalswasm/public/<goal-id>`.
