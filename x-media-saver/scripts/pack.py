"""Package only extension assets; no dependencies or build step required."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
output = root / "dist" / "x-image-saver.zip"
output.parent.mkdir(exist_ok=True)
assets = ["manifest.json", "core.js", "collector.js", "author-download.js", "background.js", "content.js", "content.css", "popup.html", "popup.css", "popup.js", "offscreen.html", "offscreen.js", "hash.js", "video-data.js", "media-bridge.js", "README.md"]
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in assets:
        archive.write(root / name, name)
    for icon in sorted((root / "icons").glob("*.png")):
        archive.write(icon, str(icon.relative_to(root)))
    for asset in sorted((root / "vendor").rglob("*")):
        if asset.is_file():
            archive.write(asset, str(asset.relative_to(root)))
print(output)
