package tsserver

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// systemd 托管模式：ts3server 注册为独立的 systemd 服务，
// 与面板进程生死解耦——面板升级/重启不影响语音，崩溃由 systemd 自动拉起。

const (
	unitName = "ts3server.service"
	unitPath = "/etc/systemd/system/" + unitName
	// 首次启动凭据在 journal 里的捕获窗口
	journalCaptureWindow = 2 * time.Minute
)

const unitTemplate = `[Unit]
Description=TeamSpeak 3 Server (managed by ts3panel)
After=network.target

[Service]
Type=simple
User=%s
ExecStart=%s
WorkingDirectory=%s
Environment=LD_LIBRARY_PATH=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`

// SystemdAvailable 报告当前环境是否具备 systemd 托管条件（root + systemctl）。
func SystemdAvailable() bool {
	if os.Geteuid() != 0 {
		return false
	}
	_, err := exec.LookPath("systemctl")
	return err == nil
}

func systemctl(args ...string) error {
	out, err := exec.Command("systemctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s 失败: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}

// ensureUnit 写入/更新 unit 文件。ts3server 拒绝以 root 运行，
// 因此以服务端目录属主身份运行。
func (m *Manager) ensureUnit() error {
	owner, err := m.serverDirOwner()
	if err != nil {
		return fmt.Errorf("确定运行用户失败: %w", err)
	}
	unit := fmt.Sprintf(unitTemplate, owner, m.binPath(), m.serverDir(), m.serverDir())
	if existing, err := os.ReadFile(unitPath); err == nil && string(existing) == unit {
		return nil
	}
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("写入 unit 文件失败: %w", err)
	}
	return systemctl("daemon-reload")
}

func (m *Manager) serverDirOwner() (string, error) {
	info, err := os.Stat(m.serverDir())
	if err != nil {
		return "", err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("无法读取目录属主")
	}
	u, err := user.LookupId(strconv.Itoa(int(st.Uid)))
	if err != nil {
		return "", err
	}
	return u.Username, nil
}

func (m *Manager) startSystemd() error {
	if err := m.ensureUnit(); err != nil {
		return err
	}
	// enable --now：立即启动并注册开机自启
	if err := systemctl("enable", "--now", unitName); err != nil {
		return err
	}
	if _, ok := m.LoadCredentials(); !ok {
		go m.captureFromJournal()
	}
	return nil
}

func (m *Manager) stopSystemd() error {
	return systemctl("stop", unitName)
}

func (m *Manager) runningSystemd() bool {
	return exec.Command("systemctl", "is-active", "--quiet", unitName).Run() == nil
}

// captureFromJournal 跟踪 journal 输出，抓取首次启动生成的管理凭据。
func (m *Manager) captureFromJournal() {
	cmd := exec.Command("journalctl", "-u", unitName, "-f", "-n", "0", "-o", "cat")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Printf("打开 journal 失败: %v", err)
		return
	}
	if err := cmd.Start(); err != nil {
		log.Printf("跟踪 journal 失败: %v", err)
		return
	}
	timer := time.AfterFunc(journalCaptureWindow, func() { cmd.Process.Kill() })
	defer timer.Stop()
	m.captureCredentials(stdout)
	cmd.Wait()
}
