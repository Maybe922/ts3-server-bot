package musicbot

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Bot 以 systemd 服务方式常驻(unit 由 install.sh 创建),
// 面板负责启停;非 systemd 环境(本地开发)下这些操作不可用。

const serviceName = "tsmusicbot.service"

// ServiceState 是 Bot 进程托管层面的状态(与 Bot 是否连上 TS 是两回事)。
type ServiceState struct {
	Managed bool `json:"managed"` // unit 是否存在(是否由 systemd 托管)
	Running bool `json:"running"`
}

func State() ServiceState {
	if _, err := os.Stat("/etc/systemd/system/" + serviceName); err != nil {
		return ServiceState{}
	}
	running := exec.Command("systemctl", "is-active", "--quiet", serviceName).Run() == nil
	return ServiceState{Managed: true, Running: running}
}

func StartService() error { return systemctl("start") }
func StopService() error  { return systemctl("stop") }

func systemctl(action string) error {
	out, err := exec.Command("systemctl", action, serviceName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s 失败: %s", action, strings.TrimSpace(string(out)))
	}
	return nil
}
