"""Replace Capacitor geolocation with the system LocationManager build.

Google fused location was returning null or never calling back, so the
debug screen only showed timeouts.
"""
from pathlib import Path

src = Path(__file__).resolve().parent / "Geolocation.java"
dst = Path("node_modules/@capacitor/geolocation/android/src/main/java/com/capacitorjs/plugins/geolocation/Geolocation.java")
if not dst.exists():
    raise SystemExit(f"plugin source missing: {dst}")
if dst.read_text(encoding="utf-8") == src.read_text(encoding="utf-8"):
    print("system location patch already applied")
else:
    dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    print("system location patch applied")
