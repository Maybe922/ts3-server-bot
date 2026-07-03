package main

import (
	"embed"
	"encoding/json"
	"flag"
	"io/fs"
	"log"
	"net/http"
)

//go:embed web
var webFS embed.FS

// Status 是面板首页轮询的全局状态。
type Status struct {
	PanelVersion    string `json:"panelVersion"`
	ServerInstalled bool   `json:"serverInstalled"`
	ServerRunning   bool   `json:"serverRunning"`
}

const version = "0.1.0-dev"

func main() {
	addr := flag.String("addr", ":8090", "面板监听地址")
	flag.Parse()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("加载内嵌前端资源失败: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("GET /api/status", handleStatus)

	log.Printf("ts3panel %s 已启动，监听 %s", version, *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatalf("面板启动失败: %v", err)
	}
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	// 里程碑 1：接入 internal/tsserver 后返回真实的安装/运行状态。
	status := Status{
		PanelVersion:    version,
		ServerInstalled: false,
		ServerRunning:   false,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(status); err != nil {
		http.Error(w, "内部错误", http.StatusInternalServerError)
		log.Printf("编码状态响应失败: %v", err)
	}
}
