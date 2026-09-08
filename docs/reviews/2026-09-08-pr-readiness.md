# ZapGoals WASM: upstream directory readiness review

**Date:** September 8, 2026  
**Reviewed release:** `v0.3.1`, source commit `ed31863500413105c337202fa5740fa5ca111e9a`  
**Verdict:** **Do not submit this release unchanged.** Reproducible builds and passing existing tests do not cover the security, accounting, payment-state, and stock-host compatibility failures below.

This is a review, not an implementation change. No production files, databases, payments, services, releases, or directory branches were changed. Only this report is committed; it has not been pushed. All reproduction writes/payments were mocked or confined to isolated in-memory storage. No real payment was made and no live invoice was created. The existing browser harness permits only the host's in-memory sandbox-frame handshake POST.

## Reviewed upstream identities

Checked the actual GitHub branch/release heads, not stale local tracking refs:

- Directory `lnbits/lnbits-extensions-wasm`: main `7b8a2b191e5fa7c5262c843a6f9d41575feefb4b`.
- LNbits stable `v1.6.0`: `d941f0a3f94bea94ff6dc1f34a993f8a6aa5934f`, released September 2, 2026.
- LNbits dev: `5ca442bbd20714ce57e4b34f5d6ba9b5a6bc9eec`.
- Local LNbits: `e8c2691f58a1744d75b6edc062e0c7d92c4d9118`, with three private September 8 sandbox changes over its rc3 base.
- Local directory fork: `4b6df50c802278cd0451fd0eaf46b3e1027aa33c`, four commits ahead and nine behind actual upstream at review time.

Primary sources were fetched read-only using GitHub REST/public downloads. The directory page was also opened in the browser. The current upstream event dispatcher was independently downloaded and is byte-identical to the local dispatcher used in isolated proofs. No separately documented directory contribution guide or CI was present; archive validation used the current upstream `update_version.py` and host models rather than invented requirements.

## High-priority findings

### R1 — Foreign-wallet payments can forge another user's goal progress

**Anchor:** `wasm/src/lib.rs:261-266`, credit at `:277-287`.

The settlement handler trusts caller-controlled payment metadata to choose a goal. It never compares the event's actual receiving `walletId` with the goal's private `walletId`, or verifies an extension-issued invoice binding. Core invoice creation accepts extension/extra metadata; the stock host derives the event's owner context from `source_id`, not the receiving wallet. Event-only export visibility therefore does not prevent this path.

**Proof:** isolated execution of the actual host dispatcher selected a victim owner for a payment received by an attacker wallet. The exact Rust handler credited the victim goal by **100 sats**, although that wallet received none. No real attacker invoice or payment was created.

**Required correction:** validate the actual receiving wallet before crediting and establish trustworthy invoice-to-goal/amount binding. Do not treat `extension`, `tag`, or `source_id` alone as authenticated invoice origin. Consider the corresponding host trust-boundary hardening with upstream. This is goal-accounting forgery, not evidence of unauthorized wallet spending.

### R2 — Concurrent edits/sweeps corrupt settled accounting

**Anchors:** `wasm/src/lib.rs:204-209`, `:281-287`, `:318-326`, `:343-350`.

Whole-goal read/modify/write operations are not atomic across independently instantiated WASM invocations. An edit writes stale financial fields back alongside presentation changes. Concurrent sweeps create unrelated random ledger IDs for the same period. Host storage calls have individual transactions, not a transaction surrounding the whole export.

**Proofs:**

- Pause an edit after reading total 0; credit and record a 100-sat event; resume the edit. Final goal total is **0**, with the hash already recorded as processed.
- Two sweeps reading the same 100-sat period both succeed. Two period-0 rows claim **200 sats moved in total**, while the goal advances only once.

**Required correction:** separate presentation writes from accounting and use a shared host-level transaction/CAS/serialization mechanism for financial mutations. Make period closure uniquely keyed and retry-safe. A Rust static mutex does not coordinate separate component instances. The stock event queue itself is serial; these proofs use HTTP edit/sweep races, not an assumed concurrent event queue.

### R3 — Duplicate settlement resurrects a completed period's funds

**Anchor:** `wasm/src/lib.rs:267-275`.

Duplicate recovery raises the current total to a historical receipt's `newTotal`, with no period identity. A legitimate reset is mistaken for an incomplete earlier credit.

**Proof:** settle 100 sats, close period 0 (current total becomes 0), replay the same event. The handler reports a duplicate but restores **100 sats**. A second closure records **200 sats accounted as moved from only 100 settled**.

**Required correction:** period-scoped receipt/recovery state and atomic completion semantics. Duplicate delivery must not restore completed-period progress. The proof calls the exact handler with mock storage; it does not claim a live replay occurred.

### R4 — Bitcoin Connect is not compatible with stock LNbits sandbox networking

**Anchors:** `static/js/public.js:47-64`, `templates/public.html:36-40`; upstream `lnbits/core/wasm_ext/routes/security.py:38-58` and `lnbits/static/js/wasm-extension-component.js:10-21`.

Stable v1.6.0 and current dev both enforce `connect-src 'none'` and an opaque-origin sandbox. Local private commits `78181b5`, `70cf014`, and `e8c2691` relax network/styles and add same-origin privileges. The current successful local connector tests depend on that different host policy.

**Browser proof:** restored exact stock CSP and sandbox only in intercepted browser responses, leaving the service untouched. The actual Bitcoin Connect LNbits provider attempted wallet lookup and payment; Chromium blocked both with `connect-src` violations **before even the mocked network handlers**. The invoice remained pending. Closing the modal exposed the main page's working, locally generated QR fallback.

**Required correction:** use approved host-mediated capabilities or explicitly disable/scope unsupported connectors and advertise the supported fallback honestly. Raising the minimum version to 1.6.0 does not fix this. Do not weaken the host's sandbox as an incidental extension workaround. This proof covers network-requiring connectors; it is not a claim that every conceivable external wallet action fails.

### R5 — Two JS widgets can both invoice the last goal

**Anchor:** `static/js/embed.js:3-6`; generated async snippet at `static/js/index.js:13`.

The widget selects the last matching script in the document rather than its executing script. With two async tags parsed before either loads, both initializations use the second tag's goal/server and placement.

**Proof:** two distinct goal tags produced two requests for the second goal, none for the first, and two widgets beside the second tag. Payment creation consequently targets that second goal. This can misdirect contributions relative to the embedding site's intended placement; the rendered title also becomes the second goal's title.

**Required correction:** capture `document.currentScript` synchronously, derive configuration only from it, and add a multiple-widget regression.

## Other functional corrections needed before presenting these features as ready

### R6 — LNURL-pay response fails the host's own parser

**Anchor:** `wasm/src/lib.rs:241`; callback processing at `:243-252`.

The callback is a relative path, and the host returns it unchanged. Passing the exact response to installed `LnurlPayResponse` fails with `invalid or missing URL scheme`; adding an absolute HTTPS origin makes the control pass. A read-only live metadata GET independently confirmed the relative callback.

Use a trusted external base URL, not an unvalidated caller-supplied origin. Also audit the callback's invoice metadata binding: it delegates to ordinary invoice creation, while the used host API supplies plain memo/extra rather than LNURL metadata-description-hash fields. Fixing just the URL is not sufficient evidence of complete LNURL interoperability. Until supported end-to-end, remove or qualify the LNURL-pay claim.

### R7 — Turning an existing ordinary goal into recurring leaves an empty schedule

**Anchor:** `wasm/src/lib.rs:138-142`; ledger write before validation at `:318-335`.

Nonrecurring goals store empty period strings. Enabling recurrence preserves them because an empty string is still `Some`. Sweep-due skips the goal indefinitely; manual sweep writes a completed ledger row before date parsing fails.

**Proof:** enable recurrence on a goal with a valid target date; saved `periodEndDate` remains empty. Two failed manual attempts leave two period-0 history rows without advancing. A new recurring goal also accepts `targetDate: "not-a-date"` and reproduces the history corruption.

Initialize period fields on false-to-true transitions, validate RFC3339 dates on write, calculate the next period before committing a completion, and make retries safe. Separately, `lib.rs:83` clamps every configured monthly day 29–31 to 28: March 31 plus one month with day 31 returns April 28 rather than April 30. Clamp only against the target month's actual length.

### R8 — Main-page stale refresh can detach the next invoice

**Anchor:** `static/js/public.js:90-94`.

The completed invoice's refresh timer survives Done and a new payment. It reads mutable attempt state, then clears the current modal controller and subscription.

**Proof:** A settles; Done; create B; another contribution raises the authoritative goal total; A's old timer runs. B remains pending but has neither its controller nor subscription. Verified receiver settlement can no longer close it through that watcher.

Bind refresh work to an immutable attempt generation, cancel it on teardown/new attempts, and never let an old refresh clean up a new invoice.

Two related main-page gaps were also reproduced:

- `templates/public.html:29` and `static/js/public.js:39-44,72`: amount remains editable during invoice creation. Submit 21, change the input to 500 while awaiting the API, settle: a starting total 10 displays **510**. Snapshot the actual invoice amount and allow authoritative correction.
- `static/js/public.js:44`: rejected bridge subscription aborts before either wallet UI or QR fallback, stranding an already-created invoice. Monitoring failure must not hide usable BOLT11/QR.

### R9 — Both embeds still have old payment lifecycle defects

**Anchors:** `static/js/embed.js:187-191,224-242`; `static/js/embed-page.js:138-143,190-205`.

Both retain empty-preimage `setPaid()` rather than the fixed main state machine. The actual bundle leaves the modal for about three seconds; this proof does **not** establish indefinite sticking. More seriously, queued old callbacks replace a subsequent amount dialog with a false receipt, cancellation hides the existing invoice instead of offering QR, and the iframe drops its subscription ID without unsubscribing.

Port attempt identity, cancellation/fallback, timer invalidation, and cleanup regressions to both embeds. A guarded test confirmed these bugs with a real visible Bitcoin Connect modal on the patched host, not only a stubbed provider.

### R10 — Advertised iframe integration is blocked; embed QR uses a third party

**Anchors:** `README.md:117-143`, `static/js/index.js:12,32`, `static/js/embed-page.js:151`, `static/js/embed.js:201`.

Both stock and local WASM wrapper responses send `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. An external website cannot embed the advertised iframe URL. A JavaScript widget is a separate integration, not a fix for those iframe headers.

Inside stock sandboxing, iframe Bitcoin Connect also fails initialization on localStorage because this template lacks the main storage shim. Its fallback QR requests `api.qrserver.com`, which stock `img-src` blocks: the BOLT11 textarea renders but the image has natural width 0. The standalone JS widget is outside that CSP and does issue a request containing the full invoice to that unrelated QR service. All such proof requests were intercepted, never sent externally.

Generate QR locally, restrict unsupported connector behavior, and remove/qualify external iframe support unless a supported host route exists. The QR issue exposes payment-specific data, not wallet-admin keys; stock iframe CSP prevents that disclosure while also breaking the image.

### R11 — Sweep execution UI promises transfers that do not happen

**Anchors:** `templates/index.html:79`, `static/js/index.js:39`.

The confirmation says sats will be moved to the target wallet and the success toast says “Moved X sats,” despite the documented accounting-only host limitation. This is not a demand to implement unsupported transfers: the execution-time wording must say no funds are transferred and that the recorded amount needs external handling.

## Release / directory preparation

1. **Missing distribution notices:** `tools/package.py:10` excludes root `LICENSE` and dependency notices. The 29-file release contains none; bundled JS references absent `index.js.LICENSE.txt`. Include project license and applicable bundled third-party notices, including the LNC dependency's supplied notices. This is missing distribution material, not a comprehensive legal audit.
2. **Inaccurate screenshots:** `config.json:37` publishes `screenshots/design-preview.png` showing Nostr recipient and Lightning Address fields that README explicitly excludes. Recapture actual WASM UI rather than advertising unsupported features.
3. **Blocked tile:** `config.json:10` points to SVG, but the host static MIME allowlist rejects SVG. Use the included PNG. The existing test only checks file existence.
4. **Stale/noisy PR branch:** the fork's proposed diff is 264 additions/247 deletions due to manifest reformatting, and a three-way merge against actual upstream conflicts. Start a clean branch at upstream, preserve its Gift Cards v0.1.4 entry and formatting, and add only the intended explicit release entry/category. A stale fork tree replacement would omit that upstream release; the three-dot PR diff does not itself claim to delete it.
5. **Alternate manifest still selects rejected source ZIP:** repo-discovery `manifest.json` uses GitHub's source archive, which contains forbidden Python test/build files. The directory's explicit install-asset URL is correct; clarify/fix the documented alternate path.
6. **Provenance nits:** Cargo/component metadata remains 0.1.1 while config is 0.3.1. No pinned Rust toolchain or locked-build command is documented. Package order/ZIP timestamps are not normalized. The actual rebuilt module does match, so these are not evidence of a stale binary.

## Positive verification / limits

- Clean isolated checkout: **`make check` and `make package` pass**.
- Rebuilt WASM module, Bitcoin Connect bundle, and both generated Vue templates are **byte-identical** to the committed release assets. No generated application file was changed in the real checkout.
- Official install ZIP SHA-256 matches manifest/checksums: `46dd3b4cc65ce96ece0cef6b3c53b77c41736415049a718f59b5696707c0efa0`.
- All **29 archive files** match immutable v0.3.1 source assets. Current upstream archive/config validation and WASM validation pass; 13 exports and the five required permissions match the used host interface.
- **5 configuration/assets Python tests**, **9 payment-state tests**, and **5 existing guarded payment-browser tests** pass. The browser passes apply to the locally patched host.
- **3 additional diagnostic browser proofs** reproduce stock connector blockage, stock iframe failure, and patched iframe lifecycle defects. Their passing assertions demonstrate defects, not stock compatibility.
- Isolated Rust/host reproductions confirmed foreign-wallet progress forgery, edit/credit and sweep races, replay inflation, recurrence transition/history corruption, monthly-date error, and LNURL parser rejection. Parent independently reran them.
- `npm audit` reports **zero advisories** for the installed locked JS dependency tree at review time. Cargo advisory tooling was unavailable; no complete Rust dependency/adversarial security audit is claimed.
- No cross-owner CRUD access, private wallet-key exposure, or reachable stored XSS was identified in the reviewed normal interfaces. Colors and suggested amounts are strictly validated; same-origin absolute bridge URLs and hash-socket payload shapes are valid, not findings.
- Did not run the older live-mutating `e2e.cjs` / `e2e-recurring.cjs`. Did not install or boot a separate full stock LNbits server: stock CSP/sandbox was applied in guarded browser responses, and upstream API/event contracts were inspected separately.

## Reproduction evidence retained locally

- `/tmp/zapgoalswasm-final-review.1UtJb0/`: clean build/package checkout.
- `/tmp/zapgoals-backend-review.ADApBm/`: exact-source Rust/mock-host harness, dispatcher/parser AST proof, logs, detailed backend report. Re-run with `cargo run --offline --manifest-path /tmp/zapgoals-backend-review.ADApBm/Cargo.toml` and `/home/exedev/lnbits/.venv/bin/python /tmp/zapgoals-backend-review.ADApBm/host_reproduction.py`.
- `/tmp/zapgoals-frontend-review.md`, `/tmp/zapgoals-frontend-review.cjs`, `/tmp/zapgoals-public-state-extra-review.cjs` and corresponding result JSON: offline UI/state proofs.
- `/tmp/zapgoals-stock-review/`: three guarded diagnostic browser specs, response-policy fixtures, JSON and screenshots.
- `/tmp/zapgoals-review-upstream/REVIEW.md` and neighboring files: immutable upstream snapshots, official ZIP, validators, asset/metadata checks, merge simulation.

These are review-time local artifacts, not a portable permanent regression suite. Convert the relevant proofs into maintained tests with the fixes.

## Recommended next step

Fix receiving-wallet/origin binding and transactional/idempotent accounting first. Then fix multi-widget/payment-state bugs and align advertised features with stock host capabilities without relaxing the sandbox. Add regression coverage, recapture screenshots/include notices, cut a new verified release, and prepare a minimal directory manifest PR from current upstream. Do not open the directory PR against unchanged v0.3.1.
