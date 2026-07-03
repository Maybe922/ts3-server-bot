#!/usr/bin/env bash
# TS3 Panel 一键安装脚本: 管理面板 + 点歌机器人 (TS3 服务器在面板界面里安装)
# 用法: curl -fsSL https://raw.githubusercontent.com/Maybe922/ts3-server-bot/main/scripts/install.sh | sudo bash
set -euo pipefail

BASE_DIR="/opt/ts3panel"
DATA_DIR="${BASE_DIR}/data"
BOT_DIR="${BASE_DIR}/bot"
PANEL_PORT="8090"
RUN_USER="ts3panel"
# 主源: GitHub Releases。TODO: 增加国内镜像源为首选,此地址作兜底
DOWNLOAD_BASE="https://github.com/Maybe922/ts3-server-bot/releases/latest/download"

info() { echo -e "\033[1;34m[TS3Panel]\033[0m $*"; }
fail() { echo -e "\033[1;31m[错误]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行(sudo bash)"
command -v systemctl >/dev/null || fail "需要 systemd(Ubuntu 20.04+/Debian 11+)"

case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) fail "暂不支持的架构: $(uname -m)" ;;
esac

# ---------- 运行用户与目录 ----------
id -u "${RUN_USER}" >/dev/null 2>&1 || useradd --system --home-dir "${BASE_DIR}" --shell /usr/sbin/nologin "${RUN_USER}"
mkdir -p "${DATA_DIR}"

# ---------- 1/3 管理面板 ----------
info "[1/3] 下载管理面板 (linux/${ARCH})..."
curl -fsSL -o /usr/local/bin/ts3panel.tmp "${DOWNLOAD_BASE}/ts3panel_linux_${ARCH}" \
  || fail "面板下载失败,请检查网络后重试"
mv /usr/local/bin/ts3panel.tmp /usr/local/bin/ts3panel
chmod +x /usr/local/bin/ts3panel

# ---------- 2/3 Node 运行时(点歌机器人依赖) ----------
NEED_NODE=1
if command -v node >/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  # Bot 预构建包的原生模块与 Node 22 ABI 绑定
  [ "${NODE_MAJOR}" -ge 22 ] && NEED_NODE=0
fi
if [ "${NEED_NODE}" -eq 1 ]; then
  info "[2/3] 安装 Node.js 22(点歌机器人运行时)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 \
    && apt-get install -y nodejs >/dev/null 2>&1 \
    || info "Node 安装失败,跳过机器人(面板与 TS3 服务器不受影响,可稍后重试)"
else
  info "[2/3] Node.js 已就绪 ($(node -v))"
fi

# ---------- 3/3 点歌机器人 ----------
if [ "${ARCH}" = "amd64" ] && command -v node >/dev/null; then
  info "[3/3] 下载点歌机器人..."
  if curl -fsSL -o /tmp/tsmusicbot.tar.gz "${DOWNLOAD_BASE}/tsmusicbot_linux_amd64.tar.gz"; then
    mkdir -p "${BOT_DIR}"
    tar -xzf /tmp/tsmusicbot.tar.gz -C "${BOT_DIR}"
    rm -f /tmp/tsmusicbot.tar.gz
    # 生成机器人配置: 连本机 TS 服务器,控制 API 只绑回环
    mkdir -p "${BOT_DIR}/data"
    if [ ! -f "${BOT_DIR}/data/config.json" ]; then
      cat > "${BOT_DIR}/data/config.json" <<EOF
{
  "serverHost": "127.0.0.1",
  "serverPort": 9987,
  "nickname": "点歌姬",
  "defaultChannel": "",
  "apiPort": 3310,
  "apiToken": "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}
EOF
    fi
    cat > /etc/systemd/system/tsmusicbot.service <<EOF
[Unit]
Description=TS3 Panel Music Bot
After=network.target

[Service]
Type=simple
User=${RUN_USER}
ExecStart=$(command -v node) ${BOT_DIR}/dist/index.js
WorkingDirectory=${BOT_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    BOT_INSTALLED=1
  else
    info "机器人下载失败,跳过(可稍后重试)"
    BOT_INSTALLED=0
  fi
else
  info "[3/3] 跳过机器人(需要 amd64 架构与 Node.js)"
  BOT_INSTALLED=0
fi

# ---------- systemd: 面板 ----------
info "注册系统服务..."
cat > /etc/systemd/system/ts3panel.service <<EOF
[Unit]
Description=TS3 Panel - TeamSpeak 3 management panel
After=network.target

[Service]
ExecStart=/usr/local/bin/ts3panel -addr :${PANEL_PORT} -data ${DATA_DIR} -bot-config ${BOT_DIR}/data/config.json
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

chown -R "${RUN_USER}:${RUN_USER}" "${BASE_DIR}"
systemctl daemon-reload
systemctl enable --now ts3panel
[ "${BOT_INSTALLED}" -eq 1 ] && systemctl enable --now tsmusicbot

PUBLIC_IP=$(curl -fsSL --max-time 5 https://ipinfo.io/ip 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
info "✅ 安装完成!"
info "接下来:"
info "  1. 在云控制台防火墙/安全组放行: TCP ${PANEL_PORT}(面板)、UDP 9987(语音)、TCP 30033(文件传输)"
info "  2. 浏览器打开: http://${PUBLIC_IP}:${PANEL_PORT}"
info "  3. 设置面板密码 → 同意协议安装 TS3 服务器 → 启动 → 开黑!"
[ "${BOT_INSTALLED}" -eq 1 ] && info "  点歌机器人已就位,服务器启动后它会自动连入,在面板点歌台直接点歌"
