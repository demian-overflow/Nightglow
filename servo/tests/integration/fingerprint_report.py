#!/usr/bin/env python3
"""
CreepJS-style fingerprint report for NightGlow / servoshell.

Drives the browser via W3C WebDriver and collects every signal that
CreepJS / FingerprintJS / bot-detection services inspect.  Prints a
structured report and exits 0 (it is informational, not a pass/fail gate).

Usage:
    python3 fingerprint_report.py --url http://<host>:7000
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request


# ── WebDriver helpers ──────────────────────────────────────────────────────────

def _req(method: str, url: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def wait_ready(base: str, timeout=90):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            r = _req("GET", f"{base}/status")
            if r.get("value", {}).get("ready"):
                return
            last = r
        except Exception as e:
            last = str(e)
        time.sleep(1)
    raise TimeoutError(f"Browser not ready after {timeout}s: {last}")


def new_session(base: str) -> str:
    r = _req("POST", f"{base}/session", {"capabilities": {}})
    sid = r.get("value", {}).get("sessionId")
    if not sid:
        raise RuntimeError(f"Session creation failed: {r}")
    return sid


def delete_session(base: str, sid: str):
    _req("DELETE", f"{base}/session/{sid}")


def navigate(base: str, sid: str, url: str):
    _req("POST", f"{base}/session/{sid}/url", {"url": url})


def execute(base: str, sid: str, script: str, args=None):
    r = _req("POST", f"{base}/session/{sid}/execute/sync",
             {"script": script, "args": args or []})
    return r.get("value")


# ── Fingerprint probes ─────────────────────────────────────────────────────────

PROBES = {
    # ── Navigator ──────────────────────────────────────────────────────────────
    "navigator.userAgent":          "return navigator.userAgent",
    "navigator.appVersion":         "return navigator.appVersion",
    "navigator.platform":           "return navigator.platform",
    "navigator.vendor":             "return navigator.vendor",
    "navigator.language":           "return navigator.language",
    "navigator.languages":          "return Array.from(navigator.languages || [])",
    "navigator.hardwareConcurrency":"return navigator.hardwareConcurrency",
    "navigator.deviceMemory":       "return navigator.deviceMemory",
    "navigator.maxTouchPoints":     "return navigator.maxTouchPoints",
    "navigator.cookieEnabled":      "return navigator.cookieEnabled",
    "navigator.doNotTrack":         "return navigator.doNotTrack",
    "navigator.webdriver":          "return navigator.webdriver",
    "navigator.pdfViewerEnabled":   "return navigator.pdfViewerEnabled",
    "navigator.onLine":             "return navigator.onLine",
    "navigator.product":            "return navigator.product",
    "navigator.productSub":         "return navigator.productSub",
    "navigator.vendorSub":          "return navigator.vendorSub",

    # ── Screen ─────────────────────────────────────────────────────────────────
    "screen.width":                 "return screen.width",
    "screen.height":                "return screen.height",
    "screen.availWidth":            "return screen.availWidth",
    "screen.availHeight":           "return screen.availHeight",
    "screen.colorDepth":            "return screen.colorDepth",
    "screen.pixelDepth":            "return screen.pixelDepth",
    "window.devicePixelRatio":      "return window.devicePixelRatio",
    "window.innerWidth":            "return window.innerWidth",
    "window.innerHeight":           "return window.innerHeight",
    "window.outerWidth":            "return window.outerWidth",
    "window.outerHeight":           "return window.outerHeight",

    # ── Timezone ───────────────────────────────────────────────────────────────
    "timezone.offset":              "return new Date().getTimezoneOffset()",
    "timezone.zone":                "return Intl.DateTimeFormat().resolvedOptions().timeZone",
    "timezone.locale":              "return Intl.DateTimeFormat().resolvedOptions().locale",

    # ── Plugins & MIME ─────────────────────────────────────────────────────────
    "navigator.plugins.length":     "return navigator.plugins.length",
    "navigator.mimeTypes.length":   "return navigator.mimeTypes.length",

    # ── WebGL ──────────────────────────────────────────────────────────────────
    "webgl.vendor": """
        try {
            var c = document.createElement('canvas');
            var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
            if (!gl) return null;
            var ext = gl.getExtension('WEBGL_debug_renderer_info');
            return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        } catch(e) { return 'error: ' + e.message; }
    """,
    "webgl.renderer": """
        try {
            var c = document.createElement('canvas');
            var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
            if (!gl) return null;
            var ext = gl.getExtension('WEBGL_debug_renderer_info');
            return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        } catch(e) { return 'error: ' + e.message; }
    """,
    "webgl.version": """
        try {
            var c = document.createElement('canvas');
            var gl = c.getContext('webgl');
            return gl ? gl.getParameter(gl.VERSION) : null;
        } catch(e) { return null; }
    """,
    "webgl.shadingLanguageVersion": """
        try {
            var c = document.createElement('canvas');
            var gl = c.getContext('webgl');
            return gl ? gl.getParameter(gl.SHADING_LANGUAGE_VERSION) : null;
        } catch(e) { return null; }
    """,
    "webgl2.supported": """
        try {
            return !!document.createElement('canvas').getContext('webgl2');
        } catch(e) { return false; }
    """,

    # ── Canvas fingerprint ─────────────────────────────────────────────────────
    "canvas.2d.dataURL.length": """
        try {
            var c = document.createElement('canvas');
            c.width = 200; c.height = 50;
            var ctx = c.getContext('2d');
            ctx.fillStyle = '#f60'; ctx.fillRect(0,0,200,50);
            ctx.fillStyle = '#069';
            ctx.font = '11pt Arial'; ctx.fillText('NightGlow fingerprint test', 2, 15);
            ctx.strokeStyle = 'rgba(102,204,0,0.7)';
            ctx.lineWidth = 2; ctx.beginPath();
            ctx.arc(50,25,20,0,Math.PI*2,true); ctx.stroke();
            return c.toDataURL().length;
        } catch(e) { return null; }
    """,
    "canvas.2d.pixel[50,25]": """
        try {
            var c = document.createElement('canvas');
            c.width = 200; c.height = 50;
            var ctx = c.getContext('2d');
            ctx.fillStyle = '#f60'; ctx.fillRect(0,0,200,50);
            var px = ctx.getImageData(50,25,1,1).data;
            return [px[0],px[1],px[2],px[3]];
        } catch(e) { return null; }
    """,

    # ── Audio ──────────────────────────────────────────────────────────────────
    "audio.supported": """
        return !!(window.AudioContext || window.webkitAudioContext);
    """,

    # ── Fonts (CSS) ───────────────────────────────────────────────────────────
    "fonts.monospace.width": """
        try {
            var s = document.createElement('span');
            s.style.fontFamily = 'monospace'; s.style.fontSize = '72px';
            s.style.visibility = 'hidden'; s.style.position = 'absolute';
            s.textContent = 'mmmmmmmmmmlli';
            document.body.appendChild(s);
            var w = s.offsetWidth;
            document.body.removeChild(s);
            return w;
        } catch(e) { return null; }
    """,

    # ── Media ──────────────────────────────────────────────────────────────────
    "media.video.mp4":  """
        try { return document.createElement('video').canPlayType('video/mp4'); }
        catch(e) { return null; }
    """,
    "media.video.webm": """
        try { return document.createElement('video').canPlayType('video/webm'); }
        catch(e) { return null; }
    """,
    "media.audio.ogg":  """
        try { return document.createElement('audio').canPlayType('audio/ogg'); }
        catch(e) { return null; }
    """,

    # ── Feature detection ──────────────────────────────────────────────────────
    "features.serviceWorker":    "return 'serviceWorker' in navigator",
    "features.indexedDB":        "return 'indexedDB' in window",
    "features.localStorage":     "return 'localStorage' in window",
    "features.sessionStorage":   "return 'sessionStorage' in window",
    "features.webSocket":        "return 'WebSocket' in window",
    "features.fetch":            "return 'fetch' in window",
    "features.geolocation":      "return 'geolocation' in navigator",
    "features.bluetooth":        "return 'bluetooth' in navigator",
    "features.usb":              "return 'usb' in navigator",
    "features.webRTC":           "return !!(window.RTCPeerConnection)",
    "features.sharedArrayBuffer":"return typeof SharedArrayBuffer !== 'undefined'",
    "features.atomics":          "return typeof Atomics !== 'undefined'",
    "features.bigInt":           "return typeof BigInt !== 'undefined'",
    "features.proxy":            "return typeof Proxy !== 'undefined'",
    "features.intl":             "return typeof Intl !== 'undefined'",
    "features.webAssembly":      "return typeof WebAssembly !== 'undefined'",
    "features.cssGrid":          """
        try {
            return CSS.supports('display','grid');
        } catch(e) { return null; }
    """,

    # ── Math fingerprint ──────────────────────────────────────────────────────
    "math.PI":           "return Math.PI",
    "math.E":            "return Math.E",
    "math.sqrt2":        "return Math.SQRT2",
    "math.tan(PI/4)":    "return Math.tan(Math.PI/4)",
    "math.sin(PI/6)":    "return Math.sin(Math.PI/6)",
    "math.acos(-1)":     "return Math.acos(-1)",
    "math.log2(1024)":   "return Math.log2(1024)",

    # ── Error stack format ─────────────────────────────────────────────────────
    "error.stack.format": """
        try { null.x; } catch(e) { return e.stack ? e.stack.split('\\n')[0] : null; }
    """,
    "error.name":  """
        try { null.x; } catch(e) { return e.name; }
    """,

    # ── Object / prototype ────────────────────────────────────────────────────
    "object.toString[object]":  "return Object.prototype.toString.call({})",
    "object.toString[array]":   "return Object.prototype.toString.call([])",
    "object.toString[window]":  "return Object.prototype.toString.call(window)",
    "object.toString[null]":    "return Object.prototype.toString.call(null)",

    # ── Performance timing ────────────────────────────────────────────────────
    "performance.supported":    "return typeof performance !== 'undefined'",
    "performance.timing.type":  """
        try { return performance.getEntriesByType('navigation')[0]?.type || null; }
        catch(e) { return null; }
    """,

    # ── Permissions (async — best effort) ────────────────────────────────────
    "permissions.notifications": """
        if (!navigator.permissions) return 'unsupported';
        return new Promise(r =>
            navigator.permissions.query({name:'notifications'})
                .then(p => r(p.state)).catch(() => r('error'))
        );
    """,

    # ── CSS paint worklet / Houdini ───────────────────────────────────────────
    "houdini.paintWorklet": "return typeof CSS !== 'undefined' && 'paintWorklet' in CSS",
}


# ── Bot-detection heuristics ──────────────────────────────────────────────────

BOT_CHECKS = [
    ("navigator.webdriver",           lambda v: v is True,
     "navigator.webdriver = true  → automated browser flag exposed"),
    ("navigator.languages",           lambda v: not v or len(v) == 0,
     "navigator.languages empty  → typical headless default"),
    ("navigator.plugins.length",      lambda v: v == 0,
     "no plugins  → common headless fingerprint"),
    ("screen.width",                  lambda v: v is None or v == 0,
     "screen.width = 0  → headless / no display"),
    ("navigator.hardwareConcurrency", lambda v: v == 0,
     "hardwareConcurrency = 0  → environment not reporting CPUs"),
    ("webgl.vendor",                  lambda v: v is None,
     "no WebGL  → headless without GPU"),
    ("timezone.zone",                 lambda v: v in (None, "UTC", ""),
     "timezone UTC  → often a giveaway in browser fingerprinting"),
    ("features.webRTC",               lambda v: not v,
     "no WebRTC  → unusual for a 'real' browser"),
    ("audio.supported",               lambda v: not v,
     "no AudioContext  → typical in headless"),
]


# ── Formatting helpers ────────────────────────────────────────────────────────

WIDTH = 72

def _fmt(v) -> str:
    if v is None:
        return "\033[90mnull\033[0m"
    if isinstance(v, bool):
        return ("\033[92mtrue\033[0m" if v else "\033[91mfalse\033[0m")
    if isinstance(v, list):
        return "[" + ", ".join(str(i) for i in v) + "]"
    s = str(v)
    return s[:120] + ("…" if len(s) > 120 else "")


def _section(title: str):
    print(f"\n\033[1;34m{'─'*WIDTH}\033[0m")
    print(f"\033[1;34m  {title}\033[0m")
    print(f"\033[1;34m{'─'*WIDTH}\033[0m")


# ── Main ──────────────────────────────────────────────────────────────────────

def run(base_url: str):
    print(f"\n\033[1mNightGlow CreepJS-style fingerprint report\033[0m")
    print(f"Target: {base_url}")
    print(f"{'─'*WIDTH}")

    wait_ready(base_url)
    sid = new_session(base_url)

    # Load a minimal HTML page so the DOM is available
    navigate(base_url, sid,
             "data:text/html,<html><head></head><body></body></html>")
    time.sleep(0.3)

    results = {}
    errors  = {}

    for key, script in PROBES.items():
        try:
            results[key] = execute(base_url, sid, script)
        except Exception as e:
            errors[key]  = str(e)
            results[key] = None

    delete_session(base_url, sid)

    # ── Print by section ──────────────────────────────────────────────────────
    sections = {
        "Navigator": [k for k in results if k.startswith("navigator.")],
        "Screen / Viewport": [k for k in results if k.startswith("screen.") or k.startswith("window.")],
        "Timezone": [k for k in results if k.startswith("timezone.")],
        "WebGL": [k for k in results if k.startswith("webgl") or k == "webgl2.supported"],
        "Canvas": [k for k in results if k.startswith("canvas.")],
        "Fonts": [k for k in results if k.startswith("fonts.")],
        "Media": [k for k in results if k.startswith("media.")],
        "Audio": [k for k in results if k.startswith("audio.")],
        "Features": [k for k in results if k.startswith("features.")],
        "Math": [k for k in results if k.startswith("math.")],
        "Error / Object": [k for k in results if k.startswith("error.") or k.startswith("object.")],
        "Performance / Permissions / Houdini": [k for k in results
                                                 if k.startswith("performance.") or
                                                    k.startswith("permissions.") or
                                                    k.startswith("houdini.")],
    }

    for section_name, keys in sections.items():
        if not keys:
            continue
        _section(section_name)
        for k in keys:
            label = k.ljust(42)
            val   = _fmt(results.get(k))
            err   = errors.get(k)
            if err:
                print(f"  {label}  \033[33m[error: {err[:40]}]\033[0m")
            else:
                print(f"  {label}  {val}")

    # ── Bot-detection summary ─────────────────────────────────────────────────
    _section("Bot-detection heuristics  (would trigger on a real site)")
    flags = []
    for probe, predicate, description in BOT_CHECKS:
        triggered = predicate(results.get(probe))
        mark = "\033[91m✗ FLAGGED\033[0m" if triggered else "\033[92m✓ clean \033[0m"
        print(f"  {mark}  {description}")
        if triggered:
            flags.append(description)

    # ── Summary ───────────────────────────────────────────────────────────────
    _section("Summary")
    total   = len(BOT_CHECKS)
    flagged = len(flags)
    clean   = total - flagged
    print(f"  Probes collected : {len(results)}")
    print(f"  Bot flags        : {flagged}/{total}")
    print(f"  Clean signals    : {clean}/{total}")
    if flagged == 0:
        print(f"\n  \033[92m✓ No bot-detection flags raised.\033[0m")
    else:
        print(f"\n  \033[93m⚠  {flagged} flag(s) raised — profile injection required for these signals.\033[0m")

    print(f"\n{'─'*WIDTH}\n")

    # JSON dump for artifact consumption
    print("\n--- JSON ---")
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:7000")
    args = parser.parse_args()
    run(args.url)
