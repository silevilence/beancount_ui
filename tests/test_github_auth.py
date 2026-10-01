import json
import os
import subprocess
from dataclasses import replace

import pytest
from beancount_ui.access import Access
from beancount_ui.app import create_app
from beancount_ui.github_auth import GithubAuth, GithubAuthInput
from beancount_ui.ledger import Ledger
from beancount_ui.sync import GitFailure, Sync
from beancount_ui.writer import Writer
from conftest import git
from fastapi.testclient import TestClient

REMOTE = "https://github.com/example/ledger"
SECRET = "test-only-private-token"


def test_auth_survives_restart_without_returning_token(ledger):
    settings = replace(ledger.settings, remote="https://github.com/example/ledger")
    client = TestClient(create_app(settings))
    response = client.post(
        "/api/sync/github-auth",
        json={
            "username": "example",
            "token": "test-only-private-token",
        },
    )
    assert response.status_code == 200
    assert "test-only-private-token" not in response.text
    restarted = TestClient(create_app(settings))
    status = restarted.get("/api/sync").json()
    assert status["github_auth"]["configured"]
    assert status["github_auth"]["username"] == "example"
    assert status["remote"] == settings.remote
    assert "test-only-private-token" not in str(status)


def test_real_git_helper_can_authenticate_after_recreation_and_removal(ledger, monkeypatch):
    auth = GithubAuth(ledger.settings.state_dir)
    auth.save(REMOTE, GithubAuthInput(username="example", token=SECRET))
    if os.name != "nt":
        assert auth.path.stat().st_mode & 0o777 == 0o600
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(ledger.settings.state_dir / "empty.gitconfig"))
    restarted = GithubAuth(ledger.settings.state_dir)
    options, env, _ = restarted.git_options(REMOTE)
    assert SECRET not in str(options) + str(env)

    def fill(host="github.com", path="example/ledger.git"):
        return subprocess.run(
            ["git", "-c", "credential.username=previous-account", *options, "credential", "fill"],
            input=f"protocol=https\nhost={host}\npath={path}\n\n",
            env=os.environ | env | {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"},
            capture_output=True,
            text=True,
            timeout=20,
        )

    result = fill()
    assert result.returncode == 0, result.stderr
    assert f"password={SECRET}" in result.stdout
    assert "username=example" in result.stdout
    for host, path in [("evil.invalid", "example/ledger"), ("github.com", "other/private")]:
        denied = fill(host, path)
        assert denied.returncode != 0
        assert SECRET not in denied.stdout + denied.stderr
    assert restarted.remove()["configured"] is False
    assert fill().returncode != 0


def test_auth_replace_remove_and_bad_requests_never_echo_secrets(ledger):
    settings = replace(ledger.settings, remote=REMOTE)
    client = TestClient(create_app(settings))
    for token in ["first_token", "replacement_token"]:
        response = client.post(
            "/api/sync/github-auth", json={"username": "example", "token": token}
        )
        assert response.status_code == 200 and token not in response.text
        saved = json.loads((settings.state_dir / "github-auth.json").read_text())
        assert saved["token"] == token
    for body in [
        {"username": "invalid\nuser", "token": SECRET},
        {"username": "example", "token": SECRET + "\nother"},
        {"username": "example", "token": {"secret": SECRET}},
        {"token": SECRET},
    ]:
        response = client.post("/api/sync/github-auth", json=body)
        assert response.status_code == 422 and SECRET not in response.text
    assert "replacement_token" not in client.get("/api/sync").text
    assert client.delete("/api/sync/github-auth").json()["configured"] is False
    assert client.delete("/api/sync/github-auth").status_code == 200


def test_auth_endpoints_require_application_login(ledger):
    client = TestClient(
        create_app(
            replace(ledger.settings, remote=REMOTE), Access("private", "access-secret-" * 4, ("*",))
        )
    )
    assert (
        client.post(
            "/api/sync/github-auth", json={"username": "example", "token": SECRET}
        ).status_code
        == 401
    )
    assert client.delete("/api/sync/github-auth").status_code == 401
    assert client.post("/api/sync/check-connection").status_code == 401
    assert not (ledger.settings.state_dir / "github-auth.json").exists()


@pytest.mark.parametrize(
    "remote",
    [
        "http://github.com/example/ledger",
        "https://github.com.evil.invalid/example/ledger",
        "https://github.com:444/example/ledger",
        "https://github.com/example/ledger?token=x",
        "git@github.com:example/ledger.git",
        "https://github.com/example/../ledger",
    ],
)
def test_saved_credentials_only_support_github_https_repositories(ledger, remote):
    auth = GithubAuth(ledger.settings.state_dir)
    with pytest.raises(ValueError, match="仅支持"):
        auth.save(remote, GithubAuthInput(username="example", token=SECRET))
    assert not auth.path.exists()


@pytest.mark.parametrize("operation", ["clone", "ls-remote", "fetch", "push"])
def test_sync_supplies_auth_without_token_in_argv_env_or_logs(
    ledger, monkeypatch, caplog, operation
):
    sync = Sync(Writer(Ledger(replace(ledger.settings, remote=REMOTE))))
    sync.configure_github_auth(GithubAuthInput(username="example", token=SECRET))
    captured = []

    def fail(command, **kwargs):
        captured.append((command, kwargs))
        assert SECRET not in str(command) + str(kwargs)
        assert "BEANCOUNT_GITHUB_CREDENTIAL_FILE" in kwargs["env"]
        assert any(item.startswith("credential.helper=!") for item in command)
        return subprocess.CompletedProcess(
            command, 128, b"", f"Authentication failed: {SECRET}".encode()
        )

    monkeypatch.setattr("beancount_ui.sync.subprocess.run", fail)
    with pytest.raises(GitFailure, match="备份中心"):
        sync.git(operation, REMOTE)
    assert SECRET not in caplog.text
    assert len(captured) == 1
    with pytest.raises(ValueError, match="仓库已改变"):
        sync.git(operation, "https://github.com/example/other")
    assert len(captured) == 1


def test_connection_check_uses_saved_auth_and_proxy_without_cloning(ledger, monkeypatch):
    sync = Sync(Writer(Ledger(replace(ledger.settings, remote=REMOTE))))
    sync.configure_github_auth(GithubAuthInput(username="example", token=SECRET))
    from beancount_ui.git_network import ProxyInput

    sync.configure_proxy(ProxyInput(mode="custom", url="http://127.0.0.1:7890"))

    def answer(command, **kwargs):
        assert "ls-remote" in command and "http.proxy=http://127.0.0.1:7890" in command
        assert "refs/heads/master-1" in command and REMOTE in command
        assert "BEANCOUNT_GITHUB_CREDENTIAL_FILE" in kwargs["env"]
        return subprocess.CompletedProcess(command, 0, b"abc123\trefs/heads/master-1\n", b"")

    monkeypatch.setattr("beancount_ui.sync.subprocess.run", answer)
    result = TestClient(create_app(sync.settings)).post("/api/sync/check-connection")
    assert result.status_code == 200
    assert result.json()["head"] == "abc123"
    assert not (sync.root / ".git").exists()
    assert "推送权限" in result.json()["message"]


def test_failed_credential_update_keeps_old_token(ledger, monkeypatch):
    auth = GithubAuth(ledger.settings.state_dir)
    auth.save(REMOTE, GithubAuthInput(username="example", token=SECRET))

    def fail(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr("beancount_ui.writer.os.replace", fail)
    with pytest.raises(OSError):
        auth.save(REMOTE, GithubAuthInput(username="example", token="new_token"))
    assert auth.read()["token"] == SECRET
    assert not list(ledger.settings.state_dir.glob(".bean-ui-*"))


def test_uncloned_status_is_actionable_and_quiet(ledger, caplog):
    client = TestClient(create_app(replace(ledger.settings, remote=REMOTE)))
    for _ in range(2):
        response = client.get("/api/sync")
        assert response.json()["remote"] == REMOTE
        assert "尚未接入" in response.json()["sync"]
    assert "Git failure" not in caplog.text


def test_fresh_deployment_can_commit_without_manual_git_identity(sync, monkeypatch):
    from beancount_ui.sync import BackupInput, ConnectInput

    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(sync.writer.state / "empty.gitconfig"))
    for key in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
        monkeypatch.delenv(key, raising=False)
    git(sync.root, "config", "--unset", "user.name")
    git(sync.root, "config", "--unset", "user.email")
    sync.connect(ConnectInput(revision=sync.preview()["revision"]))
    path = sync.root / "index.bean"
    path.write_bytes(path.read_bytes() + b"; first backup\n")
    preview = sync.backup_preview()
    result = sync.backup(BackupInput(revision=preview["revision"], head=preview["head"]))
    assert result["sync"] == "已同步"
    assert git(sync.root, "log", "-1", "--format=%ae") == "beancount-ui@localhost"
