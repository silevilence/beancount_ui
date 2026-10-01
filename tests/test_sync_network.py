import subprocess
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from beancount_ui.app import create_app
from beancount_ui.config import Settings
from beancount_ui.git_network import ProxyInput, redact_diagnostic, validate_proxy
from beancount_ui.ledger import Ledger
from beancount_ui.sync import GitFailure, Sync
from beancount_ui.writer import Writer
from conftest import git
from fastapi.testclient import TestClient


def test_clone_failure_logs_diagnostics_without_exposing_them_to_browser(
    sync, tmp_path, monkeypatch, caplog
):
    settings = replace(
        sync.settings,
        ledger_dir=tmp_path / "empty",
        state_dir=tmp_path / "empty-state",
        remote="https://github.com/example/ledger.git",
    )

    def fail(command, **kwargs):
        return subprocess.CompletedProcess(
            command, 128, b"", b"fatal: Could not resolve host: github.com\n"
        )

    client = TestClient(create_app(settings))
    monkeypatch.setattr("beancount_ui.sync.subprocess.run", fail)
    response = client.post("/api/sync/clone")
    assert response.status_code == 409
    assert "本地记录保留" in response.json()["detail"]
    assert "Could not resolve host" in caplog.text
    assert "clone" in caplog.text and "128" in caplog.text
    assert "Could not resolve host" not in response.text


def test_proxy_api_persists_before_clone_and_rejects_credentials(ledger):
    client = TestClient(create_app(ledger.settings))
    url = "socks5h://127.0.0.1:7890"
    assert client.post("/api/sync/proxy", json={"mode": "custom", "url": url}).json() == {
        "proxy_mode": "custom",
        "proxy_url": url,
    }
    restarted = TestClient(create_app(ledger.settings))
    state = restarted.get("/api/sync").json()
    assert state["proxy_mode"] == "custom" and state["proxy_url"] == url
    assert not state["connected"]
    response = restarted.post(
        "/api/sync/proxy", json={"mode": "custom", "url": "http://alice:password@host:7890"}
    )
    assert response.status_code == 422 and "alice" not in response.text
    assert restarted.get("/api/sync").json()["proxy_url"] == url
    assert restarted.post("/api/sync/proxy", json={"mode": "unknown"}).status_code == 422
    assert restarted.post("/api/sync/proxy", json={"mode": "direct"}).json() == {
        "proxy_mode": "direct",
        "proxy_url": "",
    }


@pytest.mark.parametrize(
    "url",
    [
        "localhost:7890",
        "ftp://localhost:7890",
        "http://localhost:0",
        "http://localhost:65536",
        "http://host:7890/path",
        "http://host:7890?token=secret",
        "http://host:7890#secret",
        "http://host:7890\nheader",
        "http://:7890",
        "http://user@host:7890",
    ],
)
def test_invalid_proxy_is_rejected(url):
    with pytest.raises(ValueError, match="代理地址"):
        validate_proxy(url)


@pytest.mark.parametrize("scheme", ["http", "https", "socks5", "socks5h"])
def test_proxy_protocols_and_ipv6(scheme):
    assert validate_proxy(f"{scheme}://[::1]:7890") == f"{scheme}://[::1]:7890"


def test_proxy_env_fallback_and_override_for_all_git_operations(ledger, monkeypatch):
    monkeypatch.setenv("BEANCOUNT_LEDGER_DIR", str(ledger.settings.ledger_dir))
    monkeypatch.setenv("BEANCOUNT_STATE_DIR", str(ledger.settings.state_dir))
    monkeypatch.setenv("BEANCOUNT_GIT_PROXY", "http://localhost:7890")
    sync = Sync(Writer(Ledger(Settings.from_env())))
    calls = []

    def capture(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, b"ok\n", b"")

    monkeypatch.setattr("beancount_ui.sync.subprocess.run", capture)
    monkeypatch.setenv("NO_PROXY", "*")
    for op in ["clone", "ls-remote", "fetch", "push"]:
        assert sync.git(op, "https://github.com/example/ledger.git") == "ok"
        command, kwargs = calls[-1]
        assert "http.proxy=http://localhost:7890" in command
        assert kwargs["env"]["NO_PROXY"] == ""
    sync.configure_proxy(ProxyInput(mode="custom", url="socks5h://localhost:1080"))
    sync.git("fetch", env={"GIT_INDEX_FILE": "isolated-index"}, binary=True)
    assert "http.proxy=socks5h://localhost:1080" in calls[-1][0]
    assert calls[-1][1]["env"]["GIT_INDEX_FILE"] == "isolated-index"
    sync.configure_proxy(ProxyInput(mode="direct"))
    sync.git("fetch")
    assert "http.proxy=" in calls[-1][0]
    sync.configure_proxy(ProxyInput(mode="system"))
    sync.git("fetch")
    assert "http.proxy=http://localhost:7890" in calls[-1][0]
    sync.settings = replace(sync.settings, git_proxy="")
    sync.git("fetch")
    assert not any(arg.startswith("http.proxy=") for arg in calls[-1][0])
    assert calls[-1][1]["env"]["NO_PROXY"] == "*"


@pytest.mark.parametrize("mode", ["custom", "direct"])
def test_real_git_uses_selected_proxy_or_direct_despite_existing_config(sync, monkeypatch, mode):
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path)
            self.send_error(502, "Proxy test reached")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    address = f"http://127.0.0.1:{server.server_port}"
    remote = f"{address}/ledger.git"
    # Existing per-URL proxy and NO_PROXY must not silently defeat the UI choice.
    git(sync.root, "config", f"http.{remote}.proxy", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    try:
        sync.configure_proxy(ProxyInput(mode=mode, url=address))
        with pytest.raises(GitFailure):
            sync.git("ls-remote", remote)
        assert len(seen) == 1
        assert seen[0].startswith(remote if mode == "custom" else "/ledger.git")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("failure", ["exit", "timeout", "missing"])
def test_git_failure_logs_redacted_details_and_preserves_files(
    ledger, monkeypatch, caplog, failure
):
    sync = Sync(Writer(ledger))
    path = sync.root / "index.bean"
    original = path.read_bytes()
    diagnostic = (
        b"fatal: connection refused https://alice:password@github.com/repo?access_token=hidden\n"
        b"Proxy-Authorization: Basic dXNlcjpwYXNz\nAuthorization: Bearer bearer-secret\n"
        b"password=helper-secret ghp_exampletoken github_pat_exampletoken\n"
    )

    def fail(command, **kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired(command, 45, stderr=diagnostic)
        if failure == "missing":
            raise FileNotFoundError(2, "git executable missing")
        return subprocess.CompletedProcess(command, 128, b"private ledger content", diagnostic)

    monkeypatch.setattr("beancount_ui.sync.subprocess.run", fail)
    with pytest.raises(GitFailure, match="本地记录保留"):
        sync.git("fetch")
    assert "operation=fetch" in caplog.text and "elapsed=" in caplog.text
    assert (
        "git executable missing" if failure == "missing" else "connection refused"
    ) in caplog.text
    for secret in [
        "alice",
        "password@",
        "hidden",
        "dXNlcjpwYXNz",
        "bearer-secret",
        "helper-secret",
        "exampletoken",
        "private ledger content",
    ]:
        assert secret not in caplog.text
    assert path.read_bytes() == original


def test_real_https_clone_reaches_proxy_and_logs_failure(tmp_path, caplog):
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_CONNECT(self):
            seen.append(self.path)
            self.send_error(502, "Proxy cannot reach upstream")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    sync = Sync(
        Writer(
            Ledger(
                Settings(
                    tmp_path / "empty",
                    tmp_path / "state",
                    remote="https://github.com/example/ledger.git",
                    git_proxy=f"http://127.0.0.1:{server.server_port}",
                )
            )
        )
    )
    try:
        with pytest.raises(GitFailure, match="Git clone 失败"):
            sync.clone()
        assert seen == ["github.com:443"]
        assert "operation=clone" in caplog.text and "502" in caplog.text
        assert not sync.state()["connected"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_diagnostic_redacts_before_truncation_and_handles_invalid_encoding():
    output = redact_diagnostic(b"\xff\x1b[31mhttps://alice:" + b"x" * 9000 + b"@host/repo\x00")
    assert "alice" not in output and "xxx" not in output and "host/repo" in output
    assert "\x1b" not in output and "\x00" not in output
