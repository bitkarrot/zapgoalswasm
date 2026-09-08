"""Enforce the release compiler/componentizer/JS tool versions without auto-installing."""

import json
import subprocess
from pathlib import Path

versions = json.loads(
    (Path(__file__).resolve().parents[1] / "build-tools.json").read_text()
)
commands = {
    "rustc": ["rustc", "--version"],
    "cargo-component": ["cargo", "component", "--version"],
    "node": ["node", "--version"],
}
for tool, command in commands.items():
    output = subprocess.check_output(command, text=True).strip().split()
    actual = output[0].removeprefix("v") if tool == "node" else output[1]
    if actual != versions[tool]:
        raise SystemExit(
            f"{tool}: need {versions[tool]} from build-tools.json, found {actual}"
        )
print("Release tool versions match build-tools.json")
