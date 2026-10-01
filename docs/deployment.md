# 容器部署与发布

默认镜像：`ghcr.io/silevilence/beancount_ui:latest`，平台 `linux/amd64`。
通用与 NAS Compose 均默认使用 `latest`，指向最近一次通过发布验收并成功推送的镜像。
该标签会在包含本次配置改动的版本 Tag 成功发布后提供；仅修改本地配置不会在 GHCR 创建它。
需要固定版本时，在环境变量或 Compose 同目录的 `.env` 中设置
`BEANCOUNT_IMAGE=ghcr.io/silevilence/beancount_ui:V0.1.1`（版本号按需替换）。
V0.1.1 修复局域网 HTTP 页面的保存失败并支持全开放来源配置，其验收记录与镜像摘要见该版本 Release 附件。
V0.1.0 首版已通过 [发布验收](https://github.com/silevilence/beancount_ui/actions/runs/36725085567)，
摘要为 `sha256:4df3df7a8a4a574f6dd53652e5c336914bfc3b203686d7df46f71d6386fe7351`。
每次 Release 的 `image.txt` 附件记录完整拉取地址、不可变摘要和源码提交；生产可将
`BEANCOUNT_IMAGE` 设置为该文件中的 `ghcr.io/...@sha256:...` 固定产物。
GHCR 版本标签由流水线拒绝覆盖；摘要是仓库端的内容寻址保证。V0.1.1 未改变账本与状态格式，
可按摘要回退到 V0.1.0；回退后局域网 HTTP 页面仍会重现保存失败，且需把全开放来源改回明确地址列表。

## 启动

Docker 仅用于部署和发布。开发、测试继续按 [README](../README.md) 直接运行。
容器内 Python 3.12、uv、Git、SSH 客户端与前端生产文件齐备；无个人账本或凭据。
容器默认非 root（UID/GID `10001:10001`），单 worker，时区 `Asia/Shanghai`。

在 Linux Docker 主机上准备源码目录以外的目录；下列目录必须是新目录，已有账本不要覆盖：

```bash
export BEANCOUNT_DATA_DIR=/srv/beancount
sudo install -d -o 10001 -g 10001 "$BEANCOUNT_DATA_DIR/ledger" "$BEANCOUNT_DATA_DIR/state"
# 将已有账本工作副本（含 .git）复制到 ledger，或保持为空并在页面点击克隆。
# 新的演示环境也可复制 examples/ledger，然后初始化 Git 仓库和远端。
openssl rand -hex 32 | sudo tee "$BEANCOUNT_DATA_DIR/access-token" >/dev/null
sudo chown -R 10001:10001 "$BEANCOUNT_DATA_DIR"
sudo chmod 750 "$BEANCOUNT_DATA_DIR" "$BEANCOUNT_DATA_DIR/ledger" "$BEANCOUNT_DATA_DIR/state"
sudo chmod 440 "$BEANCOUNT_DATA_DIR/access-token"
docker compose pull
docker compose up -d
docker compose ps
```

访问 `http://127.0.0.1:8000`，使用 access-token 的内容登录。默认只向主机回环地址映射端口；
容器网络会把客户端显示为网桥地址，所以容器使用 `private` 认证模式。不要改成 `local`。
健康端点 `/api/health` 仅报告进程就绪；完整账本有效性由认证后的 `/api/ledger` 和页面诊断确认。
私网访问需同时设置 `BEANCOUNT_BIND_IP=0.0.0.0`（或 NAS 的局域网 IP）和
`BEANCOUNT_ALLOWED_ORIGINS` 为浏览器实际 Origin，或显式设为 `"*"` 取消 Host/Origin 限制。
外网使用下面的 HTTPS 转发配置。

Windows Docker Desktop 可将 `BEANCOUNT_DATA_DIR` 设置为如 `E:/beancount-data`，目录在项目外。
Windows 挂载权限由 Docker Desktop 共享配置控制；确认容器 UID 10001 能读写两个目录、读取口令。

## 绿联 NAS：项目部署

**原来的示例不能原样用于局域网。** 它只发布主机回环端口，而且镜像用户 `10001:10001`
未必能写入 NAS 用户创建的目录。截图中的 `PUID=1000 PGID=10` 只是 NAS 的用户信息：
此镜像没有自动处理同名环境变量的入口脚本，需要 Compose 的 `user: "1000:10"` 才会切换身份。
根目录通用 Compose 现在也支持通过 `PUID` / `PGID` 配置 `user`。

在绿联 Docker「创建项目」中选择 `共享文件夹/docker/beancount-ui` 作为存放路径，
粘贴根目录 [compose.nas.yaml](../compose.nas.yaml) 的全部内容，**独立使用，不与通用示例合并**。
该文件使用相对挂载，数据就落在这个项目目录下：

```text
beancount-ui/
├── compose.yaml       # NAS 保存的项目配置
├── ledger/            # 正式账本，包含 main.beancount、include 文件及 .git
├── state/             # SQLite、事务恢复日志、同步配置，以及用户 HOME
└── access-token       # 只含一行至少 32 字符的随机应用口令
```

准备后再点「立即部署」：

1. NAS 示例默认拉取 `ghcr.io/silevilence/beancount_ui:latest`。
   如需固定版本或使用已导入的本地镜像，通过项目环境变量或 `.env` 设置 `BEANCOUNT_IMAGE`，
   也可直接修改 `image`；本地构建/导入方法见本节末尾。
2. 将示例的 `user` 改为实际 NAS 账户的 UID/GID（按 NAS 界面显示的账户填写，截图中为 `1000:10`）。
   在 NAS 共享文件夹权限中给该账户项目目录的读写权限，并确保 `ledger`、`state` 及现有文件继承正确权限。
   仅有 Unix chmod 并不能证明 NAS ACL 已允许访问；不需要让容器使用 root 或对共享目录执行 `chmod 777`。
3. 先创建 `ledger`、`state` 目录，再复制已有账本（含隐藏的 `.git`），或保留空 `ledger` 待克隆。
   Compose 禁止自动创建缺失的挂载目录，以免路径拼错后由 Docker 建出 root 所有的目录。
4. 创建 `access-token` 普通文本文件（UTF-8、无 BOM），保存随机口令；权限应允许所选 UID 读取，
   不允许无关 NAS 用户读取。不要把这个文件放入账本目录，不要把 GitHub Token 当应用口令。
5. NAS 示例将 `BEANCOUNT_ALLOWED_ORIGINS` 设为 `"*"`，不必填写 IP 或域名；仍然需要应用口令。
   如需限制入口，可改成明确的地址列表，见下一节。`8000:8000` 的左边是 NAS 端口，
   冲突时可改为如 `18000:8000`；使用地址列表时需同时修改对应 Origin。

若使用 SSH 准备**新建的专用项目目录**，以下是 Linux 示例。必须先将第一行改为 NAS 文件管理器显示的真实绝对路径；
`共享文件夹/...` 是界面名称，不能据此猜测 `/volume1` 或其他存储卷路径：

```bash
DATA_DIR='/实际存储卷/docker/beancount-ui'
NAS_UID=1000
NAS_GID=10
sudo install -d -m 750 -o "$NAS_UID" -g "$NAS_GID" "$DATA_DIR" "$DATA_DIR/ledger" "$DATA_DIR/state"
# 仅首次生成；已有口令时不覆盖。
if ! sudo test -e "$DATA_DIR/access-token"; then
  sudo sh -c 'umask 077; openssl rand -hex 32 > "$1"' sh "$DATA_DIR/access-token"
fi
sudo chown "$NAS_UID:$NAS_GID" "$DATA_DIR/access-token"
sudo chmod 400 "$DATA_DIR/access-token"
```

应用本身不会自动创建口令；上述初始化命令只在文件不存在时生成。登录时打开项目目录的
`access-token`，复制完整的一行随机字符串，粘贴到网页的口令框即可。容器重启不会更换它；
页面刷新后需重新登录。修改文件中的口令后重启容器使新口令生效。

上述命令不修改已有账本文件的属主。复制来的文件（包括 `.git`）也必须允许所选 UID 读写；
若 Git 提示 dubious ownership，修正该专用账本副本的属主，不要全局设置 `safe.directory=*`。
容器内对 `/data` 的镜像构建阶段 chown 无法改变宿主机挂载目录的权限。

部署后可在 NAS 的容器终端执行 `id`，确认是选定 UID/GID，再执行下面的非破坏性检查。
它会在两个目录创建并删除临时文件，读取口令但不打印内容：

```bash
uv run --no-sync python - <<'PY'
from pathlib import Path
from tempfile import TemporaryDirectory
from beancount_ui.access import Access

assert len(Access.from_env().token) >= 32
print("access-token: readable")
for root in ("/data/ledger", "/data/state"):
    with TemporaryDirectory(dir=root) as temporary:
        probe = Path(temporary) / "probe"
        probe.write_text("write check", encoding="utf-8")
        assert probe.read_text(encoding="utf-8") == "write check"
    print(root + ": writable")
PY
```

已有账本仍需在页面完成一次预览、保存和同步，验证深层文件及 `.git` 的权限。仅看到容器 healthy
并不能证明这些权限全部正确。口令读失败看容器日志；目录读写失败检查 NAS 账户、ACL 和文件属主。

**镜像版本注意：** `V0.1.0` 在非 localhost 的 HTTP 页面中调用 `crypto.randomUUID()`，
会导致单笔和整批预览失败；它也不接受 `BEANCOUNT_ALLOWED_ORIGINS: "*"`。
本次发布的 `V0.1.1` 已包含 `getRandomValues()` UUID v4 兼容实现与全开放来源配置，
通用与 NAS 示例均默认使用 `latest`，需要固定该版本时设置 `BEANCOUNT_IMAGE`。
升级到 V0.1.1 需要重新创建容器：修改 Compose 不会更新已有镜像里的前端代码。
若暂时无法使用 V0.1.1，可在 Docker 构建主机用同一份源码执行
`docker build -t beancount-ui:nas-fixed .`，再用 `docker save -o beancount-ui-nas-fixed.tar beancount-ui:nas-fixed`
导出并通过 NAS 镜像管理导入（构建主机与 NAS 架构需匹配；首版为 linux/amd64），
再设置 `BEANCOUNT_IMAGE=beancount-ui:nas-fixed` 使用该本地镜像，无需从 GHCR 拉取。
V0.1.0 也可通过有效 HTTPS 地址避开此浏览器限制。

## 局域网与 NAS 外网转发

页面与 `/api` 共用容器的 8000 端口，前端使用同源相对 URL，不需要配置单独的后端公网地址。
如果不想维护访问地址，使用 NAS 示例的配置：

```yaml
BEANCOUNT_ALLOWED_ORIGINS: "*"
```

这会取消服务端 Host 与 Origin 白名单，允许任意域名、IP 和来源，但不会取消 `private` 模式的
口令认证，也不会改变 `local` 模式仅允许本机连接的限制。星号必须加引号；留空或删除配置
仍会使 `private` 模式启动失败。它不添加跨域 CORS 响应头，浏览器仍按同源方式访问页面和 API。

需要限制入口时，多个访问地址可以同时列出，例如：

```yaml
BEANCOUNT_ALLOWED_ORIGINS: "http://192.168.1.100:8000,https://ledger.example.com"
```

地址列表中的 Origin 必须与浏览器地址栏的**协议 + 主机 + 非默认端口**一致，不带路径、末尾 `/` 或域名通配符。
HTTPS 默认 443 不写端口；外网使用 8443 则填 `https://ledger.example.com:8443`。
局域网 IP、内网域名和外网域名是不同入口，用到哪个就显式列出哪个。
模式保持 `private`；该名称表示强制应用口令认证，不会排斥通过代理转入的请求。

| 访问方式 | 配置与条件 |
| --- | --- |
| 受控局域网 `http://NAS-IP:8000` | NAS 示例已发布 LAN 端口；Origin 使用 `"*"` 或准确地址，并使用包含 HTTP 修复的镜像 |
| NAS HTTPS 反向代理 / 加密隧道 | 外网独立域名根路径 `/` 转发到 `http://NAS-IP:8000`；证书有效，入口启用访问控制和限流 |
| 同一 NAS 主机进程的代理 | 可转发到 `http://127.0.0.1:8000`；如果不需要 LAN 直连，可仅绑定回环端口 |
| 另一个 Docker 容器内的代理 | 同一 Docker 网络可用 `http://ledger:8000`，或访问 NAS 的 LAN 端口；代理容器的 `127.0.0.1` 指向它自己 |
| 路由器直接把公网 HTTP 端口映射到 8000 | 不能保护应用口令与账本传输；应加 HTTPS 代理，或通过受控 VPN 访问 |
| NAS 远程门户里的子路径/嵌入页 | 当前不支持 `/beancount/` 这样的子路径；若服务不能提供独立 Origin 根路径，不能保证兼容 |

代理必须保留浏览器的 `Host`、`Origin` 和 `Authorization`（应用使用 Bearer 口令）。
不要在入口用另一组 Basic Authorization 覆盖应用口令；入口认证可用独立的 Cookie/SSO。
Uvicorn 仍然忽略代理头，认证不依赖代理声明的客户端 IP；无需启用不受限的 forwarded headers。
Nginx HTTPS server 内的核心转发片段如下（证书、入口认证及限流由 NAS 入口配置）：

```nginx
location / {
    proxy_pass http://192.168.1.100:8000;
    proxy_set_header Host $http_host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization $http_authorization;
    proxy_cache off;
}
```

使用地址列表时，如果看到 `Invalid host header`，检查浏览器域名是否在 Origins 中以及代理是否保留 Host；
`访问来源未获允许` 表示 Origin（包括端口）不匹配；401 则检查口令及 Authorization 转发。
登录页打开后须验证单笔预览保存、整批预览保存、刷新重登以及备份状态。
切换内外网地址会切换浏览器 localStorage，草稿不会自动跨地址同步；正式账本仍是同一个。
HTTP 下浏览器可能禁用剪贴板按钮，可展开原文手工复制；HTTPS 不受此限制。

本地已验证双 Origin 的认证、代理后端 HTTP 下的读写与重复请求，以及缺失 randomUUID 的单笔/整批流程。
当前开发机无 Docker、未连接真实 NAS；NAS ACL、证书和厂商外网转发须按以上步骤现场验收。
发布流水线已增加 `1000:10` 用户的容器读写、口令文件和重建验证，须等待实际流水线运行结果。

参考：[Docker Compose user / ports / volumes](https://docs.docker.com/reference/compose-file/services/)、
[绿联 UID/GID 获取说明](https://support.ugnas.com/detail/article/en-US/369)、
[浏览器 randomUUID 的安全上下文要求](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)。

## Git 凭据与首次接入

设置 `BEANCOUNT_GIT_REMOTE` 为无嵌入凭据的 HTTPS/SSH 地址，默认分支 `master-1`。
首次接入预览会展示本地改动和未 include 的文件，确认后才允许备份，定时备份默认关闭。
使用镜像默认 UID `10001` 时，可挂载专用于此账本的 SSH 配置目录到 `/home/bean/.ssh:ro`（私钥 600、目录 700、属主 10001），
提前验证服务器指纹并提供 `known_hosts`；不要关闭主机密钥检查。HTTPS 可挂载 Git credential
helper 的运行时配置，参见 [同步说明](github-sync.md)。凭据不要写入镜像、仓库或远端 URL。
NAS 示例覆盖为数字 UID `1000` 后，镜像 `/etc/passwd` 没有该用户，OpenSSH 可能报
`No user exists for uid`，不能直接沿用上述 SSH 方案。此配置可用 HTTPS + 服务端 Git credential helper；
Git 的全局配置读取 `HOME=/data/state` 下的 `.gitconfig`，按该用户配置 `user.name` / `user.email`。
必须使用 SSH 时，保留默认 `10001:10001` 并授予其挂载权限，或自行构建具有对应 UID 用户条目的镜像。
GHCR 私有包需要在部署主机登录具有 `read:packages` 权限的账号；GitHub Release 本身不改变包可见性。

## 数据、升级、回滚与恢复

| 数据 | 保存位置 | 恢复要求 |
| --- | --- | --- |
| 正式账本、Git 历史 | `/data/ledger` 挂载目录 | 原样保留，不能替换为镜像内容 |
| 待确认请求、事务恢复日志、同步配置 | `/data/state` 挂载目录 | 与账本成对备份和恢复 |
| 补记草稿、便笺、模板设置 | 浏览器 localStorage | 保持浏览器配置、Origin 和容器账本路径相同；不属于服务器卷 |
| 访问口令、SSH/Git 凭据 | 运行时只读挂载 | 独立妥善保存，不提交到 Git |

升级前停止容器，备份 ledger 与 state 的完整目录（包括 `.git` 和 SQLite 相关文件），记录旧镜像摘要。
浏览器草稿不会因容器重建丢失，但更换浏览器、清除站点数据或改变地址会失去原存储访问；先完成补记，
或备份浏览器配置。首版草稿没有服务器端跨设备同步。

```bash
docker compose stop
# 此时用主机备份工具完整备份 BEANCOUNT_DATA_DIR，另保存浏览器配置。
# 跟随最新发布；若需固定版本，将 latest 替换为对应版本 Tag 或使用镜像摘要。
export BEANCOUNT_IMAGE=ghcr.io/silevilence/beancount_ui:latest
docker compose pull
docker compose up -d --force-recreate
docker compose ps
```

`latest` 不会自动替换正在运行的容器；每次升级仍需拉取镜像并重建容器，
参见 [Docker Compose 拉取说明](https://docs.docker.com/reference/cli/docker/compose/pull/)。
NAS 使用 `docker compose -f compose.nas.yaml` 执行同样步骤（若项目保存为 `compose.yaml` 则使用实际文件名），
或在 NAS 项目管理界面重新拉取镜像并重建。

检查健康、账本诊断、当日流水、草稿与同步状态。回滚时将 `BEANCOUNT_IMAGE` 改回此前记录的摘要，
重建容器并复验；不要重建或清空数据目录。后续版本如有不兼容状态迁移须按该版说明恢复停机备份。
出现断电或响应丢失时，用原请求重试，事务会恢复且不重复入账；不要重复新增。
有外部修改或 Git 分叉时先保留现场，按 [恢复流程](github-sync.md) 人工解决，再预览同步。

## 发布门槛

普通分支推送和 PR 仅运行 Windows/Linux 检查。`Release` 的手动运行需填写待校验版本，
只验证镜像，不推送或创建 Release；工作流不预填固定版本，后续发版无需修改工作流或 Compose。
只有 `V<主>.<次>.<修订>` 或小写 `v` Tag 推送能发布，Tag 对应提交必须包含唯一且正文非空的版本章节。

流水线先校验 changelog，运行双平台全部检查，再构建候选镜像；在临时脱敏账本与本地裸远端上验证
认证拒绝、生产页面、写入、同步、健康、无关文件不变、容器删除重建、原请求恢复与浏览器草稿恢复。
所有门槛通过后才将同一候选镜像以 Git Tag 对应的版本标签和 `latest` 推送 GHCR，
版本标签拒绝覆盖，`latest` 随每次成功推送更新；最后创建同 Tag Release。正文仅为精确匹配的 changelog
章节，镜像地址和摘要放在附件及 Actions 摘要中。`container-evidence` 提供截图与验证结果。

若 GHCR 已推送但 Release 创建失败，不重建覆盖版本镜像。核对镜像 revision 标签、摘要与成功验证的
提交后，从同 Tag 提取正文，用 `gh release create <Tag> --verify-tag --title <Tag> --notes-file <文件>
image.txt` 恢复元数据。若代码需修复，发布新的版本号。
