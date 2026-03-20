#!/usr/bin/env python3
"""
Minimal HTTP/CONNECT proxy server — pure Python stdlib, no external deps.

Can be used as a library (ProxyServer class) or run standalone:

    python3 proxy_server.py [--host 0.0.0.0] [--port 8888]

The server records every CONNECT host and every HTTP GET host+path it sees,
accessible via ProxyServer.requests (list of dicts with keys: method, host, path).
"""

import argparse
import socket
import threading
import time
from typing import List, Dict


class ProxyServer:
    """Threaded HTTP/CONNECT proxy that records requests."""

    def __init__(self, host: str = "0.0.0.0", port: int = 8888):
        self.host = host
        self.port = port
        self.requests: List[Dict] = []
        self._lock = threading.Lock()
        self._sock: socket.socket = None
        self._thread: threading.Thread = None
        self._stop_event = threading.Event()

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self):
        """Start listening in a background daemon thread."""
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.host, self.port))
        self._sock.listen(64)
        self._sock.settimeout(1.0)   # so the accept loop can check stop_event
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        print(f"[proxy] listening on {self.host}:{self.port}", flush=True)

    def stop(self):
        """Signal the server to shut down."""
        self._stop_event.set()
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass

    def wait_stopped(self, timeout: float = 5.0):
        if self._thread:
            self._thread.join(timeout)

    def recorded_hosts(self) -> List[str]:
        with self._lock:
            return [r["host"] for r in self.requests]

    # ── Internal ──────────────────────────────────────────────────────────────

    def _record(self, method: str, host: str, path: str = ""):
        with self._lock:
            self.requests.append({"method": method, "host": host, "path": path})
        print(f"[proxy] {method} {host}{path}", flush=True)

    def _accept_loop(self):
        while not self._stop_event.is_set():
            try:
                conn, addr = self._sock.accept()
            except (socket.timeout, OSError):
                continue
            t = threading.Thread(
                target=self._handle_connection,
                args=(conn,),
                daemon=True,
            )
            t.start()

    def _handle_connection(self, conn: socket.socket):
        try:
            conn.settimeout(10.0)
            raw = b""
            # Read until we have the full request header
            while b"\r\n\r\n" not in raw:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                raw += chunk
                if len(raw) > 65536:
                    break

            if not raw:
                return

            header_section = raw.split(b"\r\n\r\n", 1)[0].decode("latin-1", errors="replace")
            lines = header_section.split("\r\n")
            if not lines:
                return
            request_line = lines[0]
            parts = request_line.split(" ", 2)
            if len(parts) < 2:
                return
            method, target = parts[0], parts[1]

            if method == "CONNECT":
                self._handle_connect(conn, target, raw)
            else:
                self._handle_http(conn, method, target, raw)
        except Exception as exc:
            print(f"[proxy] handler error: {exc}", flush=True)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handle_connect(self, client: socket.socket, target: str, _raw: bytes):
        """Handle HTTPS CONNECT tunneling."""
        host, _, port_str = target.partition(":")
        port = int(port_str) if port_str.isdigit() else 443
        self._record("CONNECT", host, f":{port}")

        try:
            remote = socket.create_connection((host, port), timeout=10)
        except OSError as exc:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return

        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        self._tunnel(client, remote)

    def _handle_http(self, client: socket.socket, method: str, target: str, raw: bytes):
        """Handle plain HTTP GET/POST/etc. forwarding."""
        # target may be an absolute URL like http://example.com/path
        if target.startswith("http://"):
            rest = target[7:]
        else:
            rest = target
        slash = rest.find("/")
        if slash == -1:
            host = rest
            path = "/"
        else:
            host = rest[:slash]
            path = rest[slash:]

        self._record(method, host, path)

        # Connect to the real server and forward
        colon = host.find(":")
        if colon != -1:
            remote_host = host[:colon]
            remote_port = int(host[colon + 1:])
        else:
            remote_host = host
            remote_port = 80

        try:
            remote = socket.create_connection((remote_host, remote_port), timeout=10)
        except OSError:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return

        try:
            remote.sendall(raw)
            # Forward response back
            while True:
                data = remote.recv(65536)
                if not data:
                    break
                client.sendall(data)
        except OSError:
            pass
        finally:
            remote.close()

    def _tunnel(self, a: socket.socket, b: socket.socket):
        """Bidirectional raw tunnel between two sockets."""
        def forward(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        t = threading.Thread(target=forward, args=(b, a), daemon=True)
        t.start()
        forward(a, b)
        t.join(timeout=30)


# ── Standalone entry point ────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Minimal HTTP/CONNECT proxy")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8888)
    args = parser.parse_args()

    server = ProxyServer(host=args.host, port=args.port)
    server.start()
    print(f"[proxy] ready — press Ctrl+C to stop", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
        server.wait_stopped()
