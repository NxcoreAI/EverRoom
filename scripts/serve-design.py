import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# 静态预览 docs/design 草图用：PORT 环境变量决定端口（preview 工具自动分配）。
port = int(os.environ.get("PORT", "4173"))
root = os.path.dirname(os.path.abspath(__file__)) + "/../docs/design"
os.chdir(root)
with ThreadingHTTPServer(("127.0.0.1", port), SimpleHTTPRequestHandler) as httpd:
    httpd.serve_forever()
