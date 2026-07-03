#!/usr/bin/env bash
# TS3 Panel 一键安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/Maybe922/ts3-server-bot/main/scripts/install.sh | sudo bash
set -euo pipefail

INSTALL_DIR="/usr/local/bin"
DATA_DIR="/opt/ts3panel/data"
PANEL_PORT="8090"
# 主源：GitHub Releases。TODO: 增加国内镜像源为首选，此地址作兜底
DOWNLOAD_BASE="https://github.com/Maybe922/ts3-server-bot/releases/latest/download"

info() { echo -e "\033[1;34m[TS3Panel]\033[0m $*"; }
fail() { echo -e "\033[1;31m[错误]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行（sudo bash）"

case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) fail "暂不支持的架构: $(uname -m)" ;;
esac

command -v systemctl >/dev/null || fail "需要 systemd（Ubuntu 20.04+/Debian 11+）"

info "下载面板 (linux/${ARCH})..."
curl -fsSL -o "${INSTALL_DIR}/ts3panel.tmp" "${DOWNLOAD_BASE}/ts3panel_linux_${ARCH}" \
  || fail "下载失败，请检查网络后重试"
mv "${INSTALL_DIR}/ts3panel.tmp" "${INSTALL_DIR}/ts3panel"
chmod +x "${INSTALL_DIR}/ts3panel"

mkdir -p "${DATA_DIR}"

info "注册 systemd 服务..."
cat > /etc/systemd/system/ts3panel.service <<EOF
[Unit]
Description=TS3 Panel - TeamSpeak 3 management panel
After=network.target

[Service]
ExecStart=${INSTALL_DIR}/ts3panel -addr :${PANEL_PORT} -data ${DATA_DIR}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ts3panel

PUBLIC_IP=$(curl -fsSL --max-time 5 https://ipinfo.io/ip 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
info "✅ 安装完成！"
info "下一步："
info "  1. 在云控制台防火墙/安全组放行: TCP ${PANEL_PORT}(面板)、UDP 9987(语音)、TCP 30033(文件传输)"
info "  2. 浏览器打开: http://${PUBLIC_IP}:${PANEL_PORT}"
info "  3. 设置面板密码，按界面引导安装 TS3 服务器"
