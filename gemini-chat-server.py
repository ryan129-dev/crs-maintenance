from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import json

UPSTREAM = (
    "https://manju-pool.xiaoniuds.com/gemini/v1beta/models/"
)

MODELS = {"/generate": "gemini-3.5-flash-lite", "/image": "gemini-3.1-flash-image"}

class Handler(BaseHTTPRequestHandler):
    def reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/":
            return self.send_error(404)
        self.reply(200, "text/html; charset=utf-8",
                   Path(__file__).with_name("gemini-chat.html").read_bytes())

    def do_POST(self):
        model = MODELS.get(self.path)
        if model is None:
            return self.send_error(404)
        key = self.headers.get("x-api-key")
        size = int(self.headers.get("Content-Length", "0"))
        if not key or not 0 < size <= 1000000:
            return self.reply(400, "application/json", b'{"error":"Missing key or invalid body size"}')
        request = Request(f"{UPSTREAM}{model}:generateContent", data=self.rfile.read(size),
                          headers={"Content-Type": "application/json", "x-api-key": key})
        try:
            with urlopen(request, timeout=110) as response:
                self.reply(response.status, "application/json", response.read())
        except HTTPError as error:
            self.reply(error.code, "application/json", error.read())
        except (URLError, TimeoutError) as error:
            self.reply(502, "application/json",
                       json.dumps({"error": str(error)}).encode())

ThreadingHTTPServer(("127.0.0.1", 8769), Handler).serve_forever()
