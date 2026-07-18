package musicbot

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Bot 以 systemd 服务方式常驻(unit 由 install.sh 创建),
// 面板负责启停;非 systemd 环境(本地开发)下这些操作不可用。

const serviceName = "tsmusicbot.service"

// ServiceState 是 Bot 进程托管层面的状态(与 Bot 是否连上 TS 是两回事)。
type ServiceState struct {
	Managed bool `json:"managed"` // unit 是否存在(是否由 systemd 托管)
	Running bool `json:"running"`
	// cgroup 内存与任务数(node+全部 ffmpeg 子进程),未运行或取不到为 0。
	// 面板据此提示"内存异常偏高"——2026-07-18 失控事故的可观测信号
	MemoryBytes uint64 `json:"memoryBytes"`
	Tasks       uint64 `json:"tasks"`
}

func State() ServiceState {
	if _, err := os.Stat("/etc/systemd/system/" + serviceName); err != nil {
		return ServiceState{}
	}
	running := exec.Command("systemctl", "is-active", "--quiet", serviceName).Run() == nil
	st := ServiceState{Managed: true, Running: running}
	if running {
		st.MemoryBytes, st.Tasks = cgroupUsage()
	}
	return st
}

// cgroupUsage 读取 unit 的内存占用与任务数，取不到一律回 0（展示层跳过）。
func cgroupUsage() (mem, tasks uint64) {
	out, err := exec.Command("systemctl", "show", serviceName,
		"-p", "MemoryCurrent", "-p", "TasksCurrent", "--value").Output()
	if err != nil {
		return 0, 0
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return 0, 0
	}
	parse := func(s string) uint64 {
		v, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
		// "[not set]" 或 cgroup 未统计时的 uint64 极大值都按 0 处理
		if err != nil || v == ^uint64(0) {
			return 0
		}
		return v
	}
	return parse(lines[0]), parse(lines[1])
}

// 启停同时切换开机自启:用户"要不要机器人"的选择要在重启后依然生效。
func StartService() error { return systemctl("enable", "--now") }
func StopService() error  { return systemctl("disable", "--now") }

func systemctl(args ...string) error {
	out, err := exec.Command("systemctl", append(args, serviceName)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s 失败: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}
