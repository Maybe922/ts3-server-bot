package tsserver

import (
	"context"
	"os"
	"testing"
)

// 手动联网测试：官方源不通时应自动切 Gitee 镜像并通过 SHA256 校验。
// 运行: TS3_MIRROR_TEST=1 go test ./internal/tsserver -run TestMirrorFallback -v
func TestMirrorFallback(t *testing.T) {
	if os.Getenv("TS3_MIRROR_TEST") == "" {
		t.Skip("需要联网,设 TS3_MIRROR_TEST=1 手动运行")
	}
	dir := t.TempDir()
	m := NewManager(dir, false)

	orig := downloadURLs
	defer func() { downloadURLs = orig }()
	downloadURLs = []string{
		"https://invalid.example.invalid/ts3.tar.bz2", // 模拟官方源不通
		orig[1], // Gitee 镜像
	}

	path, err := m.download(context.Background())
	if err != nil {
		t.Fatalf("换源下载失败: %v", err)
	}
	defer os.Remove(path)
	fi, _ := os.Stat(path)
	t.Logf("镜像兜底成功,文件 %d bytes(SHA256 已在 download 内校验)", fi.Size())
}
