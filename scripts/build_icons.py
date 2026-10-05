# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==11.3.0"]
# ///
"""Package the generated master icon: uv run --script scripts/build_icons.py."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend" / "public"


def main():
    icons = PUBLIC / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    with Image.open(ROOT / "assets" / "app-icon.png") as source:
        image = source.convert("RGBA")
        if image.width != image.height:
            raise ValueError("The master application icon must be square")
        for size in (64, 128, 192, 512):
            image.resize((size, size), Image.Resampling.LANCZOS).save(
                icons / f"app-icon-{size}.png", optimize=True
            )
        image.resize((180, 180), Image.Resampling.LANCZOS).save(
            PUBLIC / "apple-touch-icon.png", optimize=True
        )
        image.save(
            PUBLIC / "favicon.ico",
            sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)],
        )


if __name__ == "__main__":
    main()
