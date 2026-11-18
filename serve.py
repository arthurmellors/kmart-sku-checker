#!/usr/bin/env python3
"""Local web UI for visualising Kmart SKU Constructor checks."""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import check_skus

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
SKUS_FILE = ROOT / "skus.txt"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787


def load_default_skus() -> list[str]:
    if not SKUS_FILE.exists():
        return []
    return check_skus.load_skus([], str(SKUS_FILE))


class Handler(BaseHTTPRequestHandler):
    server_version = "KmartSkuChecker/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/defaults":
            skus = load_default_skus()
            self._send_json(200, {"skus": skus, "source": "skus.txt" if skus else None})
            return

        relative = parsed.path.lstrip("/") or "index.html"
        if ".." in relative.split("/"):
            self._send_json(400, {"error": "Invalid path"})
            return

        target = (WEB_ROOT / relative).resolve()
        if not str(target).startswith(str(WEB_ROOT.resolve())) or not target.is_file():
            self._send_json(404, {"error": "Not found"})
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
        }:
            content_type = f"{content_type}; charset=utf-8"
        self._send(200, target.read_bytes(), content_type)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/check":
            self._send_json(404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON body"})
            return

        sku_values = payload.get("skus") or []
        if isinstance(sku_values, str):
            sku_values = sku_values.splitlines()
        if not isinstance(sku_values, list):
            self._send_json(400, {"error": "skus must be a list or string"})
            return

        skus = check_skus.load_skus([str(v) for v in sku_values], None)
        if not skus:
            self._send_json(400, {"error": "Provide at least one SKU"})
            return

        country = str(payload.get("country") or "both").upper()
        if country not in {"AU", "NZ", "BOTH"}:
            self._send_json(400, {"error": "country must be AU, NZ, or both"})
            return
        if country == "BOTH":
            country = "both"

        delay = payload.get("delay", 0.1)
        try:
            delay_f = float(delay)
        except (TypeError, ValueError):
            delay_f = 0.1

        markets = ["AU", "NZ"] if country == "both" else [country]
        checked_at = datetime.now(timezone.utc).isoformat()
        results = check_skus.run_checks(skus, markets, delay_f)
        self._send_json(
            200,
            {
                "checked_at": checked_at,
                "skus": skus,
                "markets": markets,
                "results": results,
            },
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the Kmart SKU Checker web UI")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)

    if not WEB_ROOT.exists():
        print(f"Missing web assets at {WEB_ROOT}", file=sys.stderr)
        return 1

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"SKU Checker UI → {url}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
