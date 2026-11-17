#!/usr/bin/env python3
"""
Write a small Blu-ray PGS subtitle stream (.sup) for testing image subtitles:
two captions, each followed by an empty display set that clears it, on a
1920x1080 canvas. Captions are rendered with Pillow into a 4-colour palette
(transparent, white, black outline, half-transparent grey) and run-length
encoded as PGS object data.

  python3 make-pgs.py out.sup

Segment layout per display set: PCS, WDS, [PDS, ODS], END (see the PGS
format: "PG" + PTS + DTS (90 kHz) + type + size, then the payload).
"""
import glob
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
PCS, WDS, PDS, ODS, END = 0x16, 0x17, 0x14, 0x15, 0x80
# (start seconds, end seconds, text, x, y)
CAPTIONS = [
    (1.0, 2.5, 'Image subtitle test, first caption', 360, 880),
    (3.0, 4.5, 'Second caption, higher on screen', 420, 120),
]
# Palette entries: index -> (Y, Cr, Cb, alpha) in BT.709 limited range.
PALETTE = {1: (235, 128, 128, 255), 2: (16, 128, 128, 255), 3: (126, 128, 128, 128)}


def segment(kind, pts, payload):
    t = int(round(pts * 90000))
    return b'PG' + struct.pack('>IIBH', t, t, kind, len(payload)) + payload


def rle(img):
    """PGS run-length encoding of an 8-bit indexed image."""
    out = bytearray()
    w, h = img.size
    px = img.load()
    for y in range(h):
        x = 0
        while x < w:
            c = px[x, y]
            n = 1
            while x + n < w and px[x + n, y] == c and n < 16383:
                n += 1
            if c == 0:
                out += bytes([0, n]) if n < 64 else bytes([0, 0x40 | (n >> 8), n & 0xFF])
            elif n <= 2:
                out += bytes([c]) * n
            elif n < 64:
                out += bytes([0, 0x80 | n, c])
            else:
                out += bytes([0, 0xC0 | (n >> 8), n & 0xFF, c])
            x += n
        out += b'\x00\x00'  # end of line
    return bytes(out)


def caption_image(text):
    fonts = sorted(glob.glob('/usr/share/fonts/**/DejaVuSans-Bold.ttf', recursive=True)) or \
        sorted(glob.glob('/usr/share/fonts/**/*.ttf', recursive=True))
    font = ImageFont.truetype(fonts[0], 52)
    box = ImageDraw.Draw(Image.new('L', (1, 1))).textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0] + 24, box[3] - box[1] + 24
    img = Image.new('P', (w, h), 0)
    d = ImageDraw.Draw(img)
    d.rectangle([0, h - 6, w - 1, h - 1], fill=3)  # a half-transparent bar: tests alpha
    for dx in (-3, 0, 3):
        for dy in (-3, 0, 3):
            d.text((12 - box[0] + dx, 12 - box[1] + dy), text, font=font, fill=2)
    d.text((12 - box[0], 12 - box[1]), text, font=font, fill=1)
    return img


def display_set(pts, number, state, obj=None, x=0, y=0):
    out = b''
    objects = 1 if obj else 0
    pcs = struct.pack('>HHBHBBBB', W, H, 0x10, number, state, 0, 0, objects)
    if obj:
        pcs += struct.pack('>HBBHH', 0, 0, 0, x, y)
    out += segment(PCS, pts, pcs)
    ww, wh = obj.size if obj else (1, 1)
    out += segment(WDS, pts, struct.pack('>BBHHHH', 1, 0, x, y, ww, wh))
    if obj:
        pal = struct.pack('>BB', 0, 0) + b''.join(struct.pack('>BBBBB', i, *v) for i, v in PALETTE.items())
        out += segment(PDS, pts, pal)
        data = rle(obj)
        body = struct.pack('>HH', ww, wh) + data
        ods = struct.pack('>HBB', 0, 0, 0xC0) + struct.pack('>I', len(body))[1:] + body
        out += segment(ODS, pts, ods)
    out += segment(END, pts, b'')
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'test.sup'
    stream = b''
    n = 0
    for start, end, text, x, y in CAPTIONS:
        img = caption_image(text)
        stream += display_set(start, n, 0x80, img, x, y)  # epoch start with the caption
        n += 1
        stream += display_set(end, n, 0x00, None, x, y)   # empty display set: clears it
        n += 1
    with open(path, 'wb') as f:
        f.write(stream)
    for start, end, text, x, y in CAPTIONS:
        img = caption_image(text)
        print(f'{start:.1f}-{end:.1f}s at ({x},{y}) {img.size[0]}x{img.size[1]}: {text}')


if __name__ == '__main__':
    main()
