#!/usr/bin/env python3
"""Serve the Rubiks Cube PWA production build on port 9983."""
import http.server
import os
import socketserver

PORT = 9983
ROOT = os.path.dirname(os.path.abspath(__file__))
DIRECTORY = os.path.join(ROOT, "dist")
NO_CACHE_FILES = {"index.html", "sw.js", "manifest.webmanifest"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        filename = os.path.basename(self.path.split("?", 1)[0]) or "index.html"
        if filename in NO_CACHE_FILES:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) and "." not in os.path.basename(self.path):
            self.path = "/index.html"
        super().do_GET()

    def log_message(self, format, *args):
        print(f"[RubiksCube] {self.address_string()} - {format % args}")


if __name__ == "__main__":
    if not os.path.isdir(DIRECTORY):
        raise SystemExit("dist/ not found. Run `npm run build` first.")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"RubiksCube serving on http://0.0.0.0:{PORT}")
        print(f"Local: http://localhost:{PORT}")
        httpd.serve_forever()
