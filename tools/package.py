"""Build a deterministic, runtime-only WASM install archive (no source ZIPs)."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_PATHS = (
    "config.json",
    "description.md",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.txt",
    "storage",
    "static",
    "templates",
    "wasm/module.wasm",
    "wasm/wit",
)


def package(root=ROOT):
    version = json.loads((root / "config.json").read_text())["version"]
    out = root / "dist" / f"zapgoalswasm-{version}.zip"
    out.parent.mkdir(exist_ok=True)
    files = []
    for relative in RUNTIME_PATHS:
        path = root / relative
        if not path.exists():
            raise FileNotFoundError(f"Required runtime path is missing: {relative}")
        files.extend([path] if path.is_file() else path.rglob("*"))
    with ZipFile(out, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(files):
            if path.is_symlink():
                raise ValueError(f"Runtime symlinks are not allowed: {path}")
            if not path.is_file():
                continue
            relative = path.relative_to(root)
            if path.suffix in {".py", ".pyc", ".so", ".dll", ".exe"}:
                raise ValueError(f"Non-runtime artifact: {relative}")
            info = ZipInfo(f"zapgoalswasm/{relative.as_posix()}", (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, path.read_bytes(), compresslevel=9)
    return out


if __name__ == "__main__":
    print(package())
