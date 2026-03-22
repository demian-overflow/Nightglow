# Browser Fingerprint Categories

A browser fingerprint is the set of signals a website can collect — without cookies or storage — to identify or classify a visitor. Signals come from HTTP headers, JavaScript APIs, rendering engines, and hardware. This document maps every major category and describes how each signal is collected.

---

## Category Map

```mermaid
mindmap
  root((Browser<br/>Fingerprint))
    HTTP Layer
      User-Agent header
      Accept-Language
      Accept-Encoding
      DNT / Sec-GPC
      Referer policy
      TLS fingerprint
    Navigator API
      Identity strings
      Language & locale
      Hardware hints
      Plugin list
      Connection info
      Permissions
    Screen & Display
      Physical dimensions
      Available area
      Colour depth
      Device pixel ratio
      Window dimensions
    Timezone & Locale
      IANA timezone
      UTC offset
      Date formatting
      Number formatting
    Canvas
      2D pixel hash
      Text rendering
      Emoji rendering
    WebGL
      Renderer string
      Vendor string
      Extension list
      Parameter limits
      Shader precision
    Audio
      OfflineAudioContext hash
      Oscillator noise
      Dynamics compressor
    Fonts
      CSS metric probing
      measureText width
      Fallback detection
    Hardware Signals
      CPU core count
      RAM amount
      GPU model
      Battery status
      Sensor APIs
    Network
      IP address
      WebRTC local IPs
      Connection type & speed
      DNS prefetch timing
    Feature Detection
      Supported JS APIs
      CSS feature flags
      Codec support
      WASM / SharedArrayBuffer
    Bot & Automation
      navigator.webdriver
      CDP artefacts
      Timing anomalies
      Headless indicators
```

---

## Signal Collection Flow

```mermaid
flowchart TD
    Request["HTTP Request"] --> H["HTTP Layer\nsignals"]
    PageLoad["Page Load"] --> JS["JavaScript\nexecution"]

    JS --> N["Navigator API"]
    JS --> S["Screen / Display"]
    JS --> T["Timezone / Locale"]
    JS --> R["Rendering\n(Canvas / WebGL)"]
    JS --> A["Audio"]
    JS --> F["Fonts"]
    JS --> HW["Hardware Signals"]
    JS --> NET["Network\n(WebRTC)"]
    JS --> FD["Feature Detection"]
    JS --> BOT["Bot Detection"]

    H --> AGG["Aggregation\n& Hashing"]
    N --> AGG
    S --> AGG
    T --> AGG
    R --> AGG
    A --> AGG
    F --> AGG
    HW --> AGG
    NET --> AGG
    FD --> AGG
    BOT --> AGG

    AGG --> FP["Fingerprint ID"]
    AGG --> CONF["Headless /\nBot Confidence Score"]
```

---

## 1. HTTP Layer

Collected from every request — no JavaScript needed.

| Signal | Header / Mechanism | Stable? |
|--------|-------------------|---------|
| User-Agent string | `User-Agent` | High |
| Accepted languages | `Accept-Language` | High |
| Accepted encodings | `Accept-Encoding` | Medium |
| Do-not-track intent | `DNT`, `Sec-GPC` | Low |
| HTTPS preference | `Upgrade-Insecure-Requests` | Low |
| TLS version & cipher suites | TLS handshake | High |
| TLS extension order (JA3) | TLS handshake | High |
| HTTP/2 frame settings | SETTINGS frame | High |

**TLS / JA3 fingerprint** is particularly stable because the cipher suite list and their ordering are determined by the TLS library compiled into the browser, not by JavaScript or settings.

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server

    B->>S: TLS ClientHello<br/>(cipher suites, extensions, curves)
    note right of S: JA3 hash computed here
    S-->>B: TLS ServerHello
    B->>S: HTTP GET /<br/>User-Agent: ...<br/>Accept-Language: ...<br/>Accept-Encoding: ...
    note right of S: Headers fingerprinted here
```

---

## 2. Navigator API

The `navigator` object exposes dozens of browser identity and capability signals.

### Identity strings

```js
navigator.userAgent          // full UA string
navigator.appVersion         // UA minus "Mozilla/"
navigator.platform           // OS platform, e.g. "Win32"
navigator.vendor             // browser vendor, e.g. "Google Inc."
navigator.vendorSub          // always ""
navigator.productSub         // build date string, e.g. "20030107"
navigator.product            // always "Gecko"
```

### Language & locale

```js
navigator.language           // primary language, e.g. "en-US"
navigator.languages          // ordered list, e.g. ["en-US", "en", "de"]
```

### Hardware hints

```js
navigator.hardwareConcurrency   // logical CPU count
navigator.deviceMemory          // RAM in GiB (rounded: 0.25–8)
navigator.maxTouchPoints        // 0 = no touchscreen
```

### Other signals

```js
navigator.cookieEnabled
navigator.pdfViewerEnabled
navigator.javaEnabled()
navigator.doNotTrack
navigator.webdriver            // true when driven by automation
navigator.onLine
navigator.connection           // effectiveType, downlink, rtt
```

### Plugin list

`navigator.plugins` returns a `PluginArray`. Real Chrome on Windows typically contains one entry (`PDF Viewer`). Headless browsers commonly return an empty list.

---

## 3. Screen & Display

```mermaid
block-beta
  columns 3
  A["screen.width\nscreen.height\n(physical pixels)"]:1
  B["screen.availWidth\nscreen.availHeight\n(minus taskbar)"]:1
  C["screen.colorDepth\nscreen.pixelDepth\n(typically 24)"]:1
  D["window.devicePixelRatio\n(HiDPI multiplier)"]:1
  E["window.innerWidth/Height\n(viewport)"]:1
  F["window.outerWidth/Height\n(chrome included)"]:1
```

**Headless indicators:**
- `screen.width === 0` or `screen.height === 0`
- `devicePixelRatio === 1.0` on a machine expected to have HiDPI
- `innerWidth/outerWidth` ratio inconsistent with any real browser chrome size

---

## 4. Timezone & Locale

| Signal | API | Example |
|--------|-----|---------|
| IANA timezone | `Intl.DateTimeFormat().resolvedOptions().timeZone` | `"America/New_York"` |
| UTC offset (minutes) | `new Date().getTimezoneOffset()` | `300` |
| Locale date format | `new Date().toLocaleDateString()` | `"3/22/2026"` |
| Number format | `(1234.5).toLocaleString()` | `"1,234.5"` |
| First day of week | `Intl.Locale` weekInfo | `1` (Monday) |

Mismatch between the `Accept-Language` header (HTTP layer) and `navigator.language` (JS layer) is a strong bot signal.

---

## 5. Canvas Fingerprinting

Canvas rendering differs across GPU drivers, OS font renderers, and anti-aliasing implementations. The same drawing instructions produce subtly different pixels on different machines.

```mermaid
flowchart LR
    subgraph Collection
        A["Create offscreen\n&lt;canvas&gt;"] --> B["Draw text + shapes\nat known coordinates"]
        B --> C["canvas.toDataURL()\nor getImageData()"]
        C --> D["Hash pixel array\n→ fingerprint value"]
    end

    subgraph Variation Sources
        E["GPU / driver"]
        F["OS font renderer\n(DirectWrite / CoreText / FreeType)"]
        G["Anti-aliasing settings"]
        H["Subpixel rendering"]
    end

    E & F & G & H --> B
```

**Collected signals:**
- SHA hash of the full PNG data URL
- Individual pixel RGBA values at known positions
- Text bounding box width via `measureText()`

**Noise injection** (Nightglow's `canvas_noise_seed`): adds deterministic per-profile sub-1 LSB perturbations that make canvas hashes unique per session while remaining visually identical.

---

## 6. WebGL Fingerprinting

WebGL exposes detailed GPU information and rendering behaviour.

```mermaid
flowchart TD
    WGL["WebGL context\n(getContext('webgl2'))"]

    WGL --> STR["Renderer strings\ngl.getParameter(RENDERER)\ngl.getParameter(VENDOR)"]
    WGL --> UNMASKED["Unmasked strings\nWEBGL_debug_renderer_info\nextension"]
    WGL --> EXT["Extension list\ngl.getSupportedExtensions()"]
    WGL --> PARAMS["Parameter limits\nMAX_TEXTURE_SIZE\nMAX_VIEWPORT_DIMS\nMAX_VERTEX_ATTRIBS ..."]
    WGL --> SHADER["Shader precision\ngetShaderPrecisionFormat()\nfor vertex + fragment"]
    WGL --> RENDER["Rendered image hash\ndraw a known scene\nhash pixel output"]
```

| Parameter | Example (real Chrome/NVIDIA) |
|-----------|------------------------------|
| `RENDERER` | `"ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)"` |
| `VENDOR` | `"Google Inc. (NVIDIA)"` |
| Unmasked renderer | `"NVIDIA GeForce RTX 3070"` |
| Unmasked vendor | `"NVIDIA Corporation"` |

Headless without GPU emulation returns software renderers like `"Mesa/X.org"` or blank strings.

---

## 7. Audio Fingerprinting

```mermaid
flowchart LR
    subgraph Processing chain
        OSC["OscillatorNode\nfrequency = 10000 Hz\ntype = triangle"] --> COMP
        COMP["DynamicsCompressorNode\nthreshold = -50\nknee = 40\nratio = 12\nattack = 0\nrelease = 0.25"] --> DEST["OfflineAudioContext\nbuffer destination"]
    end

    DEST --> RENDER["render 4096 samples"]
    RENDER --> HASH["sum channel[4500..5000]\n→ fingerprint float"]
```

The summed sample value differs by ~0.0001 across machines due to floating-point rounding in different audio processing implementations (native vs. software DSP). The value is highly stable for a given hardware/driver combination.

**Noise injection** (Nightglow's `audio_noise_seed`): perturbs the rendered buffer values by a seeded deterministic offset below the audible threshold.

---

## 8. Font Fingerprinting

Font availability is probed by measuring rendered text width — no direct font enumeration API exists.

```mermaid
flowchart TD
    PROBE["For each candidate font"] --> SET["ctx.font = '72px &lt;candidate&gt;, monospace'"]
    SET --> MEASURE["ctx.measureText('mmmmmmmmlli').width"]
    MEASURE --> COMPARE["width ≠ baseline monospace width?"]
    COMPARE -->|Yes| PRESENT["Font is installed"]
    COMPARE -->|No| ABSENT["Font not available"]
```

Windows, macOS, and Linux each have distinct default font sets. The intersection and difference of installed fonts is a strong OS and user-profile signal.

**Common probed fonts:** Arial, Calibri, Cambria, Comic Sans MS, Courier New, Georgia, Impact, Times New Roman, Trebuchet MS, Verdana, and 100+ others.

---

## 9. Hardware Signals

| Signal | API | Notes |
|--------|-----|-------|
| CPU logical cores | `navigator.hardwareConcurrency` | Capped at 8 in some browsers |
| RAM amount | `navigator.deviceMemory` | Rounded to nearest power of 2, max 8 GiB |
| GPU model | WebGL `WEBGL_debug_renderer_info` | Full model string |
| Battery level | `navigator.getBattery()` | Deprecated/gated in most browsers |
| Gyroscope / accelerometer | `DeviceMotionEvent` | Mobile only |
| Ambient light sensor | `AmbientLightSensor` | Rarely available |

---

## 10. Network Signals

```mermaid
flowchart TD
    subgraph WebRTC ICE leak
        A["new RTCPeerConnection()\ncreateDataChannel()"] --> B["createOffer()"]
        B --> C["ICE candidate events\ncontain local LAN IP\n192.168.x.x / 10.x.x.x"]
    end

    subgraph Connection type
        D["navigator.connection\n.effectiveType   '4g'\n.downlink        10\n.rtt             50"]
    end

    subgraph DNS timing
        E["Performance API\nresource timing\nfor known domains"]
    end
```

**WebRTC local IP leak** is the most impactful: even behind a proxy or VPN, the browser may emit the real local network IP via ICE candidates when establishing a peer connection.

---

## 11. Feature Detection

Supported APIs are enumerated via existence checks:

```mermaid
block-beta
  columns 4
  A["WebAssembly"]:1
  B["SharedArrayBuffer"]:1
  C["BigInt"]:1
  D["Proxy / Reflect"]:1
  E["ServiceWorker"]:1
  F["IndexedDB"]:1
  G["WebSocket"]:1
  H["WebRTC"]:1
  I["CSS Grid"]:1
  J["CSS Houdini"]:1
  K["Permissions API"]:1
  L["Bluetooth / USB"]:1
```

The exact combination of supported and unsupported features narrows the browser version and configuration significantly.

**Codec probing:**
```js
video.canPlayType('video/mp4; codecs="avc1.42E01E"')  // H.264
video.canPlayType('video/webm; codecs="vp9"')          // VP9
audio.canPlayType('audio/ogg; codecs="vorbis"')        // Vorbis
```

**Math constants** — floating-point results differ across architectures for:
```js
Math.tan(Math.PI / 4)      // not exactly 1.0
Math.sin(Math.PI / 6)
Math.acos(-1)
```

---

## 12. Bot & Automation Detection

```mermaid
flowchart TD
    subgraph Hard signals
        WD["navigator.webdriver === true"]
        CDP["window.cdc_adoQpoasnfa76pfcZLmcfl_Array\n(CDP injection artefact)"]
        CHROME["window.chrome absent\n(present in real Chrome)"]
        PERMS["Notification permission\nis 'denied' by default\n(headless default)"]
    end

    subgraph Soft signals
        UA["UA claims Chrome\nbut WebGL shows Mesa"]
        LANG["navigator.languages\nis empty []"]
        PLUG["navigator.plugins.length === 0"]
        SCREEN["screen.width === 800\nscreen.height === 600\n(headless defaults)"]
        TZ["timezone = UTC\n(headless default)"]
    end

    subgraph Behavioural
        MOUSE["No mouse movement\nbefore interaction"]
        TIMING["setTimeout resolves\nfaster than 4ms\n(no throttling)"]
        FOCUS["document.hasFocus()\nreturns false"]
    end

    WD & CDP & CHROME & PERMS --> HARD_SCORE["Hard bot score"]
    UA & LANG & PLUG & SCREEN & TZ --> SOFT_SCORE["Soft bot score"]
    MOUSE & TIMING & FOCUS --> BEHAV_SCORE["Behavioural score"]

    HARD_SCORE & SOFT_SCORE & BEHAV_SCORE --> FINAL["Combined confidence\n(e.g. CreepJS scores:\nheadless % / stealth %)"]
```

---

## Nightglow Implementation Status

```mermaid
quadrantChart
    title Signal Coverage: Collected vs Spoofed
    x-axis "Not Spoofed" --> "Spoofed"
    y-axis "Not Collected" --> "Collected"

    User-Agent: [0.85, 0.95]
    Platform: [0.85, 0.90]
    Languages: [0.85, 0.85]
    hardwareConcurrency: [0.85, 0.80]
    deviceMemory: [0.85, 0.75]
    Screen dimensions: [0.80, 0.85]
    Timezone: [0.80, 0.80]
    navigator.webdriver: [0.90, 0.70]
    Proxy routing: [0.75, 0.65]
    Canvas noise: [0.15, 0.90]
    WebGL renderer: [0.10, 0.88]
    Audio noise: [0.10, 0.85]
    Plugins: [0.10, 0.75]
    Fonts: [0.10, 0.70]
    WebRTC IP leak: [0.05, 0.80]
    TLS fingerprint: [0.05, 0.75]
    Behavioural timing: [0.05, 0.60]
```

| Category | Signals collected | Spoofed by nightglow |
|----------|:-----------------:|:--------------------:|
| HTTP / User-Agent | ✓ | ✓ |
| Navigator identity | ✓ | ✓ |
| Language / locale | ✓ | ✓ |
| Hardware hints | ✓ | ✓ |
| Screen & display | ✓ | ✓ |
| Timezone | ✓ | ✓ |
| Webdriver flag | ✓ | ✓ |
| Proxy routing | ✓ | ✓ |
| Canvas pixel noise | ✓ | ✗ not implemented |
| WebGL renderer / vendor | ✓ | ✗ not implemented |
| Audio context noise | ✓ | ✗ not implemented |
| Navigator plugins | ✓ | ✗ not implemented |
| Font availability | ✓ | ✗ not implemented |
| WebRTC IP leak | ✓ | ✗ not implemented |
| TLS / JA3 | ✓ | ✗ not implemented |
| Behavioural signals | ✓ | ✗ out of scope |
