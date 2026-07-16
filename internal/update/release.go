// Package update 实现面板的自更新：检查新版本、下载校验、原地替换、调度重启。
// 目标用户不该再碰 SSH——升级和安装一样，全程浏览器操作。
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 发布源与 install.sh 保持一致：GitHub 优先，不通切 Gitee 国内镜像。
const (
	githubRepoURL = "https://github.com/Maybe922/ts3-server-bot"
	giteeAPIURL   = "https://gitee.com/api/v5/repos/wushuangqq/ts3-server-bo/releases/latest"
	giteeDLBase   = "https://gitee.com/wushuangqq/ts3-server-bo/releases/download"

	// 版本检查结果缓存时长（页脚角标每天最多触发一次真实外网请求）
	checkTTL     = 24 * time.Hour
	probeTimeout = 10 * time.Second
)

// Release 是一个可下载的发行版。
type Release struct {
	Tag    string // 形如 v0.5.0
	Source string // github | gitee
	base   string // 资产下载前缀，<base>/<资产文件名>
}

// CheckResult 是给前端的版本检查结论。
type CheckResult struct {
	HasUpdate bool   `json:"hasUpdate"`
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Source    string `json:"source,omitempty"`
}

// Updater 持有当前版本与更新状态；Check 带缓存，Apply 全程互斥。
type Updater struct {
	version string // 当前面板版本（不带 v 前缀）
	botDir  string // 机器人安装目录（如 /opt/ts3panel/bot）

	applyMu sync.Mutex

	mu        sync.Mutex
	cached    *CheckResult
	checkedAt time.Time
}

func New(version, botDir string) *Updater {
	return &Updater{version: version, botDir: botDir}
}

// Check 返回是否有新版本，结果缓存 checkTTL。
func (u *Updater) Check(ctx context.Context) (CheckResult, error) {
	u.mu.Lock()
	if u.cached != nil && time.Since(u.checkedAt) < checkTTL {
		res := *u.cached
		u.mu.Unlock()
		return res, nil
	}
	u.mu.Unlock()

	rel, err := latestRelease(ctx)
	if err != nil {
		return CheckResult{}, err
	}
	res := CheckResult{
		HasUpdate: newer(rel.Tag, u.version),
		Current:   u.version,
		Latest:    rel.Tag,
		Source:    rel.Source,
	}
	u.mu.Lock()
	u.cached, u.checkedAt = &res, time.Now()
	u.mu.Unlock()
	return res, nil
}

// latestRelease 解析最新发行版：GitHub 优先，失败切 Gitee。
func latestRelease(ctx context.Context) (Release, error) {
	if rel, err := latestFromGitHub(ctx); err == nil {
		return rel, nil
	}
	rel, err := latestFromGitee(ctx)
	if err != nil {
		return Release{}, errors.New("GitHub 与 Gitee 均无法访问，请稍后重试")
	}
	return rel, nil
}

// latestFromGitHub 通过 releases/latest 的跳转 Location 取 tag，避开 API 限流。
func latestFromGitHub(ctx context.Context) (Release, error) {
	client := &http.Client{
		Timeout: probeTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubRepoURL+"/releases/latest", nil)
	if err != nil {
		return Release{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return Release{}, err
	}
	defer resp.Body.Close()

	tag := path.Base(resp.Header.Get("Location"))
	if !strings.HasPrefix(tag, "v") {
		return Release{}, fmt.Errorf("未能从 GitHub 解析版本号")
	}
	return Release{Tag: tag, Source: "github", base: githubRepoURL + "/releases/download/" + tag}, nil
}

func latestFromGitee(ctx context.Context) (Release, error) {
	client := &http.Client{Timeout: probeTimeout}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, giteeAPIURL, nil)
	if err != nil {
		return Release{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return Release{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("Gitee API 返回 HTTP %d", resp.StatusCode)
	}

	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.TagName == "" {
		return Release{}, errors.New("未能从 Gitee 解析版本号")
	}
	return Release{Tag: body.TagName, Source: "gitee", base: giteeDLBase + "/" + body.TagName}, nil
}

// newer 报告 latest 是否比 current 新（语义化版本，解析失败视为不更新）。
func newer(latest, current string) bool {
	l, lok := parseVersion(latest)
	c, cok := parseVersion(current)
	if !lok || !cok {
		return false
	}
	for i := 0; i < 3; i++ {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

func parseVersion(s string) ([3]int, bool) {
	parts := strings.SplitN(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".", 3)
	var v [3]int
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return v, false
		}
		v[i] = n
	}
	return v, true
}
