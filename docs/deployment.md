# V0.1.0 容器部署与发布

镜像：`ghcr.io/silevilence/beancount_ui:V0.1.0`，平台 `linux/amd64`。
首版已通过 [发布验收](https://github.com/silevilence/beancount_ui/actions/runs/36725085567)，
摘要为 `sha256:4df3df7a8a4a574f6dd53652e5c336914bfc3b203686d7df46f71d6386fe7351`。
每次 Release 的 `image.txt` 附件记录完整拉取地址、不可变摘要和源码提交；生产可将
`BEANCOUNT_IMAGE` 设置为该文件中的 `ghcr.io/...@sha256:...` 固定产物。
GHCR 版本标签由流水线拒绝覆盖；摘要是仓库端的内容寻址保证。首版没有旧版本可供实际降级。

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
私网访问需同时修改端口绑定、`BEANCOUNT_ALLOWED_ORIGINS` 为浏览器实际 Origin，配合受控 VPN。
公网 HTTPS、入口防护与单独验收不在首版部署范围内。

Windows Docker Desktop 可将 `BEANCOUNT_DATA_DIR` 设置为如 `E:/beancount-data`，目录在项目外。
Windows 挂载权限由 Docker Desktop 共享配置控制；确认容器 UID 10001 能读写两个目录、读取口令。

## Git 凭据与首次接入

设置 `BEANCOUNT_GIT_REMOTE` 为无嵌入凭据的 HTTPS/SSH 地址，默认分支 `master-1`。
首次接入预览会展示本地改动和未 include 的文件，确认后才允许备份，定时备份默认关闭。
可挂载专用于此账本的 SSH 配置目录到 `/home/bean/.ssh:ro`（私钥 600、目录 700、属主 10001），
提前验证服务器指纹并提供 `known_hosts`；不要关闭主机密钥检查。HTTPS 可挂载 Git credential
helper 的运行时配置，参见 [同步说明](github-sync.md)。凭据不要写入镜像、仓库或远端 URL。
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
export BEANCOUNT_IMAGE=ghcr.io/silevilence/beancount_ui:V0.1.0
docker compose pull
docker compose up -d --force-recreate
docker compose ps
```

检查健康、账本诊断、当日流水、草稿与同步状态。回滚时将 `BEANCOUNT_IMAGE` 改回此前记录的摘要，
重建容器并复验；不要重建或清空数据目录。后续版本如有不兼容状态迁移须按该版说明恢复停机备份。
出现断电或响应丢失时，用原请求重试，事务会恢复且不重复入账；不要重复新增。
有外部修改或 Git 分叉时先保留现场，按 [恢复流程](github-sync.md) 人工解决，再预览同步。

## 发布门槛

普通分支推送和 PR 仅运行 Windows/Linux 检查。`Release` 的手动运行只验证镜像，不推送或创建 Release。
只有 `V<主>.<次>.<修订>` 或小写 `v` Tag 推送能发布，Tag 对应提交必须包含唯一且正文非空的版本章节。

流水线先校验 changelog，运行双平台全部检查，再构建候选镜像；在临时脱敏账本与本地裸远端上验证
认证拒绝、生产页面、写入、同步、健康、无关文件不变、容器删除重建、原请求恢复与浏览器草稿恢复。
所有门槛通过后才将同一候选镜像推送 GHCR，最后创建同 Tag Release；正文仅为精确匹配的 changelog
章节，镜像地址和摘要放在附件及 Actions 摘要中。`container-evidence` 提供截图与验证结果。

若 GHCR 已推送但 Release 创建失败，不重建覆盖版本镜像。核对镜像 revision 标签、摘要与成功验证的
提交后，从同 Tag 提取正文，用 `gh release create <Tag> --verify-tag --title <Tag> --notes-file <文件>
image.txt` 恢复元数据。若代码需修复，发布新的版本号。
