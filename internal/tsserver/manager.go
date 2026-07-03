package tsserver

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
)

const stopTimeout = 10 * time.Second

// Credentials 是 TS3 首次启动时生成的管理凭据，抓取后落盘保存。
type Credentials struct {
	QueryUser     string `json:"queryUser"`
	QueryPassword string `json:"queryPassword"`
	AdminToken    string `json:"adminToken"`
}

// Manager 负责 TS3 服务端的安装与进程生命周期。
type Manager struct {
	mu      sync.Mutex
	baseDir string
	cmd     *exec.Cmd
}

func NewManager(baseDir string) *Manager {
	// 转为绝对路径：启动子进程时 cmd.Dir 会先切换工作目录，
	// 相对路径会在子进程的新工作目录下解析而找不到二进制。
	abs, err := filepath.Abs(baseDir)
	if err != nil {
		abs = baseDir
	}
	return &Manager{baseDir: abs}
}

func (m *Manager) serverDir() string { return filepath.Join(m.baseDir, "server") }
func (m *Manager) binPath() string   { return filepath.Join(m.serverDir(), "ts3server") }
func (m *Manager) pidFile() string   { return filepath.Join(m.baseDir, "ts3server.pid") }
func (m *Manager) credFile() string  { return filepath.Join(m.baseDir, "credentials.json") }

// Installed 报告服务端二进制是否就位。
func (m *Manager) Installed() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.installedLocked()
}

func (m *Manager) installedLocked() bool {
	info, err := os.Stat(m.binPath())
	return err == nil && !info.IsDir()
}

// Running 报告 TS3 进程是否存活（含面板重启后通过 pid 文件找回的进程）。
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.runningPID() != 0
}

// runningPID 返回存活的 TS3 进程 pid，不存活返回 0。
func (m *Manager) runningPID() int {
	data, err := os.ReadFile(m.pidFile())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil || pid <= 0 {
		return 0
	}
	// signal 0 只探测进程是否存在，不产生实际信号
	if err := syscall.Kill(pid, 0); err != nil {
		return 0
	}
	return pid
}

// Start 启动 TS3 进程并在后台抓取首次启动打印的管理凭据。
func (m *Manager) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.installedLocked() {
		return errors.New("服务器尚未安装")
	}
	if m.runningPID() != 0 {
		return errors.New("服务器已在运行")
	}

	cmd := exec.Command(m.binPath())
	cmd.Dir = m.serverDir()
	cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH="+m.serverDir())
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 ts3server 失败: %w", err)
	}
	m.cmd = cmd

	pid := strconv.Itoa(cmd.Process.Pid)
	if err := os.WriteFile(m.pidFile(), []byte(pid), 0o644); err != nil {
		log.Printf("写入 pid 文件失败: %v", err)
	}

	go m.captureCredentials(stdout)
	go func() {
		_ = cmd.Wait() // 回收子进程，避免僵尸
		os.Remove(m.pidFile())
		log.Printf("ts3server 进程已退出")
	}()
	return nil
}

// Stop 先礼后兵地停止 TS3 进程。
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	pid := m.runningPID()
	if pid == 0 {
		return errors.New("服务器未在运行")
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		return fmt.Errorf("发送停止信号失败: %w", err)
	}
	deadline := time.Now().Add(stopTimeout)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			os.Remove(m.pidFile())
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	syscall.Kill(pid, syscall.SIGKILL)
	os.Remove(m.pidFile())
	return nil
}

var (
	queryLoginRe = regexp.MustCompile(`loginname= "([^"]+)", password= "([^"]+)"`)
	tokenRe      = regexp.MustCompile(`token=(\S+)`)
)

// captureCredentials 扫描服务端输出，抓取首次启动生成的凭据并落盘。
func (m *Manager) captureCredentials(r interface{ Read([]byte) (int, error) }) {
	existing, _ := m.LoadCredentials()
	creds := existing

	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		if match := queryLoginRe.FindStringSubmatch(line); match != nil {
			creds.QueryUser, creds.QueryPassword = match[1], match[2]
		}
		if match := tokenRe.FindStringSubmatch(line); match != nil {
			creds.AdminToken = match[1]
		}
		if creds != existing {
			if err := m.saveCredentials(creds); err != nil {
				log.Printf("保存凭据失败: %v", err)
			}
			existing = creds
		}
	}
}

func (m *Manager) saveCredentials(c Credentials) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// 凭据敏感，仅属主可读
	return os.WriteFile(m.credFile(), data, 0o600)
}

// LoadCredentials 读取已保存的管理凭据；尚未生成时 ok 为 false。
func (m *Manager) LoadCredentials() (creds Credentials, ok bool) {
	data, err := os.ReadFile(m.credFile())
	if err != nil {
		return Credentials{}, false
	}
	if err := json.Unmarshal(data, &creds); err != nil {
		return Credentials{}, false
	}
	return creds, creds != Credentials{}
}
