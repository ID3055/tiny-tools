"""Copy packaged extension assets to a stable, unpacked installation directory."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("destination", type=Path, help="Fixed directory loaded by Chrome or Edge")
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent
destination = args.destination.expanduser().resolve()
if destination.is_relative_to(source) or source.is_relative_to(destination):
    parser.error("The installation directory must be separate from the source directory.")
manifest = destination / "manifest.json"
expected = json.loads((source / "manifest.json").read_text())
if manifest.exists() and json.loads(manifest.read_text()).get("name") != expected["name"]:
    parser.error("The destination contains a different extension.")
subprocess.run([sys.executable, str(source / "scripts/pack.py")], check=True)
destination.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(source / "dist/x-image-saver.zip") as archive:
    archive.extractall(destination)
(destination / "SOURCE.txt").write_text(f"Source: {source}\nSync again: python3 {__file__} {destination}\n")
print(f"Installed {expected['name']} {expected['version']} to {destination}")
print("Reload the extension in Chrome / Edge, then refresh X.")
