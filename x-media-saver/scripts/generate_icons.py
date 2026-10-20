"""Render the extension's simple vector-style mark using only the standard library."""
from pathlib import Path
import math
import struct
import zlib

output = Path(__file__).resolve().parent.parent / "icons"
output.mkdir(exist_ok=True)
segments = [(12, 5, 12, 14), (8.5, 10.5, 12, 14), (12, 14, 15.5, 10.5),
            (5.5, 15, 5.5, 18.5), (5.5, 18.5, 18.5, 18.5), (18.5, 18.5, 18.5, 15)]


def distance(x, y, segment):
    x1, y1, x2, y2 = segment
    dx, dy = x2 - x1, y2 - y1
    t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - x1 - t * dx, y - y1 - t * dy)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


for size in (16, 32, 48, 128):
    pixels = bytearray()
    for py in range(size):
        pixels.append(0)  # PNG filter: none.
        for px in range(size):
            color = [0, 0, 0, 0]
            for sy in range(4):
                for sx in range(4):
                    x = (px + (sx + .5) / 4) * 24 / size
                    y = (py + (sy + .5) / 4) * 24 / size
                    inside = math.hypot(max(abs(x - 12) - 6.5, 0), max(abs(y - 12) - 6.5, 0)) <= 5
                    sample = (29, 155, 240, 255) if inside else (0, 0, 0, 0)
                    if inside and min(distance(x, y, line) for line in segments) < .9:
                        sample = (255, 255, 255, 255)
                    for index in range(4):
                        color[index] += sample[index]
            pixels.extend(round(value / 16) for value in color)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(bytes(pixels))) + chunk(b"IEND", b"")
    (output / f"{size}.png").write_bytes(data)
print(output)
