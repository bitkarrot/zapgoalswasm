# Pure fixed-calendar accounting harness

This host-free Rust crate imports the production module directly:

```rust
#[path = "../../wasm/src/accounting.rs"]
pub mod accounting;
```

It uses only the `serde_json` and `time` versions already pinned in the WASM lockfile. No LNbits installation, live invoice, service, network, database, or WASM host is needed.

```sh
cargo test --locked --offline --manifest-path tests/accounting/Cargo.toml
```

Omit `--offline` on a machine whose Cargo cache has not yet fetched the locked dependencies. Optionally set `CARGO_TARGET_DIR` to a temporary build directory.

## Integration contract

```rust
pub fn project(
    goal: &serde_json::Value,
    receipts: &[serde_json::Value],
    as_of: u64,
) -> Result<Projection, String>;

pub struct Projection {
    pub goal: serde_json::Value,
    pub history: Vec<serde_json::Value>,
    pub totals: serde_json::Value,
}
```

**Always pass the original stored goal, never a previous `Projection.goal`. Never persist the projected goal over the original accounting inputs.** The stored `currentAmount` is the immutable opening balance (zero for new goals; preserved legacy balance otherwise). The stored schedule and first index likewise remain immutable. A repeat projection reads receipts, not an earlier derived total.

### Goal input

- `id`: required nonempty string.
- `currentAmount`: nonnegative integer opening balance, default zero.
- `recurring`: boolean, default false.
- For recurring goals: positive integer `goalAmount`; `periodIndex` (first represented legacy index, default zero); `recurrenceUnit`, `recurrenceInterval`, `recurrenceDayOfMonth`; `sweepMode`; `rolloverMode`.
- First end: valid `periodEndDate`, otherwise valid `targetDate`.
- First start: valid `periodStartDate` strictly before the first end, otherwise `createdAt`. The fallback must itself be before the first end.
- `createdAt` can be Unix seconds as a number or string, or RFC3339. Date parsing in projection preserves RFC3339 fractional precision.
- New goal integration must store an RFC3339 `periodStartDate` representing creation time and `periodEndDate = targetDate` at creation.
- Fixed rules, interval validation at write, rejection of ordinary-to-recurring conversion, and prohibiting accounting-rule edits are caller responsibilities. The pure module validates the input it sees, not the history of configuration changes.
- Public goal reads must include all these accounting inputs, notably opening `currentAmount`, stored first index/start/end, recurrence day, sweep mode, rollover mode and creation time. Missing optional rules use defaults and therefore must not be accidentally hidden by public policy when the goal actually uses nondefault rules.

### Receipt input

- Only `verified: true` receipts contribute. Missing/false verification denotes legacy tombstones and is ignored without parsing old receipt fields.
- Every contributing row needs matching `goalId`, a positive integer `amount`, and `issuedAt` (Unix seconds number/string or RFC3339).
- `issuedAt` is the immutable, privately verified issuance-record creation time, not payment delivery time or a new `now()` on replay.
- The caller verifies invoice binding, actual receiving wallet, settled status, and invoice/receipt amount before writing the receipt.
- `id` is optional for this pure projection to permit privacy-filtered inputs. If present it must be a nonempty string, and duplicate verified IDs are rejected. The listing layer must independently guarantee unique payment hashes and complete membership even when IDs are omitted from the projection inputs.
- A verified receipt before the first represented start is allocated to the first represented period; it is never silently dropped.
- A verified receipt issued after `as_of` is an explicit clock-consistency error, not omitted from the total. Capture `as_of` after completing a stable receipt read; retry with fresh time when necessary.

### Stable-read prerequisite (caller)

Receipts must be immutable and undeletable. Page them in fixed ID order, capture total `N`, require every page's total to equal `N`, require unique hash count to equal `N`, and perform a final count check equal to `N`. Retry the whole read up to three times on insertion churn, then fail clearly. Do not publish a partially accumulated result. Identical concurrent duplicate upserts do not change membership or accounting.

Use the existing stock public-scoped pagination host method and policies for public totals. Verify its public sort-field restrictions when exposing the needed sort key; this pure module does not grant storage permissions or perform pagination.

### Output

`goal` is a clone of the supplied goal. For recurring goals it replaces only derived `currentAmount`, `targetDate`, `periodIndex`, `periodStartDate`, and `periodEndDate`; for nonrecurring goals it replaces only `currentAmount`.

`history` contains the newest 100 closed periods in **newest-first** order. Each row contains:

- deterministic `id = goalId:periodIndex`, goal ID, original-index period label;
- `startDate`, `endDate`, and `completedAt = endDate` (scheduled boundary, not an execution timestamp);
- `openingAmount` (incoming carry), `receivedAmount` (issuance-allocated receipts), and `zappedAmount` (their sum);
- `movedAmount` (accounting allocation only), `rolloverAmount` (actual next-period carry), `retainedAmount` (reset-excluded excess);
- sweep/rollover modes; `accountingOnly: true`; `latePaymentsMayRevise: true`.

`totals` contains:

- `openingAmount`, `receiptAmount`, `totalAmount`;
- `movedAmount`, `retainedAmount`, `currentAmount`;
- `verifiedReceiptCount`, `closedPeriods`, `accountingOnly: true`.

Lifetime here means from the preserved opening balance/first represented period, not a recomputation or certification of older legacy history.

The module checks:

```text
totalAmount = openingAmount + receiptAmount
            = movedAmount + retainedAmount + currentAmount

closed-period zappedAmount = openingAmount + receivedAmount
                           = movedAmount + rolloverAmount + retainedAmount
```

Amounts in closed history may change when a late-paid invoice arrives, but its issuance allocation never changes. At the active period no target allocation happens yet: all incoming carry and receipts remain in `currentAmount`. A boundary closes at `as_of >= end`; issuance exactly at `end` belongs to the next period.

There are **no stored closures, reset writes, transfers, financial locks, mutable goal totals, or sequence-number dependencies** in this module. HTTP due sweeps and public/private views can all call the same projection over a stable receipt snapshot.

## Calendar and limits

All calendar arithmetic is UTC. Each boundary is calculated from the immutable first end plus an absolute step. Monthly explicit day-of-month is respected; otherwise the effective day remains the first end's day. Clamping a short month never changes the anchor for a later month, including quarterly/yearly schedules and leap years.

Public helpers:

```rust
parse_timestamp(&Value) -> Result<u64, String>
normalize_date(&str) -> Result<String, String>
calendar_boundary(first_end: &str, unit: &str, interval: u64,
                  day_of_month: u64, step: u64) -> Result<String, String>
```

`parse_timestamp` rejects nonzero fractional seconds rather than silently rounding a persisted integer. Projection itself supports fractional RFC3339 inputs accurately. `calendar_boundary` step zero is the supplied first end; all later steps retain that anchor.

The budget is **10,000 periods including the active period**, so at most 9,999 closed periods can be projected. Exceeding the budget, arithmetic/date/index overflow, malformed verified data, an invalid schedule, or a backward clock produces an explicit error. History retention at 100 does not truncate lifetime totals.

## Coverage

The harness covers nonrecurring and legacy opening balances, ignored legacy receipts, target/entire allocation, carry and reset-excluded conservation, exact and subsecond boundaries, pre-start issuances, late settlement/replay, deterministic simultaneous sweep projections, presentation races, permutation independence, leap/month-end anchoring, legacy date fallbacks, bad rules/timestamps, duplicate and cross-goal verified receipts, checked arithmetic, the 10,000-period limit, totals beyond the 100-row history window, and 12,345 unsorted receipts. A deterministic matrix checks conservation across all six recurrence units, both sweep modes, both rollover modes, and multiple view times.
