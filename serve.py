#!/usr/bin/env python3
"""Serveur de dev LibrisRecto — http://localhost:5180

La caméra exige un contexte sécurisé : localhost est accepté par les navigateurs,
mais pour tester depuis un téléphone sur le réseau local il faut du HTTPS
(GitHub Pages, ou un tunnel type `cloudflared tunnel --url http://localhost:5180`).
"""
import http.server
import socketserver
from pathlib import Path

PORT = 5180
ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Pas de cache : sinon on debugge l'ancienne version du service worker.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} — {fmt % args}")


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"LibrisRecto -> http://localhost:{PORT}  (Ctrl+C pour arrêter)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nArrêté.")
