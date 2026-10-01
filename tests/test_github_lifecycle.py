"""Exercise real Git HTTPS authentication against an isolated local Git server.

The CONNECT proxy never forwards traffic; github.com is served with a temporary
test certificate, a disposable repository and fake credentials. No GitHub access.
"""

import base64
import os
import shutil
import ssl
import subprocess
import sys
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from beancount_ui.app import create_app
from conftest import git
from fastapi.testclient import TestClient

TOKEN = "ghp_disposable_test_only"
REMOTE = "https://github.com/example/ledger.git"


@pytest.fixture
def github_server(sync, tmp_path, monkeypatch):
    executable = shutil.which("openssl")
    if os.name == "nt":
        candidate = Path(shutil.which("git")).parents[1] / "usr/bin/openssl.exe"
        if candidate.exists():
            executable = str(candidate)
    if not executable:
        pytest.skip("Local HTTPS Git fixture requires openssl")
    certificate, key = tmp_path / "test.pem", tmp_path / "test.key"
    config = tmp_path / "openssl.cnf"
    config.write_text("[req]\ndistinguished_name=dn\n[dn]\n", encoding="utf-8")
    created = subprocess.run(
        [
            executable,
            "req",
            "-config",
            str(config),
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=github.com",
            "-addext",
            "subjectAltName=DNS:github.com",
            "-keyout",
            str(key),
            "-out",
            str(certificate),
        ],
        capture_output=True,
        timeout=30,
    )
    assert created.returncode == 0, created.stderr
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "no-global-config"))
    monkeypatch.setenv("GIT_SSL_CAINFO", str(certificate))
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "http.schannelUseSSLCAInfo")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "true")
    remote = Path(git(sync.root, "remote", "get-url", "origin"))
    git(remote, "config", "http.receivepack", "true")
    expected = "Basic " + base64.b64encode(f"example:{TOKEN}".encode()).decode()
    state = {"private": False, "authorized": 0, "anonymous": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_CONNECT(self):
            if self.path != "github.com:443":
                self.send_error(403)
                return
            self.send_response(200)
            self.end_headers()
            self.connection = context.wrap_socket(self.connection, server_side=True)
            self.rfile = self.connection.makefile("rb")
            self.wfile = self.connection.makefile("wb")
            self.close_connection = False
            self.handle_one_request()
            self.wfile.flush()
            self.close_connection = True

        def do_GET(self):
            self.serve_git()

        def do_POST(self):
            self.serve_git()

        def serve_git(self):
            url = urlsplit(self.path)
            if not url.path.startswith("/example/ledger.git/"):
                self.send_error(404)
                return
            authorized = self.headers.get("Authorization") == expected
            if (state["private"] or "git-receive-pack" in self.path) and not authorized:
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="test repository"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            state["authorized" if authorized else "anonymous"] += 1
            size = self.headers.get("Content-Length", "0")
            process_env = os.environ | {
                "GIT_PROJECT_ROOT": str(remote.parent),
                "GIT_HTTP_EXPORT_ALL": "1",
                "PATH_INFO": url.path.replace("/example/ledger.git/", f"/{remote.name}/", 1),
                "REQUEST_METHOD": self.command,
                "QUERY_STRING": url.query,
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": size,
                "SERVER_PROTOCOL": "HTTP/1.1",
                "REMOTE_ADDR": "127.0.0.1",
            }
            if authorized:
                process_env["REMOTE_USER"] = "example"
            if self.headers.get("Git-Protocol"):
                process_env["GIT_PROTOCOL"] = self.headers["Git-Protocol"]
            result = subprocess.run(
                ["git", "http-backend"],
                input=self.rfile.read(int(size)),
                env=process_env,
                capture_output=True,
                timeout=30,
            )
            headers, _, content = result.stdout.partition(b"\r\n\r\n")
            parsed = [line.decode().split(":", 1) for line in headers.splitlines() if b":" in line]
            status = next(
                (int(value.split()[0]) for name, value in parsed if name == "Status"), 200
            )
            self.send_response(status)
            for name, value in parsed:
                if name.lower() not in {"status", "content-length"}:
                    self.send_header(name, value.strip())
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", state, remote
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("private", [False, True], ids=["public", "private"])
def test_web_api_clone_save_push_and_fresh_process_reuse(sync, tmp_path, github_server, private):
    proxy, server_state, remote = github_server
    server_state["private"] = private
    settings = replace(
        sync.settings,
        ledger_dir=tmp_path / "installed-ledger",
        state_dir=tmp_path / "persistent-state",
        remote=REMOTE,
    )
    client = TestClient(create_app(settings))
    assert client.post("/api/sync/proxy", json={"mode": "custom", "url": proxy}).status_code == 200
    first = client.post("/api/sync/check-connection")
    assert first.status_code == (409 if private else 200), first.text

    def save_auth():
        response = client.post(
            "/api/sync/github-auth", json={"username": "example", "token": TOKEN}
        )
        assert response.status_code == 200, response.text
        assert TOKEN not in response.text

    if private:
        save_auth()
    clone = client.post("/api/sync/clone")
    assert clone.status_code == 200, clone.text
    connected = client.post("/api/sync/connect", json={"revision": clone.json()["revision"]})
    assert connected.status_code == 200, connected.text
    preview = client.post(
        "/api/preview",
        json={
            "request_id": str(uuid4()),
            "revision": client.get("/api/ledger").json()["revision"],
            "raw": '2026-10-01 * "web only"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n',
        },
    )
    assert preview.status_code == 200, preview.text
    assert (
        client.post("/api/commit", json={"request_id": preview.json()["request_id"]}).status_code
        == 200
    )

    def backup():
        plan = client.post("/api/sync/backup-preview")
        assert plan.status_code == 200, plan.text
        return client.post(
            "/api/sync/backup",
            json={
                "revision": plan.json()["revision"],
                "head": plan.json()["head"],
            },
        )

    if not private:
        denied = backup()
        assert denied.status_code == 409  # Public read access does not grant write access.
        assert git(settings.ledger_dir, "rev-list", "--count", "origin/master-1..HEAD") == "1"
        save_auth()
    result = backup()
    assert result.status_code == 200, result.text
    assert result.json()["sync"] == "已同步"
    assert "web only" in git(remote, "show", "master-1:txs/2026/10.bean")
    state_before = (settings.state_dir / "github-auth.json").read_bytes()
    head_before = git(settings.ledger_dir, "rev-parse", "HEAD")
    # Fresh application + Git helper processes read only persistent files; no in-memory cache.
    script = """
import sys
from pathlib import Path
from fastapi.testclient import TestClient
from beancount_ui.app import create_app
from beancount_ui.config import Settings
client = TestClient(create_app(Settings(Path(sys.argv[1]), Path(sys.argv[2]), remote=sys.argv[3])))
status = client.get('/api/sync').json()
assert status['github_auth']['configured'] and status['connected']
assert status['proxy_mode'] == 'custom'
check = client.post('/api/sync/check-connection')
assert check.status_code == 200, check.text
plan = client.post('/api/sync/backup-preview').json()
response = client.post('/api/sync/backup', json={
    'revision': plan['revision'], 'head': plan['head']})
assert response.status_code == 200, response.text
assert response.json()['sync'] == '已同步'
print('persistent settings and Git access restored')
"""
    restarted = subprocess.run(
        [
            "uv",
            "run",
            "--no-project",
            "--python",
            sys.executable,
            "python",
            "-c",
            script,
            str(settings.ledger_dir),
            str(settings.state_dir),
            REMOTE,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=os.environ | {"PYTHONIOENCODING": "utf-8"},
        timeout=60,
    )
    assert restarted.returncode == 0, restarted.stderr
    assert "Git access restored" in restarted.stdout
    assert (settings.state_dir / "github-auth.json").read_bytes() == state_before
    assert git(settings.ledger_dir, "rev-parse", "HEAD") == head_before
    assert server_state["authorized"] > 0
    assert (server_state["anonymous"] > 0) is (not private)
