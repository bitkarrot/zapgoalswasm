# ZapGoals WASM

Build public, customizable Lightning funding goals. Select a receiving wallet, set a target, publish a public page, and accept BOLT11 or LNURL-pay contributions. Goal progress counts only settled invoices created for that goal.

This WASM port supports direct goal LNURL-pay URLs. Lightning Address routing and NIP-57 signature/receipt processing require host capabilities not currently exposed to WASM and are intentionally not advertised as supported.
