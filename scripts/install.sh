#!/usr/bin/env bash
# TS3 Panel 一键安装脚本
# 用法: curl -fsSL https://<分发域名>/install.sh | bash
set -euo pipefail

PANEL_VERSION="0.1.0-dev"
INSTALL_DIR="/usr/local/bin"
# TODO: 发布后替换为真实分发地址（香港节点优先，GitHub Releases 兜底）
DOWNLOAD_BASE="https://example.com/releases"

info() { echo -e "\033[1;34m[TS3Panel]\033[0m $*"; }
fail() { echo -e "\033[1;31m[错误]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行（或 sudo bash）"

case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) fail "暂不支持的架构: $(uname -m)" ;;
esac

command -v systemctl >/dev/null || fail "需要 systemd（Ubuntu 20.04+/Debian 11+/CentOS 8+）"

info "下载面板 (${ARCH})..."
curl -fsSL -o "${INSTALL_DIR}/ts3panel" \
  "${DOWNLOAD_BASE}/ts3panel_linux_${ARCH}_${PANEL_VERSION}"
chmod +x "${INSTALL_DIR}/ts3panel"

info "注册 systemd 服务..."
cat > /etc/systemd/system/ts3panel.service <<'EOF'
[Unit]
Description=TS3 Panel - TeamSpeak 3 management panel
After=network.target

[Service]
ExecStart=/usr/local/bin/ts3panel
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ts3panel

PUBLIC_IP=$(curl -fsSL --max-time 5 https://ipinfo.io/ip 2>/dev/null || hostname -I | awk '{print $1}')
info "安装完成！浏览器打开: http://${PUBLIC_IP}:8090"
info "如无法访问，请在云控制台防火墙/安全组放行 TCP 8090"
