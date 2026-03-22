# Nightglow

Headless browser built on Servo with W3C WebDriver and fingerprint spoofing.

## Pulling the image

```bash
docker pull registry.noogoo.ch/orderout/nightglow:latest
```

Or pin to a specific pipeline build:

```bash
docker pull registry.noogoo.ch/orderout/nightglow:<commit-sha>
```

## Quick start

```bash
docker run --rm -p 7000:7000 registry.noogoo.ch/orderout/nightglow:latest
```

WebDriver is now available at `http://localhost:7000`.

## Usage

### Headless with WebDriver (default)

```bash
docker run --rm -p 7000:7000 registry.noogoo.ch/orderout/nightglow:latest \
  --headless --webdriver 7000 about:blank
```

### With a fingerprint profile

Pass a JSON-encoded `BrowserProfile` via `--nightglow-profile` to spoof browser identity:

```bash
docker run --rm -p 7000:7000 registry.noogoo.ch/orderout/nightglow:latest \
  --headless --webdriver 7000 \
  --nightglow-profile '{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "label": "chrome124-win11",
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "platform": "Win32",
    "app_version": "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "product": "Gecko",
    "vendor": "Google Inc.",
    "vendor_sub": "",
    "product_sub": "20030107",
    "language": "en-US",
    "accept_language": "en-US,en;q=0.9",
    "timezone": "America/New_York",
    "timezone_offset": -300,
    "screen_width": 1920,
    "screen_height": 1080,
    "screen_avail_width": 1920,
    "screen_avail_height": 1040,
    "color_depth": 24,
    "pixel_depth": 24,
    "device_pixel_ratio": 1.0,
    "inner_width": 1280,
    "inner_height": 720,
    "outer_width": 1920,
    "outer_height": 1080,
    "hardware_concurrency": 8,
    "device_memory": 8.0,
    "plugins": [
      {
        "name": "PDF Viewer",
        "description": "Portable Document Format",
        "filename": "internal-pdf-viewer",
        "mime_types": ["application/pdf", "text/pdf"]
      }
    ],
    "fonts": [],
    "canvas_noise_seed": 12345678,
    "webgl_vendor": "Google Inc. (NVIDIA)",
    "webgl_renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "webgl_unmasked_vendor": "NVIDIA Corporation",
    "webgl_unmasked_renderer": "NVIDIA GeForce RTX 3070",
    "audio_noise_seed": 87654321,
    "proxy": null,
    "spoofed_ip": null,
    "do_not_track": false,
    "cookie_enabled": true,
    "java_enabled": false,
    "pdf_viewer_enabled": true,
    "hide_webdriver": true,
    "max_touch_points": 0
  }' \
  about:blank
```

### With a proxy

Set `"proxy"` in the profile to a SOCKS5 or HTTP proxy URL:

```json
"proxy": "socks5://user:pass@proxy.example.com:1080"
```

Or HTTP:

```json
"proxy": "http://proxy.example.com:8080"
```

## WebDriver API

Nightglow exposes a standard W3C WebDriver HTTP server (port 7000 by default).

### Health check

```bash
curl http://localhost:7000/status
# {"value":{"ready":true,...}}
```

### Basic session example (Python)

```python
import urllib.request, json

BASE = "http://localhost:7000"

def req(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method,
                               headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r).read())

# Open session
session_id = req("POST", "/session", {"capabilities": {}})["value"]["sessionId"]

# Navigate
req("POST", f"/session/{session_id}/url", {"url": "https://example.com"})

# Read title
print(req("GET", f"/session/{session_id}/title")["value"])

# Run JavaScript
result = req("POST", f"/session/{session_id}/execute/sync",
             {"script": "return navigator.userAgent", "args": []})
print(result["value"])

# Screenshot → save as PNG
import base64
png = base64.b64decode(req("GET", f"/session/{session_id}/screenshot")["value"])
open("screenshot.png", "wb").write(png)

# Close
req("DELETE", f"/session/{session_id}")
```

### Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/status` | — | Server readiness |
| `POST` | `/session` | `{"capabilities":{}}` | Open session |
| `DELETE` | `/session/:id` | — | Close session |
| `POST` | `/session/:id/url` | `{"url":"..."}` | Navigate |
| `GET` | `/session/:id/url` | — | Current URL |
| `GET` | `/session/:id/title` | — | Page title |
| `POST` | `/session/:id/execute/sync` | `{"script":"...","args":[]}` | Run JavaScript |
| `GET` | `/session/:id/screenshot` | — | PNG screenshot (base64) |

## CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--headless` / `-z` | off | Offscreen rendering, no window |
| `--webdriver PORT` | — | Start WebDriver server on PORT |
| `--nightglow-profile JSON` / `-N` | — | JSON-encoded `BrowserProfile` |
| `--user-agent STRING` / `-u` | — | Override user agent |
| `--screen-size WxH` | — | Override screen resolution |
| `--device-pixel-ratio FLOAT` | — | Override DPI ratio |
| `--window-size WxH` | — | Initial window size |
| `--output PATH` / `-o` | — | Save screenshot and exit |
| `--exit` / `-x` | off | Exit after first stable paint |
| `--certificate-path PATH` | — | Custom SSL certificate |

Pass a URL as the last argument to navigate on startup:

```bash
... --headless --webdriver 7000 https://example.com
```

## BrowserProfile fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID string | Profile identifier |
| `label` | string | Human-readable name |
| `user_agent` | string | Full UA string |
| `platform` | string | `navigator.platform` (e.g. `"Win32"`) |
| `app_version` | string | `navigator.appVersion` |
| `product` | string | `navigator.product` (always `"Gecko"`) |
| `vendor` | string | `navigator.vendor` (e.g. `"Google Inc."`) |
| `vendor_sub` | string | `navigator.vendorSub` |
| `product_sub` | string | `navigator.productSub` (e.g. `"20030107"`) |
| `language` | string | `navigator.language` |
| `accept_language` | string | `Accept-Language` header value |
| `timezone` | string | IANA timezone (e.g. `"America/New_York"`) |
| `timezone_offset` | int | Minutes from UTC (e.g. `-300`) |
| `screen_width/height` | uint | `screen.width/height` |
| `screen_avail_width/height` | uint | `screen.availWidth/availHeight` |
| `color_depth` | uint | `screen.colorDepth` (typically `24`) |
| `pixel_depth` | uint | `screen.pixelDepth` (typically `24`) |
| `device_pixel_ratio` | float | `window.devicePixelRatio` |
| `inner_width/height` | uint | `window.innerWidth/innerHeight` |
| `outer_width/height` | uint | `window.outerWidth/outerHeight` |
| `hardware_concurrency` | uint | `navigator.hardwareConcurrency` |
| `device_memory` | float | `navigator.deviceMemory` (GiB) |
| `plugins` | array | `navigator.plugins` entries |
| `fonts` | string array | Available font names |
| `canvas_noise_seed` | uint64 | Deterministic canvas noise seed |
| `webgl_vendor` | string | Masked WebGL vendor |
| `webgl_renderer` | string | Masked WebGL renderer |
| `webgl_unmasked_vendor` | string | Unmasked GPU vendor |
| `webgl_unmasked_renderer` | string | Unmasked GPU renderer |
| `audio_noise_seed` | uint64 | Deterministic audio fingerprint seed |
| `proxy` | string or null | Proxy URL (`socks5://...` or `http://...`) |
| `spoofed_ip` | string or null | Informational IP label |
| `do_not_track` | bool or null | `navigator.doNotTrack` |
| `cookie_enabled` | bool | `navigator.cookieEnabled` |
| `java_enabled` | bool | `navigator.javaEnabled()` |
| `pdf_viewer_enabled` | bool | `navigator.pdfViewerEnabled` |
| `hide_webdriver` | bool | Remove `navigator.webdriver` flag |
| `max_touch_points` | uint | `navigator.maxTouchPoints` |

## Running the test suite

With a nightglow container already running on port 7000:

```bash
# WebDriver integration tests
python3 servo/tests/integration/webdriver_tests.py --url http://localhost:7000

# Fingerprint signal report
python3 servo/tests/integration/fingerprint_report.py --url http://localhost:7000

# CreepJS headless-detection score (requires internet access)
python3 servo/tests/integration/creepjs_test.py --url http://localhost:7000 --threshold 0
```

## CI pipeline

The pipeline runs on every push to `main`:

| Stage | Job | What it does |
|-------|-----|-------------|
| `build` | `build` | Compiles Servo, pushes `registry.noogoo.ch/orderout/nightglow:<sha>` and `:latest` |
| `test` | `test-unit` | Rust unit tests for the nightglow library crate |
| `test` | `test-integration` | Starts the container, runs WebDriver tests |
| `test` | `test-proxy` | Tests proxy routing (allow_failure) |
| `fingerprint` | `fingerprint` | Collects full fingerprint report as artifact |
| `creepjs` | `creepjs` | Loads real CreepJS page, records headless/stealth scores |
| `cleanup` | `cleanup` | Deletes stale SHA tags from the registry |

Fingerprint and CreepJS reports are saved as pipeline artifacts and available for download in GitLab.
