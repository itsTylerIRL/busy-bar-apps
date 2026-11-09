#!/usr/bin/env python3
"""Capture the BUSY Bar front screen to an upscaled PNG: snap.py out.png [host]"""
import base64, sys, urllib.request
from PIL import Image
out = sys.argv[1] if len(sys.argv) > 1 else "screen.png"
host = sys.argv[2] if len(sys.argv) > 2 else "10.0.4.20"
raw = base64.b64decode(urllib.request.urlopen(f"http://{host}/api/screen?display=0", timeout=5).read())
b, g, r = Image.frombytes("RGB", (72, 16), raw).split()  # device buffer is BGR
img = Image.merge("RGB", (r, g, b))
img.resize((72 * 10, 16 * 10), Image.NEAREST).save(out)
print(out)
