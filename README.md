# TS3 Panel — TeamSpeak 3 一键部署与管理面板

给"愿意买 VPS 但不会搭服务器"的开黑玩家：一条命令装好 TeamSpeak 3 服务器，
之后全程在浏览器里管理，内置 Bot，对国内网络友好。

## 为什么做这个

- TeamSpeak 延迟低、占用小、数据自持，是开黑语音的优解，但搭建门槛劝退了大多数人
- 现有面板（如 TS3 Manager）只管理"已装好"的服务器，不解决安装部署和国内下载问题
- 知乎/博客上大量"保姆级搭建教程"证明需求真实存在，但没人产品化

## 产品形态

```
用户 VPS
├── TS3 Server（官方二进制，安装时从官方源/自建镜像下载）
├── ts3panel（本项目：Go 单二进制，systemd 常驻）
│   ├── 内嵌 Web 管理界面（浏览器访问 http://IP:8090）
│   ├── 负责 TS3 进程的安装 / 启动 / 看护 / 备份
│   └── 通过 ServerQuery/WebQuery 管理频道、权限、在线用户
└── Bot（欢迎语、AFK 挪人；音乐 Bot 为 v2 插件）
```

用户侧体验：`curl -fsSL https://<分发域名>/install.sh | bash` → 浏览器打开面板 → 点"安装服务器" → 发邀请地址给朋友。

## 关键决策记录

| 决策 | 结论 | 原因 |
|---|---|---|
| 技术栈 | Go 单二进制 + 内嵌前端 | 轻量、无运行时依赖、交叉编译方便（对标 frp/1Panel） |
| TS 版本 | 先锁定 TS3 (3.13.x) | TS6 服务端还在 beta，生态未成熟 |
| 二进制来源 | 官方源优先，自建香港镜像兜底 | teamspeak.com 国内访问不稳；**不得**重新打包分发官方二进制 |
| EULA | 用户在界面上显式点击同意 | 不能替用户静默接受（授权红线） |
| 授权模式 | 用户自己的 VPS + 免费授权(1虚拟服/32人) 或自行申请 NPL(512人) | 不做集中托管，避开 ATHP 商业授权 |
| 分发节点 | 腾讯云香港（已实测：官方源 9.5MB/0.37s，回大陆线路好） | 两头都够得着，见下方"已验证" |

## 已验证的事实（2026-07）

- 官方下载直链格式：`https://files.teamspeak-services.com/releases/server/<ver>/teamspeak3-server_linux_amd64-<ver>.tar.bz2`（当前 3.13.8，9.5MB，走 Cloudflare CDN）
- 香港节点访问官方源/Docker Hub/GitHub 全部畅通且快
- 腾讯云等云商的端口放行在**控制台安全组**层面，OS 内部无法自行打开
  → 安装向导必须引导用户放行：**UDP 9987**（语音）、TCP 30033（文件传输）、TCP 8090（本面板）
- ServerQuery 手册在服务端包内 `doc/serverquery/`；3.12+ 另有 WebQuery (HTTP+JSON)

## 目录结构

```
├── main.go              # 入口：HTTP 服务 + 内嵌静态资源
├── internal/
│   ├── tsserver/        # TS3 下载、安装、进程生命周期（里程碑 1）
│   └── query/           # ServerQuery 客户端（里程碑 2）
├── web/                 # 面板前端（embed 进二进制）
└── scripts/install.sh   # 一键安装脚本
```

## 进程模型

生产模式下面板与 TS3 各自是独立的 systemd 服务，生死解耦：

- `ts3panel.service`（root，需指挥 systemd）：面板本体，崩溃 3 秒自愈
- `ts3server.service`（服务端目录属主身份）：由面板创建和启停，崩溃 5 秒自愈，开机自启
- 面板升级/重启不影响语音；启动后阻塞等待 Query 端口就绪（最长 25s），
  查询连接带重试，消除启动窗口期的误报
- 非 root/无 systemd 环境自动降级为子进程模式（仅供开发，`-supervisor` 可强制指定）

## 里程碑

1. ~~**一键起服**~~ ✅ 已在真实 VPS 验证（含 EULA 流程、Token 抓取）
2. ~~**运维面板**~~ ✅ 概览/改名/频道增删/在线用户/踢人（ServerQuery）
3. ~~**可靠性加固**~~ ✅ systemd 双服务 + 崩溃自愈 + 就绪等待（故障演练通过）
4. **发布流水线**：GitHub Actions 已配（打 v* tag 自动出多架构二进制），待首次发版验证
5. **基础 Bot**：欢迎语、AFK 自动挪频道 ← 下一步
6. 安全与体验：HTTPS、备份恢复、端口引导页、TS3 版本升级、日志页
7. v2：音乐 Bot 插件、多虚拟服务器、权限模板、国内镜像源

## 开发

```bash
go run .          # 本地起面板，默认 :8090
go build -o ts3panel .
```
