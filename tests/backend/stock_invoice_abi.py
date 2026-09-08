#!/usr/bin/env python3
"""Execute the stock invoice request model + ABI normalizers, with no LNbits app.

This is a boundary regression, not a Wasmtime component test. It executes the
actual checkout's functions/model rather than a handwritten imitation, and never
imports services, opens a database, invokes an invoice API, or changes host code.

Run using the checkout's existing Python environment:
  /path/to/lnbits/.venv/bin/python tests/backend/stock_invoice_abi.py --lnbits-root /path/to/lnbits
"""
import argparse
import ast
import importlib.util
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any


def function_node(path, name):
    tree = ast.parse(path.read_text(), filename=str(path))
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    # Execute the exact static method body standalone; no class/runtime imports.
    node.decorator_list = []
    return node


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lnbits-root", type=Path, required=True)
    root = parser.parse_args().lnbits_root.resolve()
    api = root / "lnbits/core/wasm_ext/api"
    models_path = api / "models.py"
    spec = importlib.util.spec_from_file_location("zapgoals_stock_abi_models", models_path)
    models = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = models
    spec.loader.exec_module(models)
    scope = {"Any": Any, "Mapping": Mapping, "BaseModel": models.BaseModel,
             "ExtensionAPIMethod": models.ExtensionAPIMethod, "re": re}
    for path, name in [(api / "runtime.py", "_to_snake"),
                       (api / "runtime.py", "_request_model"),
                       (root / "lnbits/core/wasm_ext/wasm/host.py", "_component_payload_to_dict")]:
        module = ast.Module(body=[function_node(path, name)], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(path), "exec"), scope)
    method = SimpleNamespace(request_model=models.CreateInvoicePublicRequest,
                             host_name="create_invoice_public")
    expected = {"goalId": "mock-goal", "issueId": "0" * 32,
                "amount": "125", "source": "invoice", "comment": "fixture only"}
    base = {"source-id": "mock-goal", "amount": 125, "currency": "sat", "memo": "Fixture only"}

    def validate(fields):
        record = SimpleNamespace(**fields)
        payload = scope["_component_payload_to_dict"](record)
        return scope["_request_model"](method, payload)

    actual = validate({**base, "extra": list(expected.items())})
    assert actual.source_id == "mock-goal"
    assert actual.extra == expected, actual.extra
    assert isinstance(actual.extra["amount"], str)
    assert int(actual.extra["amount"]) == actual.amount
    # The regression that motivated this fix: extra-json is silently ignored.
    import json
    broken = validate({**base, "extra-json": json.dumps(expected)})
    assert broken.extra == {}, "Host has changed: reassess the ABI assumptions"
    wit = (Path(__file__).resolve().parents[2] / "wasm/wit/world.wit").read_text()
    assert "extra: list<tuple<string, string>>" in wit
    assert "extra-json" not in wit
    print("PASS: stock component record conversion -> key normalization -> tuple-to-dict -> CreateInvoicePublicRequest preserves private native metadata; JSON alias is rejected by extension WIT")


if __name__ == "__main__":
    main()
