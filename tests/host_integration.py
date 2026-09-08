#!/usr/bin/env python3
"""Opt-in, isolated stock-LNbits/Wasmtime integration proof (no app startup).

Use an existing LNbits environment with wasmtime installed. No dependencies are
installed, no component is built, and no deployment paths are changed. Run only
against a freshly built component, pinning the builder-provided SHA256:

  /path/to/lnbits/.venv/bin/python tests/host_integration.py \
      --lnbits-root /path/to/lnbits --module-sha256 BUILD_SHA256

``--prepare-only`` checks isolated imports/migrations/host policies without loading
or executing ANY component. Only wallet-list/get-wallet/create_payment_request
are fixture replacements. Host decorators, WIT adapter, permissions, SQLite and
JSON migrations are real. Event delivery uses the stock Payment payload adapter
and an explicitly resolved owner context, without background dispatch/jobs.
All files (including a JSON report) are retained under a newly allocated /tmp dir.
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import traceback
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

EXTENSION = "zapgoalswasm"
OWNER = "fixture-owner-no-real-account"
OTHER = "fixture-other-no-real-account"
WALLET = "fixture-wallet-no-real-funds"
OTHER_WALLET = "fixture-other-wallet-no-real-funds"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def utc(value):
    return (
        value.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lnbits-root", type=Path, required=True)
    parser.add_argument(
        "--repo", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument(
        "--module-sha256",
        help="Required build-owner SHA256; refuses a stale/unapproved artifact",
    )
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    args.repo = args.repo.resolve()
    args.lnbits_root = args.lnbits_root.resolve()
    if not args.prepare_only and not args.module_sha256:
        parser.error("--module-sha256 is required unless --prepare-only")
    return args


def isolate(args):
    """Before ANY lnbits import: bypass .env, force SQLite/FakeWallet, reject I/O."""
    if any(name == "lnbits" or name.startswith("lnbits.") for name in sys.modules):
        raise RuntimeError("Run as a standalone process, before any lnbits import")
    root = Path(tempfile.mkdtemp(prefix="zapgoals-stockhost-", dir="/tmp")).resolve()
    data = root / "data"
    data.mkdir()
    os.chdir(root)  # pydantic's relative .env must never read the runtime .env.
    sys.dont_write_bytecode = True
    os.environ.update(
        {
            "LNBITS_BACKEND_WALLET_CLASS": "FakeWallet",
            "LNBITS_DATA_FOLDER": str(data),
            "LNBITS_DATABASE_URL": "",
            "LNBITS_WASM_EXTENSIONS_PATH": str(root / "wasm_extensions"),
            "LNBITS_EXTENSIONS_PATH": str(root / "python_extensions"),
            "LNBITS_EXTENSIONS_UPGRADE_PATH": str(root / "upgrades"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    sys.path.insert(0, str(args.lnbits_root))

    def audit(event, values):
        if event == "socket.connect" and isinstance(values[1], tuple):
            raise AssertionError("Integration harness forbids all network connections")
        if event == "open" and isinstance(values[0], (str, bytes)):
            name = os.fsdecode(values[0])
            if any(marker in name for marker in (".sqlite", ".sqlite3")):
                if not Path(name).resolve().is_relative_to(root):
                    raise AssertionError("SQLite path outside isolated directory")

    sys.addaudithook(audit)
    extension = root / "wasm_extensions" / EXTENSION
    extension.mkdir(parents=True)
    shutil.copy2(args.repo / "config.json", extension / "config.json")
    shutil.copytree(args.repo / "storage", extension / "storage")
    if not args.prepare_only:
        module = args.repo / "wasm" / "module.wasm"
        if digest(module) != args.module_sha256.lower():
            raise AssertionError(
                "Current module SHA256 differs from build-owner approval"
            )
        (extension / "wasm").mkdir()
        shutil.copy2(module, extension / "wasm" / "module.wasm")
        shutil.copytree(args.repo / "wasm" / "wit", extension / "wasm" / "wit")
        if digest(extension / "wasm" / "module.wasm") != args.module_sha256.lower():
            raise AssertionError("Module changed during copying")
    return root, extension


class Proof:
    def __init__(self, args, root, extension):
        self.args, self.root, self.extension = args, root, extension
        self.report = {
            "mode": "prepare-only" if args.prepare_only else "actual-component",
            "isolated_root": str(root),
            "lnbits_root": str(args.lnbits_root),
            "module_sha256": None if args.prepare_only else args.module_sha256.lower(),
            "checks": [],
            "invocations": [],
            "invoice_payloads": [],
            "database_paths": [],
            "limitations": [
                "No HTTP/app startup, global jobs, real Lightning invoice, payment, or deployment",
                "Export-level invocation bypasses HTTP auth/deactivation middleware and invocation telemetry/concurrency counters; actual host auth decorators and Wasmtime store limits remain active",
            ],
        }
        self.payments = []
        self.early_settlement = False
        self.engines = []

    def check(self, condition, name):
        if not condition:
            raise AssertionError(name)
        self.report["checks"].append(name)
        print("PASS", name, flush=True)

    def save(self):
        (self.root / "report.json").write_text(
            json.dumps(self.report, indent=2, default=str) + "\n"
        )

    def import_host(self):
        import sqlalchemy.ext.asyncio as sqlalchemy_async

        original_engine = sqlalchemy_async.create_async_engine

        def safe_engine(url, *args, **kwargs):
            from sqlalchemy.engine import make_url

            parsed = make_url(url)
            if parsed.drivername != "sqlite+aiosqlite":
                raise AssertionError("Only isolated SQLite is allowed")
            path = Path(parsed.database).resolve()
            if not path.is_relative_to(self.root):
                raise AssertionError("Database engine outside isolated directory")
            self.report["database_paths"].append(str(path))
            engine = original_engine(url, *args, **kwargs)
            self.engines.append(engine)
            return engine

        # Validation wrapper, not a storage substitute: every original SQLAlchemy
        # engine and SQLite operation still runs, including import-time databases.
        sqlalchemy_async.create_async_engine = safe_engine
        import lnbits
        from lnbits.settings import settings
        from lnbits.db import Database, SQLITE
        from lnbits.core.db import db as core_db
        from lnbits.core.wasm_ext.storage import crud as storage
        from lnbits.core.wasm_ext.api.host import ExtensionHostAPI
        from lnbits.core.wasm_ext.api.runtime import ExtensionAPIHost
        from lnbits.helpers import sha256s

        self.settings, self.Database, self.core_db = settings, Database, core_db
        self.storage, self.Host, self.APIHost = (
            storage,
            ExtensionHostAPI,
            ExtensionAPIHost,
        )
        self.owner = sha256s(OWNER)
        self.other_owner = sha256s(OTHER)
        self.config = json.loads((self.extension / "config.json").read_text())
        self.permissions = self.config["permissions"]
        self.check(
            Path(lnbits.__file__).resolve().is_relative_to(self.args.lnbits_root),
            "imports use the selected LNbits source tree",
        )
        self.check(
            settings.lnbits_backend_wallet_class == "FakeWallet",
            "FakeWallet selected before imports",
        )
        self.check(
            Path(settings.lnbits_data_folder).resolve() == self.root / "data",
            "settings data path isolated",
        )
        self.check(
            Path(settings.wasm_extensions_dir).resolve() == self.extension.parent,
            "extension loader reads isolated runtime copy",
        )
        self.check(
            core_db.type == SQLITE and Path(core_db.path).is_relative_to(self.root),
            "core_db is isolated SQLite",
        )
        self.check(
            storage.core_db is core_db,
            "JSON migrations use the actual isolated core_db",
        )
        for obj in gc.get_objects():
            if isinstance(obj, Database):
                self.check(
                    obj.type == SQLITE
                    and Path(obj.path).resolve().is_relative_to(self.root),
                    f"imported Database isolated: {obj.name}",
                )
        for relative in (
            "lnbits/core/wasm_ext/api/host.py",
            "lnbits/core/wasm_ext/api/models.py",
            "lnbits/core/wasm_ext/api/registry.py",
            "lnbits/core/wasm_ext/storage/crud.py",
            "lnbits/core/wasm_ext/wasm/host.py",
            "lnbits/core/wasm_ext/wasm/invoke.py",
        ):
            self.report.setdefault("host_source_sha256", {})[relative] = digest(
                self.args.lnbits_root / relative
            )
        upstream = Path("/tmp/zapgoals-review-upstream")
        self.report["optional_upstream_comparison"] = {}
        for local, reference in (
            ("lnbits/core/wasm_ext/api/host.py", "api-host-dev.py"),
            ("lnbits/core/wasm_ext/api/models.py", "api-models-dev.py"),
            ("lnbits/core/wasm_ext/wasm/events.py", "events-dev.py"),
        ):
            if (upstream / reference).is_file():
                import difflib

                self.report["optional_upstream_comparison"][reference] = {
                    "reference_sha256": digest(upstream / reference),
                    "diff": "".join(
                        difflib.unified_diff(
                            (upstream / reference).read_text().splitlines(True),
                            (self.args.lnbits_root / local)
                            .read_text()
                            .splitlines(True),
                            fromfile=reference,
                            tofile=local,
                        )
                    ),
                }
        self.report["runtime_source_sha256"] = {
            str(path.relative_to(self.extension)): digest(path)
            for path in sorted(self.extension.rglob("*"))
            if path.is_file()
        }

    def api(self, user=None, *, event=False, owner=None, permissions=None):
        return self.APIHost(
            self.Host(
                EXTENSION,
                self.permissions if permissions is None else permissions,
                user_id=user,
                context="event" if event else "user",
                owner_id=owner,
            )
        )

    async def denied(self, awaitable, name):
        try:
            await awaitable
        except PermissionError:
            self.check(True, name)
        else:
            raise AssertionError(name + ": unexpectedly allowed")

    async def row(self, table, row_id, owner=None):
        return await self.storage.storage_get_row(
            EXTENSION, table, row_id, owner or self.owner
        )

    async def snapshot(self):
        async with self.Database("ext_" + EXTENSION).connect() as conn:
            tables = await conn.fetchall(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
            result = {}
            for table in tables:
                name = table["name"]
                if not name.replace("_", "").isalnum():
                    raise AssertionError("Unexpected SQLite table name")
                rows = await conn.fetchall(f'SELECT * FROM "{name}" ORDER BY id')
                result[name] = [dict(row) for row in rows]
            return result

    async def migrate(self):
        from lnbits.core.migrations import m000_create_migrations_table
        from lnbits.core.models import DbVersion
        from lnbits.core.models.extensions import InstallableExtension

        async with self.core_db.connect() as conn:
            await m000_create_migrations_table(conn)
        ext = InstallableExtension(id=EXTENSION, name="Zap Goals!", version="0.4.0")
        migration_dir = self.extension / "storage" / "migrations"
        deferred = self.root / "deferred_migrations"
        deferred.mkdir()
        for path in sorted(migration_dir.glob("*.json")):
            if int(path.name.split("_")[0]) > 4:
                shutil.move(str(path), deferred / path.name)
        await self.storage.migrate_wasm_extension_database(ext)
        now = datetime.now(timezone.utc)
        self.legacy_goal = {
            "id": "legacy-opening",
            "walletId": WALLET,
            "title": "Legacy opening",
            "goalAmount": 1000,
            "currentAmount": 37,
            "targetDate": utc(now + timedelta(days=30)),
            "suggestedAmounts": "[21,100]",
            "createdAt": str(int(now.timestamp()) - 3600),
            "updatedAt": str(int(now.timestamp()) - 3600),
        }
        await self.storage.storage_set_row(
            EXTENSION, "goals", self.legacy_goal, self.owner
        )
        await self.storage.storage_set_row(
            EXTENSION,
            "payment_events",
            {
                "id": "f" * 64,
                "goalId": "legacy-opening",
                "amount": 900,
                "newTotal": 900,
                "processedAt": str(int(now.timestamp()) - 1800),
            },
            self.owner,
        )
        await self.storage.storage_set_row(
            EXTENSION,
            "payment_events",
            {
                "id": "legacy-nonhex-unverified",
                "goalId": "legacy-opening",
                "amount": 500,
                "newTotal": 500,
                "processedAt": "1706659200",
            },
            self.owner,
        )
        for path in sorted(deferred.glob("*.json")):
            shutil.move(str(path), migration_dir / path.name)
        await self.storage.migrate_wasm_extension_database(
            ext, DbVersion(db=EXTENSION, version=4)
        )
        old = await self.row("goals", "legacy-opening")
        old_receipt = await self.row("payment_events", "f" * 64)
        self.check(
            old["currentAmount"] == 37,
            "real JSON migration preserves legacy opening balance",
        )
        self.check(
            old_receipt["verified"] is False,
            "real JSON migration leaves old receipt unverified",
        )
        async with self.core_db.connect() as conn:
            version = await conn.fetchone(
                "SELECT version FROM dbversions WHERE db = :db", {"db": EXTENSION}
            )
        expected = max(
            int(path.name.split("_")[0]) for path in migration_dir.glob("*.json")
        )
        self.check(
            version["version"] == expected,
            f"actual SQLite migration version recorded: {expected}",
        )
        self.report["migration_version"] = expected
        schema = json.loads((self.extension / "storage" / "schema.json").read_text())[
            "tables"
        ]
        async with self.Database("ext_" + EXTENSION).connect() as conn:
            for table, definition in schema.items():
                columns = await conn.fetchall(f'PRAGMA table_info("{table}")')
                actual = {column["name"] for column in columns}
                required = {field["name"] for field in definition["fields"]} | {
                    "__lnbits_owner_id__"
                }
                self.check(
                    required <= actual,
                    f"migrated SQLite columns match schema for {table}; missing={sorted(required - actual)}",
                )
        await self.storage.migrate_wasm_extension_database(
            ext, DbVersion(db=EXTENSION, version=expected)
        )
        self.check(
            await self.row("goals", "legacy-opening") == old,
            "repeat migration at current version is no-op",
        )

    async def policies(self):
        public = self.api()
        await self.denied(
            public.invoke("storage.get", {"table": "goals", "id": "legacy-opening"}),
            "anonymous private read denied by real host decorator",
        )
        await self.denied(
            public.invoke("storage.set", {"table": "goals", "data": self.legacy_goal}),
            "anonymous private write denied by real host decorator",
        )
        await self.denied(
            public.invoke(
                "storage.get_public", {"table": "invoice_issuances", "id": "unknown"}
            ),
            "private issuance table has no public read policy",
        )
        await self.denied(
            public.invoke(
                "storage.append_public",
                {
                    "table": "invoice_issuances",
                    "sourceId": "legacy-opening",
                    "data": {"amount": 1, "createdAt": "1", "goalId": "forged"},
                },
            ),
            "append policy rejects caller-forged goal binding",
        )
        missing = [
            p for p in self.permissions if p["id"] != "ext.storage.append_public"
        ]
        await self.denied(
            self.api(permissions=missing).invoke(
                "storage.append_public",
                {
                    "table": "invoice_issuances",
                    "sourceId": "legacy-opening",
                    "data": {"amount": 1, "createdAt": "1"},
                },
            ),
            "missing append permission denied by real decorator",
        )
        await self.denied(
            public.invoke(
                "storage.get_public_paginated",
                {
                    "table": "payment_events",
                    "sourceId": "legacy-opening",
                    "sortBy": "newTotal",
                },
            ),
            "public receipt pagination rejects private query fields",
        )
        await self.denied(
            public.invoke(
                "storage.get_public_paginated",
                {
                    "table": "payment_events",
                    "sourceId": "legacy-opening",
                    "filters": {"goalId": "forged"},
                },
            ),
            "public receipt pagination cannot override goal scope",
        )
        other = await self.api(OTHER).invoke(
            "storage.get", {"table": "goals", "id": "legacy-opening"}
        )
        self.check(other["dataJson"] is None, "private rows scoped to hashed owner")
        shown = await public.invoke(
            "storage.get_public", {"table": "goals", "id": "legacy-opening"}
        )
        self.check(
            "walletId" not in json.loads(shown["dataJson"]),
            "public policy strips destination wallet",
        )

    async def invoke(self, export, payload=None, *, user=None, event=False, owner=None):
        from lnbits.core.wasm_ext.wasm.invoke import _invoke_wasm_extension_export_sync

        host = self.api(user, event=event, owner=owner).api
        loop = asyncio.get_running_loop()
        result = await asyncio.to_thread(
            _invoke_wasm_extension_export_sync,
            self.wasm,
            export,
            payload or {},
            host,
            loop,
            "isolated-integration-no-invocation-jobs",
            self.limits,
        )
        self.report["invocations"].append(
            {
                "export": export,
                "context": "event" if event else "owner" if user else "anonymous",
                "payload": payload or {},
                "result": result,
            }
        )
        self.save()
        return result

    async def settle(self, payment):
        from lnbits.core.wasm_ext.wasm.events import _wasm_invoice_paid_payload

        source = payment.extra["source_id"]
        owner = await self.storage.storage_get_row_owner_id(EXTENSION, "goals", source)
        self.check(owner == self.owner, "event owner resolved from real source row")
        return await self.invoke(
            "on-invoice-paid",
            _wasm_invoice_paid_payload(payment),
            event=True,
            owner=owner,
        )

    async def fake_create_payment(self, wallet_id, request):
        from lnbits.core.models.payments import Payment

        self.check(
            wallet_id == WALLET,
            "actual public invoice host selects source's private wallet",
        )
        self.check(
            request.extension == EXTENSION and request.extra["tag"] == EXTENSION,
            "actual host stamps extension/tag invoice metadata",
        )
        metadata = request.extra["extra_" + EXTENSION]
        issuance_id = metadata["issueId"]
        issuance = await self.row("invoice_issuances", issuance_id)
        self.check(
            issuance is not None,
            "private issuance committed BEFORE invoice backend call",
        )
        self.check(
            issuance["goalId"] == request.extra["source_id"]
            and issuance["amount"] == request.amount,
            "host-forced private issuance source and amount match invoice",
        )
        self.check(
            await self.storage.storage_get_row_owner_id(
                EXTENSION, "invoice_issuances", issuance_id
            )
            == self.owner,
            "anonymous append inherits goal's private owner",
        )
        payment_hash = hashlib.sha256(
            f"isolated-invoice-{len(self.payments)}".encode()
        ).hexdigest()
        payment = Payment(
            checking_id="fixture-" + payment_hash,
            payment_hash=payment_hash,
            wallet_id=wallet_id,
            amount=int(request.amount * 1000),
            fee=0,
            bolt11="lnbc-fixture-not-payable-" + payment_hash,
            memo=request.memo,
            status="pending",
            extra=request.extra,
            extension=EXTENSION,
            tag=EXTENSION,
        )
        self.payments.append(payment)
        self.report["invoice_payloads"].append(
            {
                "wallet_id": wallet_id,
                "request": request.dict(),
                "payment_hash": payment_hash,
            }
        )
        if self.early_settlement:
            result = await self.settle(payment.copy(update={"status": "success"}))
            self.check(
                "error" not in result and not result.get("quarantined"),
                "settlement can finish before invoice host returns",
            )
        return payment

    def request(self, **updates):
        request = {
            "walletId": WALLET,
            "title": "Stock host goal",
            "goalAmount": 1000,
            "targetDate": utc(datetime.now(timezone.utc) + timedelta(days=30)),
            "suggestedAmounts": [21, 100],
            "fontName": "sans-serif",
        }
        request.update(updates)
        return request

    async def successful(self, export, payload=None, **context):
        result = await self.invoke(export, payload, **context)
        self.check("error" not in result, export + " succeeds")
        return result

    async def public_goal(self, goal_id):
        return await self.successful("get-public-goal", {"goalId": goal_id})

    async def component_proof(self):
        from lnbits.core.wasm_ext.wasm.loader import load_wasm_extension
        from lnbits.core.crud import wallets as wallet_crud
        from lnbits.core.services import payments as payment_service

        self.wasm = load_wasm_extension(EXTENSION)
        self.limits = {
            key: getattr(self.settings, key)
            for key in self.settings.__fields__
            if key.startswith("wasm_runtime_")
            and isinstance(getattr(self.settings, key), int)
        }
        self.report["wasmtime_limits"] = self.limits
        self.check(
            self.wasm.module_path.resolve().is_relative_to(self.root),
            "actual component loaded only from isolated runtime copy",
        )
        self.check(
            self.wasm.version == "0.4.0", "component config is pending 0.4.0 build"
        )
        wallets = {
            WALLET: SimpleNamespace(
                id=WALLET, user=OWNER, name="Fixture only", currency="sat"
            ),
            OTHER_WALLET: SimpleNamespace(
                id=OTHER_WALLET, user=OTHER, name="Other fixture", currency="sat"
            ),
        }

        async def get_wallet(wallet_id):
            return wallets.get(wallet_id)

        async def get_wallets(user_id):
            return [wallet for wallet in wallets.values() if wallet.user == user_id]

        with patch.object(wallet_crud, "get_wallet", get_wallet), patch.object(
            wallet_crud, "get_wallets", get_wallets
        ), patch.object(
            payment_service, "create_payment_request", self.fake_create_payment
        ):
            await self.lifecycle()
            await self.concurrent_events_and_archive()
            await self.calendar_and_replay()
            await self.pagination_proof()

    async def lifecycle(self):
        legacy = await self.public_goal("legacy-opening")
        self.check(
            legacy["currentAmount"] == 37,
            "legacy unverified receipt excluded from derived public amount",
        )
        self.check(
            legacy["totals"]["openingAmount"] == 37
            and legacy["totals"]["receiptAmount"] == 0,
            "legacy opening explicitly represented in public accounting",
        )
        old_status = await self.successful(
            "invoice-status", {"goalId": "legacy-opening", "paymentHash": "f" * 64}
        )
        self.check(
            old_status["paid"] is False,
            "unverified legacy receipt is not public payment proof",
        )
        await self.successful(
            "create-invoice", {"goalId": "legacy-opening", "amount": 13}
        )
        await self.settle(self.payments[-1].copy(update={"status": "success"}))
        legacy_after = await self.public_goal("legacy-opening")
        self.check(
            legacy_after["currentAmount"] == 50
            and legacy_after["totals"]["openingAmount"] == 37
            and legacy_after["totals"]["receiptAmount"] == 13,
            "post-migration verified settlement adds to preserved opening without counting old receipt",
        )
        self.check(
            (await self.row("goals", "legacy-opening"))["currentAmount"] == 37,
            "post-migration settlement never rewrites legacy opening",
        )
        denied = await self.invoke(
            "create-goal", self.request(walletId=OTHER_WALLET), user=OWNER
        )
        self.check("error" in denied, "create-goal rejects another user's wallet")
        listed_wallets = await self.successful("get-wallets", {}, user=OWNER)
        self.check(
            [wallet["id"] for wallet in listed_wallets["data"]] == [WALLET],
            "actual wallet-list host filters fixture user's wallets",
        )
        created = await self.successful("create-goal", self.request(), user=OWNER)
        goal_id = created["id"]
        listed = await self.successful("list-goals", {}, user=OWNER)
        self.check(
            goal_id in [goal["id"] for goal in listed["data"]],
            "actual component lists owner's private goals",
        )
        other_list = await self.successful("list-goals", {}, user=OTHER)
        self.check(other_list["data"] == [], "other owner list is empty")
        stored = await self.row("goals", goal_id)
        self.check(
            stored["walletId"] == WALLET and stored["currentAmount"] == 0,
            "created private goal starts with zero immutable opening",
        )
        self.check(
            await self.storage.storage_get_row_owner_id(EXTENSION, "goals", goal_id)
            == self.owner,
            "goal creation commits hashed owner",
        )
        self.check(
            await self.row("goals", goal_id, self.other_owner) is None,
            "other authenticated user cannot read goal",
        )
        before = await self.snapshot()
        public = await self.public_goal(goal_id)
        self.check(
            "walletId" not in public
            and "__lnbits_owner_id__" not in public
            and "targetWalletId" not in public,
            "WASM public response has no private ownership/wallet fields",
        )
        self.check(
            await self.snapshot() == before,
            "public GET export does not write any table",
        )
        self.early_settlement = True
        invoice = await self.successful(
            "create-invoice", {"goalId": goal_id, "amount": 125}
        )
        self.early_settlement = False
        payment = self.payments[-1]
        self.check(
            invoice["paymentHash"] == payment.payment_hash,
            "actual component returns backend payment hash",
        )
        paid = await self.successful(
            "invoice-status", {"goalId": goal_id, "paymentHash": payment.payment_hash}
        )
        self.check(
            paid["paid"] is True,
            "public invoice status observes early verified settlement",
        )
        receipt = await self.row("payment_events", payment.payment_hash)
        self.check(
            receipt["verified"] is True and receipt["amount"] == 125,
            "event writes verified immutable receipt in actual SQLite",
        )
        self.check(
            (await self.row("goals", goal_id))["currentAmount"] == 0,
            "settlement never overwrites immutable opening balance",
        )
        public = await self.public_goal(goal_id)
        self.check(
            public["currentAmount"] == 125 and public["totals"]["receiptAmount"] == 125,
            "public pagination derives totals from real verified receipt",
        )
        before = await self.snapshot()
        await self.settle(payment.copy(update={"status": "success"}))
        self.check(
            await self.snapshot() == before,
            "settlement replay is byte-for-byte row idempotent",
        )
        wrong_goal = await self.successful(
            "invoice-status",
            {"goalId": "legacy-opening", "paymentHash": payment.payment_hash},
        )
        self.check(wrong_goal["paid"] is False, "cross-goal payment hash is not proof")
        invoice2 = await self.successful(
            "create-invoice", {"goalId": goal_id, "amount": 75}
        )
        pending_payment = self.payments[-1]
        pending = await self.successful(
            "invoice-status",
            {"goalId": goal_id, "paymentHash": invoice2["paymentHash"]},
        )
        self.check(
            pending["paid"] is False, "issued but unsettled invoice stays unpaid"
        )
        for update, label in (
            ({}, "pending"),
            ({"status": "failed"}, "failed"),
            ({"status": "success", "wallet_id": OTHER_WALLET}, "wrong wallet"),
            ({"status": "success", "amount": 76000}, "wrong amount"),
        ):
            before = await self.snapshot()
            rejected = await self.settle(pending_payment.copy(update=update))
            self.check(
                rejected.get("quarantined") is True or rejected.get("ignored") is True,
                label + " event rejected",
            )
            self.check(
                await self.snapshot() == before,
                label + " event has no storage mutation",
            )
        immutable = {
            "walletId": OTHER_WALLET,
            "currentAmount": 999,
            "periodIndex": 99,
            "periodStartDate": "2024-01-01T00:00:00Z",
            "archived": True,
            "accountingVersion": 99,
            "recurring": True,
            "recurrenceUnit": "week",
            "recurrenceInterval": 2,
            "recurrenceDayOfMonth": 15,
            "rolloverMode": "reset_to_zero",
            "sweepMode": "entire_amount",
        }
        for key, value in immutable.items():
            before = await self.snapshot()
            result = await self.invoke(
                "update-goal", {"goalId": goal_id, key: value}, user=OWNER
            )
            self.check("error" in result, "immutable update rejected: " + key)
            self.check(
                await self.snapshot() == before,
                "immutable rejection has no writes: " + key,
            )
        before_goal = await self.row("goals", goal_id)
        await self.successful(
            "update-goal",
            {"goalId": goal_id, "title": "Presentation edit only"},
            user=OWNER,
        )
        after_goal = await self.row("goals", goal_id)
        self.check(
            after_goal["title"] == "Presentation edit only",
            "partial presentation update survives real SQL upsert",
        )
        self.check(
            all(
                after_goal[key] == value
                for key, value in before_goal.items()
                if key not in {"title", "updatedAt"}
            ),
            "presentation update preserves all accounting/private fields",
        )
        before = await self.snapshot()
        result = await self.invoke(
            "update-goal", {"goalId": goal_id, "title": "Not yours"}, user=OTHER
        )
        self.check(
            "error" in result and await self.snapshot() == before,
            "other owner cannot mutate goal",
        )
        await self.successful("delete-goal", {"goalId": goal_id}, user=OWNER)
        archived = await self.row("goals", goal_id)
        self.check(
            archived is not None and archived["archived"] is True,
            "delete archives rather than deleting accounting inputs",
        )
        count = len(self.payments)
        before = await self.snapshot()
        result = await self.invoke("create-invoice", {"goalId": goal_id, "amount": 1})
        self.check(
            "error" in result and len(self.payments) == count,
            "archived goal denies new invoice before backend",
        )
        self.check(
            await self.snapshot() == before,
            "archived invoice denial cannot leave orphan issuance",
        )
        listed = await self.successful("list-goals", {}, user=OWNER)
        self.check(
            goal_id not in [goal["id"] for goal in listed["data"]],
            "archived goal omitted from owner management list",
        )
        await self.settle(pending_payment.copy(update={"status": "success"}))
        public = await self.public_goal(goal_id)
        self.check(
            public["currentAmount"] == 200 and public["archived"] is True,
            "archived goal accepts previously issued late settlement",
        )

    async def concurrent_events_and_archive(self):
        created = await self.successful(
            "create-goal",
            self.request(title="Concurrent settlement fixture"),
            user=OWNER,
        )
        goal_id = created["id"]
        start = len(self.payments)
        await asyncio.gather(
            *[
                self.successful("create-invoice", {"goalId": goal_id, "amount": amount})
                for amount in (7, 11)
            ]
        )
        first, second = [
            payment.copy(update={"status": "success"})
            for payment in self.payments[start:]
        ]
        results = await asyncio.gather(
            self.settle(first), self.settle(second), self.settle(first)
        )
        self.check(
            all(
                "error" not in result and not result.get("quarantined")
                for result in results
            ),
            "concurrent distinct and duplicate events succeed through actual Wasmtime/SQLite",
        )
        public = await self.public_goal(goal_id)
        self.check(
            public["currentAmount"] == 18
            and public["totals"]["verifiedReceiptCount"] == 2,
            "concurrent settlements neither lose contributions nor double-credit duplicates",
        )
        before_goal = await self.row("goals", goal_id)
        self.check(
            before_goal["currentAmount"] == 0,
            "concurrent events preserve immutable opening",
        )
        await asyncio.gather(
            self.invoke(
                "update-goal",
                {"goalId": goal_id, "title": "Concurrent presentation edit"},
                user=OWNER,
            ),
            self.invoke("delete-goal", {"goalId": goal_id}, user=OWNER),
        )
        archived = await self.row("goals", goal_id)
        self.check(
            archived["archived"] is True and archived["currentAmount"] == 0,
            "concurrent presentation edit/archive cannot resurrect goal or overwrite opening",
        )
        self.check(
            (await self.public_goal(goal_id))["currentAmount"] == 18,
            "actual partial SQL upserts preserve concurrent verified receipts",
        )

    async def calendar_and_replay(self):
        # Historical fixture rows use genuine private storage/public append APIs.
        # We do NOT mock the clock or alter a live invoice's durable issuance.
        created = await self.successful(
            "create-goal",
            self.request(
                title="Historical calendar fixture",
                goalAmount=100,
                recurring=True,
                recurrenceUnit="month",
                recurrenceInterval=1,
                recurrenceDayOfMonth=31,
            ),
            user=OWNER,
        )
        goal_id = created["id"]
        for field, value in {
            "goalAmount": 101,
            "targetDate": utc(datetime.now(timezone.utc) + timedelta(days=31)),
        }.items():
            before = await self.snapshot()
            result = await self.invoke(
                "update-goal", {"goalId": goal_id, field: value}, user=OWNER
            )
            self.check(
                "error" in result and await self.snapshot() == before,
                "recurring accounting rule immutable: " + field,
            )
        fixture = await self.row("goals", goal_id)
        fixture.update(
            {
                "createdAt": "1706659200",
                "updatedAt": "1706659200",  # 2024-01-31 UTC
                "targetDate": "2024-02-29T00:00:00Z",
                "periodIndex": 0,
                "periodStartDate": "2024-01-31T00:00:00Z",
                "periodEndDate": "2024-02-29T00:00:00Z",
            }
        )
        await self.storage.storage_set_row(EXTENSION, "goals", fixture, self.owner)
        before = await self.snapshot()
        public = await self.public_goal(goal_id)
        active_end, active_index = public["periodEndDate"], public["periodIndex"]
        self.check(
            active_index > 1 and public["currentAmount"] == 0,
            "missed months derive active period without scheduled jobs",
        )
        periods = await self.successful("list-periods", {"goalId": goal_id}, user=OWNER)
        history = {row["periodIndex"]: row for row in periods["data"]}
        self.check(
            history[0]["startDate"] == "2024-01-31T00:00:00Z"
            and history[0]["endDate"] == "2024-02-29T00:00:00Z",
            "fixed month-end calendar clamps to leap February",
        )
        self.check(
            history[1]["startDate"] == "2024-02-29T00:00:00Z"
            and history[1]["endDate"] == "2024-03-31T00:00:00Z",
            "fixed day-31 anchor returns after leap February",
        )
        await self.successful("sweep-goal", {"goalId": goal_id}, user=OWNER)
        await self.successful("sweep-due", {}, user=OWNER)
        self.check(
            await self.snapshot() == before,
            "public/list-periods/manual/scheduled sweeps are entirely read-only",
        )
        concurrent = await asyncio.gather(
            *[
                self.successful("sweep-goal", {"goalId": goal_id}, user=OWNER)
                for _ in range(3)
            ]
        )
        self.check(
            concurrent[0] == concurrent[1] == concurrent[2],
            "concurrent read-only sweeps return deterministic projections",
        )
        self.check(
            await self.snapshot() == before,
            "concurrent sweep invocations create no closure rows or mutable totals",
        )
        # A genuine new component-issued invoice belongs to the current period,
        # even though the immutable first targetDate is years in the past.
        await self.successful("create-invoice", {"goalId": goal_id, "amount": 150})
        current_payment = self.payments[-1]
        await self.settle(current_payment.copy(update={"status": "success"}))
        current = await self.public_goal(goal_id)
        self.check(
            current["currentAmount"] == 150 and current["periodEndDate"] == active_end,
            "reaching target cannot close calendar early",
        )
        before = await self.snapshot()
        await self.successful("sweep-goal", {"goalId": goal_id}, user=OWNER)
        self.check(
            await self.snapshot() == before,
            "sweeping above target cannot mutate or close active period",
        )
        # Build a historical pending invoice fixture through the same stock host,
        # then deliver settlement now. Backend amount/hash/extra are real host
        # CreateInvoice model output; only the payment service is mocked.
        issue_stamp = int(datetime(2024, 2, 10, tzinfo=timezone.utc).timestamp())
        append = await self.api().invoke(
            "storage.append_public",
            {
                "table": "invoice_issuances",
                "sourceId": goal_id,
                "data": {"amount": 250, "createdAt": str(issue_stamp)},
            },
        )
        historical_extra = dict(current_payment.extra["extra_" + EXTENSION])
        historical_extra.update({"goalId": goal_id, "issueId": append["id"]})
        if "amount" in historical_extra:
            historical_extra["amount"] = (
                "250" if isinstance(historical_extra["amount"], str) else 250
            )
        await self.api().invoke(
            "wallet.create_invoice_public",
            {
                "sourceId": goal_id,
                "amount": 250,
                "currency": "sat",
                "memo": "Historical pending fixture",
                "extra": historical_extra,
            },
        )
        late_payment = self.payments[-1]
        before_goals = (await self.snapshot())["goals"]
        await self.settle(late_payment.copy(update={"status": "success"}))
        late_receipt = await self.row("payment_events", late_payment.payment_hash)
        self.check(
            int(late_receipt["issuedAt"]) == issue_stamp,
            "verified receipt uses immutable historical issuance time, not settlement time",
        )
        self.check(
            (await self.snapshot())["goals"] == before_goals,
            "late settlement does not change private calendar/opening inputs",
        )
        revised = await self.public_goal(goal_id)
        totals = revised["totals"]
        self.check(
            revised["currentAmount"] == 150 and revised["periodIndex"] == active_index,
            "late settlement is not incorrectly attributed to active period",
        )
        self.check(
            totals["receiptAmount"] == 400
            and totals["movedAmount"] == 250
            and totals["totalAmount"] == 400,
            "late settlement deterministically recomputes historical allocations",
        )
        self.check(
            totals["movedAmount"] + totals["retainedAmount"] + totals["currentAmount"]
            == totals["totalAmount"],
            "actual component accounting conserves all 400 fixture sats",
        )
        periods = await self.successful("list-periods", {"goalId": goal_id}, user=OWNER)
        revised_history = {row["periodIndex"]: row for row in periods["data"]}
        self.check(
            revised_history[0]["receivedAmount"] == 250
            and revised_history[0]["movedAmount"] == 100
            and revised_history[0]["rolloverAmount"] == 150,
            "late receipt revises original period and carry",
        )
        self.check(
            revised_history[1]["movedAmount"] == 100
            and revised_history[2]["movedAmount"] == 50,
            "late carry replay revises following calendar periods",
        )
        self.check(
            revised_history[0]["completedAt"] == "2024-02-29T00:00:00Z",
            "historical closure timestamp is fixed calendar boundary",
        )
        before = await self.snapshot()
        await self.settle(late_payment.copy(update={"status": "success"}))
        await self.successful("sweep-due", {}, user=OWNER)
        self.check(
            await self.snapshot() == before,
            "late-payment replay plus sweep is storage-idempotent",
        )
        self.check(
            (await self.public_goal(goal_id))["totals"] == totals,
            "replayed late event cannot double-credit derived totals",
        )

    async def pagination_proof(self):
        created = await self.successful(
            "create-goal", self.request(title="Multi-page receipt fixture"), user=OWNER
        )
        goal_id = created["id"]
        stamp = str(int(datetime.now(timezone.utc).timestamp()) - 1)
        # Efficient historical fixture insertion using the actual LNbits SQLite
        # connection. Production reads below still traverse the stock host/WIT.
        async with self.Database("ext_" + EXTENSION).connect() as conn:
            for index in range(1005):
                await conn.execute(
                    """
                    INSERT INTO zapgoalswasm.payment_events
                        (id, goalId, amount, processedAt, verified, issuedAt, __lnbits_owner_id__)
                    VALUES (:id, :goal, 1, :stamp, true, :stamp, :owner)
                """,
                    {
                        "id": hashlib.sha256(
                            f"pagination-{index}".encode()
                        ).hexdigest(),
                        "goal": goal_id,
                        "stamp": stamp,
                        "owner": self.owner,
                    },
                )
        before = await self.snapshot()
        public = await self.public_goal(goal_id)
        self.check(
            public["currentAmount"] == 1005
            and public["totals"]["verifiedReceiptCount"] == 1005,
            "actual public WIT pagination includes every receipt beyond 1000-row host page",
        )
        listed = await self.successful("list-goals", {}, user=OWNER)
        private = next(goal for goal in listed["data"] if goal["id"] == goal_id)
        self.check(
            private["totals"] == public["totals"],
            "private and public complete receipt snapshots agree",
        )
        self.check(
            await self.snapshot() == before,
            "multi-page accounting projection remains read-only",
        )

    async def run(self):
        self.import_host()
        await self.migrate()
        await self.policies()
        if not self.args.prepare_only:
            await self.component_proof()
        self.report["database_paths"] = sorted(set(self.report["database_paths"]))
        self.check(
            all(
                Path(path).is_relative_to(self.root)
                for path in self.report["database_paths"]
            ),
            "EVERY constructed Database engine path is under isolated TMP",
        )
        for engine in self.engines:
            await engine.dispose()
        self.report["result"] = (
            "PREPARED_NO_COMPONENT_EXECUTED" if self.args.prepare_only else "PASS"
        )
        self.save()


def main():
    args = arguments()
    root, extension = isolate(args)
    proof = Proof(args, root, extension)
    print("ISOLATED_ROOT=" + str(root), flush=True)
    try:
        asyncio.run(proof.run())
    except Exception:
        proof.report["result"] = "FAIL"
        proof.report["failure"] = traceback.format_exc()
        proof.save()
        raise
    finally:
        print("REPORT=" + str(root / "report.json"), flush=True)


if __name__ == "__main__":
    main()
