"""Persistent GitHub credentials, kept separate from sync status and repository files."""

import json
import re
import shlex
import sys
from pathlib import Path

from pydantic import BaseModel, SecretStr

from .github_credential import repository_key
from .writer import atomic_write


class GithubAuthInput(BaseModel):
    username: str
    token: SecretStr


class GithubAuth:
    def __init__(self, state: Path):
        self.path = state / "github-auth.json"

    def read(self):
        if not self.path.exists():
            return None
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise ValueError("GitHub 认证配置损坏，请在备份中心重新保存") from exc

    def status(self):
        saved = self.read()
        return {
            "configured": bool(saved),
            "username": saved["username"] if saved else "",
            "repository": saved["repository"] if saved else "",
        }

    def save(self, remote: str, request: GithubAuthInput):
        repository = repository_key(remote)
        if not repository:
            raise ValueError("页面认证仅支持 https://github.com/所有者/仓库 地址")
        username = request.username.strip()
        token = request.token.get_secret_value().strip()
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", username):
            raise ValueError("请输入有效的 GitHub 用户名")
        if not token or len(token) > 1024 or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
            raise ValueError("请输入有效的 GitHub Token，不要填写账户密码")
        # atomic_write uses mkstemp (0600 on Linux), fsync and replace. Even intermediate
        # files are private, and interrupted replacement preserves the previous credential.
        atomic_write(
            self.path,
            json.dumps(
                {
                    "username": username,
                    "token": token,
                    "repository": repository,
                }
            ).encode(),
        )
        return self.status()

    def remove(self):
        self.path.unlink(missing_ok=True)
        return self.status()

    def git_options(self, remote: str):
        saved = self.read()
        if not saved or not repository_key(remote):
            return [], {}, ""
        if repository_key(remote) != saved["repository"]:
            raise ValueError("GitHub 仓库已改变，请为当前仓库重新保存认证信息")
        # Only file paths reach argv/env. Git asks the helper for secrets on stdin/stdout.
        helper = "!" + " ".join(
            shlex.quote(part)
            for part in [
                "uv",
                "run",
                "--no-project",
                "--no-config",
                "--python",
                Path(sys.executable).as_posix(),
                "python",
                Path(__file__).with_name("github_credential.py").as_posix(),
            ]
        )
        return (
            [
                "-c",
                "credential.helper=",
                "-c",
                f"credential.helper={helper}",
                "-c",
                "credential.useHttpPath=true",
            ],
            {"BEANCOUNT_GITHUB_CREDENTIAL_FILE": str(self.path)},
            saved["token"],
        )
