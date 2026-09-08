import importlib.util
import json
import os
from pathlib import Path
from zipfile import ZipFile

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "zapgoals_package", ROOT / "tools/package.py"
)
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def test_distribution_is_invoice_only():
    package = json.loads((ROOT / "package.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    assert "@getalby/bitcoin-connect" not in json.dumps(package)
    assert "bitcoin-connect" not in json.dumps(lock)
    assert not (ROOT / "static/js/bitcoin-connect.js").exists()
    assert not (ROOT / "templates/embed.html").exists()
    for path in [ROOT / "static/js/public.js", ROOT / "static/js/embed.js"]:
        source = path.read_text()
        assert "qrserver.com" not in source
        assert "esm.sh" not in source
        assert "launchPaymentModal" not in source


def test_runtime_routes_and_permissions_match_supported_features():
    config = json.loads((ROOT / "config.json").read_text())
    assert config["tile"].endswith(".png")
    exports = {export["name"] for export in config["wasm"]["exports"]}
    assert "invoice-status" in exports
    assert not {"lnurl-params", "lnurl-callback"} & exports
    assert all(not route["path"].endswith("/embed") for route in config["ui_routes"])
    policies = {p["id"]: p for p in config["permissions"]}
    assert not {"wallet.pay_invoice", "http.request"} & policies.keys()
    assert policies["ext.storage.append_public"]["policies"] == [
        {
            "table": "invoice_issuances",
            "source_table": "goals",
            "source_id_field": "goalId",
            "allowed_fields": ["amount", "createdAt"],
            "max_rows_per_source": 10000,
        }
    ]
    public = {
        p["table_name"]: p for p in policies["ext.storage.read_public"]["policies"]
    }
    assert "invoice_issuances" not in public
    assert public["payment_events"]["source_id_field"] == "goalId"
    assert {"id", "goalId", "amount", "issuedAt", "verified"} <= set(
        public["payment_events"]["public_fields"]
    )
    assert not {"walletId", "issueId", "comment"} & set(
        public["payment_events"]["public_fields"]
    )
    assert {
        "recurrenceDayOfMonth",
        "periodStartDate",
        "rolloverMode",
        "sweepMode",
    } <= set(public["goals"]["public_fields"])
    for image in config["images"]:
        assert (ROOT / "screenshots" / image["uri"].rsplit("/", 1)[-1]).is_file()
        assert "invoice-only-" in image["uri"]


def test_packaging_is_deterministic_and_contains_notices(tmp_path):
    for relative in packager.RUNTIME_PATHS:
        target = tmp_path / relative
        if relative not in {"storage", "static", "templates", "wasm/wit"}:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                '{"version":"test"}' if relative == "config.json" else relative
            )
        else:
            target.mkdir(parents=True, exist_ok=True)
            (target / "asset.js").write_text("// fixture")
    archive = packager.package(tmp_path)
    first = archive.read_bytes()
    for path in tmp_path.rglob("*"):
        if path.is_file():
            os.utime(path, (1780000000, 1780000000))
    assert packager.package(tmp_path).read_bytes() == first
    with ZipFile(archive) as installed:
        names = installed.namelist()
        assert names == sorted(names)
        assert "zapgoalswasm/LICENSE" in names
        assert "zapgoalswasm/THIRD_PARTY_NOTICES.txt" in names
        assert "zapgoalswasm/manifest.json" not in names
        assert all(
            info.date_time == (1980, 1, 1, 0, 0, 0) for info in installed.infolist()
        )
    (tmp_path / "static/forbidden.py").write_text("pass")
    with pytest.raises(ValueError, match="Non-runtime"):
        packager.package(tmp_path)


def test_component_and_config_versions_agree():
    import tomllib

    version = json.loads((ROOT / "config.json").read_text())["version"]
    assert (
        tomllib.loads((ROOT / "wasm/Cargo.toml").read_text())["package"]["version"]
        == version
    )
    assert json.loads((ROOT / "package.json").read_text())["version"] == version
