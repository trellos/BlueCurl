"""Caption frames from tools/video.mjs (phase label + sim time) and encode an H.264 MP4.

Usage: python3 tools/encode_video.py <framesDir> <out.mp4> [fps=30]
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

frames_dir, out = sys.argv[1], sys.argv[2]
fps = int(sys.argv[3]) if len(sys.argv) > 3 else 30
meta = json.load(open(os.path.join(frames_dir, "meta.json")))
LABEL = {"paddle": "1  PADDLE", "popup": "2  POP-UP", "ride": "3  RIDE", "wipeout": "4  WIPEOUT"}
MAN = {"bottomTurn": "bottom turn", "cutback": "cutback", "topTurn": "top turn", "pump": "pump"}


def font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


big, small = font(30), font(18)
cap_dir = os.path.join(frames_dir, "cap")
os.makedirs(cap_dir, exist_ok=True)
for i, m in enumerate(meta):
    im = Image.open(os.path.join(frames_dir, f"f{i:05d}.png")).convert("RGB")
    d = ImageDraw.Draw(im, "RGBA")
    label = LABEL.get(m["phase"], m["phase"])
    sub = f"t {m['t']:5.2f} s   board {m['v']:4.1f} m/s"
    if m["phase"] == "ride" and m["man"] in MAN:
        sub += f"   {MAN[m['man']]}"
    if m["phase"] in ("ride", "wipeout") and m["stab"] < 0.7:
        sub += f"   stability {m['stab']:.2f}"
    d.rounded_rectangle((24, 22, 24 + 470, 22 + 84), 8, fill=(0, 0, 0, 110))
    d.text((40, 30), label, font=big, fill=(255, 255, 255, 235))
    d.text((40, 72), sub, font=small, fill=(230, 230, 230, 220))
    wm = "BlueCurl Surf Lab v0 — placeholder assets"
    d.text((im.width - 24 - d.textlength(wm, font=small), im.height - 34), wm, font=small, fill=(255, 255, 255, 150))
    im.save(os.path.join(cap_dir, f"c{i:05d}.png"))
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", os.path.join(cap_dir, "c%05d.png"),
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", out],
    check=True,
)
print("wrote", out, len(meta), "frames")
