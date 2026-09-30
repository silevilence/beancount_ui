import pytest
from beancount_ui.access import Access
from beancount_ui.app import create_app
from fastapi.testclient import TestClient

TOKEN = "test-only-secret-" * 3


def test_private_requires_token_and_known_origin(ledger):
    access = Access("private", TOKEN, ("http://ledger.test:8000",))
    client = TestClient(create_app(ledger.settings, access), base_url="http://ledger.test:8000")
    assert client.get("/api/access").json() == {"required": True, "authenticated": False}
    for path in (
        "/api/ledger",
        "/api/journal",
        "/api/sync",
        "/api/templates?day=2026-09-30",
        "/docs",
    ):
        assert client.get(path).status_code == 401
    for path in ("/api/preview", "/api/commit", "/api/sync/connect", "/api/sync/schedule"):
        assert client.post(path, json={}).status_code == 401
    assert client.get("/api/access", headers={"Authorization": "Bearer wrong"}).status_code == 401
    headers = {"Authorization": f"Bearer {TOKEN}", "Origin": "http://ledger.test:8000"}
    assert client.get("/api/access", headers=headers).json()["authenticated"]
    response = client.get("/api/ledger", headers=headers)
    assert response.status_code == 200
    assert TOKEN not in response.text
    assert response.headers["Cache-Control"] == "no-store"
    headers["Origin"] = "http://evil.test"
    assert client.post("/api/commit", headers=headers, json={}).status_code == 403
    assert (
        client.get(
            "/api/ledger", headers={"Host": "evil.test", "Authorization": f"Bearer {TOKEN}"}
        ).status_code
        == 400
    )


def test_local_rejects_remote_peer_even_with_spoofed_host(ledger):
    app = create_app(ledger.settings)
    client = TestClient(app, client=("192.168.1.30", 10000))
    assert client.get("/api/ledger", headers={"Host": "localhost"}).status_code == 403
    assert TestClient(app, client=("127.0.0.1", 10000)).get("/api/ledger").status_code == 200


def test_access_configuration_from_mount_and_invalid_settings(monkeypatch, tmp_path):
    with pytest.raises(ValueError, match="口令"):
        Access("private")
    with pytest.raises(ValueError, match="仅支持"):
        Access("public")
    for origin in ("http://x/path", "https://u:p@host", "*", "ftp://host", "http://*.test"):
        with pytest.raises(ValueError, match="Origin"):
            Access("private", TOKEN, (origin,))
    path = tmp_path / "token"
    path.write_text(TOKEN, encoding="utf-8")
    monkeypatch.setenv("BEANCOUNT_ACCESS_MODE", "private")
    monkeypatch.setenv("BEANCOUNT_ACCESS_TOKEN_FILE", str(path))
    monkeypatch.setenv("BEANCOUNT_ALLOWED_ORIGINS", "http://ledger.test:8000")
    assert Access.from_env().token == TOKEN
    assert TOKEN not in repr(Access.from_env())


def test_static_entry_available_before_login_but_ledger_protected(ledger, tmp_path, monkeypatch):
    public = tmp_path / "web"
    public.mkdir()
    (public / "index.html").write_text("<h1>Login</h1>", encoding="utf-8")
    monkeypatch.setenv("BEANCOUNT_FRONTEND_DIR", str(public))
    app = create_app(ledger.settings, Access("private", TOKEN, ("http://ledger.test:8000",)))
    client = TestClient(app)
    assert client.get("/").text == "<h1>Login</h1>"
    assert client.get("/api/ledger").status_code == 401


@pytest.mark.parametrize("which", ["ledger", "state", "parent", "child"])
def test_reject_static_private_overlap(ledger, monkeypatch, which):
    paths = {
        "ledger": ledger.settings.ledger_dir,
        "state": ledger.settings.state_dir,
        "parent": ledger.settings.ledger_dir.parent,
        "child": ledger.settings.ledger_dir / "web",
    }
    paths[which].mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("BEANCOUNT_FRONTEND_DIR", str(paths[which]))
    with pytest.raises(ValueError, match="重叠"):
        create_app(ledger.settings, Access("private", TOKEN, ("http://ledger.test:8000",)))


def test_busy_read_and_backup_do_not_claim_save_failed(ledger, monkeypatch):
    from contextlib import contextmanager

    from beancount_ui.writer import Writer
    from filelock import Timeout

    writer = Writer(ledger)

    @contextmanager
    def busy():
        raise Timeout("test lock")
        yield

    monkeypatch.setattr(writer, "guard", busy)
    app = create_app(ledger.settings)
    app.state.writer = writer
    client = TestClient(app)
    for path in ("/api/ledger", "/api/journal", "/api/sync"):
        response = client.get(path)
        assert response.status_code == 503
        assert "已保存" in response.json()["detail"]
        assert "保存结果未确认" not in response.json()["detail"]
