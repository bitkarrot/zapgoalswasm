.PHONY: build check package

build:
	npm run build
	cd wasm && cargo component build --release
	cp wasm/target/wasm32-wasip1/release/zapgoalswasm.wasm wasm/module.wasm

check:
	npm run build
	python -m json.tool config.json >/dev/null
	python -m json.tool storage/schema.json >/dev/null
	python -m json.tool storage/migrations/001_init.json >/dev/null
	python -m json.tool storage/migrations/002_payment_events.json >/dev/null
	python -m json.tool storage/migrations/003_payment_new_total.json >/dev/null
	cd wasm && cargo component check

package: build
	python tools/package.py
