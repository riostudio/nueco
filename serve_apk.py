#!/usr/bin/env python3
"""
Minimal LAN host for the MemoPad staging APK.

Serves ONE apk file at a fixed path (no directory listing, so nothing else in the
repo — secrets, node_modules — is exposed). Lets a phone on the same network
download the build by browsing to the URL.

Usage:
  python serve_apk.py                      # serves frontend/build-staging-192-168-20-32.apk on 0.0.0.0:8765
  python serve_apk.py --apk path/to.apk --port 8765 --host 0.0.0.0

Then on the device's browser:  http://192.168.20.32:8765/memopad-staging.apk
"""
import argparse
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DOWNLOAD_PATH = "/memopad-staging.apk"
APK_MIME = "application/vnd.android.package-archive"


def make_handler(apk_path: str):
    apk_name = os.path.basename(apk_path)

    class Handler(BaseHTTPRequestHandler):
        server_version = "memopad-apk-host"

        def _send_index(self):
            size_mb = os.path.getsize(apk_path) / (1024 * 1024)
            body = (
                "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                "<title>MemoPad staging</title>"
                "<div style='font-family:-apple-system,sans-serif;max-width:480px;margin:48px auto;"
                "padding:0 20px;text-align:center'>"
                "<h1 style='color:#D84315'>MemoPad — staging build</h1>"
                f"<p>{apk_name} · {size_mb:.0f} MB</p>"
                f"<p><a href='{DOWNLOAD_PATH}' style='display:inline-block;padding:16px 32px;"
                "background:#D84315;color:#fff;text-decoration:none;border-radius:12px;"
                "font-size:18px;font-weight:600'>Download &amp; install APK</a></p>"
                "<p style='color:#78909C;font-size:14px'>Enable “Install from unknown sources” "
                "when prompted.</p></div>"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _serve_apk(self, head_only=False):
            size = os.path.getsize(apk_path)
            self.send_response(200)
            self.send_header("Content-Type", APK_MIME)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f'attachment; filename="{apk_name}"')
            self.end_headers()
            if head_only:
                return
            with open(apk_path, "rb") as f:
                while chunk := f.read(1024 * 256):
                    self.wfile.write(chunk)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self._send_index()
            elif self.path == DOWNLOAD_PATH:
                self._serve_apk()
            else:
                self.send_error(404, "Not found (only %s is served)" % DOWNLOAD_PATH)

        def do_HEAD(self):
            if self.path == DOWNLOAD_PATH:
                self._serve_apk(head_only=True)
            else:
                self.send_error(404)

        def log_message(self, fmt, *args):
            print("[apk-host]", self.address_string(), fmt % args)

    return Handler


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", default="frontend/memopad-staging.apk")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    apk_path = os.path.abspath(args.apk)
    if not os.path.isfile(apk_path):
        raise SystemExit(f"APK not found: {apk_path}")

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(apk_path))
    ip = lan_ip()
    print(f"Serving {apk_path}")
    print(f"  device URL:   http://{ip}:{args.port}{DOWNLOAD_PATH}")
    print(f"  landing page: http://{ip}:{args.port}/")
    print("Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
