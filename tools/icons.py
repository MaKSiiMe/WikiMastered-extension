"""Dessine les icônes de l'extension (icons/icon-*.png), sans dépendance : `python3 tools/icons.py`.

Une carte dorée sur fond sombre, avec en haut un petit badge de prix : ce que l'extension pose sur les cartes.
Chaque pixel est calculé 4 × 4 fois (anticrénelage), puis écrit en PNG avec zlib.
"""
import struct
import zlib
from pathlib import Path

SS = 4  # sous-échantillons par côté


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """Vrai si (x, y) est dans le rectangle arrondi [x0, x1] × [y0, y1] de rayon r (coordonnées 0-1)."""
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color(x, y):
    """Couleur RGBA d'un point (0-1) de l'icône, None si transparent."""
    if rounded_rect(x, y, 0.36, 0.14, 0.64, 0.25, 0.055):  # badge de prix, au-dessus de la carte
        return (17, 17, 24, 255)
    if rounded_rect(x, y, 0.33, 0.115, 0.67, 0.275, 0.07):  # son liseré doré
        return (253, 230, 138, 255)
    if rounded_rect(x, y, 0.2, 0.08, 0.8, 0.92, 0.1):  # la carte : dégradé doré
        t = (x + y) / 2
        return (int(250 - 40 * t), int(204 - 70 * t), int(40 - 20 * t), 255)
    if rounded_rect(x, y, 0.0, 0.0, 1.0, 1.0, 0.22):  # le fond
        return (17, 17, 24, 255)
    return None


def png(size):
    rows = []
    for py in range(size):
        row = bytearray([0])  # filtre PNG « aucun »
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = color((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    if c:
                        for i in range(3):
                            acc[i] += c[i] * c[3]
                        acc[3] += c[3]
            a = acc[3] / (SS * SS)
            rgb = [int(acc[i] / acc[3]) if acc[3] else 0 for i in range(3)]
            row += bytes(rgb + [int(a)])
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 bits, RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        (out / f"icon-{size}.png").write_bytes(png(size))
        print(f"icons/icon-{size}.png")
