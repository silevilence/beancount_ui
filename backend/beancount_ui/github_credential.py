"""Git credential helper: release a saved token only for its exact GitHub repository.

This file is also invoked as a standalone script by Git; keep it stdlib-only.
"""

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit


def repository_key(remote: str) -> str:
    try:
        url = urlsplit(remote)
        if (
            url.scheme != "https"
            or url.hostname != "github.com"
            or url.port not in (None, 443)
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
        ):
            return ""
        path = url.path.strip("/").removesuffix(".git")
        if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", path):
            return ""
        if path.split("/")[1] in {".", ".."}:
            return ""
        return path.casefold()
    except ValueError:
        return ""


def main():
    if sys.argv[-1] != "get":
        return  # Git's erase/store notifications must not remove or replace the saved token.
    fields = {}
    for line in sys.stdin:
        line = line.rstrip("\r\n")
        if not line:
            break
        key, _, value = line.partition("=")
        fields[key] = value
    try:
        credentials = json.loads(
            Path(os.environ["BEANCOUNT_GITHUB_CREDENTIAL_FILE"]).read_text(encoding="utf-8")
        )
        requested = repository_key(
            f"{fields.get('protocol', '')}://{fields.get('host', '')}/{fields.get('path', '')}"
        )
        if not requested or requested != credentials["repository"]:
            return
        username, token = credentials["username"], credentials["token"]
        if any(c in username + token for c in "\r\n\0"):
            return
        sys.stdout.write(f"username={username}\npassword={token}\n\n")
    except (OSError, ValueError, KeyError, TypeError):
        return  # Never expose a credential file or exception contents to Git's stderr.


if __name__ == "__main__":
    main()
