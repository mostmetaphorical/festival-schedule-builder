"""Draw the site's icons: a pink diamond with a lime offset, on midnight.

The same mark as the page - the title's pink-and-lime offset and the step
diamonds - reduced to what still reads at 16 pixels. Writes an SVG for
browsers that take one, PNGs for those that don't, and a favicon.ico.
Standard library only.

    python make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT = Path("app")
MIDNIGHT = (12, 11, 26)
PINK = (255, 62, 165)
LIME = (184, 242, 58)

# Drawn on a 32-unit grid: background with rounded corners, a lime diamond
# nudged right, and the pink diamond over it.
RADIUS = 7
LIME_DIAMOND = [(18.5, 4), (30, 15.5), (18.5, 27), (7, 15.5)]
PINK_DIAMOND = [(14.5, 5), (26, 16.5), (14.5, 28), (3, 16.5)]

SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="{RADIUS}" fill="rgb{MIDNIGHT}"/>
  <polygon points="{' '.join(f'{x},{y}' for x, y in LIME_DIAMOND)}" fill="rgb{LIME}"/>
  <polygon points="{' '.join(f'{x},{y}' for x, y in PINK_DIAMOND)}" fill="rgb{PINK}"/>
</svg>
"""


def inside(poly, x, y):
    hit = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def in_rounded_square(x, y):
    cx = min(max(x, RADIUS), 32 - RADIUS)
    cy = min(max(y, RADIUS), 32 - RADIUS)
    return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2


def render(size: int, rounded: bool = True, samples: int = 4) -> bytes:
    rows = []
    step = 32 / size / samples
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = a = 0
            for sy in range(samples):
                for sx in range(samples):
                    x = (px * samples + sx + 0.5) * step
                    y = (py * samples + sy + 0.5) * step
                    if rounded and not in_rounded_square(x, y):
                        continue
                    colour = PINK if inside(PINK_DIAMOND, x, y) else (
                        LIME if inside(LIME_DIAMOND, x, y) else MIDNIGHT)
                    r += colour[0]; g += colour[1]; b += colour[2]; a += 255
            n = samples * samples
            if a:
                covered = a / 255
                row += bytes([round(r / covered), round(g / covered), round(b / covered), round(a / n)])
            else:
                row += bytes(4)
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size: int, raw: bytes) -> bytes:
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico(images: list[tuple[int, bytes]]) -> bytes:
    """An .ico holding PNGs, which every current browser reads."""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


def main() -> None:
    (OUT / "favicon.svg").write_text(SVG, encoding="utf-8")
    (OUT / "favicon-32.png").write_bytes(render(32))
    # iOS rounds the corners itself and dislikes transparency.
    (OUT / "apple-touch-icon.png").write_bytes(render(180, rounded=False, samples=2))
    (OUT / "favicon.ico").write_bytes(ico([(16, render(16)), (32, render(32))]))
    print("Wrote favicon.svg, favicon-32.png, apple-touch-icon.png and favicon.ico in app/")


if __name__ == "__main__":
    main()
