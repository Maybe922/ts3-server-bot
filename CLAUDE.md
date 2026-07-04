# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

TS3 Panel：给"愿意买 VPS 但不会搭服务器"的开黑玩家的 TeamSpeak 3 一键部署管理面板 + 网易云点歌机器人。用户在自己的 VPS 上 `curl | sudo bash` 安装，之后全程浏览器操作。界面文案、注释、提交信息均为中文。

## 常用命令

```bash
# 面板（Go，仓库根目录）
go run .                          # 本地起面板，默认 :8090（direct 模式，无需 systemd）
go build -o ts3panel . && go vet ./...
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o ts3panel_linux_amd64 .

# 机器人（TypeScript ESM，bot/ 目录）
cd bot && npm run build           # tsc 编译到 dist/
cd bot && npm run dev             # tsx 直跑 src/index.ts

# 换源下载集成测试（联网，默认 skip）
TS3_MIRROR_TEST=1 go test ./internal/tsserver -run TestMirrorFallback -v
```

前端 `web/index.html` 是 `//go:embed` 进二进制的——改了前端必须重新编译 Go 才能生效。

## 发版流程

1. 同步 bump 两处版本：`main.go` 的 `version` 常量 + `bot/package.json` 的 `version`
2. 提交后打 `v*` tag 推 GitHub → Actions 自动构建 Release（面板 amd64/arm64 + 机器人 tarball + SHA256SUMS）
3. **手动同步 Gitee 镜像**（大陆用户依赖）：`git push <gitee> main --tags`，再用 Gitee API 建同名 release 并上传 GitHub 构建出的四个资产。需要用户提供 Gitee 私人令牌（不落盘，每次问用户要）
4. Gitee 仓库是 `wushuangqq/ts3-server-bo`（名字确实少个 t，用户知情，**不要改名**——安装命令已固化）

升级 TS3 服务端版本时：改 `internal/tsserver/install.go` 的 `Version` 和 `officialSHA256`，并把官方新包原封上传到 Gitee 新 tag `ts3-<版本>`。

## 架构

三个独立 systemd 服务，生死解耦（面板重启不影响语音和点歌）：

- `ts3panel.service`（root）：Go 单二进制。安装/看护 ts3server、代理机器人 API、内嵌前端
- `ts3server.service`（服务端目录属主）：由面板动态生成 unit 并启停
- `tsmusicbot.service`（ts3panel 用户）：点歌机器人，**可选**——install.sh 只注册不启动，面板里一键启用/停用（`systemctl enable/disable --now`，选择跨重启持久）

面板（Go）关键包：
- `internal/tsserver`：下载安装（`downloadURLs` 多源：官方源→Gitee 镜像，所有源过同一 SHA256 硬校验）、纯 Go 解压 tar.bz2（防路径穿越）、systemd unit 生成、从 journalctl 抓取首启凭据（Token/Query 账号）
- `internal/query`：ServerQuery 客户端（127.0.0.1:10011，注意协议转义 `\s` `\p` `\/`，响应以 `error id=0` 结尾）
- `internal/musicbot`：机器人 API 代理（每次请求现读 bot 配置文件拿 apiPort/apiToken，token 轮换无感）+ systemd 启停
- `internal/auth`：bcrypt 密码 + 内存 Cookie 会话（7 天）
- API 统一信封 `{success, data, error}`；除 `/api/auth/*` 外全部走 `requireAuth`

机器人（bot/，TypeScript）：
- `ts-client.ts`：TS 语音协议封装（MIT 库 @honeybbq/teamspeak-client）。**单一守护循环**：连接→驻留至断开→5s 重试，任何失败路径都回到循环，绝不静默退出。身份持久化保证 Bot 是"同一个用户"。头像上传（封面）走 `fileTransferInitUpload(0n, "/avatar")` + `clientupdate client_flag_avatar=<md5>`；歌名挂昵称（30 字符上限，注意转义）
- `player.ts`：音频管线 = 网易云 URL → **Node fetch 下载**（不能让 ffmpeg 自己联网，见下方陷阱）→ ffmpeg 从 `pipe:0` 解码 s16le/48k/双声道 → 3840 字节 20ms 帧 → 音量增益 → Opus 编码 → `sendVoice(frame, 5)`。时间戳对齐的帧泵防漂移；断流 20s 看门狗自动跳歌；队列实时落盘 `data/queue.json`（进程退出走 `shutdown()` 保留队列，用户点停止走 `stopAll()` 清空——两者语义不同，别混用）
- `api.ts`：控制 API 只绑 127.0.0.1:3310 + Bearer Token，面板是唯一入口
- `netease.ts`：搜索/直链/歌单/扫码登录（cookie 0600 落盘）/封面（CDN `?param=300y300` 出缩略图）

## 硬约束（违反会出产品/法务事故）

- **EULA 必须用户在界面显式勾选**，代码任何路径不得默认接受
- **官方二进制不得重新打包**：Gitee 镜像必须是逐字节原包，且 `install.go` 的 SHA256 校验对所有下载源生效
- **前端保持单文件手写 HTML**（零构建零依赖）：用户在 HeroUI 重写失败后明确定调，不要引入任何前端框架/构建链
- Node 22 ABI 锁定：机器人预构建包的原生模块（@discordjs/opus）与 Node 22 绑定，CI 和 install.sh 的 Node 版本必须一致

## 踩过的坑（改相关代码前先读）

- **ffmpeg-static 在部分 Linux 上一联网（DNS）就段错误**——所以音源下载由 Node 完成、ffmpeg 只从 stdin 管道解码。不要"优化"回 `-i <url>`
- TS 头像/文件传输走 **TCP 30033**，云安全组没放行或用户挂代理时表现为客户端 LOADING IMAGE 卡死；安全组只能在云控制台改，产品必须引导放行 TCP 8090 / UDP 9987 / TCP 30033
- 机器人重连若写成事件回调互相拉起的形式会出现静默死亡竞态，保持 `start()` 的单 while 循环形态
- bot dist/*.js 平台无关，可直接 scp 到 VPS 热修（不用动 node_modules）；面板热修 = 换二进制 + `systemctl restart ts3panel`
