package update

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	downloadTimeout = 5 * time.Minute
	botUnitName     = "tsmusicbot.service"
	panelUnitName   = "ts3panel.service"
	// 已安装 bot 对应的 tarball 校验和标记:与新版一致时完全跳过 bot,不打断正在播的音乐
	botSumFile = ".release.sha256"
)

// Apply 执行一次完整更新，成功返回新版本号。
// 顺序：解析最新版 → 下载并校验全部资产 → 落地机器人 → 落地面板二进制（旧的留作 .old）。
// 全部资产校验通过之前不动任何现有文件；面板重启由调用方通过 ScheduleRestart 触发。
func (u *Updater) Apply(ctx context.Context) (string, error) {
	if os.Geteuid() != 0 || !commandExists("systemctl") {
		return "", errors.New("一键更新仅支持 systemd 安装环境（安装脚本部署的生产环境）")
	}
	if !u.applyMu.TryLock() {
		return "", errors.New("已有更新正在进行，请稍候")
	}
	defer u.applyMu.Unlock()

	// 不用 Check 的缓存：以此刻真实可达的源为准，保证 SUMS 与资产同源同版本
	rel, err := latestRelease(ctx)
	if err != nil {
		return "", err
	}
	if !newer(rel.Tag, u.version) {
		return "", fmt.Errorf("当前 v%s 已是最新版本", u.version)
	}

	sums, err := fetchSums(ctx, rel)
	if err != nil {
		return "", fmt.Errorf("获取校验清单失败: %w", err)
	}

	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	panelAsset := "ts3panel_linux_" + runtime.GOARCH
	panelTmp, err := downloadVerified(ctx, rel.base+"/"+panelAsset, sums[panelAsset], filepath.Dir(exe))
	if err != nil {
		return "", fmt.Errorf("下载面板失败: %w", err)
	}
	defer os.Remove(panelTmp) // 成功 rename 后为空操作

	// 机器人为可选组件：unit 存在且架构匹配才更新
	const botAsset = "tsmusicbot_linux_amd64.tar.gz"
	updateBot := runtime.GOARCH == "amd64" && u.botDir != "" &&
		unitExists(botUnitName) && sums[botAsset] != ""
	// 新版 tarball 与已安装的完全一致(纯面板发版)→ 不解压不重启,音乐零打断
	if updateBot && installedBotSum(u.botDir) == sums[botAsset] {
		updateBot = false
	}
	var botTmp string
	if updateBot {
		if botTmp, err = downloadVerified(ctx, rel.base+"/"+botAsset, sums[botAsset], os.TempDir()); err != nil {
			return "", fmt.Errorf("下载机器人失败: %w", err)
		}
		defer os.Remove(botTmp)
	}

	// —— 资产全部就绪，开始落地 ——
	if updateBot {
		botWasRunning := unitActive(botUnitName)
		// 先停后换：运行中的 Node 已 mmap 原生模块(opus),原地覆盖可能让它直接崩溃;
		// stop 还会触发 bot 的 shutdown() 把队列干净落盘
		if botWasRunning {
			if err := systemctl("stop", botUnitName); err != nil {
				return "", err
			}
		}
		extractErr := extractBot(botTmp, u.botDir)
		if extractErr == nil {
			writeBotSum(u.botDir, sums[botAsset])
		}
		// 用户"要不要机器人"的选择不变：原本在跑就拉回来,解压失败也尽力恢复运行
		if botWasRunning {
			if err := systemctl("start", botUnitName); err != nil && extractErr == nil {
				return "", err
			}
		}
		if extractErr != nil {
			return "", fmt.Errorf("更新机器人失败: %w", extractErr)
		}
	}

	// 面板二进制原地替换，旧版本留作 .old 便于手动回滚
	oldPath := exe + ".old"
	os.Remove(oldPath)
	if err := os.Rename(exe, oldPath); err != nil {
		return "", fmt.Errorf("备份旧面板失败: %w", err)
	}
	if err := os.Rename(panelTmp, exe); err != nil {
		os.Rename(oldPath, exe) // 回滚，保持面板可用
		return "", fmt.Errorf("替换面板失败: %w", err)
	}
	os.Chmod(exe, 0o755)
	return rel.Tag, nil
}

// ScheduleRestart 在 HTTP 响应送出后重启面板。
// 用 systemd-run 把 restart 放进独立 cgroup——若直接 exec systemctl，
// systemd 停面板时会连带杀掉这个子进程，重启永远做不完。
func ScheduleRestart() {
	err := exec.Command("systemd-run", "--collect", "--on-active=2",
		"systemctl", "restart", panelUnitName).Run()
	if err != nil {
		// 兜底：非零退出交给 unit 的 Restart=on-failure 拉起（此时二进制已是新版）
		go func() {
			time.Sleep(2 * time.Second)
			os.Exit(1)
		}()
	}
}

// fetchSums 拉取该发行版的 SHA256SUMS 并解析为 文件名→校验和。
func fetchSums(ctx context.Context, rel Release) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout*3)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rel.base+"/SHA256SUMS", nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载源返回 HTTP %d", resp.StatusCode)
	}

	sums := make(map[string]string)
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 {
			sums[strings.TrimPrefix(fields[1], "*")] = fields[0]
		}
	}
	if len(sums) == 0 {
		return nil, errors.New("校验清单为空")
	}
	return sums, scanner.Err()
}

// downloadVerified 下载到 dir 下的临时文件并强校验 SHA256，返回临时文件路径。
// 临时文件与最终目标同目录，保证后续 rename 原子生效。
func downloadVerified(ctx context.Context, url, wantSum, dir string) (string, error) {
	if wantSum == "" {
		return "", errors.New("校验清单中没有该文件，发行版可能不完整")
	}
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载源返回 HTTP %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp(dir, ".ts3panel-update-*")
	if err != nil {
		return "", err
	}
	defer tmp.Close()

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), resp.Body); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	if sum := hex.EncodeToString(hasher.Sum(nil)); sum != wantSum {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("校验和不匹配（期望 %s，实际 %s）", wantSum, sum)
	}
	return tmp.Name(), nil
}

// extractBot 把机器人 tar.gz（dist/ node_modules/ package.json）覆盖解压到 botDir。
// bot/data 不在包内，用户配置与队列天然保留；文件属主对齐目录属主（机器人以该用户运行）。
func extractBot(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	uid, gid := dirOwner(dest)
	cleanDest := filepath.Clean(dest)
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		rel := filepath.Clean(hdr.Name)
		if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("归档内含非法路径: %s", hdr.Name)
		}
		target := filepath.Join(cleanDest, rel)

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			os.Remove(target) // 覆盖旧链接
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, hdr.FileInfo().Mode())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		default:
			continue
		}
		if uid >= 0 {
			os.Lchown(target, uid, gid)
		}
	}
}

// installedBotSum 读取已安装 bot 对应的 tarball 校验和；无标记（老版本装的）返回空，走正常更新。
func installedBotSum(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, botSumFile))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// writeBotSum 记录本次落地的 tarball 校验和，供下次跳过未变化的 bot；写失败不致命。
func writeBotSum(dir, sum string) {
	path := filepath.Join(dir, botSumFile)
	if err := os.WriteFile(path, []byte(sum+"\n"), 0o644); err == nil {
		if uid, gid := dirOwner(dir); uid >= 0 {
			os.Lchown(path, uid, gid)
		}
	}
}

// dirOwner 返回目录属主的 uid/gid，取不到返回 -1（跳过 chown）。
func dirOwner(dir string) (int, int) {
	info, err := os.Stat(dir)
	if err != nil {
		return -1, -1
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return -1, -1
	}
	return int(st.Uid), int(st.Gid)
}

func unitExists(name string) bool {
	_, err := os.Stat("/etc/systemd/system/" + name)
	return err == nil
}

func unitActive(name string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", name).Run() == nil
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func systemctl(args ...string) error {
	out, err := exec.Command("systemctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s 失败: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}
