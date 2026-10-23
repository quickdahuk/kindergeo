#!/usr/bin/env python3
"""Serve Country Quest to phones and computers on your network.

  python3 tools/serve.py            # port 8000
  python3 tools/serve.py 8080       # another port

Then open one of the printed addresses.  Text files are gzip-compressed for
browsers that accept it, and hidden folders (.cache, .venv, ...) are not served.
"""
import argparse
import gzip
import http.server
import io
import os
import socket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPRESS = {'.html', '.css', '.js', '.mjs', '.json', '.svg', '.webmanifest'}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.woff2': 'font/woff2',
    }
    gz_cache = {}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        url_path = self.path.split('?', 1)[0].split('#', 1)[0]
        if any(part.startswith('.') for part in url_path.split('/') if part):
            self.send_error(404)
            return None
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            index = os.path.join(path, 'index.html')
            if not url_path.endswith('/') or not os.path.exists(index):
                return super().send_head()
            path = index
        ext = os.path.splitext(path)[1]
        if ext in COMPRESS and os.path.isfile(path) and 'gzip' in self.headers.get('Accept-Encoding', ''):
            mtime = os.path.getmtime(path)
            cached = self.gz_cache.get(path)
            if not cached or cached[0] != mtime:
                with open(path, 'rb') as f:
                    cached = (mtime, gzip.compress(f.read(), 6))
                self.gz_cache[path] = cached
            body = cached[1]
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        # Always revalidate, so phones pick up changes after a reload.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet


def lan_address():
    """This computer's address on the local network (no packets are sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser(description='Serve Country Quest on the local network.')
    ap.add_argument('port', nargs='?', type=int, default=8000)
    ap.add_argument('--host', default='0.0.0.0', help='address to listen on (default: all)')
    args = ap.parse_args()
    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    print('Country Quest is running:')
    print('  on this computer:  http://localhost:%d/' % args.port)
    ip = lan_address()
    if ip and args.host in ('0.0.0.0', ''):
        print('  on your network:   http://%s:%d/' % (ip, args.port))
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
