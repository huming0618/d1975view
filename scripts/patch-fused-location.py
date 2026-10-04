"""Make Capacitor's fused location deliver fixes instead of batching them.

The stock plugin sets maxUpdateDelayMillis from the JS timeout, so a 30s
timeout holds updates for up to 30s and the map marker stays put.
A 10s request interval does the same: the marker only jumps every 10 seconds.
"""
from pathlib import Path

path = Path("node_modules/@capacitor/geolocation/android/src/main/java/com/capacitorjs/plugins/geolocation/Geolocation.java")
text = path.read_text()
new = """                // Deliver each fix as it arrives. A 10s interval, or a max-delay
                // taken from the JS timeout, left the map sitting still.
                int interval = Math.max(1000, Math.min(minUpdateInterval, 2000));
                LocationRequest locationRequest = new LocationRequest.Builder(interval)
                    .setMinUpdateIntervalMillis(interval)
                    .setWaitForAccurateLocation(false)
                    .setPriority(priority)
                    .build();
"""
if "setWaitForAccurateLocation(false)" in text and "LocationRequest.Builder(interval)" in text:
    print("fused location patch already applied")
else:
    import re
    pat = re.compile(
        r"                LocationRequest locationRequest = new LocationRequest\.Builder\(10000\)\n"
        r"                    \.setMaxUpdateDelayMillis\((?:timeout|0)\)\n"
        r"                    \.setMinUpdateIntervalMillis\(minUpdateInterval\)\n"
        r"                    \.setPriority\(priority\)\n"
        r"                    \.build\(\);\n"
    )
    text2, n = pat.subn(new, text, count=1)
    if n != 1:
        raise SystemExit("fused location patch target not found")
    path.write_text(text2)
    print("fused location patch applied")
