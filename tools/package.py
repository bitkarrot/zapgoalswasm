import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).parents[1]
version = json.loads((root / 'config.json').read_text())['version']
out = root / 'dist' / f'zapgoalswasm-{version}.zip'
out.parent.mkdir(exist_ok=True)
with ZipFile(out, 'w', ZIP_DEFLATED) as archive:
    for relative in ('config.json', 'description.md', 'manifest.json', 'storage', 'static', 'templates', 'wasm/module.wasm', 'wasm/wit'):
        path = root / relative
        if path.is_file():
            archive.write(path, f"zapgoalswasm/{path.relative_to(root).as_posix()}")
        else:
            for child in path.rglob('*'):
                if child.is_file() and 'target' not in child.parts:
                    archive.write(child, f"zapgoalswasm/{child.relative_to(root).as_posix()}")
print(out)
