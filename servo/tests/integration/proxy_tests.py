#!/usr/bin/env python3
"""
NightGlow / servoshell proxy integration tests.

Verifies that servoshell correctly routes HTTP traffic through a configured
proxy.  A minimal HTTP/CONNECT proxy (proxy_server.py) is started in a
background thread; the tests drive servoshell via WebDriver and assert that
the proxy recorded the expected requests.

Requirements:
  - servoshell must be started WITH the proxy flag:
        /app/nightglow --headless --webdriver 7001 --proxy http://PROXY_IP:PORT about:blank
  - proxy_server.py must be in the same directory as this file.

Usage:
    python3 proxy_tests.py \\
        --webdriver-url http://NIGHTGLOW_IP:7001 \\
        [--proxy-port 8888] \\
        [--junit test-results/proxy.xml]
"""

import argparse
import json
import os
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import urllib.parse

# Import the embedded proxy server (same directory)
sys.path.insert(0, os.path.dirname(__file__))
from proxy_server import ProxyServer


# ── Minimal HTTP client (no requests dep) ────────────────────────────────────

def _req(method: str, url: str, body: Optional[dict] = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=15) as resp:
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

    def execute_script(self, script: str, args: list = None) -> Any:
        return POST(
            self._session_url("/execute/sync"),
            {"script": script, "args": args or []},
        )["value"]


# ── Test runner ───────────────────────────────────────────────────────────────

@dataclass
class TestResult:
    name: str
    passed: bool
    error: str = ""
    duration_ms: float = 0.0


@dataclass
class Suite:
    results: List[TestResult] = field(default_factory=list)

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

    def summary(self) -> tuple:
        passed = sum(1 for r in self.results if r.passed)
        return passed, len(self.results)

    def write_junit(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        suite_el = ET.Element("testsuite", {
            "name": "nightglow-proxy",
            "tests": str(len(self.results)),
            "failures": str(sum(1 for r in self.results if not r.passed)),
            "time": f"{sum(r.duration_ms for r in self.results) / 1000:.3f}",
        })
        for r in self.results:
            tc = ET.SubElement(suite_el, "testcase", {
                "name": r.name,
                "classname": "Proxy",
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
            GET(f"{base_url}/status")
            print(f"  Browser ready ({base_url})")
            return
        except HTTPError:
            print(f"  Browser ready (responded on /status, {base_url})")
            return
        except (URLError, OSError) as exc:
            last_err = exc
        time.sleep(1)
    raise TimeoutError(f"Browser not ready after {timeout}s: {last_err}")


# ── Test definitions ──────────────────────────────────────────────────────────

def run_all(webdriver_url: str, proxy: ProxyServer, junit_path: str):
    print(f"\nNightGlow proxy integration tests → {webdriver_url}\n")

    wait_for_webdriver(webdriver_url)

    suite = Suite()
    s = WebDriverSession(webdriver_url)

    # ── 1. A WebDriver session can be created on the proxy-configured servoshell
    def test_proxy_session_creates():
        sid = s.new_session()
        assert sid and len(sid) > 0, "Empty session ID — could not create session"

    suite.run("proxy_session_creates", test_proxy_session_creates)

    if not s.session_id:
        print("\nSession creation failed — skipping remaining proxy tests")
        _finish(suite, junit_path)
        return

    # ── 2. HTTP navigation goes through the proxy ─────────────────────────────
    #
    # NOTE: This test WILL FAIL until servoshell honours the --proxy flag for
    # HTTP navigation.  That is intentional — this is a TDD test.
    def test_proxy_http_navigation():
        # Clear any previously recorded requests so this test is isolated
        with proxy._lock:
            proxy.requests.clear()

        s.navigate("http://example.com")

        # Give the proxy a moment to process the request
        time.sleep(1)

        recorded = proxy.recorded_hosts()
        assert any("example.com" in h for h in recorded), (
            f"Proxy did not record a request for example.com. "
            f"Recorded hosts: {recorded!r}"
        )

    suite.run("proxy_http_navigation", test_proxy_http_navigation)

    # ── 3. navigator.webdriver is not exposed even when using a proxy ─────────
    def test_proxy_webdriver_hidden():
        result = s.execute_script("return navigator.webdriver;")
        assert not result, (
            f"navigator.webdriver is {result!r} — stealth patch not applied "
            f"when proxy is in use"
        )

    suite.run("proxy_webdriver_hidden", test_proxy_webdriver_hidden)

    s.delete_session()
    _finish(suite, junit_path)


def _finish(suite: Suite, junit_path: str):
    suite.write_junit(junit_path)
    passed, total = suite.summary()
    print(f"\n{'─'*50}")
    print(f"Results: {passed}/{total} passed")
    print(f"JUnit:   {junit_path}")
    sys.exit(0 if passed == total else 1)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="NightGlow proxy integration tests"
    )
    parser.add_argument(
        "--webdriver-url",
        default="http://localhost:7001",
        help="WebDriver base URL for servoshell (default: http://localhost:7001)",
    )
    parser.add_argument(
        "--proxy-port",
        type=int,
        default=8888,
        help="Port for the internal proxy server (default: 8888)",
    )
    parser.add_argument(
        "--junit",
        default="test-results/proxy.xml",
        help="JUnit XML output path",
    )
    args = parser.parse_args()

    # Start the proxy server (internally, in a background thread)
    proxy = ProxyServer(host="0.0.0.0", port=args.proxy_port)
    proxy.start()

    # Print the proxy address so CI scripts can read it if needed
    import socket as _socket
    hostname = _socket.gethostname()
    try:
        local_ip = _socket.gethostbyname(hostname)
    except Exception:
        local_ip = "127.0.0.1"
    print(f"[proxy] address for servoshell: http://{local_ip}:{args.proxy_port}", flush=True)

    try:
        run_all(args.webdriver_url, proxy, args.junit)
    finally:
        proxy.stop()
        proxy.wait_stopped()
