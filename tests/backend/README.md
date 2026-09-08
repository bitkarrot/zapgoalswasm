# Portable backend security and fixed-calendar integration harness

Run from the repository root:

```sh
CARGO_TARGET_DIR=/tmp/zapgoals-backend-target cargo test --offline --locked --manifest-path tests/backend/Cargo.toml --lib
CARGO_TARGET_DIR=/tmp/zapgoals-accounting-target cargo test --offline --locked --manifest-path tests/accounting/Cargo.toml
```

`--offline` requires the existing pinned dependencies to be cached; omit it only for an initial dependency fetch on another machine. The backend harness compiles the **actual** `wasm/src/lib.rs` and its production accounting module with an in-memory host. It generates no WIT bindings, WASM artifact, real invoice, LNbits instance, or network payment. Use `--lib` for this standalone backend harness.

## Verification

**47 backend integration tests + 31 pure accounting tests pass.** Coverage includes:

- Private issuance append-before-invoice, early settlement before the invoice host returns, append permission/cap failures and orphan issuance after invoice-host failure.
- Strict root success/pending/wallet/hash and private issuance goal/amount binding; no trust in nested/client metadata, guessed issuance IDs, or legacy unverified receipts.
- Deterministic receipt-only settlement: `issuedAt` and `processedAt` are the private issuance creation timestamp; no mutable goal totals, delivery timestamps, duplicate-recovery snapshots, or receipt rewrites.
- Stable public/private ID-ordered pagination, unique membership, every-page and final-count checks, three whole-read retries, insertion churn failure, duplicate-page rejection, and **12,345 receipts** without truncation.
- Fixed UTC calendar projection for all public/private views, history and both read-only sweep exports; late settlement revises its issuance period without resurrecting totals.
- Immutable stored opening balance/schedule; partial presentation saves preserve accounting/private fields; archive retains all inputs and still accepts late settlement but denies new invoices. Edit upserts contain only mandatory SQL columns plus requested presentation fields (and forced vanilla wallet mode); archive upserts contain mandatory columns plus `archived=true`. No edit payload includes `archived` or accounting/schedule state. A paused-edit → archive → resumed-edit test verifies archive remains true and the response projects a fresh reread. Already archived goals reject edits. Payload-key assertions guard this contract.
- Canonical hex hash validation applies only to verified receipts; nonhex legacy tombstone IDs remain readable and ignored by accounting.
- Accounting edit locks: wallet and recurring conversion always locked; recurrence rules always locked; recurring goal amount/date locked. Ordinary goal amount/date remain editable. Accounting/projection fields cannot be PUT.
- RFC3339 validation, UTC/month-end/leap-year boundaries, real creation-time initial start, and public receipt-only status proof.

The stock invoice ABI uses `extra: list<tuple<string,string>>`, with every metadata value a string (including decimal `amount`). The stock runtime converts that list to a dict before `CreateInvoicePublicRequest` validation; `extra-json` is silently ignored by that model and must not be used. `stock_invoice_abi.py` executes the actual checkout's record conversion, normalizer and request model without importing its application or invoking invoices:

```sh
/path/to/lnbits/.venv/bin/python tests/backend/stock_invoice_abi.py --lnbits-root /path/to/lnbits
```

This boundary regression passes against the local stock host. Full component execution still belongs to parent-managed isolated host integration after the rebuilt artifact is approved.

The mock models the inspected stock host interface and policies, not runtime/storage transactions. Parent owns the real component build and isolated stock-host integration. No live action was performed.

## Data and response contract

Stored `currentAmount` is an immutable opening balance: zero with `accountingVersion=1` for new goals; existing balance preserved with migration default `accountingVersion=0`. Legacy receipt defaults are `verified=false`, `issuedAt=""`; they remain tombstones, not contribution inputs. Existing period rows are preserved but never read/written by fixed-calendar views.

Goal views return projected accounting fields plus `totals`, `accountingTotals` (same object, UI alias), `accountingOnly=true`, and `legacyOpeningUnverified`. Never persist this projected result over the original accounting inputs.

- `sweep-goal`: `{goalId, accountingOnly:true, readOnly:true, goal, data:history, totals}`.
- `list-periods`: `{total:closedPeriods, data:latest100History, totals, accountingOnly:true, latePaymentsMayRevise:true}`.
- `sweep-due`: `{data:[{goalId,goal,totals}], total, accountingOnly:true, readOnly:true, totalSwept:0}`. Includes all nonarchived recurring goal projections, performs no writes or transfers.
- `delete-goal`: archives rather than deleting; `{archived:true, goalId}`. Public archived views/status remain readable, owner list excludes archived goals.
- `invoice-status`: unchanged `{paid:boolean}` only; it never exposes private wallet or issuance ID.

Quarantine means ignored + warning log + `quarantined=true`, with no receipt/goal mutation. It is not a reconciliation queue. Historical credit reconciliation and automatic issuance cleanup are not implemented. The issuance cap fails closed; no financial transfer or closure jobs exist.
