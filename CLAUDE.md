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

1. 同步 bump 两处版本：`main.go` 的 `version` 常量 + `bot/package.json` 的 `version`。
   **`version` 常量必须与将要打的 tag 完全一致**——面板一键更新拿它和最新 release 比对，不一致会误报/漏报更新
2. 提交后打 `v*` tag 推 GitHub → Actions 自动构建 Release（面板 amd64/arm64 + 机器人 tarball + SHA256SUMS）
3. **手动同步 Gitee 镜像**（大陆用户依赖，流程 2026-07-18 验证过）：
   - `git push https://wushuangqq:<令牌>@gitee.com/wushuangqq/ts3-server-bo.git main --tags`
   - 只需给**最新版**建 release（版本发现逻辑只看 `releases/latest`，中间版本不用建）：`POST /api/v5/repos/wushuangqq/ts3-server-bo/releases`（tag_name/name/body/target_commitish），再对返回的 id 逐个 `POST .../releases/{id}/attach_files`（multipart `file=@`）传四个资产
   - 传完从 Gitee 回下载做 SHA256 校验（必须与 GitHub 产物逐字节一致）
   - 令牌每次问用户要、不落盘；用户新生成的令牌可能报 "Access token is expired"，让用户在 Gitee 上延长过期时间即可
4. Gitee 仓库是 `wushuangqq/ts3-server-bo`（名字确实少个 t，用户知情，**不要改名**——安装命令已固化）
5. 现状认知：**每次更新都会要求用户先停用机器人**——"bot 没变就跳过"的快路永远不触发，因为每版都 bump `bot/package.json`（在 tarball 里）且 CI 打 tar 无固定时间戳，包哈希每版必变。想启用零打断需：CI 确定性打包（`--sort=name --mtime` 固定 + `gzip -n`）+ bot 版本号只在真改动时 bump（用户知情，说不急）

升级 TS3 服务端版本时：改 `internal/tsserver/install.go` 的 `Version` 和 `officialSHA256`，并把官方新包原封上传到 Gitee 新 tag `ts3-<版本>`。

用户侧升级两条路（v0.5.0 起）：面板顶栏一键更新（`internal/update`，有新版时顶栏出现蓝色胶囊按钮），或重跑安装命令（install.sh 是 `enable` + `restart`，重跑即升级；数据配置全保留）。

## 架构

三个独立 systemd 服务，生死解耦（面板重启不影响语音和点歌）：

- `ts3panel.service`（root）：Go 单二进制。安装/看护 ts3server、代理机器人 API、内嵌前端
- `ts3server.service`（服务端目录属主）：由面板动态生成 unit 并启停
- `tsmusicbot.service`（ts3panel 用户）：点歌机器人，**可选**——install.sh 只注册不启动，面板里一键启用/停用（`systemctl enable/disable --now`，选择跨重启持久）

面板（Go）关键包：
- `internal/tsserver`：下载安装（`downloadURLs` 多源：官方源→Gitee 镜像，所有源过同一 SHA256 硬校验）、纯 Go 解压 tar.bz2（防路径穿越）、systemd unit 生成、从 journalctl 抓取首启凭据（Token/Query 账号）
- `internal/query`：ServerQuery 客户端（127.0.0.1:10011，注意协议转义 `\s` `\p` `\/`，响应以 `error id=0` 结尾）
- `internal/musicbot`：机器人 API 代理（每次请求现读 bot 配置文件拿 apiPort/apiToken，token 轮换无感）+ systemd 启停
- `internal/auth`：bcrypt 密码 + 内存 Cookie 会话（7 天，面板重启即失效）
- `internal/update`：面板自更新。版本发现走 GitHub `releases/latest` 的跳转 Location 取 tag（避 API 限流）→ Gitee API 兜底，结果缓存 5 分钟（前端另有 30 分钟定时复查）；apply 先把全部资产过 SHA256SUMS 校验再动文件——bot tarball 与 `bot/.release.sha256` 标记一致则完全跳过 bot，有变化且 bot 在运行则直接拒绝（要求用户先停用），解压一律写临时文件再 rename；面板二进制留 `.old` 兜底；仅 root+systemd 环境可用
- API 统一信封 `{success, data, error}`；除 `/api/auth/*` 和 `/api/version`（更新重启期间前端探活用）外全部走 `requireAuth`——不要再新增无鉴权接口

机器人（bot/，TypeScript）：
- `ts-client.ts`：TS 语音协议封装（MIT 库 @honeybbq/teamspeak-client）。**单一守护循环**：连接→驻留至断开→5s 重试，任何失败路径都回到循环，绝不静默退出。连接必须带 `serverPassword`（服主在 TS 客户端设的连接密码，面板点歌台可填，改后下轮重连生效）。身份持久化保证 Bot 是"同一个用户"。头像上传（封面）走 `fileTransferInitUpload(0n, "/avatar")` + `clientupdate client_flag_avatar=<md5>`；歌名挂昵称（30 字符上限，注意转义）
- `player.ts`：音频管线 = 网易云 URL → **Node fetch 下载**（不能让 ffmpeg 自己联网，见下方陷阱）→ **32MB PassThrough 整首预缓存**（防 CDN 掐闲置慢连接，见下方陷阱）→ ffmpeg 从 `pipe:0` 解码 s16le/48k/双声道 → 3840 字节 20ms 帧 → 音量增益 → Opus 编码 → `sendVoice(frame, 5)`。时间戳对齐的帧泵防漂移；播放进度 = 已发帧数×20ms（`status.positionMs`，前端 5s 校准+本地插值）；断流 20s 看门狗自动跳歌；**切歌用 `session` 代际串行化**（并发切歌会泄漏帧泵/ffmpeg，见下方陷阱）；队列实时落盘 `data/queue.json`（进程退出走 `shutdown()` 保留队列，用户点停止走 `stopAll()` 清空——两者语义不同，别混用）
- `api.ts`：控制 API 只绑 127.0.0.1:3310 + Bearer Token，面板是唯一入口
- `netease.ts`：搜索（cloudsearch `offset` 翻页）/直链/歌单/扫码登录（cookie 0600 落盘）/封面（CDN `?param=300y300` 出缩略图）/歌词（LRC 原文透传，前端解析时间轴并按播放进度本地滚动，一首歌只取一次）
- `chat-commands.ts`：频道聊天点歌（`!点歌` `!跳过` `!队列` 等，半角/全角前缀都认，中文别名可不加空格）。库对收发消息两头都做了协议转义，业务代码传纯文本即可；回复走 `TSClient.reply`（私聊回私聊、频道回频道）；必须过滤自己发的消息防自触发循环；每用户 2s 冷却防刷屏/洪水保护

## 硬约束（违反会出产品/法务事故）

- **EULA 必须用户在界面显式勾选**，代码任何路径不得默认接受
- **官方二进制不得重新打包**：Gitee 镜像必须是逐字节原包，且 `install.go` 的 SHA256 校验对所有下载源生效
- **前端保持单文件手写 HTML**（零构建零依赖）：用户在 HeroUI 重写失败后明确定调，不要引入任何前端框架/构建链
- Node 22 ABI 锁定：机器人预构建包的原生模块（@discordjs/opus）与 Node 22 绑定，CI 和 install.sh 的 Node 版本必须一致
- **已知在库风险（清理需用户批准，先别恶化）**：`data/server/`（官方 ts3server 二进制 13.7MB + 全套服务端文件 + `.ts3server_license_accepted`）和 `data-musictest/panel-password.hash` 正被 git 追踪、在公开历史里——前者踩上一条"不得分发官方二进制"的红线，后者是密码哈希泄漏。`.gitignore` 只挡了 `data-*/` 没挡 `data/`。**不要再 `git add` `data/` 下的任何文件**；彻底清理 = `git rm` + filter-repo 重写历史 + force push，必须用户显式点头

## 踩过的坑（改相关代码前先读）

- **ffmpeg-static 在部分 Linux 上一联网（DNS）就段错误**——所以音源下载由 Node 完成、ffmpeg 只从 stdin 管道解码。不要"优化"回 `-i <url>`
- TS 头像/文件传输走 **TCP 30033**，云安全组没放行或用户挂代理时表现为客户端 LOADING IMAGE 卡死；安全组只能在云控制台改，产品必须引导放行 TCP 8090 / UDP 9987 / TCP 30033
- 机器人重连若写成事件回调互相拉起的形式会出现静默死亡竞态，保持 `start()` 的单 while 循环形态
- **TS3 服务器连接密码只在建连时校验，不踢在线客户端**——服主设密码后 bot"连着一切正常，掉线后永远回不去"。线上表现：服务器没事、bot 15s 超时无限重试。已发生过一次（v0.5.0 修复）
- **@honeybbq/teamspeak-client 会静默吞掉无 return code 的 error 命令**（仅 id=3329 被 ban 有处理）——服务器在握手期的拒绝原因（如 error 1028 密码错误）全被吃掉，bot 只见超时。排障方法：把库 dist 复制出来在 `#k`（入站命令分发）加日志抓原始命令流。该库 `connect()` 失败路径还会泄漏 UDP socket（上游未修）
- **面板自更新的自重启必须走 `systemd-run`（独立 cgroup）**：直接 exec `systemctl restart` 会在 systemd 停面板时连带杀掉子进程，重启永远完不成；兜底是非零退出交给 unit 的 `Restart=on-failure`
- **更新涉及 bot 组件时 Apply 直接拒绝、要求用户先「停用机器人」**（产品约定：打断音乐的时机由服主自己挑）；bot tarball 没变（比对 `bot/.release.sha256` 标记）则完全跳过、零打断——纯面板发版绝不动 bot。背景：放歌中覆盖正在执行的 ffmpeg 报 ETXTBSY `text file busy`（v0.5.6→v0.5.7 升级时线上发生），Node 已 mmap 的原生模块（opus）也有崩溃风险；解压一律"写临时文件再 rename"（rename 换 inode 对运行中二进制永远合法）。bot 重启后队列会恢复但**不自动续播**（要点 ⏭）（v0.5.7/v0.5.8 修复）
- **并发切歌会泄漏帧泵和 ffmpeg，且泄漏会滚雪球**（2026-07-18 线上事故）：切歌的"取直链"是异步窗口，窗口期另一次切歌（双击 ⏭、看门狗+手动同时触发、enqueue 撞上在途切歌）会让两条管线并存——`this.pump` 被覆盖后旧帧泵永久泄漏，旧 ffmpeg 变孤儿；每个泄漏帧泵又各自触发"断流跳歌"再开新管线，指数繁殖。线上实况：10 小时刷出 1422 条空歌名「」跳歌日志、283 个僵尸 ffmpeg、吃光 2G 内存+2G swap，bot 因 `packet ack timeout` 掉线且面板误显"未启用"。修复（v0.6.0）：`session` 代际闸门（`stopCurrent` 时 `++`，异步落地前必须比对，帧泵闭包代际过期自毁）+ `switchPending` 挡住 enqueue 顶掉在途切歌。**改 player.ts 任何异步路径前先想代际**
- **音源下载连接不能跟着解码节奏细水长流**：旧管线靠 ffmpeg stdout 背压把下载扼到 ~实时速率，跨境 CDN 会掐闲置慢连接——线上表现为每首歌放三五分钟就"断流跳歌"（半开连接不报错，只能等 20s 看门狗）。v0.6.0 起下载全速灌进 32MB PassThrough 预缓存、ffmpeg 从内存消化，别把预缓存"优化"掉
- bot dist/*.js 平台无关，可直接 scp 到 VPS 热修（不用动 node_modules）；面板热修 = 换二进制 + `systemctl restart ts3panel`
