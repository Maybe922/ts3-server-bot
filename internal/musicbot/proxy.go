// Package musicbot 负责面板与点歌机器人的对接。
// Bot 的控制 API 只绑本机回环 + Bearer Token；面板作为唯一入口，
// 把已登录用户的点歌请求代理过去——用户侧只见面板，一套登录。
package musicbot

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

const requestTimeout = 15 * time.Second

// ErrNotConfigured 表示 Bot 配置不存在（未安装或未启动过）。
var ErrNotConfigured = errors.New("音乐 Bot 未安装或尚未启动")

type botConfig struct {
	APIPort  int    `json:"apiPort"`
	APIToken string `json:"apiToken"`
}

// Proxy 转发面板请求到 Bot 控制 API。
type Proxy struct {
	configPath string
	client     *http.Client
}

func NewProxy(configPath string) *Proxy {
	return &Proxy{
		configPath: configPath,
		client:     &http.Client{Timeout: requestTimeout},
	}
}

// loadConfig 每次调用现读配置：文件极小，且 Bot 重装后 token 会变。
func (p *Proxy) loadConfig() (botConfig, error) {
	data, err := os.ReadFile(p.configPath)
	if err != nil {
		return botConfig{}, ErrNotConfigured
	}
	var cfg botConfig
	if err := json.Unmarshal(data, &cfg); err != nil || cfg.APIPort == 0 || cfg.APIToken == "" {
		return botConfig{}, ErrNotConfigured
	}
	return cfg, nil
}

// Forward 把请求转发给 Bot，返回 Bot 的响应体（与面板同款 JSON 信封）。
func (p *Proxy) Forward(method, path string, body []byte) (int, []byte, error) {
	cfg, err := p.loadConfig()
	if err != nil {
		return 0, nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", cfg.APIPort, path)
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return 0, nil, errors.New("音乐 Bot 未在运行")
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, respBody, nil
}
