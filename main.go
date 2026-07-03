package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"

	"ts3panel/internal/tsserver"
)

//go:embed web
var webFS embed.FS

const version = "0.1.0-dev"

type server struct {
	ts *tsserver.Manager
}

func main() {
	addr := flag.String("addr", ":8090", "面板监听地址")
	dataDir := flag.String("data", "data", "数据目录（存放 TS3 服务端、凭据、pid）")
	flag.Parse()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("加载内嵌前端资源失败: %v", err)
	}

	s := &server{ts: tsserver.NewManager(*dataDir)}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("POST /api/server/install", s.handleInstall)
	mux.HandleFunc("POST /api/server/start", s.handleStart)
	mux.HandleFunc("POST /api/server/stop", s.handleStop)

	log.Printf("ts3panel %s 已启动，监听 %s，数据目录 %s", version, *addr, *dataDir)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatalf("面板启动失败: %v", err)
	}
}

// respond 输出统一的 API 响应信封。
func respond(w http.ResponseWriter, status int, data any, errMsg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"success": errMsg == "", "data": data, "error": nil}
	if errMsg != "" {
		body["error"] = errMsg
	}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("编码响应失败: %v", err)
	}
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	creds, hasCreds := s.ts.LoadCredentials()
	status := map[string]any{
		"panelVersion":    version,
		"serverVersion":   tsserver.Version,
		"serverInstalled": s.ts.Installed(),
		"serverRunning":   s.ts.Running(),
	}
	if hasCreds {
		status["credentials"] = creds
	}
	respond(w, http.StatusOK, status, "")
}

func (s *server) handleInstall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AcceptLicense bool `json:"acceptLicense"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respond(w, http.StatusBadRequest, nil, "请求格式错误")
		return
	}
	if err := s.ts.Install(r.Context(), req.AcceptLicense); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, tsserver.ErrLicenseNotAccepted) {
			status = http.StatusBadRequest
		}
		respond(w, status, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "安装完成"}, "")
}

func (s *server) handleStart(w http.ResponseWriter, r *http.Request) {
	if err := s.ts.Start(); err != nil {
		respond(w, http.StatusInternalServerError, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "已启动"}, "")
}

func (s *server) handleStop(w http.ResponseWriter, r *http.Request) {
	if err := s.ts.Stop(); err != nil {
		respond(w, http.StatusInternalServerError, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "已停止"}, "")
}
