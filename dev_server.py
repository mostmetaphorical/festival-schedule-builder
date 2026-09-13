"""Serve app/ for local development, with caching switched off.

Python's built-in server lets the browser cache JavaScript modules, so after an
edit the page can keep running the old code - which makes a fixed bug look
unfixed, or an unfixed one look fixed. This sends no-store on every response.

    ./.venv/bin/python dev_server.py            # http://localhost:8124
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8124
    root = Path(__file__).parent / "app"
    handler = partial(NoCacheHandler, directory=str(root))
    print(f"Serving {root} at http://localhost:{port} (no caching)")
    ThreadingHTTPServer(("", port), handler).serve_forever()


if __name__ == "__main__":
    main()
