import json
from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_wasm_config_declares_matching_exports_and_routes():
    config = json.loads((ROOT / 'config.json').read_text())
    exports = {item['name'] for item in config['wasm']['exports']}
    routes = {item['export'] for item in config['api_routes']}
    assert config['extension_type'] == 'wasm'
    assert routes <= exports
    assert {'create-goal', 'get-public-goal', 'create-invoice', 'on-invoice-paid'} <= exports


def test_public_invoice_permission_is_restricted_to_goal_wallet_field():
    config = json.loads((ROOT / 'config.json').read_text())
    permission = next(p for p in config['permissions'] if p['id'] == 'wallet.create_invoice_public')
    assert permission['policies'] == [{'table': 'goals', 'wallet_field': 'walletId'}]


def test_payment_event_storage_supports_idempotent_accounting():
    schema = json.loads((ROOT / 'storage/schema.json').read_text())
    assert {'id', 'goalId', 'amount', 'newTotal', 'processedAt'} == {
        field['name'] for field in schema['tables']['payment_events']['fields']
    }


def test_extension_details_and_icon_are_publishable():
    config = json.loads((ROOT / 'config.json').read_text())
    assert config['repo'].startswith('https://github.com/')
    assert config['description_md'].startswith('https://')
    assert config['contributors']
    assert config['tags']
    assert (ROOT / 'static' / config['tile'].removeprefix('/ext-assets/zapgoalswasm/')).is_file()
