.PHONY: build check package test test-python test-state test-backend test-browser

PYTHON ?= python

build:
	$(PYTHON) tools/check_toolchain.py
	npm run build
	cargo component build --manifest-path wasm/Cargo.toml --locked --release
	cp wasm/target/wasm32-wasip1/release/zapgoalswasm.wasm wasm/module.wasm

check:
	$(PYTHON) tools/check_toolchain.py
	npm run build
	$(PYTHON) -m json.tool config.json >/dev/null
	$(PYTHON) -m json.tool storage/schema.json >/dev/null
	$(PYTHON) -c "import json,pathlib; [json.loads(p.read_text()) for p in pathlib.Path('storage/migrations').glob('*.json')]"
	cargo component check --manifest-path wasm/Cargo.toml --locked

package: build
	$(PYTHON) tools/package.py

test-python:
	$(PYTHON) -m pytest -q tests/test_config.py tests/test_web_assets.py tests/test_distribution.py

test-state:
	node --test tests/payment-state.test.cjs

test-backend:
	cargo test --locked --manifest-path tests/backend/Cargo.toml --lib
	cargo test --locked --manifest-path tests/accounting/Cargo.toml

test-browser:
	node node_modules/@playwright/test/cli.js test tests/payment-dialog.spec.cjs tests/widget.spec.cjs --workers=1 --output=/tmp/zapgoalswasm-browser-results

test: test-python test-state test-backend
