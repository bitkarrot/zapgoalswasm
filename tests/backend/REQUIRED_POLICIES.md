# Parent integration: required config changes (not applied here)

Read against the actual local host at `/home/exedev/lnbits/lnbits/core/wasm_ext/api/{host,models,permissions}.py` and `wasm/events.py`.

Add this permission exactly (append normalizer uses `table`, NOT `table_name`):

```json
{
  "id": "ext.storage.append_public",
  "description": "Record private goal-bound invoice issuances before invoice creation",
  "policies": [{
    "table": "invoice_issuances",
    "source_table": "goals",
    "source_id_field": "goalId",
    "allowed_fields": ["amount", "createdAt"],
    "max_rows_per_source": 10000
  }]
}
```

The host resolves the private source goal's owner, injects goalId, generates a uuid4 hex row ID, and commits storage before returning it. Do NOT grant public read to invoice_issuances. Do NOT allow goalId/id in allowed_fields. Limit 10000 matches host default; at cap invoice creation must fail closed until an approved retention policy (no automatic deletion).

Add this policy to existing `ext.storage.read_public` (read normalizer does use `table_name`). Fixed-calendar public projections require complete receipt fields and the public sort key `id`:

```json
{"table_name": "payment_events", "public_fields": ["id", "goalId", "verified", "amount", "issuedAt"], "source_id_field": "goalId"}
```

The public goal policy additionally needs `archived`, `accountingVersion`, `periodStartDate`, `periodEndDate`, `periodIndex`, `createdAt`, `currentAmount`, `recurrenceDayOfMonth`, `recurrenceUnit`, `recurrenceInterval`, `rolloverMode`, and `sweepMode` for accurate projection. Keep walletId and targetWalletId private. The status export still returns ONLY `{paid:boolean}`; the broader filtered receipt reads are used internally for totals. No issueId is publicly readable.

New stock-host import: `storage-get-public-paginated`, request `{table, source-id, filters-json, search, search-fields-json, sort-by, descending, limit, offset}` and ordinary storage-paginated-response. Inspected host enforces source_id into goalId filter and requires sort_by=id to be in public_fields.

Add public WASM export `invoice-status` and API route:

```json
{"method": "GET", "path": "/goals/{goalId}/payments/{paymentHash}", "export": "invoice-status", "auth": "public", "ownerContext": {"table": "goals", "idParam": "goalId"}}
```

Remove `lnurl-params` and `lnurl-callback` exports and both LNURL routes. Remove LNURL claims from config descriptions. Retain existing private read/write and goal-bound `wallet.create_invoice_public` policy.

Host signature verified: storage-append-public request `{table: string, source-id: string, data-json: option<string>}` -> `{id: string}`. `data_json` maps to request.data via host model validator. Event root fields are walletId, paymentHash, amount (msats), pending, status, extra. Invoice extra is host-namespaced as extra_zapgoalswasm.

Never deploy/restart or generate bindings as part of this backend task. Parent owns build/config changes. Existing payment events default verified=false and never become status proof automatically. Historical invoices without private issuance remain quarantined pending approved reconciliation.


## Stock invoice metadata ABI correction

`create-invoice-public-request` MUST use `extra: list<tuple<string,string>>`, not `extra-json`. The stock runtime explicitly converts native extra lists to a dict; `CreateInvoicePublicRequest` has no `parse_extra_json` alias and silently ignores that unknown field. All metadata is string-valued, including decimal sats in `amount`; the settlement verifier parses that decimal string and still compares actual msats against the private integer issuance amount. `issueId` remains private and only goes into this native extra metadata, not response or memo. Regression: `tests/backend/stock_invoice_abi.py` executes the actual local stock conversion/model and passed. No host modification is needed.

## Manual sweep permissions (v0.5.0)

Add both plain permissions (verified against the stock host's method registry;
they are not policy-aware):

```json
{"id": "wallet.create_invoice", "description": "Create internal sweep invoices on the user's target wallet"},
{"id": "wallet.pay_invoice", "description": "Pay sweep invoices from the goal's receiving wallet"}
```

The stock host enforces wallet ownership for both: `wallet.user == user_id` for
the authenticated invocation, so a sweep can only create an invoice on a wallet
the owner already controls and pay from the goal's own wallet. New WIT imports
(mirroring the host's pydantic models, extra as native string pairs):

```
record create-invoice-request { wallet-id: string, amount: f64, currency: string, memo: string, tag: string, extra: list<tuple<string, string>> }
create-invoice: func(req: create-invoice-request) -> create-invoice-response;
record pay-invoice-request { wallet-id: string, payment-request: string, max-sat: option<u64>, description: string, extra: list<tuple<string, string>> }
record pay-invoice-response { ok: bool, error: option<string>, checking-id: option<string>, payment-hash: option<string>, status: option<string>, amount-msat: s64, fee-msat: s64, pending: bool, success: bool }
pay-invoice: func(req: pay-invoice-request) -> pay-invoice-response;
```

Migration 006 adds the private `sweeps` ledger (marker rows keyed
`sweep:{goalId}:{closedPeriods}`; attempt nonce, amount, target, payment hash,
status). `sweep-goal` is now the owner-only transfer action; `list-periods`
and `sweep-due` stay read-only. Sweep target-invoice settlement events carry
sweep metadata but no issuance binding, so `on-invoice-paid` quarantines them.
