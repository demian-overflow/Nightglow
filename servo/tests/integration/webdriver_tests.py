#!/usr/bin/env python3
"""
NightGlow / servoshell WebDriver integration tests.

Drives the running servoshell binary via the W3C WebDriver HTTP API.
No Selenium dependency — plain requests calls only.

Usage:
    python3 webdriver_tests.py [--url http://localhost:7000] [--junit test-results/webdriver.xml]

The binary must already be running:
    /app/nightglow --headless --webdriver 7000 about:blank
"""

import argparse
import base64
import json
import os
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import urllib.request
import urllib.parse


# ── Minimal HTTP client (no requests dep) ────────────────────────────────────

def _req(method: str, url: str, body: Optional[dict] = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def GET(url: str) -> dict:
    return _req("GET", url)


def POST(url: str, body: dict = None) -> dict:
    return _req("POST", url, body or {})


def DELETE(url: str) -> dict:
    return _req("DELETE", url)


# ── WebDriver session helper ──────────────────────────────────────────────────

class WebDriverSession:
    """Thin wrapper around a W3C WebDriver session."""

    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")
        self.session_id: Optional[str] = None

    def _url(self, path: str) -> str:
        return f"{self.base}{path}"

    def _session_url(self, path: str = "") -> str:
        assert self.session_id, "No active session"
        return f"{self.base}/session/{self.session_id}{path}"

    def status(self) -> dict:
        return GET(self._url("/status"))

    def new_session(self) -> str:
        caps = {
            "capabilities": {
                "alwaysMatch": {
                    "browserName": "servo",
                }
            }
        }
        resp = POST(self._url("/session"), caps)
        self.session_id = resp["value"]["sessionId"]
        return self.session_id

    def delete_session(self):
        if self.session_id:
            DELETE(self._session_url())
            self.session_id = None

    def navigate(self, url: str):
        POST(self._session_url("/url"), {"url": url})

    def current_url(self) -> str:
        return GET(self._session_url("/url"))["value"]

    def title(self) -> str:
        return GET(self._session_url("/title"))["value"]

    def execute_script(self, script: str, args: list = None) -> Any:
        return POST(
            self._session_url("/execute/sync"),
            {"script": script, "args": args or []},
        )["value"]

    def screenshot_png(self) -> bytes:
        b64 = GET(self._session_url("/screenshot"))["value"]
        return base64.b64decode(b64)


# ── Test runner ───────────────────────────────────────────────────────────────

@dataclass
class TestResult:
    name: str
    passed: bool
    error: str = ""
    duration_ms: float = 0.0


@dataclass
class Suite:
    results: list[TestResult] = field(default_factory=list)

    def run(self, name: str, fn: Callable):
        start = time.monotonic()
        try:
            fn()
            elapsed = (time.monotonic() - start) * 1000
            self.results.append(TestResult(name, True, duration_ms=elapsed))
            print(f"  PASS  {name}  ({elapsed:.0f}ms)")
        except Exception as exc:
            elapsed = (time.monotonic() - start) * 1000
            err = traceback.format_exc()
            self.results.append(TestResult(name, False, error=err, duration_ms=elapsed))
            print(f"  FAIL  {name}  ({elapsed:.0f}ms)")
            print(f"        {exc}")

    def summary(self) -> tuple[int, int]:
        passed = sum(1 for r in self.results if r.passed)
        return passed, len(self.results)

    def write_junit(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        suite_el = ET.Element("testsuite", {
            "name": "nightglow-webdriver",
            "tests": str(len(self.results)),
            "failures": str(sum(1 for r in self.results if not r.passed)),
            "time": f"{sum(r.duration_ms for r in self.results) / 1000:.3f}",
        })
        for r in self.results:
            tc = ET.SubElement(suite_el, "testcase", {
                "name": r.name,
                "classname": "WebDriver",
                "time": f"{r.duration_ms / 1000:.3f}",
            })
            if not r.passed:
                ET.SubElement(tc, "failure", {"message": r.error.splitlines()[0]}).text = r.error
        ET.ElementTree(suite_el).write(path, encoding="unicode", xml_declaration=True)


# ── Wait for browser ──────────────────────────────────────────────────────────

def wait_for_webdriver(base_url: str, timeout: int = 60):
    """Poll /status until the browser is ready or timeout expires."""
    deadline = time.monotonic() + timeout
    last_err = None
    while time.monotonic() < deadline:
        try:
            resp = GET(f"{base_url}/status")
            # Servo may return ready:false but that still means the server is up
            print(f"  Browser ready ({base_url})")
            return
        except HTTPError:
            # Servo returns 500 on /status once the server is initialised but
            # before any session exists — that means it IS up, proceed.
            print(f"  Browser ready (responded on /status, {base_url})")
            return
        except (URLError, OSError) as exc:
            last_err = exc
        time.sleep(1)
    raise TimeoutError(f"Browser not ready after {timeout}s: {last_err}")


# ── Test definitions ──────────────────────────────────────────────────────────

def run_all(base_url: str, junit_path: str):
    print(f"\nNightGlow WebDriver integration tests → {base_url}\n")

    wait_for_webdriver(base_url)

    suite = Suite()
    s = WebDriverSession(base_url)

    # ── 1. Status endpoint ────────────────────────────────────────────────────
    def test_status():
        resp = s.status()
        assert "value" in resp, f"Unexpected /status response: {resp}"
        # Servo sets ready:true once WebDriver server is initialised
        assert resp["value"].get("ready") is True, f"Browser not ready: {resp['value']}"

    suite.run("status_endpoint_ready", test_status)

    # ── 2. Session lifecycle ──────────────────────────────────────────────────
    def test_new_session():
        sid = s.new_session()
        assert sid and len(sid) > 0, "Empty session ID"

    suite.run("new_session", test_new_session)

    # Remaining tests require a live session — skip if creation failed
    if not s.session_id:
        print("\nSession creation failed — skipping remaining tests")
        _finish(suite, junit_path)
        return

    # ── 3. Navigate to a data: URL and verify ─────────────────────────────────
    DATA_URL = "data:text/html,<title>NightGlow%20Test</title><h1>hello</h1>"

    def test_navigate_data_url():
        s.navigate(DATA_URL)
        url = s.current_url()
        assert url.startswith("data:"), f"Unexpected URL: {url}"

    suite.run("navigate_data_url", test_navigate_data_url)

    # ── 4. Page title via WebDriver ───────────────────────────────────────────
    def test_page_title():
        s.navigate(DATA_URL)
        title = s.title()
        assert title == "NightGlow Test", f"Unexpected title: {title!r}"

    suite.run("page_title", test_page_title)

    # ── 5. Script execution: arithmetic ───────────────────────────────────────
    def test_execute_script_arithmetic():
        result = s.execute_script("return 6 * 7;")
        assert result == 42, f"Expected 42, got {result!r}"

    suite.run("execute_script_arithmetic", test_execute_script_arithmetic)

    # ── 6. Script execution: DOM access ───────────────────────────────────────
    def test_execute_script_dom():
        s.navigate("data:text/html,<p id='x'>nightglow</p>")
        result = s.execute_script("return document.getElementById('x').textContent;")
        assert result == "nightglow", f"Got {result!r}"

    suite.run("execute_script_dom", test_execute_script_dom)

    # ── 7. navigator.webdriver is hidden ─────────────────────────────────────
    # NightGlow sets hide_webdriver=true in BrowserProfile.chrome_win11_us(),
    # meaning the automation marker must not be visible to pages.
    def test_navigator_webdriver_hidden():
        result = s.execute_script("return navigator.webdriver;")
        assert not result, (
            f"navigator.webdriver is {result!r} — stealth patch not applied"
        )

    suite.run("navigator_webdriver_hidden", test_navigator_webdriver_hidden)

    # ── 8. navigator.platform matches profile ────────────────────────────────
    # The default chrome_win11_us profile sets platform="Win32".
    # When servoshell is launched with --user-agent from a NightGlow profile,
    # the UA string should contain "Windows NT".
    def test_user_agent_contains_windows():
        ua = s.execute_script("return navigator.userAgent;")
        assert isinstance(ua, str) and len(ua) > 0, f"Empty UA: {ua!r}"
        # We only assert it's a non-empty string here since the profile injection
        # into servoshell is handled at the launcher level, not inside WebDriver.
        # A future test can pass --user-agent and assert exact match.
        print(f"        UA={ua[:80]}")

    suite.run("user_agent_non_empty", test_user_agent_contains_windows)

    # ── 9. Screenshot returns a valid PNG ─────────────────────────────────────
    PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

    def test_screenshot_png():
        s.navigate("data:text/html,<body style='background:red'></body>")
        png = s.screenshot_png()
        assert len(png) > 100, f"Screenshot too small ({len(png)} bytes)"
        assert png[:8] == PNG_MAGIC, (
            f"Not a PNG: magic bytes are {png[:8]!r}"
        )

    suite.run("screenshot_is_png", test_screenshot_png)

    # ── 10. Multiple navigations in one session ───────────────────────────────
    def test_multiple_navigations():
        for i in range(3):
            s.navigate(f"data:text/html,<title>page{i}</title>")
            title = s.title()
            assert title == f"page{i}", f"Navigation {i}: expected 'page{i}', got {title!r}"

    suite.run("multiple_navigations", test_multiple_navigations)

    # ── 11. Session cleanup ───────────────────────────────────────────────────
    def test_delete_session():
        s.delete_session()
        assert s.session_id is None

    suite.run("delete_session", test_delete_session)

    _finish(suite, junit_path)


def _finish(suite: Suite, junit_path: str):
    suite.write_junit(junit_path)
    passed, total = suite.summary()
    print(f"\n{'─'*50}")
    print(f"Results: {passed}/{total} passed")
    print(f"JUnit:   {junit_path}")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:7000",
                        help="WebDriver base URL (default: http://localhost:7000)")
    parser.add_argument("--junit", default="test-results/webdriver.xml",
                        help="JUnit XML output path")
    args = parser.parse_args()
    run_all(args.url, args.junit)
