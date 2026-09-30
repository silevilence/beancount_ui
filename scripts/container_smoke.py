"""Linux Actions release gate: only synthetic data and an isolated local Git remote."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import httpx
from playwright.sync_api import sync_playwright

IMAGE = sys.argv[1]
NAME = "beancount-release-smoke"
TOKEN = "isolated-container-smoke-token-32-characters"
EVIDENCE = Path("container-evidence")
EVIDENCE.mkdir(exist_ok=True)


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def docker(*args):
    return command("docker", *args)


def git(path, *args):
    return command("git", "-c", f"safe.directory={path}", "-C", str(path), *args)


def api(client, path, payload=None):
    response = client.get(path) if payload is None else client.post(path, json=payload)
    response.raise_for_status()
    return response.json()


def start(data):
    docker(
        "run",
        "-d",
        "--name",
        NAME,
        "-p",
        "127.0.0.1:8000:8000",
        "-v",
        f"{data}:/data",
        "-e",
        f"BEANCOUNT_ACCESS_TOKEN={TOKEN}",
        "-e",
        "BEANCOUNT_ALLOWED_ORIGINS=http://127.0.0.1:8000",
        IMAGE,
    )
    for _ in range(60):
        health = docker("inspect", "--format", "{{.State.Health.Status}}", NAME)
        if health == "healthy":
            return
        time.sleep(1)
    raise RuntimeError("Container did not become healthy")


def main():
    # No mounted ledger is present in the image itself, and it runs without root.
    assert docker("image", "inspect", "--format", "{{.Config.User}}", IMAGE) == "10001:10001"
    assert docker("run", "--rm", "--entrypoint", "find", IMAGE, "/data", "-type", "f") == ""
    with tempfile.TemporaryDirectory(prefix="bean-container-") as temporary:
        data = Path(temporary)
        root = data / "ledger"
        shutil.copytree("examples/ledger", root)
        (data / "state").mkdir()
        git(root, "init", "-b", "master-1")
        git(root, "config", "user.name", "Container Test")
        git(root, "config", "user.email", "container@example.invalid")
        git(root, "add", ".")
        git(root, "commit", "-m", "synthetic baseline")
        command("git", "init", "--bare", str(data / "remote.git"))
        git(root, "remote", "add", "origin", str(data / "remote.git"))
        git(root, "push", "-u", "origin", "master-1")
        git(root, "remote", "set-url", "origin", "/data/remote.git")
        original = {p.relative_to(root): p.read_bytes() for p in root.rglob("*.bean")}
        # Match the documented bind-mount ownership, and exercise the image's default UID.
        docker(
            "run",
            "--rm",
            "--user",
            "0",
            "-v",
            f"{data}:/data",
            "--entrypoint",
            "chown",
            IMAGE,
            "-R",
            "10001:10001",
            "/data",
        )
        try:
            start(data)
            with httpx.Client(
                base_url="http://127.0.0.1:8000",
                timeout=30,
                headers={"Authorization": f"Bearer {TOKEN}"},
            ) as client:
                assert httpx.get(str(client.base_url) + "api/ledger").status_code == 401
                assert httpx.post(str(client.base_url) + "api/commit", json={}).status_code == 401
                assert client.get("/").status_code == 200
                status = api(client, "/api/ledger")
                assert not status["errors"]
                preview = api(client, "/api/sync/preview", {})
                assert api(
                    client,
                    "/api/sync/connect",
                    {
                        "revision": preview["revision"],
                    },
                )["connected"]
                request = {
                    "request_id": str(uuid4()),
                    "revision": status["revision"],
                    "raw": '2026-09-30 * "container saved"\n'
                    "  Expenses:Food 18.60 CNY\n  Assets:Cash -18.60 CNY\n",
                }
                api(client, "/api/preview", request)
                api(client, "/api/commit", {"request_id": request["request_id"]})
                p = api(client, "/api/sync/backup-preview", {})
                assert (
                    api(
                        client,
                        "/api/sync/backup",
                        {
                            "revision": p["revision"],
                            "head": p["head"],
                        },
                    )["sync"]
                    == "已同步"
                )
                assert git(root, "rev-parse", "HEAD") == git(
                    data / "remote.git", "rev-parse", "master-1"
                )
                # Preserve a pending server request as well as a browser draft across recreation.
                request["request_id"] = str(uuid4())
                request["revision"] = api(client, "/api/ledger")["revision"]
                request["raw"] = request["raw"].replace("container saved", "after recreation")
                api(client, "/api/preview", request)
                journal = api(client, "/api/journal?day=2026-09-30")
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch()
                    page = browser.new_page(viewport={"width": 1280, "height": 900})
                    page.goto(str(client.base_url))
                    page.locator('input[type="password"]').fill(TOKEN)
                    page.get_by_role("button", name="登录", exact=True).click()
                    page.get_by_text("当日消费", exact=True).wait_for()
                    key = f"beancount-ui.batch.v1.{journal['identity']}"
                    form = {
                        "date": "2026-09-30",
                        "payee": "draft retained",
                        "narration": "draft retained",
                        "amount": "2.00",
                        "currency": "CNY",
                        "category": "Expenses:Food",
                        "payment": "Assets:Cash",
                        "note": "",
                    }
                    draft = {"form": form, "items": [{"business": "ordinary", "entry": form}]}
                    page.evaluate(
                        "([key, value]) => localStorage.setItem(key, value)",
                        [key, json.dumps(draft)],
                    )
                    docker("rm", "-f", NAME)
                    start(data)
                    assert api(client, "/api/ledger")["revision"] == request["revision"]
                    assert (
                        api(
                            client,
                            "/api/commit",
                            {
                                "request_id": request["request_id"],
                            },
                        )["status"]
                        == "done"
                    )
                    assert (
                        api(
                            client,
                            "/api/commit",
                            {
                                "request_id": request["request_id"],
                            },
                        )["status"]
                        == "done"
                    )
                    page.reload()
                    page.locator('input[type="password"]').fill(TOKEN)
                    page.get_by_role("button", name="登录", exact=True).click()
                    page.get_by_role("button", name="补记工作台", exact=False).first.click()
                    page.get_by_text("draft retained", exact=False).first.wait_for()
                    assert json.loads(page.evaluate("key => localStorage.getItem(key)", key))
                    page.screenshot(path=str(EVIDENCE / "draft-after-recreation.png"))
                    browser.close()
                view = api(client, "/api/journal?day=2026-09-30")
                assert view["expenses"] == {"CNY": "62.70"}
                assert not api(client, "/api/ledger")["errors"]
                for path, content in original.items():
                    if path.as_posix() != "txs/2026/index.bean":
                        assert (root / path).read_bytes() == content
                (EVIDENCE / "result.json").write_text(
                    json.dumps(
                        {
                            "health": "healthy",
                            "auth": "passed",
                            "frontend": "passed",
                            "sync": "passed",
                            "recreation": "passed",
                            "draft": "passed",
                            "idempotency": "passed",
                            "unrelated_files": "unchanged",
                        },
                        indent=2,
                    )
                    + "\n"
                )
        finally:
            try:
                (EVIDENCE / "container.log").write_text(docker("logs", NAME))
                docker("rm", "-f", NAME)
            finally:
                docker(
                    "run",
                    "--rm",
                    "--user",
                    "0",
                    "-v",
                    f"{data}:/data",
                    "--entrypoint",
                    "chown",
                    IMAGE,
                    "-R",
                    f"{os.getuid()}:{os.getgid()}",
                    "/data",
                )


if __name__ == "__main__":
    main()
