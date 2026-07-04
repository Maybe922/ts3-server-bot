package tsserver

import (
	"archive/tar"
	"compress/bzip2"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Version 是当前锁定的 TS3 服务端版本。
const Version = "3.13.8"

// 下载源按顺序尝试：官方源优先，Gitee 国内镜像兜底。
// 镜像是官方包的逐字节拷贝，无论从哪个源下载都必须过同一个 SHA256 校验。
var downloadURLs = []string{
	"https://files.teamspeak-services.com/releases/server/" +
		Version + "/teamspeak3-server_linux_amd64-" + Version + ".tar.bz2",
	"https://gitee.com/wushuangqq/ts3-server-bo/releases/download/ts3-" +
		Version + "/teamspeak3-server_linux_amd64-" + Version + ".tar.bz2",
}

// 2026-07-03 从官方源实测记录的校验和（见 README"已验证的事实"）。
const officialSHA256 = "a3c4658e09892d3dbd8ea752d0de42dc7d111bf44d09721927f0f4782496eb2d"

const downloadTimeout = 3 * time.Minute

// ErrLicenseNotAccepted 表示用户未确认 TeamSpeak 许可协议。
var ErrLicenseNotAccepted = errors.New("必须先阅读并同意 TeamSpeak 许可协议")

// Install 下载官方服务端包并解压到 serverDir。
// acceptLicense 必须由用户在界面上显式勾选后传入，不允许代码侧默认接受。
func (m *Manager) Install(ctx context.Context, acceptLicense bool) error {
	if !acceptLicense {
		return ErrLicenseNotAccepted
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.installedLocked() {
		return errors.New("服务器已安装")
	}

	archive, err := m.download(ctx)
	if err != nil {
		return fmt.Errorf("下载失败: %w", err)
	}
	defer os.Remove(archive)

	if err := m.extract(archive); err != nil {
		return fmt.Errorf("解压失败: %w", err)
	}

	// 服务端启动时检查该文件是否存在，存在即视为已接受协议。
	// 用户已在界面上显式同意，这里将其落盘。
	licenseFlag := filepath.Join(m.serverDir(), ".ts3server_license_accepted")
	if err := os.WriteFile(licenseFlag, nil, 0o644); err != nil {
		return fmt.Errorf("写入协议确认标记失败: %w", err)
	}
	return nil
}

// download 依次尝试各下载源，成功即返回临时文件路径（含 SHA256 校验）。
func (m *Manager) download(ctx context.Context) (string, error) {
	var errs []string
	for _, url := range downloadURLs {
		path, err := m.downloadFrom(ctx, url)
		if err == nil {
			return path, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err() // 用户取消/整体超时,不再换源
		}
		errs = append(errs, err.Error())
	}
	return "", fmt.Errorf("所有下载源均失败: %s", strings.Join(errs, "; "))
}

// downloadFrom 从单一源拉取安装包到临时文件并校验 SHA256。
func (m *Manager) downloadFrom(ctx context.Context, url string) (string, error) {
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

	if err := os.MkdirAll(m.baseDir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(m.baseDir, "ts3-download-*.tar.bz2")
	if err != nil {
		return "", err
	}
	defer tmp.Close()

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), resp.Body); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	if sum := hex.EncodeToString(hasher.Sum(nil)); sum != officialSHA256 {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("校验和不匹配（期望 %s，实际 %s），文件可能被篡改或版本已更新", officialSHA256, sum)
	}
	return tmp.Name(), nil
}

// extract 将 tar.bz2 解压到 serverDir，剥掉包内顶层目录。
func (m *Manager) extract(archive string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()

	dest := m.serverDir()
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}

	tr := tar.NewReader(bzip2.NewReader(f))
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		rel := stripTopDir(hdr.Name)
		if rel == "" {
			continue
		}
		target, err := securePath(dest, rel)
		if err != nil {
			return err
		}
		if err := writeEntry(tr, hdr, target); err != nil {
			return err
		}
	}
}

// stripTopDir 去掉归档路径的顶层目录（teamspeak3-server_linux_amd64/...）。
func stripTopDir(name string) string {
	_, rest, found := strings.Cut(filepath.ToSlash(name), "/")
	if !found {
		return ""
	}
	return rest
}

// securePath 拼接并确保目标路径不逃逸出 dest（防 tar 路径穿越）。
func securePath(dest, rel string) (string, error) {
	target := filepath.Join(dest, rel)
	if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
		return "", fmt.Errorf("归档内含非法路径: %s", rel)
	}
	return target, nil
}

func writeEntry(tr *tar.Reader, hdr *tar.Header, target string) error {
	switch hdr.Typeflag {
	case tar.TypeDir:
		return os.MkdirAll(target, 0o755)
	case tar.TypeSymlink:
		return os.Symlink(hdr.Linkname, target)
	case tar.TypeReg:
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, hdr.FileInfo().Mode())
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, tr)
		return err
	default:
		return nil // 忽略其他类型（硬链接等包内不存在）
	}
}
