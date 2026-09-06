from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_templates_and_assets_exist():
    for path in ('templates/index.html', 'templates/public.html', 'static/js/bridge.js', 'static/js/index.js', 'static/js/public.js', 'static/image/zapgoals.svg'):
        assert (ROOT / path).is_file()
