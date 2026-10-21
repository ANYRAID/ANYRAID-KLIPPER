#!/usr/bin/env python3
# Check that Lychee accepts valid links and rejects real regressions.
# This file may be distributed under the terms of the GNU GPLv3 license.
import http.server
import os
from pathlib import Path
import subprocess
import tempfile
import threading


def check(binary, root, name, content, error, offline=True):
    source = root / (name + ".md")
    source.write_text(content, encoding="utf-8")
    args = [binary, "--no-progress", "--max-retries", "0"]
    if offline:
        args += ["--offline", "--include-fragments"]
    result = subprocess.run(
        args + [str(source)], cwd=root, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
        check=False,
    )
    if error is None:
        passed = result.returncode == 0
    else:
        passed = result.returncode != 0 and error in result.stdout
    if not passed:
        raise SystemExit("Unexpected result for %s:\n%s"
                         % (name, result.stdout))
    print("PASS: " + name)


class MissingPage(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_error(404, "Deliberate broken-link fixture")

    def log_message(self, *args):
        pass


def main():
    binary = os.environ.get("LYCHEE_BIN", "lychee")
    with tempfile.TemporaryDirectory(prefix="klipper-links-") as directory:
        root = Path(directory)
        (root / "target.md").write_text(
            "# English\n\n## 简体中文\n", encoding="utf-8")
        (root / "image.png").write_bytes(b"image fixture")
        check(binary, root, "valid",
              "[English](target.md#english)\n[中文](target.md#简体中文)\n"
              "![image](image.png)", None)
        check(binary, root, "missing-file", "[broken](missing.md)",
              "missing.md")
        check(binary, root, "missing-anchor",
              "[broken](target.md#missing-section)", "Cannot find fragment")
        check(binary, root, "missing-image", "![broken](missing.png)",
              "missing.png")
        # No repository config here: this loopback URL is an isolated fixture.
        with http.server.HTTPServer(("127.0.0.1", 0), MissingPage) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                url = "http://127.0.0.1:%d/missing" % server.server_port
                check(binary, root, "http-404", "[broken](%s)" % url,
                      "404", offline=False)
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    main()
