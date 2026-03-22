#!/usr/bin/env python3
"""
CreepJS headless-detection scraper for NightGlow / servoshell.

Loads https://abrahamjuliot.github.io/creepjs/ inside the browser, waits for
the analysis to complete, then extracts and prints the three confidence scores:

  • Like-headless %  — behavioural signals that resemble a headless environment
  • Headless %       — hard headless indicators  (webdriver flag, UA, etc.)
  • Stealth %        — evidence of anti-detection patching

Exit codes
  0  headless % == 0  (browser passes as human)
  1  headless % > 0   (browser is detectable)
  2  page did not render / scores could not be extracted

Usage:
    python3 creepjs_test.py --url http://<host>:7000 [--threshold 0]
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/"

# ── WebDriver helpers ──────────────────────────────────────────────────────────

def _req(method: str, url: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def wait_ready(base: str, timeout: int = 120):
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


# ── CreepJS DOM extraction ─────────────────────────────────────────────────────

# Waits until the result container is present and the first score has been filled
WAIT_SCRIPT = """
var el = document.querySelector('#headless-resistance-detection-results');
if (!el) return null;
var rating = el.querySelector('.like-headless-rating, .headless-rating, .stealth-rating');
if (!rating) return null;
// CreepJS writes "N% like headless:" into the text — check it's not empty/placeholder
var txt = rating.textContent || '';
return txt.trim().length > 2 ? 'ready' : null;
"""

EXTRACT_SCRIPT = """
function pct(selector) {
    var el = document.querySelector(selector);
    if (!el) return null;
    // text is like "6% like headless: ..."
    var m = el.textContent.match(/^(\\d+)%/);
    return m ? parseInt(m[1], 10) : null;
}

function signals(selector) {
    var container = document.querySelector(selector);
    if (!container) return {};
    // signals live inside the modal-content div as "key: value" lines
    var modal = container.querySelector('.modal-content div');
    if (!modal) return {};
    var out = {};
    modal.innerHTML.split('<br>').forEach(function(line) {
        var clean = line.replace(/<[^>]+>/g, '').trim();
        if (!clean) return;
        var idx = clean.indexOf(':');
        if (idx === -1) return;
        out[clean.slice(0, idx).trim()] = clean.slice(idx + 1).trim();
    });
    return out;
}

// Also grab the Resistance section
function resistance() {
    var el = document.querySelector('#headless-resistance-detection-results .col-six:last-child');
    if (!el) return {};
    var out = {};
    el.querySelectorAll('div').forEach(function(div) {
        var txt = div.textContent.trim();
        var idx = txt.indexOf(':');
        if (idx !== -1) out[txt.slice(0, idx).trim()] = txt.slice(idx + 1).trim();
    });
    return out;
}

// Platform hints
function platformHints() {
    var el = document.querySelector('.block-text');
    return el ? el.textContent.trim() : null;
}

return {
    likeHeadless: pct('.like-headless-rating'),
    headless:     pct('.headless-rating'),
    stealth:      pct('.stealth-rating'),
    likeHeadlessSignals: signals('.like-headless-rating'),
    headlessSignals:     signals('.headless-rating'),
    stealthSignals:      signals('.stealth-rating'),
    resistance:          resistance(),
    platformHints:       platformHints(),
    chromium:            (document.querySelector('#headless-resistance-detection-results')
                           || {textContent: ''}).textContent.includes('chromium: true'),
};
"""

# ── Formatting ────────────────────────────────────────────────────────────────

W = 72

def _bar(pct: int, width: int = 40) -> str:
    filled = int(width * pct / 100)
    bar    = "█" * filled + "░" * (width - filled)
    color  = "\033[92m" if pct == 0 else ("\033[93m" if pct < 20 else "\033[91m")
    return f"{color}{bar}\033[0m  {pct}%"


def _section(title: str):
    print(f"\n\033[1;34m{'─'*W}\033[0m")
    print(f"\033[1;34m  {title}\033[0m")
    print(f"\033[1;34m{'─'*W}\033[0m")


def _signal_table(signals: dict):
    for k, v in signals.items():
        v = v.strip()
        color = "\033[91m" if v == "true" else ("\033[92m" if v == "false" else "\033[90m")
        print(f"    {k:<35}  {color}{v}\033[0m")


# ── Main ──────────────────────────────────────────────────────────────────────

def run(base_url: str, threshold: int) -> int:
    print(f"\n\033[1mNightGlow → CreepJS headless detection test\033[0m")
    print(f"Browser : {base_url}")
    print(f"Target  : {CREEPJS_URL}")
    print(f"{'─'*W}")

    wait_ready(base_url)
    sid = new_session(base_url)

    print("\n  Navigating to CreepJS …")
    navigate(base_url, sid, CREEPJS_URL)

    # Wait for CreepJS to complete its async analysis (up to 60 s)
    print("  Waiting for analysis to complete …", end="", flush=True)
    deadline = time.time() + 90
    ready = None
    while time.time() < deadline:
        try:
            ready = execute(base_url, sid, WAIT_SCRIPT)
            if ready == "ready":
                break
        except Exception:
            pass
        print(".", end="", flush=True)
        time.sleep(2)
    print()

    if ready != "ready":
        print("\n\033[91m  ✗ CreepJS did not complete within 90s — "
              "page may not have rendered.\033[0m\n")
        delete_session(base_url, sid)
        return 2

    data = execute(base_url, sid, EXTRACT_SCRIPT) or {}
    delete_session(base_url, sid)

    like_hl = data.get("likeHeadless")
    headless = data.get("headless")
    stealth  = data.get("stealth")
    chromium = data.get("chromium", False)

    # ── Scores ────────────────────────────────────────────────────────────────
    _section("Headless-resistance scores")
    print(f"  chromium detected : {'yes' if chromium else 'no'}")
    print()
    for label, val in [
        ("like-headless %", like_hl),
        ("headless %      ", headless),
        ("stealth %       ", stealth),
    ]:
        if val is None:
            print(f"  {label}  \033[90munable to extract\033[0m")
        else:
            print(f"  {label}  {_bar(val)}")

    # ── Signal breakdown ──────────────────────────────────────────────────────
    if data.get("likeHeadlessSignals"):
        _section("Like-headless signals")
        _signal_table(data["likeHeadlessSignals"])

    if data.get("headlessSignals"):
        _section("Headless signals")
        _signal_table(data["headlessSignals"])

    if data.get("stealthSignals"):
        _section("Stealth signals")
        _signal_table(data["stealthSignals"])

    if data.get("resistance"):
        _section("Resistance / privacy mode")
        for k, v in data["resistance"].items():
            print(f"    {k:<20}  {v}")

    if data.get("platformHints"):
        _section("Platform hints")
        print(f"    {data['platformHints']}")

    # ── Verdict ───────────────────────────────────────────────────────────────
    _section("Verdict")
    if headless is None:
        print("  \033[93m⚠  Scores not extracted — page did not render creepjs fully.\033[0m")
        result = 2
    elif headless > threshold:
        print(f"  \033[91m✗  headless={headless}% exceeds threshold={threshold}% "
              f"— browser is detectable.\033[0m")
        result = 1
    else:
        print(f"  \033[92m✓  headless={headless}% ≤ threshold={threshold}% "
              f"— browser passes headless check.\033[0m")
        result = 0

    print(f"\n{'─'*W}\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url",       default="http://localhost:7000")
    parser.add_argument("--threshold", type=int, default=0,
                        help="Max allowed headless%% (exit 1 if exceeded). Default 0.")
    args = parser.parse_args()
    sys.exit(run(args.url, args.threshold))
